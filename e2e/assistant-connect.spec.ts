import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

import { e2eDatabaseUrl, e2eSetupToken } from "../playwright.config";
import { writeSamplePdf } from "./support/sample-pdf";
import { readFile } from "node:fs/promises";

// An AI assistant connects the way Claude Code does, prepares a draft, and
// the sender finds it waiting. The assistant's side is plain HTTP (register,
// authorize, token, MCP); the sender's side runs in a real browser: sign-in
// hand-off, consent screen, the upload page (signed out, through sign-in and
// back, then the drop), review page and Connected apps. The upload API is
// covered with a plain PUT. Not covered: the Vercel Blob direct-upload path.
//
// It makes its own administrator and sender in the database, so it works on
// whatever the earlier specs left behind. The playwright config runs it
// after them, because it would otherwise claim the install first.

const PASSWORD = "correct horse battery staple 42";
const LOOPBACK = "http://127.0.0.1:33419/callback";
const CLIENT_NAME = "E2E Claude Code";
const TITLE = "Lease for unit 4B";

type RpcResult = {
  result?: { content?: Array<{ text: string }>; isError?: boolean };
};

async function insertUser(
  database: pg.Pool,
  input: { email: string; name: string; role: "admin" | "user" },
) {
  const id = randomUUID();

  await database.query(
    `insert into public."user" (id, name, email, "emailVerified", role) values ($1, $2, $3, true, $4)`,
    [id, input.name, input.email, input.role],
  );
  await database.query(
    `insert into public.account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await hashPassword(PASSWORD)],
  );
}

test("an assistant connects, prepares a draft, and the sender sees it", async ({
  baseURL,
  browser,
  page,
  request,
}, testInfo) => {
  const origin = baseURL ?? "";
  const runId = String(Date.now());
  const adminEmail = `assist-admin+${runId}@example.com`;
  const senderEmail = `assist-sender+${runId}@example.com`;
  const signerEmail = `assist-signer+${runId}@example.com`;
  const database = new pg.Pool({ connectionString: e2eDatabaseUrl });

  try {
    // Standing alone, nobody has set the install up. Whoever has, the
    // test's own people come next.
    const admins = await database.query(
      `select 1 from public."user" where role = 'admin' limit 1`,
    );

    if (admins.rowCount === 0) {
      const setup = await request.post("/api/setup", {
        data: {
          email: `assist-setup+${runId}@example.com`,
          fullName: "Sol Setup",
          organizationName: "Assist Test Org",
          password: PASSWORD,
          setupToken: e2eSetupToken,
          supportAddress: `help+${runId}@example.com`,
        },
      });

      expect(setup.status()).toBe(201);
    }

    await insertUser(database, {
      email: adminEmail,
      name: "Ada Admin",
      role: "admin",
    });
    await insertUser(database, {
      email: senderEmail,
      name: "Sam Sender",
      role: "user",
    });

    // The assistant has nothing to connect to until the administrator
    // turns it on.
    const closed = await request.get(
      "/.well-known/oauth-protected-resource/api/mcp",
    );

    expect(closed.status()).toBe(404);

    await test.step("the administrator turns assistant connections on", async () => {
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();

      await adminPage.goto("/login");
      await adminPage.getByLabel("Email").fill(adminEmail);
      await adminPage.getByLabel("Password").fill(PASSWORD);
      await adminPage.getByRole("button", { name: "Log in" }).click();
      await expect(adminPage).toHaveURL(/\/dashboard$/);
      await adminPage.goto("/settings");
      await adminPage
        .getByRole("switch", { name: "AI assistant connections" })
        .click();
      await expect(
        adminPage.getByRole("switch", {
          checked: true,
          name: "AI assistant connections",
        }),
      ).toBeVisible();
      await adminContext.close();
    });

    const discovery = await request.get(
      "/.well-known/oauth-protected-resource/api/mcp",
    );

    expect(discovery.status()).toBe(200);

    // The assistant registers itself.
    const registered = await request.post("/api/auth/oauth2/register", {
      data: {
        client_name: CLIENT_NAME,
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [LOOPBACK],
        response_types: ["code"],
        scope: "envelopes:read drafts:write offline_access",
        token_endpoint_auth_method: "none",
      },
      headers: { origin },
    });

    expect(registered.status()).toBe(201);

    const clientId = String(
      ((await registered.json()) as { client_id: string }).client_id,
    );
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = `${origin}/api/auth/oauth2/authorize?${new URLSearchParams(
      {
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: LOOPBACK,
        resource: `${origin}/api/mcp`,
        response_type: "code",
        scope: "envelopes:read drafts:write offline_access",
        state: "e2e-state",
      },
    ).toString()}`;
    let code = "";

    await test.step("the sender signs in and approves on the consent page", async () => {
      // Nothing listens at the loopback address. The browser is sent there
      // and the test reads the code from the request.
      await page.route("http://127.0.0.1:33419/**", async (route) => {
        code = new URL(route.request().url()).searchParams.get("code") ?? "";
        await route.fulfill({
          body: "<p>The assistant has the code.</p>",
          contentType: "text/html",
          status: 200,
        });
      });

      await page.goto(authorizeUrl);
      await expect(page).toHaveURL(/\/login\?/);
      await page.getByLabel("Email").fill(senderEmail);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Log in" }).click();

      // Signing in picks the request up where it left off.
      await expect(page).toHaveURL(/\/oauth\/consent\?/);
      await expect(page.getByText(CLIENT_NAME)).toBeVisible();
      await expect(page.getByText("as it describes itself")).toBeVisible();
      await expect(page.getByText("It can't send anything.")).toBeVisible();
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForURL(/127\.0\.0\.1:33419\/callback/);
      expect(code).not.toBe("");
      expect(new URL(page.url()).searchParams.get("state")).toBe("e2e-state");
    });

    const tokenResponse = await request.post("/api/auth/oauth2/token", {
      form: {
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: LOOPBACK,
        resource: `${origin}/api/mcp`,
      },
      headers: { origin },
    });

    expect(tokenResponse.status()).toBe(200);

    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token: string;
    };
    let nextId = 1;
    const callRaw = (token: string, name: string, args: object) =>
      request.post("/api/mcp", {
        data: {
          id: (nextId += 1),
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        },
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
      });
    const call = async (name: string, args: object) => {
      const response = await callRaw(accessToken, name, args);

      expect(response.status()).toBe(200);

      const body = (await response.json()) as RpcResult;

      expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);

      return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<
        string,
        unknown
      >;
    };

    const started = (await call("start_draft", { title: TITLE })) as {
      uploadApiUrl: string;
      uploadId: string;
    };

    await test.step("the PDF goes to the one-time link", async () => {
      const pdfPath = await writeSamplePdf(testInfo.outputPath("lease.pdf"));
      const upload = await request.put(started.uploadApiUrl, {
        data: await readFile(pdfPath),
        headers: { "content-type": "application/pdf" },
      });

      expect(upload.status()).toBeLessThan(300);

      // The link works once.
      const again = await request.put(started.uploadApiUrl, {
        data: await readFile(pdfPath),
        headers: { "content-type": "application/pdf" },
      });

      expect(again.status()).toBeGreaterThanOrEqual(400);
    });

    await test.step("the upload page: sign in, land back on it, drop the PDF", async () => {
      const viaPage = (await call("start_draft", { title: "Page upload" })) as {
        uploadId: string;
        uploadPageUrl: string;
      };

      // Signed out, the link sends the sender to sign in and back.
      await page.context().clearCookies();
      await page.goto(viaPage.uploadPageUrl);
      await expect(page).toHaveURL(/\/login\?/);
      await page.getByLabel("Email").fill(senderEmail);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page).toHaveURL(new RegExp(`/upload/[^/?]+$`));
      await expect(page.getByLabel("Upload PDF")).toBeAttached();

      await page
        .getByLabel("Upload PDF")
        .setInputFiles(await writeSamplePdf(testInfo.outputPath("page.pdf")));
      await expect(page.getByText(/^Uploaded\./)).toBeVisible();

      const viaPageDone = (await call("get_upload", {
        uploadId: viaPage.uploadId,
      })) as { status: string };

      expect(viaPageDone.status).toBe("done");
    });

    const done = (await call("get_upload", {
      uploadId: started.uploadId,
    })) as { envelopeId: string; reviewUrl: string; status: string };

    expect(done.status).toBe("done");

    await call("set_signers", {
      envelopeId: done.envelopeId,
      signers: [{ email: signerEmail, name: "Tess Tenant" }],
    });

    const text = (await call("get_document_text", {
      envelopeId: done.envelopeId,
    })) as { hasTextLayer: boolean };

    expect(text.hasTextLayer).toBe(true);

    const placed = (await call("place_fields", {
      envelopeId: done.envelopeId,
      fields: [
        {
          anchor: { page: 1, position: "right", text: "Signature:" },
          signer: signerEmail,
          type: "signature",
        },
        {
          anchor: { page: 2, position: "right", text: "Signature:" },
          signer: signerEmail,
          type: "signature",
        },
      ],
    })) as { placed: unknown[] };

    expect(placed.placed).toHaveLength(2);

    await test.step("the sender finds the draft waiting for review", async () => {
      await page.goto(done.reviewUrl);
      await expect(page.getByText(TITLE).first()).toBeVisible();
      await expect(page.getByText(signerEmail).first()).toBeVisible();
      await expect(page.getByText("(2 fields)")).toBeVisible();
    });

    await test.step("Connected apps lists the assistant, and Revoke ends it", async () => {
      await page.goto("/settings");

      const row = page.getByRole("listitem").filter({ hasText: CLIENT_NAME });

      await expect(row).toBeVisible();
      await row.getByRole("button", { name: `Revoke ${CLIENT_NAME}` }).click();
      await expect(
        page.getByText("No assistants are connected."),
      ).toBeVisible();

      const afterRevoke = await callRaw(accessToken, "list_envelopes", {});

      expect(afterRevoke.status()).toBe(401);
    });
  } finally {
    await database.end();
  }
});
