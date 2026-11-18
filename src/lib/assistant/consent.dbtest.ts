import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import type { getAuth as GetAuth } from "../auth/server.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { listSystemAuditEvents } from "../services/system-audit.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import {
  answerConsent,
  ASSISTANT_TEST_PASSWORD,
  assistantAuthorizePath,
  callAuth,
  connectAssistant,
  createAssistantTestUser,
  createPkce,
  createSignedInCookie,
  issueAssistantToken,
  prepareAssistantTestEnvironment,
  refreshAssistantToken,
  registerAssistantClient,
  replyRedirect,
  seedAssistantResource,
} from "./test-support.ts";

// Approving an assistant on the consent page, against a real Postgres and
// the real auth handler: what is recorded, that the page is shown every
// time, and who is never given a code. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let getAuth: typeof GetAuth;

async function setSettings(values: {
  assistantConnections?: boolean;
  requireTwoFactor?: boolean;
}) {
  await saveSettings(values, database);
  invalidateSettingsCache();
}

async function connectionRows(userId: string) {
  return (
    await database.query<{
      approved_at: string;
      client_id: string;
      client_name: string;
      last_used_at: string | null;
    }>(
      `select client_id, client_name, approved_at, last_used_at
         from assistant_connections where user_id = $1`,
      [userId],
    )
  ).rows;
}

async function consentRows(userId: string) {
  return (
    await database.query(`select 1 from "oauthConsent" where "userId" = $1`, [
      userId,
    ])
  ).rowCount;
}

async function assistantEvents() {
  return (await listSystemAuditEvents({}, database)).filter(
    ({ event }) =>
      event === "assistant_connected" || event === "assistant_disconnected",
  );
}

/** Up to the consent page, as a signed-in sender. */
async function reachConsent(
  cookie: string,
  clientId: string,
  options: { offlineAccess?: boolean } = {},
) {
  const { challenge, verifier } = createPkce();
  const authorized = await callAuth(
    "GET",
    assistantAuthorizePath(clientId, {
      challenge,
      offlineAccess: options.offlineAccess,
    }),
    { cookie },
  );

  return { authorized, url: replyRedirect(authorized), verifier };
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  ({ getAuth } = await import("../auth/server.ts"));
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.system_audit_events");
  invalidateSettingsCache();
  await seedAssistantResource(database);
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.system_audit_events");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("approving consent records the connection and an assistant_connected event", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const startedAt = Math.floor(Date.now() / 1000);
  const issued = await issueAssistantToken(database, {
    clientName: "Claude Code",
    userId: user.id,
  });

  assert.equal(typeof issued.accessToken, "string");
  assert.equal(typeof issued.refreshToken, "string");
  assert.equal(issued.clientName, "Claude Code");

  const rows = await connectionRows(user.id);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.client_id, issued.clientId);
  assert.equal(rows[0]?.client_name, "Claude Code");
  assert.ok(Number(rows[0]?.approved_at) >= startedAt);
  assert.equal(rows[0]?.last_used_at, null);

  const events = await assistantEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "assistant_connected");
  assert.equal(events[0]?.targetUserId, user.id);
  assert.equal(events[0]?.actorUserId, user.id);
  assert.deepEqual(events[0]?.metadata, {
    clientId: issued.clientId,
    clientName: "Claude Code",
  });
  // The plugin's own record of the approval is not kept, so the next
  // authorization asks again.
  assert.equal(await consentRows(user.id), 0);
});

test("reconnecting a client after its connection ended records it again", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const { clientId } = await issueAssistantToken(database, { userId: user.id });

  // As Task 4's endAssistantConnection will.
  await database.query(
    `delete from assistant_connections where user_id = $1 and client_id = $2`,
    [user.id, clientId],
  );
  assert.equal((await connectionRows(user.id)).length, 0);

  const reconnectedAt = Math.floor(Date.now() / 1000);

  await connectAssistant(database, { clientId, userId: user.id });

  const rows = await connectionRows(user.id);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.client_id, clientId);
  assert.ok(Number(rows[0]?.approved_at) >= reconnectedAt);
  assert.equal(
    (await assistantEvents()).filter(
      ({ event }) => event === "assistant_connected",
    ).length,
    2,
  );
});

test("a client that already has a connection still sees the consent page", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const cookie = await createSignedInCookie(database, user.id);

  // Without offline_access the SDK sends no prompt=consent, and the plugin
  // would skip the page for a client it already holds a consent for.
  const again = await reachConsent(cookie, issued.clientId, {
    offlineAccess: false,
  });

  assert.equal(again.url?.pathname, "/oauth/consent", again.url?.href);
  assert.equal(again.url?.searchParams.get("code"), null);

  // The tokens issued before still renew.
  const refreshed = await refreshAssistantToken(
    issued.clientId,
    issued.refreshToken,
  );

  assert.notEqual(refreshed.refreshToken, issued.refreshToken);
});

test("denying consent records nothing", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const clientId = await registerAssistantClient();
  const cookie = await createSignedInCookie(database, user.id);
  const { url } = await reachConsent(cookie, clientId);

  assert.equal(url?.pathname, "/oauth/consent");

  const denied = await answerConsent(cookie, url, false);
  const callback = replyRedirect(denied);

  assert.equal(callback?.searchParams.get("error"), "access_denied");
  assert.equal(callback?.searchParams.get("code"), null);
  assert.equal((await connectionRows(user.id)).length, 0);
  assert.equal((await assistantEvents()).length, 0);
  assert.equal(await consentRows(user.id), 0);
});

test("a user who must set up two-step sign-in is not issued a code", async () => {
  await setSettings({ assistantConnections: true });

  // A password account without two-step sign-in.
  const user = await createAssistantTestUser(database);
  const clientId = await registerAssistantClient();
  const cookie = await createSignedInCookie(database, user.id);
  // A consent page reached before the requirement was turned on.
  const earlier = await reachConsent(cookie, clientId);

  assert.equal(earlier.url?.pathname, "/oauth/consent");

  await setSettings({ requireTwoFactor: true });

  const authorized = await reachConsent(cookie, clientId);

  assert.equal(authorized.authorized.status, 403);
  assert.equal(authorized.authorized.payload?.code, "TWO_STEP_SETUP_REQUIRED");

  const approved = await answerConsent(cookie, earlier.url, true);

  assert.equal(approved.status, 403);
  assert.equal(approved.payload?.code, "TWO_STEP_SETUP_REQUIRED");

  // Signing in from the sign-in page the provider sends a signed-out
  // sender to.
  const { challenge } = createPkce();
  const signedOut = await callAuth(
    "GET",
    assistantAuthorizePath(clientId, { challenge }),
  );
  const login = replyRedirect(signedOut);

  assert.equal(login?.pathname, "/login");

  const signedIn = await callAuth("POST", "/sign-in/email", {
    body: {
      email: user.email,
      oauth_query: login.search.slice(1),
      password: ASSISTANT_TEST_PASSWORD,
    },
  });

  assert.equal(signedIn.status, 403);
  assert.equal(signedIn.payload?.code, "TWO_STEP_SETUP_REQUIRED");
  assert.equal(replyRedirect(signedIn), null);
  assert.equal((await connectionRows(user.id)).length, 0);
});

test("when the connection can't be recorded, the client gets no code", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database);
  const clientId = await registerAssistantClient();
  const cookie = await createSignedInCookie(database, user.id);
  const reached = await reachConsent(cookie, clientId);

  assert.equal(reached.url?.pathname, "/oauth/consent");

  // Recording the connection fails, as it would with the database down.
  await database.query(`
    create or replace function fail_connection_insert() returns trigger as $$
    begin raise exception 'recording failed'; end;
    $$ language plpgsql;
    create trigger fail_connection_insert before insert on assistant_connections
      for each row execute function fail_connection_insert();
  `);

  try {
    const approved = await answerConsent(cookie, reached.url!, true);

    assert.ok(approved.status >= 400, `status ${approved.status}`);
    assert.equal(replyRedirect(approved), null);
    assert.ok(!JSON.stringify(approved.payload).includes("code="));
    assert.equal((await connectionRows(user.id)).length, 0);
    assert.equal((await assistantEvents()).length, 0);
  } finally {
    await database.query(
      `drop trigger fail_connection_insert on assistant_connections; drop function fail_connection_insert()`,
    );
  }
});

test("a user who hasn't verified their email address is not issued a code", async () => {
  await setSettings({ assistantConnections: true });

  const user = await createAssistantTestUser(database, {
    emailVerified: false,
  });
  const clientId = await registerAssistantClient();
  const cookie = await createSignedInCookie(database, user.id);
  const authorized = await reachConsent(cookie, clientId);

  assert.equal(authorized.authorized.status, 403);
  assert.equal(authorized.authorized.payload?.code, "EMAIL_NOT_VERIFIED");
  assert.equal(authorized.url, null);
});

test("the consent page trusts only the signed request", async () => {
  await setSettings({ assistantConnections: true });

  const { readConsentRequest } = await import("./consent.ts");
  const secret = (await getAuth().$context).secret;
  const user = await createAssistantTestUser(database);
  const clientId = await registerAssistantClient("Claude Code");
  const otherClientId = await registerAssistantClient("Lookalike");
  const cookie = await createSignedInCookie(database, user.id);
  const { url } = await reachConsent(cookie, clientId);

  assert.ok(url);

  const request = await readConsentRequest(url.searchParams, { secret });

  assert.deepEqual(request && { ...request, oauthQuery: undefined }, {
    clientId,
    clientName: "Claude Code",
    oauthQuery: undefined,
    redirectHost: "127.0.0.1:33418",
  });
  assert.equal(
    new URLSearchParams(request?.oauthQuery).get("client_id"),
    clientId,
  );

  // Another client named in the query, in place of the signed one or
  // next to it, is not believed.
  const swapped = new URLSearchParams(url.searchParams);

  swapped.set("client_id", otherClientId);
  assert.equal(await readConsentRequest(swapped, { secret }), null);

  const doubled = new URLSearchParams(url.searchParams);

  doubled.append("client_id", otherClientId);
  assert.equal(await readConsentRequest(doubled, { secret }), null);

  const unsigned = new URLSearchParams(url.searchParams);

  unsigned.delete("sig");
  assert.equal(await readConsentRequest(unsigned, { secret }), null);
  assert.equal(
    await readConsentRequest(new URLSearchParams(), { secret }),
    null,
  );
});
