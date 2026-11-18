import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnyObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ZodError } from "zod";

import { EnvelopeMutationError } from "../envelopes.ts";
import { logRouteError } from "../security/logging.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "../security/route-controls.ts";
import { getRequestPathname } from "../security/request.ts";
import { DocumentImportError } from "../services/document-import.ts";
import { TemplateError } from "../templates.ts";
import type { AssistantContext } from "./guard.ts";
import { DRAFT_TOOLS } from "./tools/drafts.ts";
import { ENVELOPE_TOOLS } from "./tools/envelopes.ts";
import { FIELD_TOOLS } from "./tools/fields.ts";
import { type AssistantTool, AssistantToolError } from "./tools/shared.ts";
import { UPLOAD_TOOLS } from "./tools/uploads.ts";

export { type AssistantTool, draftLinks } from "./tools/shared.ts";

// The MCP server an assistant talks to. One is built per request, for the
// sender and assistant the token stands for, and every tool it offers acts
// only for that sender.

/**
 * Every tool the server offers. Each tool file exports its own list; a new
 * file's list is added here.
 */
export const ASSISTANT_TOOLS: Array<AssistantTool<unknown, unknown>> = [
  ...ENVELOPE_TOOLS,
  ...UPLOAD_TOOLS,
  ...FIELD_TOOLS,
  ...DRAFT_TOOLS,
];

const SERVER_INFO = { name: "SignuDoc", version: "1.0.0" };

const SERVER_INSTRUCTIONS =
  "SignuDoc is an e-signature service. These tools read and prepare the sender's envelopes. Nothing here sends a document or emails anyone: the sender reviews and sends every envelope in SignuDoc themselves.";

type ToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ text, type: "text" }], ...(isError ? { isError } : {}) };
}

/** What a ZodError says, in one line the assistant can act on. */
function describeValidationError(error: ZodError): string {
  const issues = error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");

  return `Invalid input. ${issues}`;
}

async function runTool(
  tool: AssistantTool<unknown, unknown>,
  context: AssistantContext,
  rawInput: unknown,
  request: Request,
): Promise<ToolResult> {
  // The scope comes first: a tool the sender did not grant never runs.
  if (!context.scopes.includes(tool.scope)) {
    return textResult(
      `This connection was not given the ${tool.scope} permission, so it cannot use ${tool.name}. The sender can connect again and approve it.`,
      true,
    );
  }

  const limited = await applyRateLimit({
    category: `assistant_${tool.name}`,
    key: buildRateLimitKey(["assistant", tool.name, context.userId]),
    limit: tool.rateLimit.limit,
    message: "Too many requests. Wait a little and try again.",
    request,
    userId: context.userId,
    windowMs: tool.rateLimit.windowMs,
  });

  if (limited) {
    return textResult("Too many requests. Wait a little and try again.", true);
  }

  try {
    const input = tool.input.parse(rawInput ?? {});
    const output = await tool.run(context, input, request);

    return textResult(JSON.stringify(output));
  } catch (error) {
    if (error instanceof ZodError) {
      return textResult(describeValidationError(error), true);
    }

    if (
      error instanceof AssistantToolError ||
      error instanceof EnvelopeMutationError ||
      error instanceof TemplateError ||
      error instanceof DocumentImportError
    ) {
      return textResult(error.message, true);
    }

    // Anything else may carry internals. It goes to the log, and the
    // assistant gets a message that says nothing about it.
    logRouteError(error, {
      category: "assistant_tool_error",
      message: "An AI assistant's tool call failed.",
      metadata: { clientId: context.clientId, tool: tool.name },
      path: getRequestPathname(request),
      userId: context.userId,
    });

    return textResult(
      "Something went wrong on SignuDoc's side. Try again in a moment.",
      true,
    );
  }
}

/** The server for one request, offering every tool in ASSISTANT_TOOLS. */
export function buildAssistantServer(
  context: AssistantContext,
  request: Request,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });

  for (const tool of ASSISTANT_TOOLS) {
    server.registerTool(
      tool.name,
      {
        annotations: {
          openWorldHint: false,
          readOnlyHint: tool.scope === "envelopes:read",
        },
        description: tool.description,
        inputSchema: tool.input as unknown as AnyObjectSchema,
      },
      async (input: unknown) => runTool(tool, context, input, request),
    );
  }

  return server;
}
