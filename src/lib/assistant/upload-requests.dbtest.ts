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
import { createStorageService } from "../services/storage.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import type {
  consumeUploadRequest as Consume,
  createUploadRequest as Create,
  getUploadRequestStatus as Status,
  UploadRequestError as UploadError,
} from "./upload-requests.ts";
import type { AssistantContext } from "./guard.ts";
import { prepareAssistantTestEnvironment } from "./test-support.ts";

// One-time upload links, against a real Postgres. Run with
// `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let createUploadRequest: typeof Create;
let consumeUploadRequest: typeof Consume;
let getUploadRequestStatus: typeof Status;
let UploadRequestError: typeof UploadError;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-upload-req-"));

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
  ({
    consumeUploadRequest,
    createUploadRequest,
    getUploadRequestStatus,
    UploadRequestError,
  } = await import("./upload-requests.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.app_settings");
  await saveSettings({ assistantConnections: true }, database);
  invalidateSettingsCache();
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@uploads.example.test'`,
  );
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@uploads.example.test`;
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

const pdfInput = () => ({
  body: sourcePdf,
  contentType: "application/pdf",
  filename: "lease.pdf",
});

const options = () => ({
  database,
  storageService: createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  }),
});

async function draftCount(userId: string): Promise<number> {
  const result = await database.query(
    `select count(*)::int as n from public.envelopes where user_id = $1`,
    [userId],
  );

  return result.rows[0].n;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof UploadRequestError);

    return { message: error.message, status: error.statusCode };
  }

  assert.fail("expected the upload to be refused");
}

test("an upload request creates one draft tagged as made through MCP", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Ada's lease" },
    database,
  );
  const { envelopeId } = await consumeUploadRequest(
    { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
    options(),
  );

  assert.equal(await draftCount(context.userId), 1);

  const draft = await database.query(
    `select user_id, title, status from public.envelopes where id = $1`,
    [envelopeId],
  );

  assert.equal(draft.rows[0].user_id, context.userId);
  assert.equal(draft.rows[0].title, "Ada's lease");
  assert.equal(draft.rows[0].status, "draft");

  const events = await database.query(
    `select metadata, actor_type from public.audit_events where envelope_id = $1 and event = 'created'`,
    [envelopeId],
  );
  const metadata =
    typeof events.rows[0].metadata === "string"
      ? JSON.parse(events.rows[0].metadata)
      : events.rows[0].metadata;

  assert.equal(events.rows[0].actor_type, "sender");
  assert.deepEqual(metadata, {
    client: "Test Client",
    clientId: context.clientId,
    via: "mcp",
  });

  const status = await getUploadRequestStatus(
    context.userId,
    request.uploadId,
    undefined,
    database,
  );

  assert.equal(status?.status, "done");
  assert.equal(status?.envelopeId, envelopeId);
});

test("refuses a used, expired or other user's upload request", async () => {
  const context = await createUser();
  const other = await createUser();

  // Unknown.
  const unknown = await refusal(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: "nope" },
      options(),
    ),
  );

  assert.deepEqual(unknown, {
    message: "This upload link isn't valid.",
    status: 404,
  });

  // Used.
  const used = await createUploadRequest({ context, title: "Used" }, database);

  await consumeUploadRequest(
    { sessionUserId: null, sourcePdf: pdfInput(), token: used.token },
    options(),
  );

  const before = await draftCount(context.userId);
  const again = await refusal(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: used.token },
      options(),
    ),
  );

  assert.deepEqual(again, {
    message: "This upload link has already been used.",
    status: 409,
  });

  // Expired.
  const old = await createUploadRequest(
    { context, now: Math.floor(Date.now() / 1000) - 3600, title: "Old" },
    database,
  );
  const expired = await refusal(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: old.token },
      options(),
    ),
  );

  assert.deepEqual(expired, {
    message: "This upload link has expired. Ask your assistant for a new one.",
    status: 410,
  });

  // Someone else's.
  const mine = await createUploadRequest({ context, title: "Mine" }, database);
  const stranger = await refusal(
    consumeUploadRequest(
      {
        sessionUserId: other.userId,
        sourcePdf: pdfInput(),
        token: mine.token,
      },
      options(),
    ),
  );

  assert.deepEqual(stranger, {
    message: "This upload link belongs to someone else.",
    status: 403,
  });
  assert.equal(await draftCount(context.userId), before);
  assert.equal(await draftCount(other.userId), 0);

  // Still usable by its owner after being refused for someone else.
  await consumeUploadRequest(
    {
      sessionUserId: context.userId,
      sourcePdf: pdfInput(),
      token: mine.token,
    },
    options(),
  );
});

test("a token-only upload stops working once the assistant is disconnected", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Gone" },
    database,
  );

  await database.query(
    `delete from public.assistant_connections where user_id = $1`,
    [context.userId],
  );

  const refused = await refusal(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
      options(),
    ),
  );

  assert.deepEqual(refused, {
    message:
      "This upload link stopped working because the assistant was disconnected.",
    status: 403,
  });
  assert.equal(await draftCount(context.userId), 0);
});

test("refuses an upload while assistant connections are turned off", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Off" },
    database,
  );

  await saveSettings({ assistantConnections: false }, database);
  invalidateSettingsCache();

  const refused = await refusal(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
      options(),
    ),
  );

  assert.deepEqual(refused, {
    message: "AI assistant connections are turned off on this site.",
    status: 403,
  });
  assert.equal(await draftCount(context.userId), 0);
});

test("a PDF that can't be read leaves the link usable", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Broken" },
    database,
  );

  await assert.rejects(
    consumeUploadRequest(
      {
        sessionUserId: null,
        sourcePdf: {
          body: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
          filename: "bad.pdf",
        },
        token: request.token,
      },
      options(),
    ),
  );
  await consumeUploadRequest(
    { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
    options(),
  );
  assert.equal(await draftCount(context.userId), 1);
});

test("two uploads racing on one link make one draft", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Race" },
    database,
  );
  const results = await Promise.allSettled([
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
      options(),
    ),
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
      options(),
    ),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof UploadRequestError);
  assert.equal((rejected[0]!.reason as UploadError).statusCode, 409);
  assert.equal(await draftCount(context.userId), 1);
});

test("only the token's hash is stored", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Hash" },
    database,
  );
  const row = await database.query(
    `select * from public.assistant_upload_requests where id = $1`,
    [request.uploadId],
  );

  assert.ok(!JSON.stringify(row.rows[0]).includes(request.token));
  assert.equal(row.rows[0].token_hash.length, 64);
  assert.equal(request.expiresAt - row.rows[0].created_at * 1, 1800);
  assert.equal(Number(row.rows[0].expires_at), request.expiresAt);
});

test("status reports waiting, expired and nothing for another user", async () => {
  const context = await createUser();
  const other = await createUser();
  const request = await createUploadRequest({ context, title: "S" }, database);
  const now = Math.floor(Date.now() / 1000);

  assert.equal(
    (
      await getUploadRequestStatus(
        context.userId,
        request.uploadId,
        now,
        database,
      )
    )?.status,
    "waiting",
  );
  assert.equal(
    (
      await getUploadRequestStatus(
        context.userId,
        request.uploadId,
        now + 1801,
        database,
      )
    )?.status,
    "expired",
  );
  assert.equal(
    await getUploadRequestStatus(other.userId, request.uploadId, now, database),
    null,
  );
});

test("a failure after the link is claimed gives the link back and leaves no draft", async () => {
  const context = await createUser();
  const request = await createUploadRequest(
    { context, title: "Storage down" },
    database,
  );
  const working = options().storageService;
  const broken = {
    ...working,
    putObject: async () => {
      throw new Error("storage is down");
    },
  } as typeof working;

  await assert.rejects(
    consumeUploadRequest(
      { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
      { database, storageService: broken },
    ),
    /storage is down/,
  );
  assert.equal(await draftCount(context.userId), 0);

  const row = await database.query(
    `select used_at, envelope_id from public.assistant_upload_requests where id = $1`,
    [request.uploadId],
  );

  assert.equal(row.rows[0].used_at, null);
  assert.equal(row.rows[0].envelope_id, null);

  await consumeUploadRequest(
    { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
    options(),
  );
  assert.equal(await draftCount(context.userId), 1);
});

test("the link and its draft are written together, and many racing uploads don't starve the pool", async () => {
  const context = await createUser();
  const requests = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      createUploadRequest({ context, title: `Bulk ${index}` }, database),
    ),
  );
  const results = await Promise.all(
    requests.map((request) =>
      consumeUploadRequest(
        { sessionUserId: null, sourcePdf: pdfInput(), token: request.token },
        options(),
      ),
    ),
  );
  const linked = await database.query(
    `select count(*)::int as n from public.assistant_upload_requests where user_id = $1 and used_at is not null and envelope_id is not null`,
    [context.userId],
  );

  assert.equal(results.length, 30);
  assert.equal(linked.rows[0].n, 30);
  assert.equal(await draftCount(context.userId), 30);
});
