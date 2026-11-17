import type { DbExecutor } from "../db/connection.ts";

/**
 * Ends every assistant's connection to every sender's account. Used when an
 * administrator turns assistant connections off.
 */
export async function endAllAssistantConnections(
  database: DbExecutor,
): Promise<void> {
  await database.query(`DELETE FROM assistant_connections`);
}
