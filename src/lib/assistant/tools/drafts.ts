import { z } from "zod";

import {
  deleteDraftEnvelope,
  getPrepareEnvelopeDataForUser,
  listCopyRecipientsForEnvelopeId,
  replaceDraftEnvelopeSigners,
} from "../../envelopes.ts";
import { getDb } from "../../db/connection.ts";
import { idSchema } from "../../schemas/common.ts";
import {
  copyRecipientSchema,
  draftSignerSchema,
} from "../../schemas/signer.ts";
import {
  type AssistantTool,
  AssistantToolError,
  draftLinks,
} from "./shared.ts";

// The tools that set who signs a draft and delete a draft. Nothing is sent
// or emailed.

const incomingSignerSchema = draftSignerSchema.omit({
  envelopeId: true,
  id: true,
});
const incomingCopyRecipientSchema = copyRecipientSchema.omit({ id: true });

const setSignersInput = z.object({
  copyRecipients: z.array(incomingCopyRecipientSchema).optional(),
  envelopeId: idSchema,
  signers: z.array(incomingSignerSchema),
});

const deleteDraftInput = z.object({ envelopeId: idSchema });

function byEmail(rows: ReadonlyArray<{ email: string; id: string }>) {
  return new Map(rows.map((row) => [row.email.toLowerCase(), row.id]));
}

export const setSigners: AssistantTool<
  z.infer<typeof setSignersInput>,
  {
    prepareUrl: string;
    reviewUrl: string;
    signers: Array<{
      email: string;
      id: string;
      name: string;
      signOrder: number;
    }>;
  }
> = {
  description:
    "Sets who signs a draft in SignuDoc, in signing order (the order of the list), and optionally who gets a copy of the finished document. This replaces the signers on the draft. A signer whose email matches one already on the draft (ignoring case) is kept, so any fields already placed for them stay; a signer with a new email is added, and one left out is removed along with their fields. Each signer takes a name, an email and optionally accessCode (4 to 64 characters, null removes it), requireEmailCode, and signatureMeaning (approval, review, responsibility or authorship, for Part 11 envelopes). Leave out copyRecipients to keep the current ones. Drafts only. Nothing is sent or emailed: tell the sender to open the prepare link to place fields, then review and send in SignuDoc.",
  input: setSignersInput,
  name: "set_signers",
  rateLimit: { limit: 60, windowMs: 10 * 60 * 1000 },
  run: async (context, { copyRecipients, envelopeId, signers }) => {
    const envelope = await getPrepareEnvelopeDataForUser(
      context.userId,
      envelopeId,
    );

    if (!envelope) {
      throw new AssistantToolError("Envelope not found.");
    }

    const signerIds = byEmail(envelope.signers);
    const copyIds = byEmail(
      await listCopyRecipientsForEnvelopeId(envelopeId, getDb()),
    );
    const result = await replaceDraftEnvelopeSigners(
      context.userId,
      envelopeId,
      {
        copyRecipients: copyRecipients?.map((recipient) => ({
          ...recipient,
          id: copyIds.get(recipient.email.toLowerCase()),
        })),
        signers: signers.map((signer) => ({
          ...signer,
          id: signerIds.get(signer.email.toLowerCase()),
        })),
      },
    );

    return {
      signers: result.signers.map(({ email, id, name, signOrder }) => ({
        email,
        id,
        name,
        signOrder,
      })),
      ...draftLinks(envelopeId),
    };
  },
  scope: "drafts:write",
};

export const deleteDraft: AssistantTool<
  z.infer<typeof deleteDraftInput>,
  { deleted: true }
> = {
  description:
    "Deletes a draft in SignuDoc, with its document, signers and fields. This can't be undone. Drafts only: a sent envelope is refused. Ask the sender before deleting. Nothing is sent or emailed.",
  input: deleteDraftInput,
  name: "delete_draft",
  rateLimit: { limit: 30, windowMs: 10 * 60 * 1000 },
  run: async (context, { envelopeId }) => {
    await deleteDraftEnvelope(context.userId, envelopeId);

    return { deleted: true };
  },
  scope: "drafts:write",
};

export const DRAFT_TOOLS = [
  setSigners,
  deleteDraft,
] as unknown as ReadonlyArray<AssistantTool<unknown, unknown>>;
