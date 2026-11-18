import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

import { getDb, queryOne, type DbExecutor } from "../db/connection.ts";
import { signedOAuthQuery } from "./signed-query.ts";

// What the consent page shows a sender, read only from what the OAuth
// provider signed. Anything else in the page's address could have been put
// there by whoever sent the link.

/** Shown when an assistant registered without a name. */
export const UNNAMED_ASSISTANT = "Unnamed assistant";

export type ConsentRequest = {
  clientId: string;
  /** The name the assistant gave itself when it registered. */
  clientName: string;
  /** The signed query, sent back with Approve or Deny. */
  oauthQuery: string;
  /** Where the assistant will send the sender back to. */
  redirectHost: string;
};

/**
 * The name an assistant registered with, from the provider's own table.
 * Null when there is no such client.
 */
export async function readAssistantClientName(
  clientId: string,
  database: DbExecutor = getDb(),
): Promise<string | null> {
  const row = await queryOne<{ name: string | null }>(
    database,
    `SELECT name FROM "oauthClient" WHERE "clientId" = $1`,
    [clientId],
  );

  if (!row) {
    return null;
  }

  return row.name?.trim() || UNNAMED_ASSISTANT;
}

/**
 * The authorization request on the consent page's address, if the provider
 * signed it and it hasn't expired. Null otherwise, and when the client no
 * longer exists.
 */
export async function readConsentRequest(
  search: URLSearchParams,
  options: { database?: DbExecutor; secret: string },
): Promise<ConsentRequest | null> {
  const oauthQuery = signedOAuthQuery(search);

  if (
    !oauthQuery ||
    !(await verifyOAuthQueryParams(oauthQuery, options.secret))
  ) {
    return null;
  }

  const signed = new URLSearchParams(oauthQuery);
  const clientIds = signed.getAll("client_id");
  const redirectUris = signed.getAll("redirect_uri");

  if (clientIds.length !== 1 || redirectUris.length !== 1) {
    return null;
  }

  const [clientId] = clientIds as [string];
  let redirectHost: string;

  try {
    redirectHost = new URL(redirectUris[0] ?? "").host;
  } catch {
    return null;
  }

  const clientName = await readAssistantClientName(clientId, options.database);

  if (clientName === null || !redirectHost) {
    return null;
  }

  return { clientId, clientName, oauthQuery, redirectHost };
}
