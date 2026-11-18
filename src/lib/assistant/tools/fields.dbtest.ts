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
  replaceDraftEnvelopeSigners,
} from "../../envelopes.ts";
import { createStorageService } from "../../services/storage.ts";
import { DEFAULT_FIELD_SIZE_FRACTIONS } from "../anchor-placement.ts";
import type { AssistantContext } from "../guard.ts";
import type { buildAssistantServer as BuildServer } from "../server.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  prepareAssistantTestEnvironment,
} from "../test-support.ts";

// get_document_text and place_fields, called through a real MCP client
// against a real Postgres. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let storageDir: string;
let sourcePdf: Uint8Array;
let blankPdf: Uint8Array;
let buildAssistantServer: typeof BuildServer;

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-assistant-fields-"));
  // The tools read the PDF through the default storage service.
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);

  page.drawText("Client signature", { font, size: 12, x: 72, y: 700 });
  page.drawText("Date:", { font, size: 12, x: 72, y: 600 });
  sourcePdf = await pdf.save();

  const blank = await PDFDocument.create();

  blank.addPage([612, 792]);
  blankPdf = await blank.save();
  ({ buildAssistantServer } = await import("../server.ts"));
});

beforeEach(async () => {
  await database.query("delete from public.rate_limits");
});

after(async () => {
  await database.query(
    `delete from public."user" where email like '%@fields.example.test'`,
  );
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

async function createUser(name: string): Promise<AssistantContext> {
  const userId = randomUUID();
  const userEmail = `${userId}@fields.example.test`;

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

async function createDraft(
  userId: string,
  pdfBytes: Uint8Array = sourcePdf,
): Promise<string> {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: pdfBytes,
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

  await replaceDraftEnvelopeSigners(
    userId,
    draft.envelope.id,
    {
      signers: [{ email: "dana@example.com", name: "Dana", order: 1 }],
    },
    database,
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

const signatureAtLabel = {
  anchor: { position: "right", text: "Client signature" },
  signer: "dana@example.com",
  type: "signature",
};

test("place_fields saves fields at the anchors", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [
      signatureAtLabel,
      {
        anchor: { position: "right", text: "date:" },
        signer: "DANA@example.com",
        type: "date",
      },
    ],
  });

  assert.equal(result.isError, false, result.text);

  const body = JSON.parse(result.text) as {
    placed: Array<{
      heightPt: number;
      page: number;
      signerEmail: string;
      type: string;
      widthPt: number;
    }>;
    prepareUrl: string;
    reviewUrl: string;
  };

  assert.deepEqual(body.placed, [
    {
      heightPt: 55.4,
      page: 1,
      signerEmail: "dana@example.com",
      type: "signature",
      widthPt: 146.9,
    },
    {
      heightPt: 19.2,
      page: 1,
      signerEmail: "dana@example.com",
      type: "date",
      widthPt: 73.4,
    },
  ]);
  assert.ok(body.prepareUrl.endsWith(`/envelopes/${envelopeId}/prepare`));

  const saved = await getPrepareEnvelopeDataForUser(ada.userId, envelopeId, {
    database,
  });
  const signature = saved?.fields.find((field) => field.type === "signature");

  assert.equal(saved?.fields.length, 2);
  assert.ok(signature);
  // The label ends at about x = 72 + its width; the field starts after it.
  assert.ok(signature.x > (72 + 50) / 612 && signature.x < 0.5);
});

test("place_fields places Name, Job title and Company boxes at Text's size", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [
      { ...signatureAtLabel, type: "name" },
      {
        anchor: { position: "below", text: "Client signature" },
        required: false,
        signer: "dana@example.com",
        type: "job_title",
      },
      {
        anchor: { position: "right", text: "Date:" },
        signer: "dana@example.com",
        type: "company",
      },
    ],
  });

  assert.equal(result.isError, false, result.text);

  const saved = await getPrepareEnvelopeDataForUser(ada.userId, envelopeId, {
    database,
  });
  const byType = new Map(saved?.fields.map((field) => [field.type, field]));

  assert.deepEqual([...byType.keys()].sort(), ["company", "job_title", "name"]);
  assert.equal(byType.get("name")?.required, true);
  assert.equal(byType.get("job_title")?.required, false);
  assert.equal(
    byType.get("company")?.width,
    DEFAULT_FIELD_SIZE_FRACTIONS.text.width,
  );
});

test("place_fields takes a width and height in points", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [
      {
        anchor: { position: "right", text: "Date:" },
        height: 20,
        signer: "dana@example.com",
        type: "text",
        width: 153,
      },
    ],
  });

  assert.equal(result.isError, false, result.text);

  const body = JSON.parse(result.text) as {
    placed: Array<{ heightPt: number; widthPt: number }>;
  };

  assert.equal(body.placed[0]?.widthPt, 153);
  assert.equal(body.placed[0]?.heightPt, 20);

  const saved = await getPrepareEnvelopeDataForUser(ada.userId, envelopeId, {
    database,
  });
  const text = saved?.fields[0];

  assert.ok(text);
  assert.ok(Math.abs(text.width - 153 / 612) < 1e-5);
  assert.ok(Math.abs(text.height - 20 / 792) < 1e-5);
});

test("place_fields refuses an optional Name box", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [{ ...signatureAtLabel, required: false, type: "name" }],
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /name fields are always required/);
});

test("place_fields saves nothing when one anchor is missing", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId);

  assert.equal(
    (
      await callTool(ada, "place_fields", {
        envelopeId,
        fields: [signatureAtLabel],
      })
    ).isError,
    false,
  );

  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [
      { ...signatureAtLabel, type: "initials" },
      {
        anchor: { position: "right", text: "Witness" },
        signer: "dana@example.com",
        type: "text",
      },
      { ...signatureAtLabel, signer: "nobody@example.com" },
    ],
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /Couldn't find "Witness" in the document\./);
  assert.match(result.text, /No signer matches "nobody@example\.com"\./);

  const saved = await getPrepareEnvelopeDataForUser(ada.userId, envelopeId, {
    database,
  });

  assert.deepEqual(
    saved?.fields.map((field) => field.type),
    ["signature"],
  );
});

test("place_fields says so when the PDF has no text", async () => {
  const ada = await createUser("Ada");
  const envelopeId = await createDraft(ada.userId, blankPdf);
  const result = await callTool(ada, "place_fields", {
    envelopeId,
    fields: [signatureAtLabel],
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /This page has no text, so fields can't be placed/);
});

test("get_document_text returns page text and refuses a sent envelope", async () => {
  const ada = await createUser("Ada");
  const bob = await createUser("Bob");
  const envelopeId = await createDraft(ada.userId);
  const result = await callTool(ada, "get_document_text", { envelopeId });

  assert.equal(result.isError, false, result.text);

  const body = JSON.parse(result.text) as {
    hasTextLayer: boolean;
    pages: Array<{
      heightPt: number;
      pageNumber: number;
      text: string;
      widthPt: number;
    }>;
    truncated: boolean;
  };

  assert.equal(body.hasTextLayer, true);
  assert.equal(body.truncated, false);
  assert.equal(body.pages[0]?.pageNumber, 1);
  assert.equal(body.pages[0]?.widthPt, 612);
  assert.equal(body.pages[0]?.heightPt, 792);
  assert.match(body.pages[0]?.text ?? "", /Client signature/);

  const blankId = await createDraft(ada.userId, blankPdf);
  const blank = JSON.parse(
    (await callTool(ada, "get_document_text", { envelopeId: blankId })).text,
  ) as { hasTextLayer: boolean };

  assert.equal(blank.hasTextLayer, false);

  const other = await callTool(bob, "get_document_text", { envelopeId });

  assert.equal(other.isError, true);
  assert.match(other.text, /Envelope not found/);

  await database.query(
    `update envelopes set status = 'sent', sent_at = 1 where id = $1`,
    [envelopeId],
  );

  const sent = await callTool(ada, "get_document_text", { envelopeId });

  assert.equal(sent.isError, true);
  assert.match(sent.text, /Only drafts can be read/);
});
