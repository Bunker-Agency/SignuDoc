import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { replaceDbPoolForTests } from "../../db/connection.ts";
import { openTestDatabase } from "../../db/test-database.ts";
import { createStorageService } from "../../services/storage.ts";
import { invalidateSettingsCache, saveSettings } from "../../settings.ts";
import type { AssistantContext } from "../guard.ts";
import type { buildAssistantServer as BuildServer } from "../server.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  prepareAssistantTestEnvironment,
} from "../test-support.ts";
import type { consumeUploadRequest as Consume } from "../upload-requests.ts";

// start_draft and get_upload through a real MCP client. Run with
// `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let buildAssistantServer: typeof BuildServer;
let consumeUploadRequest: typeof Consume;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-upload-tools-"));

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
  ({ buildAssistantServer } = await import("../server.ts"));
  ({ consumeUploadRequest } = await import("../upload-requests.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.app_settings");
  await saveSettings({ assistantConnections: true }, database);
  invalidateSettingsCache();
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@upload-tools.example.test'`,
  );
  await database.query("delete from public.app_settings");
  invalidateSettingsCache();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@upload-tools.example.test`;
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

async function callTool(
  context: AssistantContext,
  name: string,
  args: Record<string, unknown> = {},
) {
  const server = buildAssistantServer(
    context,
    new Request(`${ASSISTANT_TEST_BASE_URL}/api/mcp`, { method: "POST" }),
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await server.connect(serverSide);
  await client.connect(clientSide);

  try {
    const result = await client.callTool({ arguments: args, name });
    const first = (result.content as Array<{ text: string; type: string }>)[0];

    return { isError: result.isError === true, text: first?.text ?? "" };
  } finally {
    await client.close();
  }
}

test("start_draft returns page and API links that expire in 30 minutes", async () => {
  const context = await createUser();
  const before = Math.floor(Date.now() / 1000);
  const result = await callTool(context, "start_draft", { title: "Lease" });

  assert.equal(result.isError, false);

  const body = JSON.parse(result.text) as {
    expiresAt: number;
    note: string;
    uploadApiUrl: string;
    uploadId: string;
    uploadPageUrl: string;
  };
  const token = body.uploadPageUrl.split("/upload/")[1] ?? "";

  assert.ok(token.length >= 43);
  assert.equal(
    body.uploadPageUrl,
    `${ASSISTANT_TEST_BASE_URL}/upload/${token}`,
  );
  assert.equal(
    body.uploadApiUrl,
    `${ASSISTANT_TEST_BASE_URL}/api/assistant/uploads/${token}`,
  );
  assert.ok(body.expiresAt >= before + 1800 && body.expiresAt <= before + 1810);
  assert.match(body.note, /application\/pdf/);
  assert.match(body.note, /4\.5 MB/);

  const stored = await database.query(
    `select title, user_id, client_id from public.assistant_upload_requests where id = $1`,
    [body.uploadId],
  );

  assert.equal(stored.rows[0].title, "Lease");
  assert.equal(stored.rows[0].user_id, context.userId);
  assert.equal(stored.rows[0].client_id, context.clientId);
});

test("get_upload reports waiting, then done with review links", async () => {
  const context = await createUser();
  const started = JSON.parse(
    (await callTool(context, "start_draft", { title: "Lease" })).text,
  ) as { uploadId: string; uploadPageUrl: string };
  const waiting = JSON.parse(
    (await callTool(context, "get_upload", { uploadId: started.uploadId }))
      .text,
  ) as { envelopeId: unknown; status: string };

  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.envelopeId, null);

  const { envelopeId } = await consumeUploadRequest(
    {
      sessionUserId: null,
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: "lease.pdf",
      },
      token: started.uploadPageUrl.split("/upload/")[1] ?? "",
    },
    {
      database,
      storageService: createStorageService({
        env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
      }),
    },
  );
  const done = JSON.parse(
    (await callTool(context, "get_upload", { uploadId: started.uploadId }))
      .text,
  ) as {
    envelopeId: string;
    prepareUrl: string;
    reviewUrl: string;
    status: string;
  };

  assert.equal(done.status, "done");
  assert.equal(done.envelopeId, envelopeId);
  assert.equal(
    done.reviewUrl,
    `${ASSISTANT_TEST_BASE_URL}/envelopes/${envelopeId}/review`,
  );
  assert.equal(
    done.prepareUrl,
    `${ASSISTANT_TEST_BASE_URL}/envelopes/${envelopeId}/prepare`,
  );
});

test("get_upload doesn't show another user's upload request", async () => {
  const ada = await createUser();
  const bob = await createUser();
  const started = JSON.parse(
    (await callTool(ada, "start_draft", { title: "Lease" })).text,
  ) as { uploadId: string };
  const result = await callTool(bob, "get_upload", {
    uploadId: started.uploadId,
  });

  assert.equal(result.isError, true);
  assert.equal(result.text, "Upload request not found.");
});
