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

export const startDraft: AssistantTool<
  z.infer<typeof startDraftInput>,
  {
    expiresAt: number;
    note: string;
    uploadApiUrl: string;
    uploadId: string;
    uploadPageUrl: string;
  }
> = {
  description:
    "Starts a new draft envelope in SignuDoc. You can't send a PDF through this connection, so this returns a one-time upload link instead, good for 30 minutes. Give the sender uploadPageUrl to open and drop the PDF on. Then call get_upload to see when it has arrived. Nothing is sent or emailed to anyone.",
  input: startDraftInput,
  name: "start_draft",
  rateLimit: { limit: 20, windowMs: 10 * 60 * 1000 },
  run: async (context, input) => {
    const request = await createUploadRequest({
      context,
      title: input.title,
    });
    const base = appBaseUrl();

    return {
      expiresAt: request.expiresAt,
      note: "Give the sender uploadPageUrl to open and drop the PDF on. If you can run commands, you can instead send the PDF yourself: PUT it to uploadApiUrl with the header content-type: application/pdf (4.5 MB at most on Vercel). The link works once and expires in 30 minutes. Then call get_upload with the uploadId to see when the draft exists. Treat the links as secrets: don't show them anywhere but to the sender.",
      uploadApiUrl: `${base}/api/assistant/uploads/${request.token}`,
      uploadId: request.uploadId,
      uploadPageUrl: `${base}/upload/${request.token}`,
    };
  },
  scope: "drafts:write",
};

export const getUpload: AssistantTool<
  z.infer<typeof getUploadInput>,
  {
    envelopeId: string | null;
    expiresAt: number;
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
