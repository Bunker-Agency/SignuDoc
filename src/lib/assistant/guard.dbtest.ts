import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";

import type pg from "pg";

import type { getAuth as GetAuth } from "../auth/server.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { runRetentionSweep } from "../retention.ts";
import { createStorageService } from "../services/storage.ts";
import { listSystemAuditEvents } from "../services/system-audit.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import { resetTwoFactor } from "../sign-in-security.ts";
import type {
  endAllAssistantConnections as EndAll,
  endAssistantConnection as EndOne,
  listAssistantConnections as List,
} from "./connections.ts";
import type { requireAssistantContext as RequireContext } from "./guard.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  ASSISTANT_TEST_PASSWORD,
  callAuth,
  createAssistantTestUser,
  createSignedInCookie,
  issueAssistantToken,
  prepareAssistantTestEnvironment,
  seedAssistantResource,
} from "./test-support.ts";

// The guard every MCP request goes through, and the ways a connection
// ends, against a real Postgres and real tokens from the real auth server.
// Run with `npm run test:db`.

prepareAssistantTestEnvironment();

const RESOURCE_METADATA = `${ASSISTANT_TEST_BASE_URL}/.well-known/oauth-protected-resource/api/mcp`;

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let getAuth: typeof GetAuth;
let requireAssistantContext: typeof RequireContext;
let endAssistantConnection: typeof EndOne;
let endAllAssistantConnections: typeof EndAll;
let listAssistantConnections: typeof List;

async function setSettings(values: {
  assistantConnections?: boolean;
  requireTwoFactor?: boolean;
  sessionIdleMinutes?: number | null;
  sessionMaxHours?: number | null;
}) {
  await saveSettings(values, database);
  invalidateSettingsCache();
}

function mcpRequest(accessToken?: string): Request {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };

  if (accessToken !== undefined) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  return new Request(`${ASSISTANT_TEST_BASE_URL}/api/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
    headers,
    method: "POST",
  });
}

async function refused(accessToken?: string): Promise<Response> {
  const result = await requireAssistantContext(mcpRequest(accessToken));

  assert.ok(
    result instanceof Response,
    `expected a refusal, got ${JSON.stringify(result)}`,
  );

  return result;
}

async function connectionRows(userId: string) {
  return (
    await database.query<{
      approved_at: string;
      client_id: string;
      last_used_at: string | null;
    }>(
      `select client_id, approved_at, last_used_at
         from assistant_connections where user_id = $1`,
      [userId],
    )
  ).rows;
}

async function pluginRows(userId: string) {
  const count = async (table: string) =>
    Number(
      (
        await database.query<{ total: string }>(
          `select count(*)::text as total from public."${table}" where "userId" = $1`,
          [userId],
        )
      ).rows[0]?.total,
    );

  return {
    access: await count("oauthAccessToken"),
    consent: await count("oauthConsent"),
    refresh: await count("oauthRefreshToken"),
  };
}

async function disconnections() {
  return (await listSystemAuditEvents({}, database)).filter(
    ({ event }) => event === "assistant_disconnected",
  );
}

/** The refresh grant, answered as it is (refreshAssistantToken throws). */
async function refreshGrant(clientId: string, refreshToken: string) {
  return callAuth("POST", "/oauth2/token", {
    form: {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });
}

/** Asserts the connection is over: the guard, the refresh and the rows. */
async function assertEnded(
  userId: string,
  issued: { accessToken: string; clientId: string; refreshToken: string },
) {
  assert.equal((await refused(issued.accessToken)).status, 401);
  assert.equal((await connectionRows(userId)).length, 0);
  assert.deepEqual(await pluginRows(userId), {
    access: 0,
    consent: 0,
    refresh: 0,
  });

  const refreshed = await refreshGrant(issued.clientId, issued.refreshToken);

  assert.notEqual(refreshed.status, 200, JSON.stringify(refreshed.payload));
  assert.equal(refreshed.payload?.access_token, undefined);
}

/**
 * Leaves an opaque access token and a consent in the plugin's tables, as
 * a client that asked for no resource would have, to show they go too.
 */
async function addPluginLeftovers(userId: string, clientId: string) {
  await database.query(
    `insert into "oauthAccessToken" (id, token, "clientId", "userId", "expiresAt", "createdAt", scopes)
       values ($1, $2, $3, $4, now() + interval '1 hour', now(), '["envelopes:read"]')`,
    [randomUUID(), randomBytes(16).toString("hex"), clientId, userId],
  );
  await database.query(
    `insert into "oauthConsent" (id, "clientId", "userId", scopes, "createdAt", "updatedAt")
       values ($1, $2, $3, '["envelopes:read"]', now(), now())`,
    [randomUUID(), clientId, userId],
  );
}

async function createAdmin() {
  const id = randomUUID();
  const email = `${id}@example.test`;

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role, "twoFactorEnabled")
       values ($1, 'Ada Admin', $2, true, 'admin', true)`,
    [id, email],
  );

  return { email, userId: id };
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  ({ getAuth } = await import("../auth/server.ts"));
  ({ requireAssistantContext } = await import("./guard.ts"));
  ({
    endAllAssistantConnections,
    endAssistantConnection,
    listAssistantConnections,
  } = await import("./connections.ts"));
});

async function clean() {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.system_audit_events");
  invalidateSettingsCache();
}

beforeEach(async () => {
  await clean();
  await seedAssistantResource(database);
});

after(async () => {
  await clean();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("accepts a valid token and returns the user and client", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database, { name: "Pat Sender" });
  const issued = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });
  const context = await requireAssistantContext(mcpRequest(issued.accessToken));

  assert.deepEqual(context, {
    clientId: issued.clientId,
    clientName: "Claude Code",
    scopes: ["envelopes:read", "drafts:write"],
    userEmail: user.email,
    userId: user.id,
    userName: "Pat Sender",
  });

  // Only the scopes the sender granted.
  const narrow = await issueAssistantToken(database, {
    scopes: ["envelopes:read"],
    userId: user.id,
  });
  const narrowContext = await requireAssistantContext(
    mcpRequest(narrow.accessToken),
  );

  assert.ok(!(narrowContext instanceof Response));
  assert.deepEqual(narrowContext.scopes, ["envelopes:read"]);
});

test("a connection's use is written down once a minute, and listed", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });
  const approvedAt = Math.floor(Date.now() / 1000) - 120;

  await database.query(
    `update assistant_connections set approved_at = $2 where user_id = $1`,
    [user.id, approvedAt],
  );

  const before = Math.floor(Date.now() / 1000);

  assert.ok(
    !(
      (await requireAssistantContext(mcpRequest(issued.accessToken))) instanceof
      Response
    ),
  );

  const listed = await listAssistantConnections(user.id, database);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.clientId, issued.clientId);
  assert.equal(listed[0]?.clientName, "Claude Code");
  assert.equal(listed[0]?.approvedAt, approvedAt);
  assert.ok((listed[0]?.lastUsedAt ?? 0) >= before);
});

test("refuses a token whose connection was revoked", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });

  await addPluginLeftovers(user.id, issued.clientId);

  assert.equal(
    await endAssistantConnection(
      { clientId: issued.clientId, reason: "revoked", userId: user.id },
      database,
    ),
    true,
  );

  const response = await refused(issued.accessToken);

  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    new RegExp(`resource_metadata="${RESOURCE_METADATA}"`),
  );
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /error="invalid_token"/,
  );
  await assertEnded(user.id, issued);

  const events = await disconnections();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.targetUserId, user.id);
  assert.deepEqual(events[0]?.metadata, {
    clientId: issued.clientId,
    clientName: "Claude Code",
    reason: "revoked",
  });

  // Ending it again finds nothing, and records nothing.
  assert.equal(
    await endAssistantConnection(
      { clientId: issued.clientId, reason: "revoked", userId: user.id },
      database,
    ),
    false,
  );
  assert.equal((await disconnections()).length, 1);
});

test("a refresh after revoke is refused", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  // Before the revoke the refresh works, so the refusal below is the
  // revoke's doing.
  const first = await refreshGrant(issued.clientId, issued.refreshToken);

  assert.equal(first.status, 200, JSON.stringify(first.payload));

  const refreshToken = String(first.payload?.refresh_token);

  await endAssistantConnection(
    { clientId: issued.clientId, reason: "revoked", userId: user.id },
    database,
  );

  const refreshed = await refreshGrant(issued.clientId, refreshToken);

  assert.notEqual(refreshed.status, 200);
  assert.equal(refreshed.payload?.error, "invalid_grant");
  assert.equal(refreshed.payload?.access_token, undefined);
});

test("refuses a token past the install's maximum session age", async () => {
  await setSettings({ assistantConnections: true, sessionMaxHours: 1 });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });

  await database.query(
    `update assistant_connections set approved_at = approved_at - 3601 where user_id = $1`,
    [user.id],
  );

  const response = await refused(issued.accessToken);

  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    new RegExp(`resource_metadata="${RESOURCE_METADATA}"`),
  );
  await assertEnded(user.id, issued);
  assert.deepEqual((await disconnections())[0]?.metadata, {
    clientId: issued.clientId,
    clientName: "Claude Code",
    reason: "limits",
  });
});

test("refuses a token left unused past the install's idle timeout", async () => {
  await setSettings({ assistantConnections: true, sessionIdleMinutes: 30 });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await database.query(
    `update assistant_connections
        set approved_at = approved_at - 7200, last_used_at = approved_at - 1801
      where user_id = $1`,
    [user.id],
  );

  assert.equal((await refused(issued.accessToken)).status, 401);
  await assertEnded(user.id, issued);
});

test("without session limits a token is accepted however old its connection", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await database.query(
    `update assistant_connections set approved_at = approved_at - 30 * 86400 where user_id = $1`,
    [user.id],
  );

  assert.ok(
    !(
      (await requireAssistantContext(mcpRequest(issued.accessToken))) instanceof
      Response
    ),
  );
  assert.equal((await connectionRows(user.id)).length, 1);
});

test("refuses while the setting is off", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  // As another instance would turn it off, past this one's settings cache.
  await database.query(
    `update app_settings set assistant_connections = false where id`,
  );

  const response = await refused(issued.accessToken);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("refuses a user who must set up two-step sign-in", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await setSettings({ requireTwoFactor: true });

  assert.equal((await refused(issued.accessToken)).status, 403);
  // Setting it up is all it takes, so the connection is kept.
  assert.equal((await connectionRows(user.id)).length, 1);
});

test("refuses a token whose user is gone or no longer verified", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await database.query(
    `update "user" set "emailVerified" = false where id = $1`,
    [user.id],
  );
  assert.equal((await refused(issued.accessToken)).status, 401);

  await database.query(`delete from "user" where id = $1`, [user.id]);
  assert.equal((await refused(issued.accessToken)).status, 401);
});

test("a 401 names the protected resource metadata", async () => {
  await setSettings({ assistantConnections: true });

  const missing = await refused();

  assert.equal(missing.status, 401);
  assert.equal(
    missing.headers.get("www-authenticate"),
    `Bearer resource_metadata="${RESOURCE_METADATA}"`,
  );

  const forged = await refused("not-a-real-token");

  assert.equal(forged.status, 401);
  assert.match(
    forged.headers.get("www-authenticate") ?? "",
    new RegExp(
      `error="invalid_token".*resource_metadata="${RESOURCE_METADATA}"`,
    ),
  );
});

test("a token with a broken signature or past its expiry gets the challenge", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const [header, body, signature = ""] = issued.accessToken.split(".");
  const flipped = signature.startsWith("A") ? "B" : "A";
  const tampered = `${header}.${body}.${flipped}${signature.slice(1)}`;
  const challenge = new RegExp(
    `error="invalid_token".*resource_metadata="${RESOURCE_METADATA}"`,
  );

  const broken = await refused(tampered);

  assert.equal(broken.status, 401);
  assert.match(broken.headers.get("www-authenticate") ?? "", challenge);

  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3601_000 });

  try {
    const expired = await refused(issued.accessToken);

    assert.equal(expired.status, 401);
    assert.match(expired.headers.get("www-authenticate") ?? "", challenge);
  } finally {
    mock.timers.reset();
  }
});

test("refusals are logged without the token", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await endAssistantConnection(
    { clientId: issued.clientId, reason: "revoked", userId: user.id },
    database,
  );

  const lines: string[] = [];
  const original = console.warn;

  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    await refused(issued.accessToken);
    await refused("not-a-real-token");
  } finally {
    console.warn = original;
  }

  const refusals = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.category === "assistant_token_refused");

  assert.equal(refusals.length, 2);
  assert.deepEqual(refusals[0]?.metadata, {
    clientId: issued.clientId,
    reason: "connection_gone",
  });
  assert.equal(refusals[0]?.userId, user.id);
  assert.equal(
    (refusals[1]?.metadata as { reason?: string }).reason,
    "invalid_token",
  );

  for (const line of lines) {
    assert.ok(!line.includes(issued.accessToken));
    assert.ok(!line.includes("not-a-real-token"));
  }
});

test("a password reset ends the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const first = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });
  const second = await issueAssistantToken(database, {
    clientName: "Claude Desktop",
    userId: user.id,
  });
  const context = await getAuth().$context;
  const token = randomBytes(16).toString("hex");

  await context.internalAdapter.createVerificationValue({
    expiresAt: new Date(Date.now() + 3600_000),
    identifier: `reset-password:${token}`,
    value: user.id,
  });

  const reset = await callAuth("POST", "/reset-password", {
    body: { newPassword: `${ASSISTANT_TEST_PASSWORD} anew`, token },
  });

  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  await assertEnded(user.id, first);
  await assertEnded(user.id, second);

  const events = await disconnections();

  assert.deepEqual(
    events
      .map((event) => event.metadata as { clientName: string; reason: string })
      .sort((a, b) => a.clientName.localeCompare(b.clientName)),
    [
      {
        clientId: first.clientId,
        clientName: "Claude Code",
        reason: "password_reset",
      },
      {
        clientId: second.clientId,
        clientName: "Claude Desktop",
        reason: "password_reset",
      },
    ],
  );
});

test("an administrator's two-step reset ends the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const admin = await createAdmin();
  const user = await createAssistantTestUser(database);
  const other = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const kept = await issueAssistantToken(database, { userId: other.id });

  await database.query(
    `update "user" set "twoFactorEnabled" = true where id = $1`,
    [user.id],
  );
  await resetTwoFactor(admin, user.id, database);

  await assertEnded(user.id, issued);
  assert.equal((await disconnections())[0]?.metadata?.reason, "sign_in_reset");
  // Someone else's connection is not touched.
  assert.ok(
    !(
      (await requireAssistantContext(mcpRequest(kept.accessToken))) instanceof
      Response
    ),
  );
});

test("an administrator's two-step reset that fails keeps the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const admin = await createAdmin();
  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  // The reset is refused (no two-step sign-in to reset), and rolls back.
  await assert.rejects(resetTwoFactor(admin, user.id, database));
  assert.equal((await connectionRows(user.id)).length, 1);
  assert.equal((await pluginRows(user.id)).refresh > 0, true);
  assert.ok(
    !(
      (await requireAssistantContext(mcpRequest(issued.accessToken))) instanceof
      Response
    ),
  );
});

test("signing out everywhere ends the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const cookie = await createSignedInCookie(database, user.id);
  const revoked = await callAuth("POST", "/revoke-sessions", {
    body: {},
    cookie,
  });

  assert.equal(revoked.status, 200, JSON.stringify(revoked.payload));
  await assertEnded(user.id, issued);
  assert.equal(
    (await disconnections())[0]?.metadata?.reason,
    "sessions_revoked",
  );
});

test("signing out everywhere else ends the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const cookie = await createSignedInCookie(database, user.id);
  const revoked = await callAuth("POST", "/revoke-other-sessions", {
    body: {},
    cookie,
  });

  assert.equal(revoked.status, 200, JSON.stringify(revoked.payload));
  await assertEnded(user.id, issued);
});

test("changing the password and signing out other devices ends the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const cookie = await createSignedInCookie(database, user.id);
  const changed = await callAuth("POST", "/change-password", {
    body: {
      currentPassword: ASSISTANT_TEST_PASSWORD,
      newPassword: `${ASSISTANT_TEST_PASSWORD} anew`,
      revokeOtherSessions: true,
    },
    cookie,
  });

  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  await assertEnded(user.id, issued);
});

test("changing the password alone keeps the user's connections", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const cookie = await createSignedInCookie(database, user.id);
  const changed = await callAuth("POST", "/change-password", {
    body: {
      currentPassword: ASSISTANT_TEST_PASSWORD,
      newPassword: `${ASSISTANT_TEST_PASSWORD} anew`,
    },
    cookie,
  });

  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.equal((await connectionRows(user.id)).length, 1);
  assert.ok(
    !(
      (await requireAssistantContext(mcpRequest(issued.accessToken))) instanceof
      Response
    ),
  );
});

test("purging a closed account ends its connections", async () => {
  await setSettings({ assistantConnections: true });
  await createAdmin();

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-assistant-"));

  try {
    await database.query(
      `insert into account_closure_requests
         (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
       values ($1, 1, 1, 1, 1)`,
      [user.id],
    );

    const summary = await runRetentionSweep({
      database,
      storageService: createStorageService({
        env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
      }),
    });

    assert.equal(summary.accountsPurged, 1);
  } finally {
    await rm(storageDir, { force: true, recursive: true });
  }

  // The account's row is deleted, and everything of the assistant's goes
  // with it by foreign key.
  await assertEnded(user.id, issued);
});

test("turning assistant connections off ends every connection and the provider's tokens", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const other = await createAssistantTestUser(database);
  const first = await issueAssistantToken(database, { userId: user.id });
  const second = await issueAssistantToken(database, { userId: other.id });

  await addPluginLeftovers(user.id, first.clientId);
  await endAllAssistantConnections(database);
  // Back on, so the guard's refusal is the ended connection's.
  await setSettings({ assistantConnections: true });

  await assertEnded(user.id, first);
  await assertEnded(other.id, second);
});
