import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { isAPIError } from "better-auth/api";

import { getAuth } from "../auth/server.ts";
import { getDb, queryOne } from "../db/connection.ts";
import { logSecurityEvent } from "../security/logging.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";
import { needsTwoFactorSetup } from "../sign-in-security.ts";
import {
  checkConnection,
  endAssistantConnection,
  touchAssistantConnection,
} from "./connections.ts";
import {
  ASSISTANT_SCOPES,
  assistantResourceUrl,
  type AssistantScope,
  readAssistantSettings,
} from "./oauth.ts";

// The guard every MCP request goes through. An access token is a JWT the
// provider signed, and cannot be recalled once issued, so a valid
// signature is not enough: the sender's connection (connections.ts) must
// still exist and be within the install's session limits, the sender must
// still be allowed to use SignuDoc, and the setting must still be on. All
// of it is read from the database on every request, never from a cache.

export type AssistantContext = {
  clientId: string;
  clientName: string;
  scopes: AssistantScope[];
  userEmail: string;
  userId: string;
  userName: string;
};

/** Why a request was refused, as logged. Never the token itself. */
type RefusalReason =
  | "connection_gone"
  | "email_not_verified"
  | "error"
  | "idle"
  | "invalid_token"
  | "missing_token"
  | "setting_off"
  | "too_old"
  | "two_step_setup_required"
  | "user_gone";

function createVerifier(auth: ReturnType<typeof getAuth>) {
  return oauthProviderResourceClient(auth).getActions()
    .verifyAccessTokenRequest;
}

let resourceClient: {
  auth: ReturnType<typeof getAuth>;
  verify: ReturnType<typeof createVerifier>;
} | null = null;

/** Verifies tokens in-process, with the auth server's own keys. */
function verifier() {
  const auth = getAuth();

  if (resourceClient?.auth !== auth) {
    resourceClient = { auth, verify: createVerifier(auth) };
  }

  return resourceClient.verify;
}

/**
 * Where an MCP client finds out how to get a token (RFC 9728), as the
 * provider's own challenge names it: the resource's path after
 * `/.well-known/oauth-protected-resource`.
 */
function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);

  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, "")}`;
}

function logRefusal(
  request: Request,
  reason: RefusalReason,
  details: { clientId?: string; userId?: string } = {},
): void {
  logSecurityEvent(reason === "error" ? "error" : "warn", {
    category: "assistant_token_refused",
    ipAddress: getClientIpAddress(request.headers),
    message: "Refused an AI assistant's request.",
    metadata: {
      ...(details.clientId ? { clientId: details.clientId } : {}),
      reason,
    },
    path: getRequestPathname(request),
    userId: details.userId ?? null,
  });
}

/**
 * A 401 for a token that verified but no longer stands for a connection.
 * Its challenge has the same form as the provider's, so the assistant
 * starts connecting again.
 */
function invalidToken(resource: string, description: string): Response {
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      headers: {
        "Access-Control-Expose-Headers": "WWW-Authenticate",
        "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${protectedResourceMetadataUrl(resource)}"`,
      },
      status: 401,
    },
  );
}

/** A 403: connecting again would not help. */
function forbidden(description: string): Response {
  return Response.json(
    { error: "access_denied", error_description: description },
    { status: 403 },
  );
}

/** The provider's own refusal (missing or invalid token), as it made it. */
function providerRefusal(error: {
  body?: unknown;
  headers?: HeadersInit;
  statusCode: number;
}): Response {
  return Response.json(error.body ?? { error: "invalid_token" }, {
    headers: error.headers,
    status: error.statusCode,
  });
}

/**
 * The sender and assistant an MCP request acts for, or the response that
 * refuses it. Every refusal returns before anything else is done for the
 * request, and is logged.
 */
export async function requireAssistantContext(
  request: Request,
): Promise<AssistantContext | Response> {
  try {
    return await checkAssistantRequest(request);
  } catch (error) {
    // Anything unexpected refuses the request; it never lets it through.
    logRefusal(request, "error");
    console.error(
      "[assistant] Could not check an assistant's request:",
      error instanceof Error ? error.message : "unknown",
    );

    return Response.json({ error: "server_error" }, { status: 500 });
  }
}

async function checkAssistantRequest(
  request: Request,
): Promise<AssistantContext | Response> {
  // 1. The setting, read uncached: turning it off holds at once everywhere.
  const settings = await readAssistantSettings();

  if (!settings?.assistantConnections) {
    logRefusal(request, "setting_off");

    return forbidden("AI assistant connections are turned off on this site.");
  }

  // 2. The token: signed by this server, for this resource, not expired.
  const resource = assistantResourceUrl(process.env);
  let payload: Awaited<ReturnType<ReturnType<typeof verifier>>>;

  try {
    payload = await verifier()(request, {
      verifyOptions: { audience: resource },
    });
  } catch (error) {
    if (isAPIError(error)) {
      logRefusal(
        request,
        request.headers.has("authorization")
          ? "invalid_token"
          : "missing_token",
      );

      return providerRefusal(error);
    }

    throw error;
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const clientId =
    typeof payload.azp === "string"
      ? payload.azp
      : typeof payload.client_id === "string"
        ? payload.client_id
        : null;

  if (!userId || !clientId) {
    logRefusal(request, "invalid_token");

    return invalidToken(resource, "The access token names no user or client.");
  }

  // 3. The sender: still there, and their address still verified.
  const user = await queryOne<{
    email: string;
    emailVerified: boolean;
    name: string;
    twoFactorEnabled: boolean | null;
  }>(
    getDb(),
    `SELECT email, name, "emailVerified", "twoFactorEnabled" FROM "user" WHERE id = $1`,
    [userId],
  );

  if (!user) {
    logRefusal(request, "user_gone", { clientId, userId });

    return invalidToken(resource, "The account is gone.");
  }

  if (!user.emailVerified) {
    logRefusal(request, "email_not_verified", { clientId, userId });

    return invalidToken(
      resource,
      "The account's email address is not verified.",
    );
  }

  // 4. Nothing to do in SignuDoc until two-step sign-in is set up.
  if (
    await needsTwoFactorSetup(settings, {
      id: userId,
      twoFactorEnabled: user.twoFactorEnabled === true,
    })
  ) {
    logRefusal(request, "two_step_setup_required", { clientId, userId });

    return forbidden("Set up two-step sign-in before using an AI assistant.");
  }

  // 5. The connection: still there, and within the install's limits.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const connection = await queryOne<{
    approvedAt: number;
    clientName: string;
    lastUsedAt: number | null;
  }>(
    getDb(),
    `SELECT approved_at AS "approvedAt",
            last_used_at AS "lastUsedAt",
            client_name AS "clientName"
       FROM assistant_connections
      WHERE user_id = $1 AND client_id = $2`,
    [userId, clientId],
  );
  const check = checkConnection(connection, settings, nowSeconds);

  if (!connection || !check.ok) {
    const reason = check.ok ? "connection_gone" : check.reason;

    if (reason === "idle" || reason === "too_old") {
      await endAssistantConnection({ clientId, reason: "limits", userId });
    }

    logRefusal(request, reason === "gone" ? "connection_gone" : reason, {
      clientId,
      userId,
    });

    return invalidToken(resource, "The connection has ended.");
  }

  // 6. Its use, written down at most once a minute.
  if (check.touch) {
    await touchAssistantConnection(userId, clientId, nowSeconds);
  }

  const granted = new Set(
    typeof payload.scope === "string" ? payload.scope.split(" ") : [],
  );

  return {
    clientId,
    clientName: connection.clientName,
    scopes: ASSISTANT_SCOPES.filter((scope) => granted.has(scope)),
    userEmail: user.email,
    userId,
    userName: user.name,
  };
}
