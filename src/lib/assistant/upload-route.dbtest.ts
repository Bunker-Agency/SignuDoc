import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import type { AssistantContext } from "./guard.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  createSignedInCookie,
  prepareAssistantTestEnvironment,
} from "./test-support.ts";
import type { createUploadRequest as Create } from "./upload-requests.ts";

// The upload link's HTTP route, called directly. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let route: typeof import("../../app/api/assistant/uploads/[token]/route.ts");
let createUploadRequest: typeof Create;
const previousEnv = {
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR,
};

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-upload-route-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
  route = await import("../../app/api/assistant/uploads/[token]/route.ts");
  ({ createUploadRequest } = await import("./upload-requests.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.app_settings");
  await saveSettings({ assistantConnections: true }, database);
  invalidateSettingsCache();
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@upload-route.example.test'`,
  );
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@upload-route.example.test`;
  const clientId = `client-${userId}`;

  await database.query(
    `insert into public."user" (id, name, email, "emailVerified", role) values ($1, 'Ada', $2, true, 'user')`,
    [userId, userEmail],
  );
  await database.query(
    `insert into public.assistant_connections (user_id, client_id, client_name, approved_at) values ($1, $2, 'Test Client', $3)`,
    [userId, clientId, Math.floor(Date.now() / 1000)],
  );

  return {
    clientId,
    clientName: "Test Client",
    scopes: ["envelopes:read", "drafts:write"],
    userEmail,
    userId,
    userName: "Ada",
  };
}

const url = (token: string) =>
  `${ASSISTANT_TEST_BASE_URL}/api/assistant/uploads/${token}`;
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

test("PUT with the link and a PDF makes the draft", async () => {
  const context = await createUser();
  const { token } = await createUploadRequest(
    { context, title: "Lease" },
    database,
  );
  const response = await route.PUT(
    new Request(url(token), {
      body: sourcePdf as BodyInit,
      headers: { "content-type": "application/pdf" },
      method: "PUT",
    }),
    ctx(token),
  );
  const body = (await response.json()) as { envelopeId: string };

  assert.equal(response.status, 201);
  assert.ok(body.envelopeId);
  assert.ok(!JSON.stringify(body).includes(token));

  const again = await route.PUT(
    new Request(url(token), {
      body: sourcePdf as BodyInit,
      headers: { "content-type": "application/pdf" },
      method: "PUT",
    }),
    ctx(token),
  );

  assert.equal(again.status, 409);
  assert.ok(!(await again.text()).includes(token));
});

test("PUT refuses a body that isn't application/pdf, and one that is too big", async () => {
  const context = await createUser();
  const { token } = await createUploadRequest(
    { context, title: "Lease" },
    database,
  );
  const wrong = await route.PUT(
    new Request(url(token), {
      body: sourcePdf as BodyInit,
      headers: { "content-type": "text/plain" },
      method: "PUT",
    }),
    ctx(token),
  );
  const big = await route.PUT(
    new Request(url(token), {
      body: new Uint8Array(21 * 1024 * 1024),
      headers: { "content-type": "application/pdf" },
      method: "PUT",
    }),
    ctx(token),
  );

  assert.equal(wrong.status, 415);
  assert.equal(big.status, 413);
});

test("PUT stops working once the assistant is disconnected", async () => {
  const context = await createUser();
  const { token } = await createUploadRequest(
    { context, title: "Lease" },
    database,
  );

  await database.query(
    `delete from public.assistant_connections where user_id = $1`,
    [context.userId],
  );

  const response = await route.PUT(
    new Request(url(token), {
      body: sourcePdf as BodyInit,
      headers: { "content-type": "application/pdf" },
      method: "PUT",
    }),
    ctx(token),
  );

  assert.equal(response.status, 403);
});

test("POST needs a session for the link's own user", async () => {
  const ada = await createUser();
  const bob = await createUser();
  const { token } = await createUploadRequest(
    { context: ada, title: "Lease" },
    database,
  );
  const form = () => {
    const data = new FormData();

    data.append(
      "file",
      new File([sourcePdf as BlobPart], "lease.pdf", {
        type: "application/pdf",
      }),
    );

    return data;
  };
  const anonymous = await route.POST(
    new Request(url(token), { body: form(), method: "POST" }),
    ctx(token),
  );
  const stranger = await route.POST(
    new Request(url(token), {
      body: form(),
      headers: { cookie: await createSignedInCookie(database, bob.userId) },
      method: "POST",
    }),
    ctx(token),
  );
  const owner = await route.POST(
    new Request(url(token), {
      body: form(),
      headers: { cookie: await createSignedInCookie(database, ada.userId) },
      method: "POST",
    }),
    ctx(token),
  );

  assert.equal(anonymous.status, 401);
  assert.equal(stranger.status, 403);
  assert.equal(owner.status, 201);
});

test("both routes refuse while the setting is off", async () => {
  const context = await createUser();
  const { token } = await createUploadRequest(
    { context, title: "Lease" },
    database,
  );

  await saveSettings({ assistantConnections: false }, database);
  invalidateSettingsCache();

  const put = await route.PUT(
    new Request(url(token), {
      body: sourcePdf as BodyInit,
      headers: { "content-type": "application/pdf" },
      method: "PUT",
    }),
    ctx(token),
  );
  const post = await route.POST(
    new Request(url(token), { body: new FormData(), method: "POST" }),
    ctx(token),
  );

  assert.equal(put.status, 403);
  assert.equal(post.status, 403);
});
