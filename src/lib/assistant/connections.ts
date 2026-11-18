import { getDb, type DbExecutor } from "../db/connection.ts";

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
 * Ends every assistant's connection to every sender's account. Used when an
 * administrator turns assistant connections off.
 */
export async function endAllAssistantConnections(
  database: DbExecutor,
): Promise<void> {
  await database.query(`DELETE FROM assistant_connections`);
}
