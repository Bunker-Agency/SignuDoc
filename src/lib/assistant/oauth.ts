import {
  verifyOAuthQueryParams,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { APIError, type BetterAuthPlugin } from "better-auth";
import {
  type createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";

import { getDb, queryOne, withTransaction } from "../db/connection.ts";
import {
  getClientIpAddress,
  getRequestUserAgent,
} from "../security/request.ts";
import { requireConfigValue } from "../services/service-config.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import { readStoredSettings, type AppSettings } from "../settings.ts";
import { needsTwoFactorSetup } from "../sign-in-security.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";
import { recordAssistantConnection } from "./connections.ts";
import { readAssistantClientName, UNNAMED_ASSISTANT } from "./consent.ts";

// SignuDoc as an OAuth authorization server for AI assistants (MCP
// clients), through Better Auth's OAuth provider plugin. Everything here is
// shut while the administrator's "AI assistant connections" setting is off.

/** What an assistant may be allowed to do. Both are granted on consent. */
export const ASSISTANT_SCOPES = ["envelopes:read", "drafts:write"] as const;

export type AssistantScope = (typeof ASSISTANT_SCOPES)[number];

// offline_access is what gets the assistant a refresh token. The OpenID
// scopes (openid, profile, email) are left out: an assistant has no use for
// an ID token, and without openid the plugin serves plain OAuth metadata.
const GRANTABLE_SCOPES = [...ASSISTANT_SCOPES, "offline_access"];

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const ASSISTANT_CONNECTIONS_OFF =
  "AI assistant connections are turned off on this site.";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The redirect URIs a client may register: https anywhere, or http on this
 * machine (the loopback addresses a desktop or command-line assistant
 * listens on). Nothing else, so no custom schemes.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") {
    return parsed.hostname !== "";
  }

  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

// The OAuth endpoints an assistant needs to register, be authorized, get
// and refresh tokens, and give them back. Every other /oauth2/ path is
// blocked: managing clients and consents is done through SignuDoc's own
// pages, so that ending a connection always goes through SignuDoc.
const ALLOWED_OAUTH_PATHS = new Set([
  "/oauth2/register",
  "/oauth2/authorize",
  "/oauth2/token",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/public-client",
  "/oauth2/revoke",
  "/oauth2/introspect",
  "/oauth2/userinfo",
]);

// Paths outside /oauth2/ that are blocked too. The jwt plugin, which the
// OAuth provider signs its tokens with, also hands a session's JWT to
// anyone signed in at /token. Nothing in SignuDoc uses it.
const BLOCKED_OTHER_PATHS = new Set(["/token"]);

/**
 * Where an auth API path stands: `allowed` while the setting is on,
 * `blocked` always, or `not_oauth` (the rest of the auth API).
 */
export function classifyOAuthPath(
  path: string,
): "not_oauth" | "allowed" | "blocked" {
  if (BLOCKED_OTHER_PATHS.has(path)) {
    return "blocked";
  }

  if (path !== "/oauth2" && !path.startsWith("/oauth2/")) {
    return "not_oauth";
  }

  return ALLOWED_OAUTH_PATHS.has(path) ? "allowed" : "blocked";
}

/**
 * The OAuth discovery documents, wherever the auth handler may answer for
 * them: `/.well-known/…` at the root, with the issuer's path after it, or
 * under the issuer's path.
 */
export function isDiscoveryPath(pathname: string): boolean {
  return pathname.includes("/.well-known/");
}

/**
 * The address of SignuDoc's MCP endpoint, which is the audience of every
 * access token the provider issues. It must match the protected resource
 * metadata byte for byte, so it has no trailing slash.
 */
export function assistantResourceUrl(env: EnvSource = process.env): string {
  const appEnv = getEnv(env);
  const appUrl = requireConfigValue(
    "auth",
    "APP_URL",
    appEnv.appUrl ?? appEnv.auth.betterAuthUrl,
  );

  return `${appUrl.replace(/\/+$/, "")}/api/mcp`;
}

/** The OAuth provider plugin's options. */
export function buildOAuthProviderOptions(env: EnvSource = process.env) {
  return {
    // Assistants register themselves (RFC 7591), with no account and no
    // initial access token. Registration is limited per address below, and
    // a client is worth nothing until a sender approves it.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // A client that leaves out application_type is native when its redirect
    // URIs are loopback http (Claude Code, other desktop assistants), and
    // web otherwise.
    clientRegistrationDefaultApplicationType: "infer",
    // What a registered client may ever ask for. The plugin would otherwise
    // let every client ask for every scope it knows.
    clientRegistrationDefaultScopes: [...GRANTABLE_SCOPES],
    consentPage: "/oauth/consent",
    // There is one resource, so tokens for it do not need a per-client link.
    // Such links are made only at registration and would tie each client to
    // the exact APP_URL it registered under.
    enforcePerClientResources: false,
    // An assistant acts for the sender who approved it, never on its own,
    // so client_credentials is not offered.
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: "/login",
    // PKCE is not an option: the plugin requires it of public clients and
    // of any request for offline_access, which covers every assistant.
    rateLimit: { register: { max: 10, window: 3600 } },
    resources: [assistantResourceUrl(env)],
    scopes: [...GRANTABLE_SCOPES],
  } satisfies OAuthOptions<string[]>;
}

/**
 * The stored settings, read from the database each time rather than from
 * the settings cache: turning assistant connections off must hold at once
 * on every instance, not after the cache runs out. Null when they can't be
 * read, which counts as off.
 */
async function readGateSettings(): Promise<AppSettings | null> {
  try {
    return await readStoredSettings();
  } catch (error) {
    console.error("[assistant] Could not read the settings:", error);

    return null;
  }
}

/** Whether the setting is on, read as the gate reads it. */
export async function assistantConnectionsOn(): Promise<boolean> {
  return (await readGateSettings())?.assistantConnections ?? false;
}

// Where an assistant is given a code: authorizing (also run by the plugin
// inside sign-in, the second step and consent) and approving consent.
const CODE_PATHS = new Set(["/oauth2/authorize", "/oauth2/consent"]);

/**
 * Called first in the auth server's `hooks.before`, so it covers HTTP
 * requests, server calls and the authorize step the plugin runs inside
 * sign-in, the second step and consent.
 *
 * Because it covers server calls too, the blocked endpoints (get-client,
 * delete-consent and the rest) answer NOT_FOUND to SignuDoc's own code as
 * well. Server code reads and writes the provider's tables directly
 * ("oauthClient", "oauthConsent", ...) or uses /oauth2/public-client.
 */
export async function enforceAssistantOAuthGate(
  ctx: HookContext,
): Promise<void> {
  const path = ctx.path ?? "";
  const classification = classifyOAuthPath(path);

  if (classification === "not_oauth") {
    return;
  }

  if (classification === "blocked") {
    throw new APIError("NOT_FOUND");
  }

  const settings = await readGateSettings();

  if (!settings?.assistantConnections) {
    throw new APIError("FORBIDDEN", {
      code: "ASSISTANT_CONNECTIONS_OFF",
      message: ASSISTANT_CONNECTIONS_OFF,
    });
  }

  if (path === "/oauth2/register") {
    checkRegisteredRedirectUris(ctx.body);
  }

  if (CODE_PATHS.has(path)) {
    await checkSenderMayConnect(ctx, settings);
  }
}

/**
 * A sender who hasn't verified their email address, or who must set up
 * two-step sign-in before using SignuDoc, doesn't get as far as connecting
 * an assistant. Read from the user's row, not the session, whose cookie can
 * vouch for a few minutes on its own.
 */
async function checkSenderMayConnect(
  ctx: HookContext,
  settings: AppSettings,
): Promise<void> {
  const session = await getSessionFromCtx(ctx).catch(() => null);

  // Signed out: the provider sends them to sign in, and this runs again
  // when the sign-in picks the authorization up.
  if (!session) {
    return;
  }

  const user = await queryOne<{
    emailVerified: boolean;
    twoFactorEnabled: boolean | null;
  }>(
    getDb(),
    `SELECT "emailVerified", "twoFactorEnabled" FROM "user" WHERE id = $1`,
    [session.user.id],
  );

  if (!user) {
    return;
  }

  if (!user.emailVerified) {
    throw new APIError("FORBIDDEN", {
      code: "EMAIL_NOT_VERIFIED",
      message: "Verify your email address before you connect an AI assistant.",
    });
  }

  if (
    await needsTwoFactorSetup(settings, {
      id: session.user.id,
      twoFactorEnabled: user.twoFactorEnabled === true,
    })
  ) {
    throw new APIError("FORBIDDEN", {
      code: "TWO_STEP_SETUP_REQUIRED",
      message: "Set up two-step sign-in before you connect an AI assistant.",
    });
  }
}

function readBodyField(body: unknown, field: string): unknown {
  return typeof body === "object" && body !== null && field in body
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

/** The client redirect a reply carries, if it hands the client a code. */
function codeRedirect(returned: unknown): URL | null {
  const location = isAPIError(returned)
    ? new Headers(returned.headers).get("location")
    : readBodyField(returned, "url");

  if (typeof location !== "string") {
    return null;
  }

  try {
    const url = new URL(location);

    return url.searchParams.get("code") && !url.searchParams.has("error")
      ? url
      : null;
  } catch {
    // A path on this site (the sign-in or consent page), not the client.
    return null;
  }
}

/**
 * Called in the auth server's `hooks.after`. When a sender approves an
 * assistant on the consent page, records the connection and an
 * `assistant_connected` event. This is the one place a connection is
 * recorded.
 *
 * The plugin stores its own record of the approval, and would skip the
 * consent page next time while that record covers what the assistant asks
 * for. It is removed here, whatever the answer, so every authorization
 * comes back to the consent page and through here. Tokens don't depend on
 * it: the token endpoint never reads it.
 */
export async function recordAssistantConsent(ctx: HookContext): Promise<void> {
  if (ctx.path !== "/oauth2/consent") {
    return;
  }

  // The request as the provider signed it. ctx.query is empty here.
  const oauthQuery = readBodyField(ctx.body, "oauth_query");

  if (typeof oauthQuery !== "string") {
    return;
  }

  const clientId = new URLSearchParams(oauthQuery).get("client_id");
  const session = await getSessionFromCtx(ctx).catch(() => null);

  if (clientId && session) {
    await getDb().query(
      `DELETE FROM "oauthConsent" WHERE "clientId" = $1 AND "userId" = $2`,
      [clientId, session.user.id],
    );
  }

  // Deny answers with the client's address too, carrying an error.
  if (
    readBodyField(ctx.body, "accept") !== true ||
    !codeRedirect(ctx.context.returned)
  ) {
    return;
  }

  // A code is never handed out without its connection: throwing here
  // replaces the reply that carries it.
  if (
    !clientId ||
    !session ||
    !(await verifyOAuthQueryParams(oauthQuery, ctx.context.secret))
  ) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "The connection could not be recorded.",
    });
  }

  const clientName =
    (await readAssistantClientName(clientId)) ?? UNNAMED_ASSISTANT;
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();

  await withTransaction(async (tx) => {
    await recordAssistantConnection(
      { clientId, clientName, userId: session.user.id },
      tx,
    );
    await recordSystemAuditEvent(
      {
        actorEmail: session.user.email,
        actorUserId: session.user.id,
        event: "assistant_connected",
        ipAddress: getClientIpAddress(headers),
        metadata: { clientId, clientName },
        targetUserId: session.user.id,
        userAgent: getRequestUserAgent(headers),
      },
      tx,
    );
  });
}

// The plugin has no hook for checking redirect URIs at registration, and
// lets through private-use schemes such as com.example.app:/cb. A missing
// or malformed list is left to the plugin's own validation.
function checkRegisteredRedirectUris(body: unknown) {
  if (typeof body !== "object" || body === null || !("redirect_uris" in body)) {
    return;
  }

  const uris: unknown = body.redirect_uris;

  if (!Array.isArray(uris)) {
    return;
  }

  for (const uri of uris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      // RFC 7591's error shape.
      throw new APIError("BAD_REQUEST", {
        error: "invalid_redirect_uri",
        error_description:
          "Redirect URIs must use https, or http on localhost, 127.0.0.1 or [::1].",
      });
    }
  }
}

/**
 * The OAuth provider answers its discovery documents before Better Auth's
 * hooks run, so `hooks.before` never sees them. This plugin, placed before
 * the provider, answers 404 for them while the setting is off.
 */
export function assistantDiscoveryGate() {
  return {
    id: "assistant-discovery-gate",
    onRequest: async (request: Request) => {
      if (!isDiscoveryPath(new URL(request.url).pathname)) {
        return;
      }

      if (await assistantConnectionsOn()) {
        return;
      }

      return { response: new Response("Not Found", { status: 404 }) };
    },
  } satisfies BetterAuthPlugin;
}
