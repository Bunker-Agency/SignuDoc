import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { listSystemAuditEvents } from "../services/system-audit.ts";
import {
  getSettings,
  invalidateSettingsCache,
  readStoredSettings,
  saveSettings,
} from "../settings.ts";
import { setAssistantConnections } from "./settings.ts";

// The install setting that lets senders connect an AI assistant, against a
// real Postgres. Run with `npm run test:db`.

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let admin: { email: string; userId: string };

async function createUser(role: "admin" | "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat Person', $2, true, $3)`,
    [id, email, role],
  );

  return { email, userId: id };
}

async function connect(userId: string, clientId: string) {
  await database.query(
    `insert into assistant_connections (user_id, client_id, client_name, approved_at) values ($1, $2, 'Claude', 1)`,
    [userId, clientId],
  );
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  admin = await createUser("admin");
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("assistant connections are off on a fresh install", async () => {
  assert.equal((await getSettings()).assistantConnections, false);

  // A row saved before the setting existed has no value for it.
  await saveSettings({ organizationName: "Acme" }, database);
  invalidateSettingsCache();

  assert.equal((await getSettings()).assistantConnections, false);
});

test("turning assistant connections on records a settings_changed event", async () => {
  await setAssistantConnections(admin, true);

  assert.equal(
    (await readStoredSettings(database))?.assistantConnections,
    true,
  );

  const [latest] = await listSystemAuditEvents({ limit: 1 }, database);

  assert.equal(latest?.event, "settings_changed");
  assert.equal(latest?.actorUserId, admin.userId);
  assert.deepEqual(
    (latest?.metadata as { changes?: Record<string, unknown> }).changes
      ?.assistantConnections,
    { from: false, to: true },
  );
});

test("setting the same value records nothing", async () => {
  await setAssistantConnections(admin, true);
  await setAssistantConnections(admin, true);

  assert.equal((await listSystemAuditEvents({}, database)).length, 1);
});

test("turning assistant connections off ends every connection", async () => {
  const sender = await createUser("user");

  await setAssistantConnections(admin, true);
  await connect(sender.userId, "client-a");
  await connect(sender.userId, "client-b");
  await setAssistantConnections(admin, false);

  const rows = await database.query(`select 1 from assistant_connections`);

  assert.equal(rows.rowCount, 0);
  assert.equal(
    (await readStoredSettings(database))?.assistantConnections,
    false,
  );
});

test("only an administrator can change it", async () => {
  const sender = await createUser("user");

  await assert.rejects(setAssistantConnections(sender, true), {
    statusCode: 403,
  });
  assert.equal(
    (await readStoredSettings(database))?.assistantConnections,
    undefined,
  );
});
