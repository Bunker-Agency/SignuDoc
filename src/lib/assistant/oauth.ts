import type { OAuthOptions } from "@better-auth/oauth-provider";
import { APIError, type BetterAuthPlugin } from "better-auth";

import { readStoredSettings } from "../settings.ts";
import { requireConfigValue } from "../services/service-config.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";

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
 * Whether the setting is on, read from the database each time rather than
 * from the settings cache: turning it off must hold at once on every
 * instance, not after the cache runs out. Anything that stops it being read
 * counts as off.
 */
export async function assistantConnectionsOn(): Promise<boolean> {
  try {
    return (await readStoredSettings())?.assistantConnections ?? false;
  } catch (error) {
    console.error("[assistant] Could not read the settings:", error);

    return false;
  }
}

/**
 * Called first in the auth server's `hooks.before`, so it covers HTTP
 * requests, server calls and the authorize step the plugin runs inside
 * sign-in and consent.
 */
export async function enforceAssistantOAuthGate(ctx: {
  body?: unknown;
  path?: string;
}): Promise<void> {
  const path = ctx.path ?? "";
  const classification = classifyOAuthPath(path);

  if (classification === "not_oauth") {
    return;
  }

  if (classification === "blocked") {
    throw new APIError("NOT_FOUND");
  }

  if (!(await assistantConnectionsOn())) {
    throw new APIError("FORBIDDEN", { message: ASSISTANT_CONNECTIONS_OFF });
  }

  if (path === "/oauth2/register") {
    checkRegisteredRedirectUris(ctx.body);
  }
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
