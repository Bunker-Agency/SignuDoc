import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type pg from "pg";

import { replaceDbPoolForTests } from "../../db/connection.ts";
import { openTestDatabase } from "../../db/test-database.ts";
import {
  createDraftEnvelope,
  getPrepareEnvelopeDataForUser,
  listCopyRecipientsForEnvelopeId,
} from "../../envelopes.ts";
import { createStorageService } from "../../services/storage.ts";
import type { AssistantContext } from "../guard.ts";
import type { buildAssistantServer as BuildServer } from "../server.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  prepareAssistantTestEnvironment,
} from "../test-support.ts";

// set_signers and delete_draft, called through a real MCP client against a
// real Postgres. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let buildAssistantServer: typeof BuildServer;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-assistant-drafts-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);

  page.drawText("Client signature", { font, size: 12, x: 72, y: 700 });
  page.drawText("Counter signature", { font, size: 12, x: 72, y: 600 });
  sourcePdf = await pdf.save();
  ({ buildAssistantServer } = await import("../server.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@drafts.example.test'`,
  );
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(name: string): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@drafts.example.test`;

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

async function createDraft(userId: string): Promise<string> {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: "contract.pdf",
      },
      title: "Contract",
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

type SignersBody = {
  prepareUrl: string;
  reviewUrl: string;
  signers: Array<{
    email: string;
    id: string;
    name: string;
    signOrder: number;
  }>;
};

test("set_signers adds signers in order and returns their IDs", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "set_signers", {
    copyRecipients: [{ email: "cc@example.com", name: "Carl" }],
    envelopeId,
    signers: [
      { email: "dana@example.com", name: "Dana" },
      { accessCode: "1234", email: "eli@example.com", name: "Eli" },
    ],
  });

  assert.equal(result.isError, false, result.text);

  const body = JSON.parse(result.text) as SignersBody;

  assert.deepEqual(
    body.signers.map(({ email, name, signOrder }) => ({
      email,
      name,
      signOrder,
    })),
    [
      { email: "dana@example.com", name: "Dana", signOrder: 1 },
      { email: "eli@example.com", name: "Eli", signOrder: 2 },
    ],
  );
  assert.ok(body.signers.every((signer) => signer.id.length > 0));
  assert.ok(body.prepareUrl.endsWith(`/envelopes/${envelopeId}/prepare`));

  const copies = await listCopyRecipientsForEnvelopeId(envelopeId, database);

  assert.deepEqual(
    copies.map((copy) => copy.email),
    ["cc@example.com"],
  );
});

test("set_signers keeps the fields of an unchanged signer", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const first = JSON.parse(
    (
      await callTool(ada, "set_signers", {
        copyRecipients: [{ email: "Cc@example.com", name: "Carl" }],
        envelopeId,
        signers: [
          { email: "dana@example.com", name: "Dana" },
          { email: "eli@example.com", name: "Eli" },
        ],
      })
    ).text,
  ) as SignersBody;
  const placed = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [
      {
        anchor: { position: "right", text: "Client signature" },
        signer: "dana@example.com",
        type: "signature",
      },
      {
        anchor: { position: "right", text: "Counter signature" },
        signer: "eli@example.com",
        type: "signature",
      },
    ],
  });

  assert.equal(placed.isError, false, placed.text);

  const copiesBefore = await listCopyRecipientsForEnvelopeId(
    envelopeId,
    database,
  );
  const second = await callTool(ada, "set_signers", {
    copyRecipients: [{ email: "cc@example.com", name: "Carl C" }],
    envelopeId,
    signers: [
      { email: "DANA@example.com", name: "Dana" },
      { email: "eli@example.com", name: "Eli Renamed" },
    ],
  });

  assert.equal(second.isError, false, second.text);

  const body = JSON.parse(second.text) as SignersBody;

  assert.deepEqual(
    body.signers.map((signer) => signer.id),
    first.signers.map((signer) => signer.id),
  );
  assert.equal(body.signers[1]?.name, "Eli Renamed");

  const saved = await getPrepareEnvelopeDataForUser(ada.userId, envelopeId, {
    database,
  });

  assert.equal(saved?.fields.length, 2);

  const copiesAfter = await listCopyRecipientsForEnvelopeId(
    envelopeId,
    database,
  );

  assert.equal(copiesAfter[0]?.id, copiesBefore[0]?.id);
  assert.equal(copiesAfter[0]?.name, "Carl C");
});

test("set_signers accepts a Part 11 signature meaning", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "set_signers", {
    envelopeId,
    signers: [
      {
        email: "dana@example.com",
        name: "Dana",
        requireEmailCode: true,
        signatureMeaning: "approval",
      },
    ],
  });

  assert.equal(result.isError, false, result.text);

  const row = await database.query<{
    require_email_code: boolean;
    signature_meaning: string | null;
  }>(
    `select require_email_code, signature_meaning from signers where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(row.rows[0]?.signature_meaning, "approval");
  assert.equal(row.rows[0]?.require_email_code, true);

  const bad = await callTool(ada, "set_signers", {
    envelopeId,
    signers: [
      { email: "dana@example.com", name: "Dana", signatureMeaning: "nope" },
    ],
  });

  assert.equal(bad.isError, true);
});

test("delete_draft deletes the caller's draft and refuses a sent one", async () => {
  const ada = await createUser("Ada");
  const draftId = await createDraft(ada.userId);
  const result = await callTool(ada, "delete_draft", { envelopeId: draftId });

  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), { deleted: true });

  const gone = await database.query(`select 1 from envelopes where id = $1`, [
    draftId,
  ]);

  assert.equal(gone.rowCount, 0);

  const sentId = await createDraft(ada.userId);

  await database.query(
    `update envelopes set status = 'sent', sent_at = 1 where id = $1`,
    [sentId],
  );

  const sent = await callTool(ada, "delete_draft", { envelopeId: sentId });

  assert.equal(sent.isError, true);
  assert.match(sent.text, /Only draft envelopes can be deleted\./);

  const sentSigners = await callTool(ada, "set_signers", {
    envelopeId: sentId,
    signers: [{ email: "dana@example.com", name: "Dana" }],
  });

  assert.equal(sentSigners.isError, true);
  assert.match(sentSigners.text, /Only draft envelopes can be updated\./);
});

test("delete_draft refuses another user's draft", async () => {
  const ada = await createUser("Ada");
  const bob = await createUser("Bob");
  const draftId = await createDraft(ada.userId);
  const result = await callTool(bob, "delete_draft", { envelopeId: draftId });

  assert.equal(result.isError, true);
  assert.match(result.text, /Envelope not found/);

  const setResult = await callTool(bob, "set_signers", {
    envelopeId: draftId,
    signers: [{ email: "dana@example.com", name: "Dana" }],
  });

  assert.equal(setResult.isError, true);
  assert.match(setResult.text, /Envelope not found/);

  const still = await database.query(`select 1 from envelopes where id = $1`, [
    draftId,
  ]);

  assert.equal(still.rowCount, 1);
});
