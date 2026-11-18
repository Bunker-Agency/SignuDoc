import { z } from "zod";

import {
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
} from "../../envelopes.ts";
import { readDraftPdfText } from "../../pdf-text.ts";
import { idSchema } from "../../schemas/common.ts";
import { fieldTypeSchema } from "../../schemas/field.ts";
import { pageLines, resolveAnchoredFields } from "../anchor-placement.ts";
import {
  type AssistantTool,
  AssistantToolError,
  draftLinks,
} from "./shared.ts";

// The tools that put fields on a draft by the words on the page. Nothing is
// sent or emailed.

export const DOCUMENT_TEXT_LIMIT = 50_000;

const getDocumentTextInput = z.object({
  envelopeId: idSchema,
  fromPage: z.number().int().positive().optional(),
  toPage: z.number().int().positive().optional(),
});

const anchoredFieldSchema = z.object({
  anchor: z.object({
    occurrence: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    position: z.enum(["right", "below", "over"]),
    text: z.string().trim().min(1).max(200),
  }),
  group: z.string().max(64).optional(),
  label: z.string().max(120).optional(),
  options: z.array(z.string()).max(100).optional(),
  required: z.boolean().optional(),
  signer: z.string().trim().min(1).max(320),
  type: fieldTypeSchema,
});

const placeFieldsInput = z.object({
  envelopeId: idSchema,
  fields: z.array(anchoredFieldSchema).min(1).max(200),
});

export const getDocumentText: AssistantTool<
  z.infer<typeof getDocumentTextInput>,
  {
    hasTextLayer: boolean;
    pages: Array<{ pageNumber: number; text: string }>;
    truncated: boolean;
  }
> = {
  description:
    "Reads the text of a draft's PDF in SignuDoc, page by page, so you can see the labels to place fields next to. Use place_fields to put fields by those labels. Optionally limit it with fromPage and toPage. If hasTextLayer is false the PDF is scanned or has no text, and fields have to be placed on the prepare page by the sender. At most 50,000 characters come back; truncated says when there was more. Drafts only. This only reads: nothing is changed, and nobody is emailed.",
  input: getDocumentTextInput,
  name: "get_document_text",
  rateLimit: { limit: 60, windowMs: 10 * 60 * 1000 },
  run: async (context, { envelopeId, fromPage, toPage }) => {
    const pages = await readDraftPdfText(context.userId, envelopeId);
    const hasTextLayer = pages.some((page) =>
      page.items.some((item) => item.text.trim().length > 0),
    );
    const from = fromPage ?? 1;
    const to = toPage ?? Number.POSITIVE_INFINITY;
    const result: Array<{ pageNumber: number; text: string }> = [];
    let used = 0;
    let truncated = false;

    for (const page of pages) {
      if (page.pageNumber < from || page.pageNumber > to) {
        continue;
      }

      const text = pageLines(page).join("\n");
      const room = DOCUMENT_TEXT_LIMIT - used;

      if (text.length > room) {
        result.push({ pageNumber: page.pageNumber, text: text.slice(0, room) });
        truncated = true;
        break;
      }

      result.push({ pageNumber: page.pageNumber, text });
      used += text.length;
    }

    return { hasTextLayer, pages: result, truncated };
  },
  scope: "envelopes:read",
};

export const placeFields: AssistantTool<
  z.infer<typeof placeFieldsInput>,
  {
    placed: Array<{ page: number; signerEmail: string; type: string }>;
    prepareUrl: string;
    reviewUrl: string;
  }
> = {
  description:
    "Places fields on a draft in SignuDoc by the text they sit next to. For each field give the signer (an email address or id from get_envelope), the field type, and an anchor: the text to find (as read with get_document_text), which side to put the field on (right, below or over), and optionally which occurrence (default 1) or page. This replaces every field already on the draft. If any anchor can't be found or any signer doesn't match, nothing is saved and every problem is listed. Drafts only. Nothing is sent or emailed: tell the sender to open the prepare link to check the fields and send in SignuDoc.",
  input: placeFieldsInput,
  name: "place_fields",
  rateLimit: { limit: 60, windowMs: 10 * 60 * 1000 },
  run: async (context, { envelopeId, fields }) => {
    const pages = await readDraftPdfText(context.userId, envelopeId);
    const envelope = await getPrepareEnvelopeDataForUser(
      context.userId,
      envelopeId,
    );

    if (!envelope) {
      throw new AssistantToolError("Envelope not found.");
    }

    const resolved = resolveAnchoredFields(pages, envelope.signers, fields);

    if (!resolved.ok) {
      throw new AssistantToolError(
        `No fields were placed. ${resolved.problems
          .map(({ index, message }) => `Field ${index + 1}: ${message}`)
          .join(" ")}`,
      );
    }

    await replaceDraftEnvelopeFields(context.userId, envelopeId, {
      fields: resolved.placements,
    });

    const emails = new Map(
      envelope.signers.map((signer) => [signer.id, signer.email]),
    );

    return {
      placed: resolved.placements.map((placement) => ({
        page: placement.page,
        signerEmail: emails.get(placement.signerId) ?? "",
        type: placement.type,
      })),
      ...draftLinks(envelopeId),
    };
  },
  scope: "drafts:write",
};

export const FIELD_TOOLS = [
  getDocumentText,
  placeFields,
] as unknown as ReadonlyArray<AssistantTool<unknown, unknown>>;
