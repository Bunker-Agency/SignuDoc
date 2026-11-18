import { z } from "zod";

import {
  getEnvelopeDetailDataForUser,
  getPrepareEnvelopeDataForUser,
  getReviewEnvelopeDataForUser,
  listEnvelopesForUser,
} from "../../envelopes.ts";
import { idSchema } from "../../schemas/common.ts";
import { envelopeListFiltersSchema } from "../../schemas/envelope.ts";
import {
  type AssistantTool,
  AssistantToolError,
  detailLink,
  draftLinks,
} from "./shared.ts";

// The tools that read the sender's envelopes. Both act only for the user
// the token belongs to, through the *ForUser functions.

const MAX_PAGE_SIZE = 100;

type EnvelopeListInput = z.infer<typeof envelopeListFiltersSchema>;

const toIso = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;

export const listEnvelopes: AssistantTool<
  EnvelopeListInput,
  {
    envelopes: Array<{
      createdAt: string | null;
      id: string;
      sentAt: string | null;
      signers: Array<{ email: string; name: string; status: string }>;
      status: string;
      title: string;
    }>;
    hasMore: boolean;
    page: number;
  }
> = {
  description:
    "Lists the sender's envelopes in SignuDoc, newest first, with each one's status and signers. Filter by status (draft, sent, completed, declined, voided) or search by title or a signer's or recipient's email address. Use it to find an envelope before reading it with get_envelope. This only reads: nothing is changed, and nobody is emailed. Sending an envelope happens in SignuDoc, by the sender, never through this connection.",
  input: envelopeListFiltersSchema,
  name: "list_envelopes",
  rateLimit: { limit: 60, windowMs: 10 * 60 * 1000 },
  run: async (context, input) => {
    // One more than asked for shows whether there is a next page. At the
    // largest page size there is no room for it, so a full page counts.
    const lookahead = input.limit < MAX_PAGE_SIZE;
    const rows = await listEnvelopesForUser(context.userId, {
      ...input,
      limit: lookahead ? input.limit + 1 : input.limit,
    });
    const shown = rows.slice(0, input.limit);

    return {
      envelopes: shown.map((row) => ({
        createdAt: toIso(row.createdAt),
        id: row.id,
        sentAt: toIso(row.sentAt),
        signers: (row.signers ?? []).map(({ email, name, status }) => ({
          email,
          name,
          status,
        })),
        status: row.status,
        title: row.title,
      })),
      hasMore: lookahead
        ? rows.length > input.limit
        : rows.length === input.limit,
      page: input.page,
    };
  },
  scope: "envelopes:read",
};

const getEnvelopeInput = z.object({ envelopeId: idSchema });

export const getEnvelope: AssistantTool<
  z.infer<typeof getEnvelopeInput>,
  Record<string, unknown>
> = {
  description:
    "Reads one of the sender's envelopes in SignuDoc: its title, status, page count, signers, copy recipients, fields and deadline. For a draft it also returns a review link and a prepare link: tell the sender to open them in SignuDoc to check the draft, place fields and send it. For any other envelope it returns a link to its page in SignuDoc. This only reads: nothing is changed, and nobody is emailed. Sending happens in SignuDoc, by the sender, never through this connection.",
  input: getEnvelopeInput,
  name: "get_envelope",
  rateLimit: { limit: 120, windowMs: 10 * 60 * 1000 },
  run: async (context, { envelopeId }) => {
    // Every read below is for the token's user, so someone else's envelope
    // is the same as none.
    const prepare = await getPrepareEnvelopeDataForUser(
      context.userId,
      envelopeId,
    );

    if (!prepare) {
      throw new AssistantToolError("Envelope not found.");
    }

    const signersById = new Map(
      prepare.signers.map((signer) => [signer.id, signer]),
    );
    const fields = prepare.fields.map((field) => ({
      id: field.id ?? null,
      label: field.label ?? null,
      page: field.page,
      signerEmail: signersById.get(field.signerId)?.email ?? null,
      type: field.type,
    }));

    if (prepare.status === "draft") {
      const review = await getReviewEnvelopeDataForUser(
        context.userId,
        envelopeId,
      );

      if (!review) {
        throw new AssistantToolError("Envelope not found.");
      }

      return {
        copyRecipients: review.copyRecipients.map(({ email, name }) => ({
          email,
          name,
        })),
        fields,
        id: envelopeId,
        pageCount: review.pageCount,
        ...draftLinks(envelopeId),
        signers: review.signers.map((signer) => ({
          email: signer.email,
          id: signer.id,
          name: signer.name,
          signOrder: signer.order,
          status: "draft",
        })),
        status: review.status,
        title: review.title,
      };
    }

    const detail = await getEnvelopeDetailDataForUser(
      context.userId,
      envelopeId,
    );

    if (!detail) {
      throw new AssistantToolError("Envelope not found.");
    }

    return {
      copyRecipients: detail.copyRecipients.map(({ email, name }) => ({
        email,
        name,
      })),
      deadline: detail.deadline?.expiresAtLabel ?? null,
      detailUrl: detailLink(envelopeId),
      fields,
      id: envelopeId,
      pageCount: prepare.pageCount,
      signers: detail.signers.map((signer) => ({
        email: signer.email,
        id: signer.id,
        name: signer.name,
        signOrder: signer.order,
        status: signer.status,
      })),
      status: detail.status,
      title: detail.title,
    };
  },
  scope: "envelopes:read",
};

export const ENVELOPE_TOOLS = [
  listEnvelopes,
  getEnvelope,
] as unknown as ReadonlyArray<AssistantTool<unknown, unknown>>;
