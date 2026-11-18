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
    // A claimed link with no draft yet is still being received.
    status:
      row.used_at !== null && row.envelope_id !== null
        ? "done"
        : row.used_at === null && expiresAt <= now
          ? "expired"
          : "waiting",
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
 * Makes the draft for an upload link and uses the link up, once.
 *
 * Step 1 claims the link in a short transaction of its own: the row is
 * locked (`FOR UPDATE`), checked, and marked used before anything else
 * happens, so two uploads racing on one link cannot both go on. Step 2
 * makes the draft on its own connection, with no row lock held across the
 * PDF parsing and the storage write; the link's `envelope_id` is written in
 * the same transaction as the draft, so they commit together. If step 2
 * fails (a PDF that can't be read, storage down) the claim is cleared and
 * the link works again. If the server dies between the two steps the link
 * stays used: it fails closed, and a new link is asked for.
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
  const row = await withTransaction(async (tx) => {
    const locked = await queryOne<LockedRow>(
      tx,
      `select id, user_id, client_id, client_name, title, expires_at, used_at, envelope_id
         from assistant_upload_requests where token_hash = $1 for update`,
      [hashOpaqueToken(input.token)],
    );

    if (!locked || locked.user_id === null) {
      throw new UploadRequestError(404, GONE_MESSAGE);
    }

    if (locked.used_at !== null) {
      throw new UploadRequestError(
        409,
        "This upload link has already been used.",
      );
    }

    if (Number(locked.expires_at) <= now) {
      throw new UploadRequestError(
        410,
        "This upload link has expired. Ask your assistant for a new one.",
      );
    }

    if (
      input.sessionUserId !== null &&
      input.sessionUserId !== locked.user_id
    ) {
      throw new UploadRequestError(
        403,
        "This upload link belongs to someone else.",
      );
    }

    if (input.sessionUserId === null) {
      const connection = await queryOne(
        tx,
        `select 1 from assistant_connections where user_id = $1 and client_id = $2`,
        [locked.user_id, locked.client_id],
      );

      if (!connection) {
        throw new UploadRequestError(
          403,
          "This upload link stopped working because the assistant was disconnected.",
        );
      }
    }

    await tx.query(
      `update assistant_upload_requests set used_at = $2 where id = $1`,
      [locked.id, now],
    );

    return locked as LockedRow & { user_id: string };
  }, database);

  try {
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
      {
        database,
        ...(storageService ? { storageService } : {}),
        withinTransaction: async (tx, envelopeId) => {
          await tx.query(
            `update assistant_upload_requests set envelope_id = $2 where id = $1`,
            [row.id, envelopeId],
          );
        },
      },
    );

    return { envelopeId: draft.envelope.id };
  } catch (error) {
    // Nothing was made, so the link is given back.
    await database
      .query(
        `update assistant_upload_requests set used_at = null where id = $1 and envelope_id is null`,
        [row.id],
      )
      .catch((releaseError) =>
        console.error(
          "[assistant] Could not release an upload link:",
          releaseError,
        ),
      );

    throw error;
  }
}
