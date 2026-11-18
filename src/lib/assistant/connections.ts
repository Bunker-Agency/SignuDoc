import {
  type DbExecutor,
  getDb,
  queryMany,
  withTransaction,
} from "../db/connection.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import {
  checkSession,
  type SessionCheck,
  type SessionLimits,
} from "../session-controls.ts";

// An AI assistant's connection to a sender's account: one row in
// assistant_connections per sender and assistant (OAuth client) they
// approved. The OAuth provider's access tokens are JWTs and cannot be
// recalled, so the row is what decides: the token guard (guard.ts) checks
// it on every request, and ending a connection deletes it together with
// everything the provider kept for that sender and assistant (its consent,
// refresh tokens and any opaque access tokens). Refresh tokens outlive
// sessions and consents in the provider, so they are deleted here
// explicitly.
//
// The provider's tables are written with SQL directly: its own management
// endpoints are blocked (oauth.ts) and answer NOT_FOUND to server calls too.

/** Why a single connection ended. */
export type EndConnectionReason = "revoked" | "limits";

/** Why every connection of a sender ended. */
export type EndUserConnectionsReason =
  "password_reset" | "sign_in_reset" | "sessions_revoked";

export type AssistantConnection = {
  approvedAt: number;
  clientId: string;
  clientName: string;
  lastUsedAt: number | null;
};

function isPool(database: DbExecutor): database is ReturnType<typeof getDb> {
  return "connect" in database && "totalCount" in database;
}

/**
 * Runs `work` in one transaction: a new one when given the pool, or the
 * caller's when given a connection that is already inside one.
 */
async function inTransaction<T>(
  database: DbExecutor,
  work: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return isPool(database) ? withTransaction(work, database) : work(database);
}

/**
 * Records that a sender approved an assistant. Approving again (after the
 * connection ended, or from a second device) starts it afresh: a new
 * approval time, and no use yet.
 */
export async function recordAssistantConnection(
  input: {
    clientId: string;
    clientName: string;
    now?: number;
    userId: string;
  },
  database: DbExecutor = getDb(),
): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);

  await database.query(
    `INSERT INTO assistant_connections (user_id, client_id, client_name, approved_at, last_used_at)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (user_id, client_id) DO UPDATE
       SET client_name = excluded.client_name,
           approved_at = excluded.approved_at,
           last_used_at = NULL`,
    [input.userId, input.clientId, input.clientName, now],
  );
}

/**
 * Whether a connection may still be used now. Pure. A connection is held
 * to the install's session limits as a session that began when the sender
 * approved it: no longer than the maximum session age after approval, and
 * no longer than the idle timeout after its last use. A limit that is off
 * (null) does not apply; the refresh token's own lifetime still does.
 */
export function checkConnection(
  row: { approvedAt: number; lastUsedAt: number | null } | null,
  limits: SessionLimits,
  nowSeconds: number,
): SessionCheck {
  return checkSession(
    row
      ? {
          createdAt: new Date(row.approvedAt * 1000),
          lastActiveAt: row.lastUsedAt,
        }
      : null,
    limits,
    nowSeconds,
  );
}

/** Writes down that the connection was used. */
export async function touchAssistantConnection(
  userId: string,
  clientId: string,
  nowSeconds: number,
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `UPDATE assistant_connections SET last_used_at = $3
      WHERE user_id = $1 AND client_id = $2`,
    [userId, clientId, nowSeconds],
  );
}

/** The sender's connections, the most recently approved first. */
export async function listAssistantConnections(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<AssistantConnection[]> {
  return queryMany<AssistantConnection>(
    database,
    `SELECT client_id AS "clientId",
            client_name AS "clientName",
            approved_at AS "approvedAt",
            last_used_at AS "lastUsedAt"
       FROM assistant_connections
      WHERE user_id = $1
      ORDER BY approved_at DESC, client_name ASC`,
    [userId],
  );
}

/** Deletes what the provider kept for the sender, or for one assistant. */
async function deleteProviderGrants(
  tx: DbExecutor,
  userId: string,
  clientId?: string,
): Promise<void> {
  const where =
    clientId === undefined
      ? `"userId" = $1`
      : `"userId" = $1 AND "clientId" = $2`;
  const values = clientId === undefined ? [userId] : [userId, clientId];

  // Access tokens first: an opaque one may point at a refresh token.
  await tx.query(`DELETE FROM "oauthAccessToken" WHERE ${where}`, values);
  await tx.query(`DELETE FROM "oauthRefreshToken" WHERE ${where}`, values);
  await tx.query(`DELETE FROM "oauthConsent" WHERE ${where}`, values);
}

async function recordDisconnected(
  tx: DbExecutor,
  input: {
    clientId: string;
    clientName: string;
    reason: EndConnectionReason | EndUserConnectionsReason;
    userId: string;
  },
): Promise<void> {
  await recordSystemAuditEvent(
    {
      actorEmail: null,
      actorUserId: null,
      event: "assistant_disconnected",
      metadata: {
        clientId: input.clientId,
        clientName: input.clientName,
        reason: input.reason,
      },
      targetUserId: input.userId,
    },
    tx,
  );
}

/**
 * Ends one assistant's connection to a sender's account, at once: its
 * existing access tokens stop working at the guard, and its refresh tokens
 * are gone. Records `assistant_disconnected` when there was a connection.
 * True when there was one.
 */
export async function endAssistantConnection(
  input: { clientId: string; reason: EndConnectionReason; userId: string },
  database: DbExecutor = getDb(),
): Promise<boolean> {
  return inTransaction(database, async (tx) => {
    // Deleting and reading in one statement, so two requests ending the
    // same connection at once record it once.
    const ended = await queryMany<{ clientName: string }>(
      tx,
      `DELETE FROM assistant_connections
        WHERE user_id = $1 AND client_id = $2
        RETURNING client_name AS "clientName"`,
      [input.userId, input.clientId],
    );

    await deleteProviderGrants(tx, input.userId, input.clientId);

    const row = ended[0];

    if (!row) {
      return false;
    }

    await recordDisconnected(tx, {
      clientId: input.clientId,
      clientName: row.clientName,
      reason: input.reason,
      userId: input.userId,
    });

    return true;
  });
}

/**
 * Ends every assistant's connection to a sender's account, as their
 * sessions end: a password reset, an administrator resetting their sign-in,
 * or signing out everywhere. Inside the caller's transaction when given
 * one.
 */
export async function endAssistantConnectionsForUser(
  userId: string,
  reason: EndUserConnectionsReason,
  database: DbExecutor = getDb(),
): Promise<void> {
  await inTransaction(database, async (tx) => {
    const ended = await queryMany<{ clientId: string; clientName: string }>(
      tx,
      `DELETE FROM assistant_connections
        WHERE user_id = $1
        RETURNING client_id AS "clientId", client_name AS "clientName"`,
      [userId],
    );

    // Everything the provider kept for the sender, whether or not it has a
    // connection of ours behind it.
    await deleteProviderGrants(tx, userId);

    for (const row of ended) {
      await recordDisconnected(tx, { ...row, reason, userId });
    }
  });
}

/**
 * Ends every assistant's connection to every sender's account. Used when an
 * administrator turns assistant connections off, inside that change's
 * transaction. Registered clients are kept: they are worth nothing without
 * a sender's approval.
 */
export async function endAllAssistantConnections(
  database: DbExecutor = getDb(),
): Promise<void> {
  await inTransaction(database, async (tx) => {
    await tx.query(`DELETE FROM assistant_connections`);
    await tx.query(`DELETE FROM "oauthAccessToken"`);
    await tx.query(`DELETE FROM "oauthRefreshToken"`);
    await tx.query(`DELETE FROM "oauthConsent"`);
  });
}
