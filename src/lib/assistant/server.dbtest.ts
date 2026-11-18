import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type pg from "pg";
import { z } from "zod";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import type { AssistantContext } from "./guard.ts";
import type {
  ASSISTANT_TOOLS as Tools,
  AssistantTool,
  buildAssistantServer as BuildServer,
  draftLinks as DraftLinks,
} from "./server.ts";
import {
  ASSISTANT_TEST_BASE_URL,
  createAssistantTestUser,
  issueAssistantToken,
  prepareAssistantTestEnvironment,
  seedAssistantResource,
} from "./test-support.ts";

// The MCP endpoint, its discovery document and the tool framework, against
// a real Postgres and real tokens. Run with `npm run test:db`.

prepareAssistantTestEnvironment();

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let ASSISTANT_TOOLS: typeof Tools;
let buildAssistantServer: typeof BuildServer;
let draftLinks: typeof DraftLinks;
let mcpRoute: typeof import("../../app/api/mcp/route.ts");
let metadataRoute: typeof import("../../app/.well-known/oauth-protected-resource/route.ts");
let metadataPathRoute: typeof import("../../app/.well-known/oauth-protected-resource/api/mcp/route.ts");

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  ({ ASSISTANT_TOOLS, buildAssistantServer, draftLinks } =
    await import("./server.ts"));
  mcpRoute = await import("../../app/api/mcp/route.ts");
  metadataRoute =
    await import("../../app/.well-known/oauth-protected-resource/route.ts");
  metadataPathRoute =
    await import("../../app/.well-known/oauth-protected-resource/api/mcp/route.ts");
});

async function clean() {
  await database.query(`truncate public."user" cascade`);
  await database.query(`delete from public."oauthClient"`);
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  invalidateSettingsCache();
}

beforeEach(async () => {
  await clean();
  await seedAssistantResource(database);
});

after(async () => {
  await clean();
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

async function setConnections(on: boolean) {
  await saveSettings({ assistantConnections: on }, database);
  invalidateSettingsCache();
}

function context(scopes: AssistantContext["scopes"]): AssistantContext {
  return {
    clientId: "client-1",
    clientName: "Test assistant",
    scopes,
    userEmail: "pat@example.test",
    userId: randomUUID(),
    userName: "Pat",
  };
}

function stubTool(
  overrides: Partial<AssistantTool<Record<string, never>, unknown>> = {},
): AssistantTool<Record<string, never>, unknown> {
  return {
    description: "A stub.",
    input: z.object({}),
    name: "stub_tool",
    rateLimit: { limit: 100, windowMs: 60_000 },
    run: async () => ({ ok: true }),
    scope: "drafts:write",
    ...overrides,
  };
}

async function callWithStub(
  tool: AssistantTool<Record<string, never>, unknown>,
  scopes: AssistantContext["scopes"],
  caller: AssistantContext = context(scopes),
) {
  ASSISTANT_TOOLS.push(tool as AssistantTool<unknown, unknown>);

  try {
    const server = buildAssistantServer(
      caller,
      new Request(`${ASSISTANT_TEST_BASE_URL}/api/mcp`, { method: "POST" }),
    );
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

    await server.connect(serverSide);
    await client.connect(clientSide);

    try {
      const result = await client.callTool({ arguments: {}, name: tool.name });
      const first = (result.content as Array<{ text: string }>)[0];

      return { isError: result.isError === true, text: first?.text ?? "" };
    } finally {
      await client.close();
    }
  } finally {
    ASSISTANT_TOOLS.pop();
  }
}

function rpc(token: string | undefined, body: unknown, method = "POST") {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };

  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  return new Request(`${ASSISTANT_TEST_BASE_URL}/api/mcp`, {
    body: method === "POST" ? JSON.stringify(body) : undefined,
    headers,
    method,
  });
}

test("a tool needing drafts:write is refused with only envelopes:read", async () => {
  let ran = false;
  const result = await callWithStub(
    stubTool({
      run: async () => {
        ran = true;

        return { ok: true };
      },
    }),
    ["envelopes:read"],
  );

  assert.equal(result.isError, true);
  assert.match(result.text, /drafts:write/);
  assert.equal(ran, false);

  const allowed = await callWithStub(stubTool(), ["drafts:write"]);

  assert.equal(allowed.isError, false);
});

test("a tool's unexpected error is not shown to the assistant", async () => {
  const original = console.error;

  console.error = () => undefined;

  try {
    const result = await callWithStub(
      stubTool({
        run: async () => {
          throw new Error("password authentication failed for user signudoc");
        },
      }),
      ["drafts:write"],
    );

    assert.equal(result.isError, true);
    assert.ok(!result.text.includes("password"));
    assert.match(result.text, /went wrong/i);
  } finally {
    console.error = original;
  }
});

test("a tool is refused once its rate limit is used up", async () => {
  const tool = stubTool({
    name: "limited_tool",
    rateLimit: { limit: 1, windowMs: 60_000 },
  });
  const caller = context(["drafts:write"]);
  const first = await callWithStub(tool, ["drafts:write"], caller);
  const second = await callWithStub(tool, ["drafts:write"], caller);

  assert.equal(first.isError, false);
  assert.equal(second.isError, true);
  assert.match(second.text, /too many/i);
});

test("draftLinks gives absolute review and prepare addresses", () => {
  assert.deepEqual(draftLinks("abc"), {
    prepareUrl: `${ASSISTANT_TEST_BASE_URL}/envelopes/abc/prepare`,
    reviewUrl: `${ASSISTANT_TEST_BASE_URL}/envelopes/abc/review`,
  });
});

test("POST /api/mcp without a token returns 401 with WWW-Authenticate", async () => {
  await setConnections(true);

  const response = await mcpRoute.POST(
    rpc(undefined, { id: 1, jsonrpc: "2.0", method: "tools/list" }),
  );

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/localhost:3998\/\.well-known\/oauth-protected-resource\/api\/mcp"/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("GET and DELETE /api/mcp answer 405 for a connected assistant, and 401 without a token", async () => {
  await setConnections(true);

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  for (const [handler, method] of [
    [mcpRoute.GET, "GET"],
    [mcpRoute.DELETE, "DELETE"],
  ] as const) {
    const refused = await handler(rpc(undefined, null, method));

    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("cache-control"), "no-store");

    const response = await handler(rpc(issued.accessToken, null, method));

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("POST /api/mcp refuses everything while the setting is off", async () => {
  await setConnections(true);

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });

  await setConnections(false);

  const response = await mcpRoute.POST(
    rpc(issued.accessToken, { id: 1, jsonrpc: "2.0", method: "tools/list" }),
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("tools/list over the route lists list_envelopes and get_envelope", async () => {
  await setConnections(true);

  const user = await createAssistantTestUser(database);
  const issued = await issueAssistantToken(database, { userId: user.id });
  const initialize = await mcpRoute.POST(
    rpc(issued.accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    }),
  );

  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get("cache-control"), "no-store");

  const response = await mcpRoute.POST(
    rpc(issued.accessToken, { id: 2, jsonrpc: "2.0", method: "tools/list" }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = (await response.json()) as {
    result: { tools: Array<{ description: string; name: string }> };
  };
  const names = body.result.tools.map((tool) => tool.name);

  assert.ok(names.includes("list_envelopes"));
  assert.ok(names.includes("get_envelope"));

  for (const tool of body.result.tools) {
    assert.match(tool.description, /SignuDoc/);
  }

  // And a call through the route acts for the token's user.
  const called = await mcpRoute.POST(
    rpc(issued.accessToken, {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "list_envelopes" },
    }),
  );
  const callBody = (await called.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };

  assert.notEqual(callBody.result.isError, true);
  assert.deepEqual(JSON.parse(callBody.result.content[0]?.text ?? "{}"), {
    envelopes: [],
    hasMore: false,
    page: 1,
  });
});

test("the protected resource metadata is served at both paths while the setting is on", async () => {
  await setConnections(true);

  for (const handler of [metadataPathRoute.GET, metadataRoute.GET]) {
    const response = await handler();

    assert.equal(response.status, 200);

    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.resource, `${ASSISTANT_TEST_BASE_URL}/api/mcp`);
    assert.deepEqual(body.authorization_servers, [
      `${ASSISTANT_TEST_BASE_URL}/api/auth`,
    ]);
    assert.deepEqual(body.scopes_supported, [
      "envelopes:read",
      "drafts:write",
      "offline_access",
    ]);
  }
});

test("the protected resource metadata is 404 while the setting is off", async () => {
  await setConnections(false);

  for (const handler of [metadataPathRoute.GET, metadataRoute.GET]) {
    const response = await handler();

    assert.equal(response.status, 404);
  }
});
