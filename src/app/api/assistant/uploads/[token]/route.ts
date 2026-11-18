import { NextResponse } from "next/server";
import { z } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { assistantConnectionsOn } from "@/lib/assistant/oauth";
import {
  consumeUploadRequest,
  lookupUploadRequest,
  UploadRequestError,
} from "@/lib/assistant/upload-requests";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";
import { DocumentImportError } from "@/lib/services/document-import";
import {
  authorizeDirectUpload,
  DirectUploadRequestError,
} from "@/lib/services/direct-upload";
import {
  discardPendingUpload,
  PendingUploadError,
  readPendingUpload,
} from "@/lib/services/pending-uploads";
import {
  createStorageService,
  supportsDirectUploads,
} from "@/lib/services/storage";
import { isPendingUploadKey } from "@/lib/services/storage-keys";
import { MAX_UPLOAD_SIZE_BYTES } from "@/lib/types/domain";

// Where a one-time upload link (made by the start_draft tool) receives its
// PDF. The token is the credential for PUT, so it is never logged or put in
// a response: logs and rate-limit records see a copy of the request with
// the token replaced by [token].

const LOGGED_PATH = "/api/assistant/uploads/[token]";

type UploadRouteContext = { params: Promise<{ token: string }> };

function redacted(request: Request): Request {
  return new Request(new URL(LOGGED_PATH, request.url), {
    headers: request.headers,
  });
}

function refuse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function fromError(error: unknown, request: Request, userId?: string) {
  if (error instanceof UploadRequestError) {
    return refuse(error.message, error.statusCode);
  }

  if (
    error instanceof DocumentImportError ||
    error instanceof PendingUploadError ||
    error instanceof DirectUploadRequestError
  ) {
    return refuse(error.message, 400);
  }

  logRouteError(error, {
    category: "assistant_upload_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure while receiving an assistant upload.",
    path: LOGGED_PATH,
    userId: userId ?? null,
  });

  return refuse("Unable to receive the upload.", 500);
}

async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);

      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

// A shell agent sends the PDF itself. The link is the only credential, and
// the assistant connection that asked for it must still be there.
export async function PUT(request: Request, context: UploadRouteContext) {
  if (!(await assistantConnectionsOn())) {
    return refuse("AI assistant connections are turned off on this site.", 403);
  }

  const limited = await applyRateLimit({
    category: "assistant_upload_put",
    key: buildRateLimitKey([
      "assistant-upload-put",
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 20,
    request: redacted(request),
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  if (contentType !== "application/pdf") {
    return refuse("Send the PDF with content-type: application/pdf.", 415);
  }

  const declared = Number(request.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > MAX_UPLOAD_SIZE_BYTES) {
    return refuse("This file exceeds the 20 MB limit.", 413);
  }

  try {
    const { token } = await context.params;
    const body = await readBodyWithLimit(request, MAX_UPLOAD_SIZE_BYTES);

    if (body === null) {
      return refuse("This file exceeds the 20 MB limit.", 413);
    }

    if (body.byteLength === 0) {
      return refuse("The request had no PDF in it.", 400);
    }

    const result = await consumeUploadRequest({
      sessionUserId: null,
      sourcePdf: {
        body,
        contentType: "application/pdf",
        filename: "upload.pdf",
      },
      token,
    });

    return NextResponse.json(
      { envelopeId: result.envelopeId },
      { status: 201 },
    );
  } catch (error) {
    return fromError(error, request);
  }
}

const pendingUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  uploadKey: z.string().min(1).max(512),
});

// The upload page, for the signed-in sender the link belongs to. With Vercel
// Blob it is asked first for a signed URL (authorize), then told where the
// PDF went; with local storage the PDF arrives as a form.
export async function POST(request: Request, context: UploadRouteContext) {
  if (!(await assistantConnectionsOn())) {
    return refuse("AI assistant connections are turned off on this site.", 403);
  }

  const sessionResult = await requireVerifiedSenderSession(redacted(request));

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const userId = sessionResult.user.id;
  const limited = await applyRateLimit({
    category: "assistant_upload_post",
    key: buildRateLimitKey(["assistant-upload-post", userId]),
    limit: 40,
    request: redacted(request),
    userId,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return limited;
  }

  try {
    const { token } = await context.params;
    const found = await lookupUploadRequest(token);

    if (!found) {
      return refuse("This upload link isn't valid.", 404);
    }

    if (found.userId !== userId) {
      return refuse("This upload link belongs to someone else.", 403);
    }

    if (found.status === "done") {
      return refuse("This upload link has already been used.", 409);
    }

    if (found.status === "expired") {
      return refuse(
        "This upload link has expired. Ask your assistant for a new one.",
        410,
      );
    }

    const isJson = (request.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("application/json");

    if (!isJson) {
      const formData = await request.formData().catch(() => null);
      const file = formData?.get("file");

      if (!(file instanceof File)) {
        return refuse("A PDF file is required.", 400);
      }

      const result = await consumeUploadRequest({
        sessionUserId: userId,
        sourcePdf: {
          body: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type,
          filename: file.name,
        },
        token,
      });

      return NextResponse.json(
        { envelopeId: result.envelopeId },
        { status: 201 },
      );
    }

    if (!supportsDirectUploads()) {
      return refuse("Direct uploads are not available on this install.", 404);
    }

    const body: unknown = await request.json().catch(() => null);

    if (
      typeof body === "object" &&
      body !== null &&
      (body as { type?: unknown }).type === "blob.generate-presigned-url"
    ) {
      return NextResponse.json(
        await authorizeDirectUpload({ body, request, userId }),
      );
    }

    const parsed = pendingUploadSchema.safeParse(body);

    if (!parsed.success) {
      return refuse("Invalid upload request.", 400);
    }

    const { filename, uploadKey } = parsed.data;

    if (!isPendingUploadKey(uploadKey, userId)) {
      return refuse("Invalid upload reference.", 400);
    }

    const storageService = createStorageService();

    try {
      const result = await consumeUploadRequest({
        sessionUserId: userId,
        sourcePdf: {
          body: await readPendingUpload({
            key: uploadKey,
            storageService,
            userId,
          }),
          contentType: "application/pdf",
          filename,
        },
        token,
      });

      return NextResponse.json(
        { envelopeId: result.envelopeId },
        { status: 201 },
      );
    } finally {
      await discardPendingUpload({ key: uploadKey, storageService });
    }
  } catch (error) {
    return fromError(error, request, userId);
  }
}
