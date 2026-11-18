import { z } from "zod";

import { envelopeTitleSchema } from "../../schemas/common.ts";
import {
  createUploadRequest,
  getUploadRequestStatus,
} from "../upload-requests.ts";
import {
  type AssistantTool,
  AssistantToolError,
  appBaseUrl,
  draftLinks,
} from "./shared.ts";

// The two tools that start a draft. A PDF's bytes can't go through a tool
// call, so start_draft hands back a one-time link and the sender drops the
// PDF there. Nothing is sent or emailed.

const startDraftInput = z.object({ title: envelopeTitleSchema });
const getUploadInput = z.object({ uploadId: z.string().min(1).max(100) });

// Shown while the PDF hasn't arrived, so the assistant asks the sender
// instead of polling a link nobody has opened.
const WAITING_NOTE =
  "Nothing has arrived yet. The PDF only arrives when the sender opens the upload link from start_draft and drops the file on it. If you haven't heard that they've done it, ask them rather than checking again.";

export const startDraft: AssistantTool<
  z.infer<typeof startDraftInput>,
  {
    askTheSender: string;
    expiresAt: number;
    note: string;
    uploadApiUrl: string;
    uploadId: string;
    uploadPageUrl: string;
  }
> = {
  description:
    "Makes a one-time upload link for a new SignuDoc draft. No draft exists yet: it is created only when the PDF arrives on the link, and you can't send a PDF through this connection. So the sender has to open uploadPageUrl and drop the PDF on it themselves. Tell them that plainly, with the link, in your next message (askTheSender has the words), and don't say the draft is set up until get_upload reports done. The link works once and lasts 30 minutes. Nothing is sent or emailed to anyone.",
  input: startDraftInput,
  name: "start_draft",
  rateLimit: { limit: 20, windowMs: 10 * 60 * 1000 },
  run: async (context, input) => {
    const request = await createUploadRequest({
      context,
      title: input.title,
    });
    const base = appBaseUrl();

    const uploadPageUrl = `${base}/upload/${request.token}`;

    return {
      askTheSender: `To start the draft, open this link and drop the PDF on it: ${uploadPageUrl} (it works once and expires in 30 minutes). Tell me when it's done.`,
      expiresAt: request.expiresAt,
      note: "No draft exists until the PDF arrives. Pass askTheSender on to the sender now. If you can run commands and have the file, you can instead send the PDF yourself: PUT it to uploadApiUrl with the header content-type: application/pdf (4.5 MB at most on Vercel). Then call get_upload with the uploadId to see when the draft exists. Treat the links as secrets: don't show them anywhere but to the sender.",
      uploadApiUrl: `${base}/api/assistant/uploads/${request.token}`,
      uploadId: request.uploadId,
      uploadPageUrl,
    };
  },
  scope: "drafts:write",
};

export const getUpload: AssistantTool<
  z.infer<typeof getUploadInput>,
  {
    envelopeId: string | null;
    expiresAt: number;
    note?: string;
    prepareUrl?: string;
    reviewUrl?: string;
    status: "done" | "expired" | "waiting";
  }
> = {
  description:
    "Checks an upload link made by start_draft in SignuDoc. status is waiting until the PDF arrives, then done with the new draft's envelopeId and links to review it and place its fields, or expired once it can no longer be used (30 minutes, or a PDF that never became a draft). This only reads.",
  input: getUploadInput,
  name: "get_upload",
  rateLimit: { limit: 120, windowMs: 10 * 60 * 1000 },
  run: async (context, input) => {
    const status = await getUploadRequestStatus(context.userId, input.uploadId);

    if (!status) {
      throw new AssistantToolError("Upload request not found.");
    }

    return {
      ...status,
      ...(status.status === "waiting" ? { note: WAITING_NOTE } : {}),
      ...(status.status === "done" && status.envelopeId
        ? draftLinks(status.envelopeId)
        : {}),
    };
  },
  scope: "drafts:write",
};

export const UPLOAD_TOOLS = [startDraft, getUpload] as Array<
  AssistantTool<unknown, unknown>
>;
