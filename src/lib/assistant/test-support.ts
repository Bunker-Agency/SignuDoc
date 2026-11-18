import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import type { getAuth as GetAuth } from "../auth/server.ts";
import {
  ASSISTANT_SCOPES,
  assistantResourceUrl,
  type AssistantScope,
} from "./oauth.ts";
import { registerAppModuleResolution } from "./test-module-resolution.ts";

// For DB tests of assistant connections: real tokens from the real auth
// server, got the way an assistant gets them. It registers a client,
// authorizes it as a signed-in sender, approves the consent page and
// exchanges the code with PKCE, all through getAuth().handler.
//
// Only for tests. Call prepareAssistantTestEnvironment() at the top of the
// test file, before anything loads the auth server, and turn the setting on
// before asking for a token.

export const ASSISTANT_TEST_BASE_URL = "http://localhost:3998";
export const ASSISTANT_TEST_REDIRECT_URI = "http://127.0.0.1:33418/callback";
export const ASSISTANT_TEST_PASSWORD = "a long enough passphrase";

export const ASSISTANT_TEST_ENV = {
  APP_URL: ASSISTANT_TEST_BASE_URL,
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123",
  BETTER_AUTH_URL: ASSISTANT_TEST_BASE_URL,
  EMAIL_DRIVER: "capture",
  NODE_ENV: "test",
};

/**
 * The auth server (getAuth) is built from process.env, once, and is loaded
 * with the app's "@/" and next/* imports. Sets up both.
 */
export function prepareAssistantTestEnvironment(): void {
  Object.assign(process.env, ASSISTANT_TEST_ENV);
  registerAppModuleResolution();
}

async function loadAuth(): Promise<typeof GetAuth> {
  registerAppModuleResolution();

  return (await import("../auth/server.ts")).getAuth;
}

export type AuthReply = {
  headers: Headers;
  payload: Record<string, unknown> | null;
  status: number;
};

/**
 * One request to the auth API, as a browser's fetch would make it: JSON
 * back, so redirects come as `{ redirect, url }`.
 */
export async function callAuth(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    form?: Record<string, string>;
  } = {},
): Promise<AuthReply> {
  const getAuth = await loadAuth();
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: ASSISTANT_TEST_BASE_URL,
    "user-agent": "assistant test",
    "x-forwarded-for": "203.0.113.9",
  };
  let body: string | undefined;

  if (options.cookie) {
    headers.cookie = options.cookie;
  }

  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body ?? {});
  }

  const response = await getAuth().handler(
    new Request(`${ASSISTANT_TEST_BASE_URL}/api/auth${path}`, {
      body,
      headers,
      method,
    }),
  );
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;

  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  return { headers: response.headers, payload, status: response.status };
}

/** Where a reply sends the browser, or null when it doesn't. */
export function replyRedirect(reply: AuthReply): URL | null {
  const url = reply.payload?.url ?? reply.headers.get("location");

  return typeof url === "string" ? new URL(url, ASSISTANT_TEST_BASE_URL) : null;
}

function describe(reply: AuthReply): string {
  return `${String(reply.status)} ${JSON.stringify(reply.payload)}`;
}

/**
 * The provider adds its resource when it starts, once, and only logs a
 * failure, so a test that empties the table or starts before the migration
 * would find it missing.
 */
let staleKeysCleared = false;

export async function seedAssistantResource(database: pg.Pool): Promise<void> {
  // The signing keys are encrypted with the secret in use. A key left by
  // another run (the end-to-end test shares this database and uses its own
  // secret) can't be read, so it is cleared once, before this process makes
  // its own.
  if (!staleKeysCleared) {
    staleKeysCleared = true;
    await database.query(`delete from public."jwks"`);
  }

  await database.query(
    `insert into public."oauthResource" (id, identifier, name, "createdAt", "updatedAt")
       values ($1, $2, 'SignuDoc MCP', now(), now())
       on conflict (identifier) do nothing`,
    [randomUUID(), assistantResourceUrl(process.env)],
  );
}

/** A sender with a password, verified unless told otherwise. */
export async function createAssistantTestUser(
  database: pg.Pool,
  options: { emailVerified?: boolean; name?: string } = {},
): Promise<{ email: string; id: string }> {
  const context = await (await loadAuth())().$context;
  const id = randomUUID();
  const email = `${id}@example.test`;

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, $2, $3, $4, 'user')`,
    [id, options.name ?? "Pat Sender", email, options.emailVerified ?? true],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(ASSISTANT_TEST_PASSWORD)],
  );

  return { email, id };
}

/**
 * A session for the user, made directly rather than by signing in, and the
 * Cookie header that carries it.
 */
export async function createSignedInCookie(
  database: pg.Pool,
  userId: string,
): Promise<string> {
  const found = await database.query(`select 1 from "user" where id = $1`, [
    userId,
  ]);

  if (found.rowCount === 0) {
    throw new Error(`createSignedInCookie: no user ${userId}`);
  }

  const context = await (await loadAuth())().$context;
  const session = await context.internalAdapter.createSession(userId);
  // Better Auth signs its session cookie as `<token>.<HMAC-SHA256>`.
  const signature = createHmac("sha256", context.secret)
    .update(session.token)
    .digest("base64");

  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(
    `${session.token}.${signature}`,
  )}`;
}

/** Registers a public client the way Claude Code would (RFC 7591). */
export async function registerAssistantClient(
  clientName = "Test assistant",
): Promise<string> {
  const registered = await callAuth("POST", "/oauth2/register", {
    body: {
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [ASSISTANT_TEST_REDIRECT_URI],
      response_types: ["code"],
      scope: "envelopes:read drafts:write offline_access",
      token_endpoint_auth_method: "none",
    },
  });

  if (registered.status !== 201) {
    throw new Error(`registration failed: ${describe(registered)}`);
  }

  return String(registered.payload?.client_id);
}

export function createPkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  return { challenge, verifier };
}

/** The authorization request an assistant sends the sender's browser to. */
export function assistantAuthorizePath(
  clientId: string,
  options: {
    challenge: string;
    extra?: Record<string, string>;
    offlineAccess?: boolean;
    scopes?: readonly AssistantScope[];
  },
): string {
  const scopes: string[] = [...(options.scopes ?? ASSISTANT_SCOPES)];

  if (options.offlineAccess ?? true) {
    scopes.push("offline_access");
  }

  return `/oauth2/authorize?${new URLSearchParams({
    client_id: clientId,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    redirect_uri: ASSISTANT_TEST_REDIRECT_URI,
    resource: assistantResourceUrl(process.env),
    response_type: "code",
    scope: scopes.join(" "),
    state: "state-123",
    ...options.extra,
  }).toString()}`;
}

/** Approves (or denies) the consent page the provider sent the sender to. */
export async function answerConsent(
  cookie: string,
  consentUrl: URL,
  accept: boolean,
): Promise<AuthReply> {
  return callAuth("POST", "/oauth2/consent", {
    body: { accept, oauth_query: consentUrl.search.slice(1) },
    cookie,
  });
}

export type AssistantTokens = {
  accessToken: string;
  refreshToken: string;
};

function readTokens(reply: AuthReply): AssistantTokens {
  const accessToken = reply.payload?.access_token;
  const refreshToken = reply.payload?.refresh_token;

  if (
    reply.status !== 200 ||
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string"
  ) {
    throw new Error(`token request failed: ${describe(reply)}`);
  }

  return { accessToken, refreshToken };
}

/** A refresh, the way an assistant renews its access token. */
export async function refreshAssistantToken(
  clientId: string,
  refreshToken: string,
): Promise<AssistantTokens> {
  return readTokens(
    await callAuth("POST", "/oauth2/token", {
      form: {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
    }),
  );
}

/**
 * The whole connection for a client that is already registered: authorize
 * as the user, approve the consent page, exchange the code.
 */
export async function connectAssistant(
  database: pg.Pool,
  input: { clientId: string; scopes?: AssistantScope[]; userId: string },
): Promise<AssistantTokens> {
  await seedAssistantResource(database);

  const cookie = await createSignedInCookie(database, input.userId);
  const { challenge, verifier } = createPkce();
  const authorized = await callAuth(
    "GET",
    assistantAuthorizePath(input.clientId, {
      challenge,
      scopes: input.scopes,
    }),
    { cookie },
  );
  const consentUrl = replyRedirect(authorized);

  if (consentUrl?.pathname !== "/oauth/consent") {
    throw new Error(
      `authorize did not ask for consent: ${describe(authorized)}`,
    );
  }

  const approved = await answerConsent(cookie, consentUrl, true);
  const callback = replyRedirect(approved);
  const code = callback?.searchParams.get("code");

  if (!code) {
    throw new Error(`consent did not return a code: ${describe(approved)}`);
  }

  return readTokens(
    await callAuth("POST", "/oauth2/token", {
      form: {
        client_id: input.clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: ASSISTANT_TEST_REDIRECT_URI,
        resource: assistantResourceUrl(process.env),
      },
    }),
  );
}

/**
 * Registers a new client and connects it to the user, as an assistant
 * would. Assistant connections must be turned on.
 */
export async function issueAssistantToken(
  database: pg.Pool,
  input: {
    clientName?: string;
    scopes?: AssistantScope[];
    userId: string;
  },
): Promise<{
  accessToken: string;
  clientId: string;
  clientName: string;
  refreshToken: string;
}> {
  const clientName = input.clientName ?? "Test assistant";
  const clientId = await registerAssistantClient(clientName);
  const tokens = await connectAssistant(database, {
    clientId,
    scopes: input.scopes,
    userId: input.userId,
  });

  return { ...tokens, clientId, clientName };
}
