import { randomUUID } from "node:crypto";

import {
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "../db/connection.ts";
import { createDraftEnvelope } from "../envelopes.ts";
import {
  hashOpaqueToken,
  issueOpaqueToken,
} from "../services/opaque-tokens.ts";
import type { StorageService } from "../services/storage/types.ts";
import type { AssistantContext } from "./guard.ts";
import { assistantConnectionsOn } from "./oauth.ts";

// A one-time upload link. A model cannot pass a PDF's bytes through a tool
// call, so it asks for a link, and the sender (or a shell the model can
// run) sends the PDF there. The link is single use, belongs to one sender
// and runs out 30 minutes after it was made. Only the SHA-256 of the token
// is stored, as with the other links SignuDoc emails out.

export const UPLOAD_REQUEST_LIFETIME_SECONDS = 1800;

const GONE_MESSAGE = "This upload link isn't valid.";

export class UploadRequestError extends Error {
  statusCode: 400 | 403 | 404 | 409 | 410;

  constructor(statusCode: UploadRequestError["statusCode"], message: string) {
    super(message);
    this.name = "UploadRequestError";
    this.statusCode = statusCode;
  }
}

export async function createUploadRequest(
  input: { context: AssistantContext; now?: number; title: string },
  database: DbPool = getDb(),
): Promise<{ expiresAt: number; token: string; uploadId: string }> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const issued = issueOpaqueToken({
    expiresInSeconds: UPLOAD_REQUEST_LIFETIME_SECONDS,
    issuedAt: now,
  });
  const uploadId = randomUUID();

  await database.query(
    `
      insert into assistant_upload_requests
        (id, token_hash, user_id, client_id, client_name, title, created_at, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      uploadId,
      issued.tokenHash,
      input.context.userId,
      input.context.clientId,
      input.context.clientName,
      input.title,
      now,
      issued.exp,
    ],
  );

  return { expiresAt: issued.exp, token: issued.token, uploadId };
}

type StatusRow = {
  envelope_id: string | null;
  expires_at: string | number;
  used_at: string | number | null;
};

export type UploadRequestStatus = {
  envelopeId: string | null;
  expiresAt: number;
  status: "done" | "expired" | "waiting";
};

function toStatus(row: StatusRow, now: number): UploadRequestStatus {
  const expiresAt = Number(row.expires_at);

  return {
    envelopeId: row.envelope_id,
    expiresAt,
    status:
      row.used_at !== null ? "done" : expiresAt <= now ? "expired" : "waiting",
  };
}

/** Where an upload request stands, for the sender it belongs to. */
export async function getUploadRequestStatus(
  userId: string,
  uploadId: string,
  now: number = Math.floor(Date.now() / 1000),
  database: DbPool = getDb(),
): Promise<UploadRequestStatus | null> {
  const row = await queryOne<StatusRow>(
    database,
    `select envelope_id, expires_at, used_at from assistant_upload_requests where id = $1 and user_id = $2`,
    [uploadId, userId],
  );

  return row ? toStatus(row, now) : null;
}

export type UploadRequestLookup = {
  clientName: string;
  envelopeId: string | null;
  expiresAt: number;
  status: UploadRequestStatus["status"];
  title: string;
  userId: string;
};

/**
 * What the upload page and its API need to know about a link, without using
 * it up. Null when the token is unknown.
 */
export async function lookupUploadRequest(
  token: string,
  now: number = Math.floor(Date.now() / 1000),
  database: DbPool = getDb(),
): Promise<UploadRequestLookup | null> {
  const row = await queryOne<
    StatusRow & { client_name: string; title: string; user_id: string | null }
  >(
    database,
    `select envelope_id, expires_at, used_at, client_name, title, user_id from assistant_upload_requests where token_hash = $1`,
    [hashOpaqueToken(token)],
  );

  if (!row || row.user_id === null) {
    return null;
  }

  return {
    clientName: row.client_name,
    title: row.title,
    userId: row.user_id,
    ...toStatus(row, now),
  };
}

type ConsumeInput = {
  now?: number;
  sessionUserId: string | null;
  sourcePdf: { body: Uint8Array; contentType: string; filename: string };
  token: string;
};

type ConsumeOptions = {
  database?: DbPool;
  storageService?: StorageService;
};

type LockedRow = {
  client_id: string;
  client_name: string;
  envelope_id: string | null;
  expires_at: string | number;
  id: string;
  title: string;
  used_at: string | number | null;
  user_id: string | null;
};

/**
 * Makes the draft for an upload link and uses the link up. The row is
 * locked for the whole of it, so two uploads racing on one link make one
 * draft. When the PDF is refused the link is left as it was.
 *
 * With no `sessionUserId` the link itself is the credential (a shell agent
 * sending the PDF), so the assistant connection that asked for it must
 * still exist. With one, the sender is here in person and it must be the
 * link's own sender.
 */
export async function consumeUploadRequest(
  input: ConsumeInput,
  { database = getDb(), storageService }: ConsumeOptions = {},
): Promise<{ envelopeId: string }> {
  if (!(await assistantConnectionsOn())) {
    throw new UploadRequestError(
      403,
      "AI assistant connections are turned off on this site.",
    );
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);

  return withTransaction(async (tx) => {
    const row = await queryOne<LockedRow>(
      tx,
      `select id, user_id, client_id, client_name, title, expires_at, used_at, envelope_id
         from assistant_upload_requests where token_hash = $1 for update`,
      [hashOpaqueToken(input.token)],
    );

    if (!row || row.user_id === null) {
      throw new UploadRequestError(404, GONE_MESSAGE);
    }

    if (row.used_at !== null) {
      throw new UploadRequestError(
        409,
        "This upload link has already been used.",
      );
    }

    if (Number(row.expires_at) <= now) {
      throw new UploadRequestError(
        410,
        "This upload link has expired. Ask your assistant for a new one.",
      );
    }

    if (input.sessionUserId !== null && input.sessionUserId !== row.user_id) {
      throw new UploadRequestError(
        403,
        "This upload link belongs to someone else.",
      );
    }

    if (input.sessionUserId === null) {
      const connection = await queryOne(
        tx,
        `select 1 from assistant_connections where user_id = $1 and client_id = $2`,
        [row.user_id, row.client_id],
      );

      if (!connection) {
        throw new UploadRequestError(
          403,
          "This upload link stopped working because the assistant was disconnected.",
        );
      }
    }

    const draft = await createDraftEnvelope(
      row.user_id,
      {
        auditMetadata: {
          client: row.client_name,
          clientId: row.client_id,
          via: "mcp",
        },
        sourcePdf: input.sourcePdf,
        title: row.title,
      },
      storageService ? { database, storageService } : { database },
    );

    await tx.query(
      `update assistant_upload_requests set used_at = $2, envelope_id = $3 where id = $1`,
      [row.id, now, draft.envelope.id],
    );

    return { envelopeId: draft.envelope.id };
  }, database);
}
