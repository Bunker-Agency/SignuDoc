import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, beforeEach, test } from "node:test";

import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import type pg from "pg";

import type { getAuth as GetAuth } from "../auth/server.ts";
import type { refuseDiscoveryWhileOff as RefuseDiscoveryWhileOff } from "./discovery.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import {
  getSettings,
  invalidateSettingsCache,
  saveSettings,
} from "../settings.ts";
import { buildOAuthProviderOptions, classifyOAuthPath } from "./oauth.ts";

// SignuDoc as an OAuth authorization server for AI assistants, against a
// real Postgres and the real auth handler: registration, what is reachable
// with the setting off and on, and the discovery documents. Run with
// `npm run test:db`.

const BASE_URL = "http://localhost:3998";
const RESOURCE = `${BASE_URL}/api/mcp`;
const PASSWORD = "a long enough passphrase";
const LOOPBACK_REDIRECT = "http://127.0.0.1:33418/callback";

const env = {
  APP_URL: BASE_URL,
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123",
  BETTER_AUTH_URL: BASE_URL,
  EMAIL_DRIVER: "capture",
  NODE_ENV: "test",
};

// The auth server is the app's own (getAuth), built from process.env, and
// the discovery routes import it with the app's "@/" paths. Plain Node
// needs both spelled out, and next/* with its file name.
Object.assign(process.env, env);

const SRC = new URL("../../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    if (specifier.startsWith("@/")) {
      const path = specifier.slice(2);

      return nextResolve(
        new URL(/\.[a-z]+$/.test(path) ? path : `${path}.ts`, SRC).href,
        context,
      );
    }

    return nextResolve(specifier, context);
  },
});

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let getAuth: typeof GetAuth;
let refuseDiscoveryWhileOff: typeof RefuseDiscoveryWhileOff;

type Cookies = Map<string, string>;

function cookieHeader(cookies: Cookies): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorbCookies(response: Response, cookies: Cookies) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;

    if (!pair || index < 0) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (value === "" || /max-age=0/i.test(line)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

type Reply = {
  headers: Headers;
  payload: Record<string, unknown> | null;
  status: number;
};

async function send(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookies?: Cookies;
    form?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: BASE_URL,
    "user-agent": "oauth dbtest",
    "x-forwarded-for": "203.0.113.9",
  };
  let body: string | undefined;

  if (options.cookies) {
    headers.cookie = cookieHeader(options.cookies);
  }

  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body ?? {});
  }

  const response = await getAuth().handler(
    new Request(`${BASE_URL}/api/auth${path}`, { body, headers, method }),
  );

  if (options.cookies) {
    absorbCookies(response, options.cookies);
  }

  const text = await response.text();
  let payload: Record<string, unknown> | null = null;

  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = null;
  }

  return { headers: response.headers, payload, status: response.status };
}

async function setAssistantConnections(enabled: boolean) {
  await saveSettings({ assistantConnections: enabled }, database);
  invalidateSettingsCache();
}

async function createSignedInSender(): Promise<Cookies> {
  const context = await getAuth().$context;
  const id = randomUUID();
  const email = `${id}@example.test`;

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat Sender', $2, true, 'user')`,
    [id, email],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(PASSWORD)],
  );

  const cookies: Cookies = new Map();
  const signedIn = await send("POST", "/sign-in/email", {
    body: { email, password: PASSWORD },
    cookies,
  });

  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.payload));

  return cookies;
}

const VALID_REGISTRATION = {
  client_name: "Test assistant",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [LOOPBACK_REDIRECT],
  response_types: ["code"],
  scope: "envelopes:read drafts:write offline_access",
  token_endpoint_auth_method: "none",
};

async function registerClient(): Promise<string> {
  const registered = await send("POST", "/oauth2/register", {
    body: VALID_REGISTRATION,
  });

  assert.equal(registered.status, 201, JSON.stringify(registered.payload));

  return String(registered.payload?.client_id);
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  return { challenge, verifier };
}

function authorizePath(
  clientId: string,
  extra: Record<string, string> = {},
): string {
  return `/oauth2/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    resource: RESOURCE,
    response_type: "code",
    scope: "envelopes:read drafts:write offline_access",
    state: "state-123",
    ...extra,
  }).toString()}`;
}

function redirectUrl(reply: Reply): string {
  const url = reply.payload?.url ?? reply.headers.get("location");

  assert.equal(
    typeof url,
    "string",
    `expected a redirect: ${String(reply.status)} ${JSON.stringify(reply.payload)}`,
  );

  return url as string;
}

type PluginEndpoint = { form: boolean; method: string; path: string };

// Every path and method the OAuth provider and the jwt plugin serve over
// HTTP, as the plugins themselves list them, and whether the endpoint takes
// only a form body (it refuses anything else before any hook runs).
function pluginEndpoints(): PluginEndpoint[] {
  const endpoints = {
    ...oauthProvider(buildOAuthProviderOptions(env)).endpoints,
    ...jwt({ disableSettingJwtHeader: true }).endpoints,
  };
  const list: PluginEndpoint[] = [];

  for (const endpoint of Object.values(endpoints)) {
    const { options, path } = endpoint as {
      options?: {
        metadata?: { allowedMediaTypes?: string[] };
        method?: string | string[];
      };
      path?: string;
    };

    if (!path) {
      continue;
    }

    const methods = options?.method ?? "GET";
    const mediaTypes = options?.metadata?.allowedMediaTypes ?? [];
    const form =
      mediaTypes.includes("application/x-www-form-urlencoded") &&
      !mediaTypes.includes("application/json");

    for (const method of Array.isArray(methods) ? methods : [methods]) {
      list.push({ form: form && method !== "GET", method, path });
    }
  }

  return list;
}

function concretePath(path: string): string {
  return path
    .replace(":identifier", encodeURIComponent(RESOURCE))
    .replace(":client_id", "some-client");
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);

  ({ getAuth } = await import("../auth/server.ts"));
  ({ refuseDiscoveryWhileOff } = await import("./discovery.ts"));
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  invalidateSettingsCache();
  // The provider adds its resource when it starts, once, and only logs a
  // failure. These tests do not depend on when that ran.
  await database.query(
    `insert into public."oauthResource" (id, identifier, name, "createdAt", "updatedAt")
       values ($1, $2, 'SignuDoc MCP', now(), now())
       on conflict (identifier) do nothing`,
    [randomUUID(), RESOURCE],
  );
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("registration is refused while assistant connections are off", async () => {
  const refused = await send("POST", "/oauth2/register", {
    body: VALID_REGISTRATION,
  });

  assert.equal(refused.status, 403);
  assert.equal(
    refused.payload?.message,
    "AI assistant connections are turned off on this site.",
  );
  assert.equal(
    (await database.query(`select 1 from "oauthClient"`)).rowCount,
    0,
  );
});

test("registration succeeds when on", async () => {
  await setAssistantConnections(true);

  const registered = await send("POST", "/oauth2/register", {
    body: VALID_REGISTRATION,
  });

  assert.equal(registered.status, 201, JSON.stringify(registered.payload));
  assert.equal(typeof registered.payload?.client_id, "string");
  // What the client may ever be granted: the assistant scopes and a
  // refresh token, never the OpenID ones.
  assert.deepEqual(String(registered.payload?.scope).split(" ").sort(), [
    "drafts:write",
    "envelopes:read",
    "offline_access",
  ]);

  // claude.ai's callback is a web client's https redirect.
  const web = await send("POST", "/oauth2/register", {
    body: {
      ...VALID_REGISTRATION,
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    },
  });

  assert.equal(web.status, 201, JSON.stringify(web.payload));
});

test("registration rejects a non-loopback http redirect URI", async () => {
  await setAssistantConnections(true);

  for (const uri of [
    "http://example.com/cb",
    "http://localhost.evil.com/cb",
    // The plugin itself would take this one.
    "com.example.app:/cb",
  ]) {
    const refused = await send("POST", "/oauth2/register", {
      body: { ...VALID_REGISTRATION, redirect_uris: [LOOPBACK_REDIRECT, uri] },
    });

    assert.equal(refused.status, 400, uri);
    assert.equal(refused.payload?.error, "invalid_redirect_uri", uri);
  }

  assert.equal(
    (await database.query(`select 1 from "oauthClient"`)).rowCount,
    0,
  );
});

test("client and consent management endpoints are not reachable", async () => {
  await setAssistantConnections(true);

  const cookies = await createSignedInSender();
  const clientId = await registerClient();

  // The four the plan names, with real arguments.
  for (const [method, path, body] of [
    [
      "POST",
      "/oauth2/create-client",
      { redirect_uris: ["https://evil.example/cb"] },
    ],
    ["POST", "/oauth2/update-client", { client_id: clientId, update: {} }],
    ["POST", "/oauth2/delete-consent", { id: "x" }],
    ["GET", "/oauth2/get-clients", undefined],
  ] as const) {
    const reply = await send(method, path, { body, cookies });

    assert.equal(reply.status, 404, `${method} ${path}`);
  }

  // And every other blocked path and method the plugins serve, on and off.
  const blocked = pluginEndpoints().filter(
    ({ path }) => classifyOAuthPath(path) === "blocked",
  );

  assert.ok(blocked.length >= 15);

  for (const enabled of [true, false]) {
    await setAssistantConnections(enabled);

    for (const { form, method, path } of blocked) {
      const fields = { client_id: clientId, id: "x" };
      const reply = await send(method, `${path}?client_id=${clientId}&id=x`, {
        body: form ? undefined : fields,
        cookies,
        form: form ? fields : undefined,
      });

      assert.equal(reply.status, 404, `${method} ${path} (on: ${enabled})`);
    }
  }

  assert.equal(
    (await database.query(`select 1 from "oauthClient"`)).rowCount,
    1,
  );
});

test("the server-only admin endpoints are not reachable over HTTP", async () => {
  await setAssistantConnections(true);

  const cookies = await createSignedInSender();

  for (const { method, path } of pluginEndpoints().filter(({ path }) =>
    path.startsWith("/admin/oauth2/"),
  )) {
    const reply = await send(method, concretePath(path), {
      body: { redirect_uris: ["https://evil.example/cb"] },
      cookies,
    });

    assert.equal(reply.status, 404, `${method} ${path}`);
  }
});

test("every allowed OAuth endpoint refuses while assistant connections are off", async () => {
  const cookies = await createSignedInSender();
  const allowed = pluginEndpoints().filter(
    ({ path }) => classifyOAuthPath(path) === "allowed",
  );

  assert.equal(new Set(allowed.map(({ path }) => path)).size, 9);

  for (const { form, method, path } of allowed) {
    const fields = {
      client_id: "x",
      grant_type: "authorization_code",
      token: "x",
    };
    const reply = await send(method, `${path}?client_id=x`, {
      body: form ? undefined : { accept: true, client_id: "x" },
      cookies,
      form: form ? fields : undefined,
    });

    assert.equal(reply.status, 403, `${method} ${path}`);
  }
});

test("the jwt plugin's session token is not handed out", async () => {
  await setAssistantConnections(true);

  const cookies = await createSignedInSender();
  const session = await send("GET", "/get-session", { cookies });

  assert.equal(session.status, 200);
  assert.ok(session.payload?.user, "the session is recognised");
  assert.equal(session.headers.get("set-auth-jwt"), null);
  assert.equal((await send("GET", "/token", { cookies })).status, 404);
  // The public keys stay where clients and resource servers find them.
  assert.equal((await send("GET", "/jwks")).status, 200);
});

test("the discovery document is 404 while off", async () => {
  const root =
    await import("../../app/.well-known/oauth-authorization-server/route.ts");
  const withIssuerPath =
    await import("../../app/.well-known/oauth-authorization-server/api/auth/route.ts");

  assert.equal(
    (
      await withIssuerPath.GET(
        new Request(
          `${BASE_URL}/.well-known/oauth-authorization-server/api/auth`,
        ),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await root.GET(
        new Request(`${BASE_URL}/.well-known/oauth-authorization-server`),
      )
    ).status,
    404,
  );

  // The auth handler itself, for the catch-all route and anything else
  // that reaches it, at every address the provider answers.
  for (const path of [
    "/api/auth/.well-known/oauth-authorization-server",
    "/api/auth/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server/api/auth",
  ]) {
    const response = await getAuth().handler(new Request(`${BASE_URL}${path}`));

    assert.equal(response.status, 404, path);
  }
});

test("the auth route's own discovery check", async () => {
  const discovery = new Request(
    `${BASE_URL}/api/auth/.well-known/oauth-authorization-server`,
  );
  const other = new Request(`${BASE_URL}/api/auth/get-session`);

  assert.equal((await refuseDiscoveryWhileOff(discovery))?.status, 404);
  assert.equal(await refuseDiscoveryWhileOff(other), null);

  await setAssistantConnections(true);

  assert.equal(await refuseDiscoveryWhileOff(discovery), null);
  assert.equal(await refuseDiscoveryWhileOff(other), null);
});

test("turning the setting off takes effect at once, even where the settings are cached", async () => {
  await setAssistantConnections(true);
  await registerClient();

  // This instance has the setting cached as on. Another instance turns it
  // off, which does not clear this instance's cache.
  assert.equal((await getSettings()).assistantConnections, true);
  await database.query(
    `update public.app_settings set assistant_connections = false where id`,
  );
  assert.equal((await getSettings()).assistantConnections, true);

  const refused = await send("POST", "/oauth2/register", {
    body: VALID_REGISTRATION,
  });

  assert.equal(refused.status, 403);
  assert.equal(
    (
      await getAuth().handler(
        new Request(
          `${BASE_URL}/api/auth/.well-known/oauth-authorization-server`,
        ),
      )
    ).status,
    404,
  );
});

test("the discovery document describes the provider when on", async () => {
  await setAssistantConnections(true);

  const root =
    await import("../../app/.well-known/oauth-authorization-server/route.ts");
  const withIssuerPath =
    await import("../../app/.well-known/oauth-authorization-server/api/auth/route.ts");
  const responses = [
    await withIssuerPath.GET(
      new Request(
        `${BASE_URL}/.well-known/oauth-authorization-server/api/auth`,
      ),
    ),
    await root.GET(
      new Request(`${BASE_URL}/.well-known/oauth-authorization-server`),
    ),
    await getAuth().handler(
      new Request(
        `${BASE_URL}/api/auth/.well-known/oauth-authorization-server`,
      ),
    ),
  ];

  for (const response of responses) {
    assert.equal(response.status, 200);

    const metadata = (await response.json()) as Record<string, unknown>;

    assert.equal(metadata.issuer, `${BASE_URL}/api/auth`);
    assert.equal(
      metadata.registration_endpoint,
      `${BASE_URL}/api/auth/oauth2/register`,
    );
    assert.equal(
      metadata.authorization_endpoint,
      `${BASE_URL}/api/auth/oauth2/authorize`,
    );
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.scopes_supported, [
      "envelopes:read",
      "drafts:write",
      "offline_access",
    ]);
  }

  // Not an OpenID provider, so there is no OpenID configuration.
  assert.equal(
    (
      await getAuth().handler(
        new Request(`${BASE_URL}/api/auth/.well-known/openid-configuration`),
      )
    ).status,
    404,
  );
});

test("a public client's authorization without a PKCE challenge is refused", async () => {
  await setAssistantConnections(true);

  const cookies = await createSignedInSender();
  const clientId = await registerClient();
  // Without offline_access, so it is the public-client rule that applies.
  const reply = await send(
    "GET",
    authorizePath(clientId, { scope: "envelopes:read" }),
    { cookies },
  );
  const url = new URL(redirectUrl(reply), BASE_URL);

  assert.equal(`${url.origin}${url.pathname}`, LOOPBACK_REDIRECT);
  assert.equal(url.searchParams.get("error"), "invalid_request");
  assert.equal(url.searchParams.get("code"), null);
});

test("an assistant is authorized end to end without the OpenID scopes", async () => {
  await setAssistantConnections(true);

  const cookies = await createSignedInSender();
  const clientId = await registerClient();
  const { challenge, verifier } = pkce();
  const authorized = await send(
    "GET",
    authorizePath(clientId, {
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
    { cookies },
  );
  const consentUrl = new URL(redirectUrl(authorized), BASE_URL);

  assert.equal(consentUrl.pathname, "/oauth/consent");

  const consented = await send("POST", "/oauth2/consent", {
    body: { accept: true, oauth_query: consentUrl.search.slice(1) },
    cookies,
  });
  const callback = new URL(redirectUrl(consented));
  const code = callback.searchParams.get("code");

  assert.equal(`${callback.origin}${callback.pathname}`, LOOPBACK_REDIRECT);
  assert.ok(code, callback.href);

  const token = await send("POST", "/oauth2/token", {
    form: {
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: LOOPBACK_REDIRECT,
      resource: RESOURCE,
    },
  });

  assert.equal(token.status, 200, JSON.stringify(token.payload));
  assert.equal(typeof token.payload?.refresh_token, "string");

  const [, payload] = String(token.payload?.access_token).split(".");
  const claims = JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  assert.equal(claims.aud, RESOURCE);
  assert.equal(claims.iss, `${BASE_URL}/api/auth`);
  assert.equal(claims.azp, clientId);
  assert.equal(claims.scope, "envelopes:read drafts:write offline_access");
});

test("a sign-in that resumes an authorization started before the setting went off gets no code", async () => {
  await setAssistantConnections(true);

  const clientId = await registerClient();
  const { challenge } = pkce();
  const started = await send(
    "GET",
    authorizePath(clientId, {
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  );
  const loginUrl = new URL(redirectUrl(started), BASE_URL);

  assert.equal(loginUrl.pathname, "/login");

  // The sender's account exists, but they have not signed in yet.
  const signedIn = await createSignedInSender();
  const email = (
    await database.query<{ email: string }>(
      `select email from "user" order by "createdAt" desc limit 1`,
    )
  ).rows[0]?.email;

  signedIn.clear();
  await setAssistantConnections(false);

  const resumed = await send("POST", "/sign-in/email", {
    body: {
      email,
      oauth_query: loginUrl.search.slice(1),
      password: PASSWORD,
    },
    cookies: signedIn,
  });
  const body = JSON.stringify(resumed.payload);

  assert.equal(resumed.status, 403, body);
  assert.doesNotMatch(body, /code=|\/oauth\/consent/);
  assert.equal(
    (await database.query(`select 1 from "oauthConsent"`)).rowCount,
    0,
  );
});
