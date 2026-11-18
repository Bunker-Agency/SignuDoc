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
import { createDraftEnvelope } from "../../envelopes.ts";
import { createStorageService } from "../../services/storage.ts";
import type { AssistantContext } from "../guard.ts";
import { ASSISTANT_TEST_BASE_URL } from "../test-support.ts";
import { prepareAssistantTestEnvironment } from "../test-support.ts";
import type { buildAssistantServer as BuildServer } from "../server.ts";

// The read tools, called through a real MCP client against a real
// Postgres. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let buildAssistantServer: typeof BuildServer;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-assistant-tools-"));

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
  ({ buildAssistantServer } = await import("../server.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@tools.example.test'`,
  );
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(name: string): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@tools.example.test`;

  await database.query(
    `insert into public."user" (id, name, email, "emailVerified", role) values ($1, $2, $3, true, 'user')`,
    [userId, name, userEmail],
  );

  return {
    clientId: "client-1",
    clientName: "Test assistant",
    scopes: ["envelopes:read", "drafts:write"],
    userEmail,
    userId,
    userName: name,
  };
}

async function createDraft(userId: string, title: string): Promise<string> {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: "small.pdf",
      },
      title,
    },
    {
      database,
      storageService: createStorageService({
        env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
      }),
    },
  );

  return draft.envelope.id;
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

test("list_envelopes returns only the caller's envelopes", async () => {
  const ada = await createUser("Ada");
  const bob = await createUser("Bob");
  const adaDraft = await createDraft(ada.userId, "Ada's lease");

  await createDraft(bob.userId, "Bob's secret");

  const result = await callTool(ada, "list_envelopes");

  assert.equal(result.isError, false);

  const body = JSON.parse(result.text) as {
    envelopes: Array<{ id: string; title: string; signers: unknown[] }>;
    hasMore: boolean;
    page: number;
  };

  assert.deepEqual(
    body.envelopes.map((envelope) => envelope.id),
    [adaDraft],
  );
  assert.equal(body.envelopes[0]?.title, "Ada's lease");
  assert.deepEqual(body.envelopes[0]?.signers, []);
  assert.equal(body.page, 1);
  assert.equal(body.hasMore, false);
  assert.ok(!result.text.includes("Bob's secret"));
});

test("list_envelopes says when there are more", async () => {
  const ada = await createUser("Ada");

  await createDraft(ada.userId, "One");
  await createDraft(ada.userId, "Two");

  const result = await callTool(ada, "list_envelopes", { limit: 1 });
  const body = JSON.parse(result.text) as {
    envelopes: unknown[];
    hasMore: boolean;
  };

  assert.equal(body.envelopes.length, 1);
  assert.equal(body.hasMore, true);
});

test("get_envelope refuses another user's envelope", async () => {
  const ada = await createUser("Ada");
  const bob = await createUser("Bob");
  const bobDraft = await createDraft(bob.userId, "Bob's secret");
  const result = await callTool(ada, "get_envelope", {
    envelopeId: bobDraft,
  });

  assert.equal(result.isError, true);
  assert.equal(result.text, "Envelope not found.");
});

test("get_envelope returns review and prepare links for a draft", async () => {
  const ada = await createUser("Ada");
  const draft = await createDraft(ada.userId, "Ada's lease");
  const result = await callTool(ada, "get_envelope", { envelopeId: draft });

  assert.equal(result.isError, false);

  const body = JSON.parse(result.text) as {
    pageCount: number;
    reviewUrl: string;
    prepareUrl: string;
    status: string;
    title: string;
  };

  assert.equal(body.title, "Ada's lease");
  assert.equal(body.status, "draft");
  assert.equal(body.pageCount, 1);
  assert.equal(
    body.reviewUrl,
    `${ASSISTANT_TEST_BASE_URL}/envelopes/${draft}/review`,
  );
  assert.equal(
    body.prepareUrl,
    `${ASSISTANT_TEST_BASE_URL}/envelopes/${draft}/prepare`,
  );
});
