import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";
import { ZodError } from "zod";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import { correctSentEnvelopeSigner } from "./envelopes.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import type { StorageService } from "./services/storage.ts";
import { exportSignerData } from "./signer-data.ts";
import {
  recordSignerConsent,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// What a signer gives for the Name, Job title and Company boxes: how the
// boxes fill, what is kept and what is refused, against a real Postgres.
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function recordingEmailService() {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      sent.push(message);

      return { accepted: [message.to], messageId: "m-1", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };

  return { sent, service };
}

function stubStorage(): StorageService {
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };

  return {
    deleteObject: async () => undefined,
    getObject: refuse,
    getObjectStream: refuse,
    headObject: refuse,
    putObject: async ({ key }) => ({ bucketName: "test", key }),
  };
}

type BoxType = "company" | "job_title" | "name" | "signature";

/** A sent envelope with Jordan Lee as the one signer, holding these boxes. */
async function sendEnvelope(
  boxes: Array<{ required?: boolean; type: BoxType }>,
) {
  const userId = randomUUID();
  const ownerEmail = `${userId}@example.test`;
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const link = await issueSigningLink({ expiresInSeconds: 30 * DAY });
  const email = `${signerId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, ownerEmail],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at
      ) values (
        $1, $2, 'Lease', 'sent', $3, 'lease.pdf', 10, 1, $4, $5, $6
      )
    `,
    [
      envelopeId,
      userId,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      unixNow() - 60,
      unixNow() + 30 * DAY,
    ],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Jordan Lee', $3, 1, 'notified', $4, $5, $6)
    `,
    [signerId, envelopeId, email, link.tokenHash, link.exp, unixNow()],
  );

  // A second signer still to come, so signing here does not seal the file.
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Casey Second', $3, 2, 'pending')
    `,
    [randomUUID(), envelopeId, `${randomUUID()}@example.test`],
  );

  const fieldIds: string[] = [];

  for (const [index, box] of boxes.entries()) {
    const fieldId = randomUUID();

    fieldIds.push(fieldId);
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height,
          required
        ) values ($1, $2, $3, $4, 1, 0.1, $5, 0.2, 0.03, $6)
      `,
      [
        fieldId,
        envelopeId,
        signerId,
        box.type,
        0.1 + index * 0.05,
        box.required ?? true,
      ],
    );
  }

  await consent(link.token);

  return {
    email,
    envelopeId,
    fieldIds,
    signerId,
    token: link.token,
    userId,
  };
}

function consent(token: string) {
  return recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
}

function submit(
  token: string,
  signatureFieldId: string | undefined,
  signerDetails?: unknown,
) {
  return submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: signatureFieldId
        ? [
            {
              fieldId: signatureFieldId,
              imageDataUrl: DRAWN_SIGNATURE,
              inputMethod: "drawn",
              type: "signature",
            },
          ]
        : [],
      ...(signerDetails === undefined ? {} : { signerDetails }),
    },
    {
      database,
      emailService: recordingEmailService().service,
      storageService: stubStorage(),
    },
  );
}

async function readFields(envelopeId: string) {
  const result = await database.query<{
    input_method: string | null;
    submitted_at: string | null;
    type: string;
    value: string | null;
  }>(
    `
      select type, value, input_method, submitted_at
      from fields
      where envelope_id = $1
      order by y
    `,
    [envelopeId],
  );

  return result.rows;
}

async function readSigner(signerId: string) {
  const result = await database.query<{
    company: string | null;
    job_title: string | null;
    status: string;
  }>(`select company, job_title, status from signers where id = $1`, [
    signerId,
  ]);

  return result.rows[0]!;
}

async function signedMetadata(envelopeId: string) {
  const result = await database.query<{ metadata: Record<string, unknown> }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'signed'`,
    [envelopeId],
  );

  assert.equal(result.rows.length, 1);

  return result.rows[0]!.metadata;
}

const FIRST_SCENARIO = [
  { type: "name" },
  { type: "job_title" },
  { type: "company" },
  { type: "company" },
  { type: "signature" },
] as const;

async function signFirstScenario() {
  const sent = await sendEnvelope([...FIRST_SCENARIO]);

  await submit(sent.token, sent.fieldIds[4], {
    company: "Acme Ltd",
    jobTitle: "Head of Operations",
  });

  return sent;
}

test("every detail box fills from one answer", async () => {
  const sent = await signFirstScenario();
  const fields = await readFields(sent.envelopeId);

  assert.deepEqual(
    fields.slice(0, 4).map((row) => [row.type, row.value, row.input_method]),
    [
      ["name", "Jordan Lee", "auto"],
      ["job_title", "Head of Operations", "auto"],
      ["company", "Acme Ltd", "auto"],
      ["company", "Acme Ltd", "auto"],
    ],
  );
  assert.ok(fields.slice(0, 4).every((row) => row.submitted_at !== null));

  const signer = await readSigner(sent.signerId);

  assert.equal(signer.job_title, "Head of Operations");
  assert.equal(signer.company, "Acme Ltd");

  const metadata = await signedMetadata(sent.envelopeId);

  assert.equal(metadata.jobTitle, "Head of Operations");
  assert.equal(metadata.company, "Acme Ltd");
});

test("a missing required detail is refused", async () => {
  const sent = await sendEnvelope([
    { required: true, type: "company" },
    { type: "signature" },
  ]);

  await assert.rejects(submit(sent.token, sent.fieldIds[1]), (error) => {
    assert.ok(error instanceof SigningMutationError);
    assert.equal(
      error.message,
      "Complete all required fields before finishing.",
    );
    return true;
  });
  assert.equal((await readSigner(sent.signerId)).status, "notified");
});

test("a whitespace-only detail is refused", async () => {
  const sent = await sendEnvelope([
    { required: true, type: "company" },
    { type: "signature" },
  ]);

  // The schema turns this away before the signing code sees it.
  await assert.rejects(
    submit(sent.token, sent.fieldIds[1], { company: "   " }),
    (error) => error instanceof ZodError,
  );
  assert.equal((await readSigner(sent.signerId)).status, "notified");
});

test("an optional detail may be left out", async () => {
  const sent = await sendEnvelope([
    { required: false, type: "job_title" },
    { type: "signature" },
  ]);

  await submit(sent.token, sent.fieldIds[1]);

  const [box] = await readFields(sent.envelopeId);

  assert.equal(box?.value, null);
  assert.equal(box?.submitted_at, null);
  assert.equal(box?.input_method, null);
  assert.equal((await readSigner(sent.signerId)).job_title, null);
  assert.equal("jobTitle" in (await signedMetadata(sent.envelopeId)), false);
});

test("a detail with no box is not kept", async () => {
  const sent = await sendEnvelope([{ type: "signature" }]);

  await submit(sent.token, sent.fieldIds[0], { jobTitle: "CFO" });

  assert.equal((await readSigner(sent.signerId)).job_title, null);
  assert.equal("jobTitle" in (await signedMetadata(sent.envelopeId)), false);
});

test("the signer cannot change their name", async () => {
  const sent = await sendEnvelope([{ type: "name" }, { type: "signature" }]);

  await submit(sent.token, sent.fieldIds[1], {
    name: "Someone Else",
  });

  const [box] = await readFields(sent.envelopeId);

  assert.equal(box?.value, "Jordan Lee");
});

test("a corrected name is the one on the box", async () => {
  const sent = await sendEnvelope([{ type: "name" }, { type: "signature" }]);
  const { sent: emails, service } = recordingEmailService();

  await correctSentEnvelopeSigner(
    sent.userId,
    sent.envelopeId,
    sent.signerId,
    { name: "Jordan A. Lee" },
    {
      ipAddress: "203.0.113.8",
      senderEmail: "sam@example.test",
      senderName: "Sam Sender",
      userAgent: "test",
    },
    { database, emailService: service },
  );

  // The correction replaced the link, so the signer comes in on the new one.
  const newToken = emails[0]?.textBody.match(/\/sign\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(newToken);
  await consent(newToken);
  await submit(newToken, sent.fieldIds[1]);

  const [box] = await readFields(sent.envelopeId);

  assert.equal(box?.value, "Jordan A. Lee");
});

test("the signer-data export includes the details", async () => {
  const sent = await signFirstScenario();
  const exported = await exportSignerData(sent.email, database);

  assert.equal(exported.envelopes.length, 1);
  assert.equal(exported.envelopes[0]?.jobTitle, "Head of Operations");
  assert.equal(exported.envelopes[0]?.company, "Acme Ltd");
});
