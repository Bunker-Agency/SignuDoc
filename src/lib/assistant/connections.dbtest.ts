import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  createAssistantTestUser,
  createSignedInCookie,
  prepareAssistantTestEnvironment,
} from "./test-support.ts";

// The routes behind Settings > Connected apps, called directly with a
// session cookie. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let listRoute: typeof import("../../app/api/account/connections/route.ts");
let itemRoute: typeof import("../../app/api/account/connections/[clientId]/route.ts");
const emails: string[] = [];

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  listRoute = await import("../../app/api/account/connections/route.ts");
  itemRoute =
    await import("../../app/api/account/connections/[clientId]/route.ts");
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.app_settings");
  await saveSettings({ assistantConnections: true }, database);
  invalidateSettingsCache();
});

after(async () => {
  await database.query("delete from public.assistant_connections");
  for (const email of emails) {
    await database.query(`delete from public."user" where email = $1`, [email]);
  }
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

async function sender(): Promise<{
  cookie: string;
  email: string;
  id: string;
}> {
  const user = await createAssistantTestUser(database);

  emails.push(user.email);

  return { ...user, cookie: await createSignedInCookie(database, user.id) };
}

async function connect(
  userId: string,
  clientId: string,
  clientName: string,
  approvedAt: number,
) {
  await database.query(
    `insert into public.assistant_connections (user_id, client_id, client_name, approved_at) values ($1, $2, $3, $4)`,
    [userId, clientId, clientName, approvedAt],
  );
}

const base = `${ASSISTANT_TEST_BASE_URL}/api/account/connections`;
const ctx = (clientId: string) => ({ params: Promise.resolve({ clientId }) });

test("lists only the signed-in sender's connections", async () => {
  const mine = await sender();
  const theirs = await sender();
  const clientA = `client-${mine.id}`;

  await connect(mine.id, clientA, "My assistant", 1_700_000_000);
  await connect(
    theirs.id,
    `client-${theirs.id}`,
    "Their assistant",
    1_700_000_100,
  );

  const response = await listRoute.GET(
    new Request(base, { headers: { cookie: mine.cookie } }),
  );
  const body = (await response.json()) as {
    connections: Array<{ clientId: string; clientName: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(
    body.connections.map((c) => [c.clientId, c.clientName]),
    [[clientA, "My assistant"]],
  );

  const anonymous = await listRoute.GET(new Request(base));

  assert.equal(anonymous.status, 401);
});

test("revoking a connection ends it and records assistant_disconnected", async () => {
  const user = await sender();
  const clientId = `client-${user.id}`;

  await connect(user.id, clientId, "My assistant", 1_700_000_000);

  const response = await itemRoute.DELETE(
    new Request(`${base}/${clientId}`, {
      headers: { cookie: user.cookie },
      method: "DELETE",
    }),
    ctx(clientId),
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const left = await database.query(
    `select 1 from public.assistant_connections where user_id = $1`,
    [user.id],
  );

  assert.equal(left.rowCount, 0);

  const events = await database.query(
    `select actor_user_id, actor_email, target_user_id, metadata
       from public.system_audit_events
      where event = 'assistant_disconnected' and target_user_id = $1`,
    [user.id],
  );

  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].actor_user_id, user.id);
  assert.equal(events.rows[0].actor_email, user.email);
  assert.equal(events.rows[0].metadata.reason, "revoked");
  assert.equal(events.rows[0].metadata.clientId, clientId);

  const again = await itemRoute.DELETE(
    new Request(`${base}/${clientId}`, {
      headers: { cookie: user.cookie },
      method: "DELETE",
    }),
    ctx(clientId),
  );

  assert.equal(again.status, 404);
});

test("revoking someone else's connection returns 404", async () => {
  const mine = await sender();
  const theirs = await sender();
  const clientId = `client-${theirs.id}`;

  await connect(theirs.id, clientId, "Their assistant", 1_700_000_000);

  const response = await itemRoute.DELETE(
    new Request(`${base}/${clientId}`, {
      headers: { cookie: mine.cookie },
      method: "DELETE",
    }),
    ctx(clientId),
  );

  assert.equal(response.status, 404);

  const still = await database.query(
    `select 1 from public.assistant_connections where user_id = $1`,
    [theirs.id],
  );

  assert.equal(still.rowCount, 1);
});
