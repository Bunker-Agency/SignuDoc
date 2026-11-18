import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { requireAssistantContext } from "@/lib/assistant/guard";
import { buildAssistantServer } from "@/lib/assistant/server";
import { logRouteError } from "@/lib/security/logging";
import { getRequestPathname } from "@/lib/security/request";

// The endpoint AI assistants talk to (MCP, Streamable HTTP). It keeps no
// session: every request is checked on its own token and answered in full
// by a server built for it, so nothing is held open between requests.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same response, marked so nothing stores it. */
function noStore(response: Response): Response {
  const headers = new Headers(response.headers);

  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function POST(request: Request): Promise<Response> {
  const context = await requireAssistantContext(request);

  if (context instanceof Response) {
    return noStore(context);
  }

  const server = buildAssistantServer(context, request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);

    return noStore(await transport.handleRequest(request));
  } catch (error) {
    logRouteError(error, {
      category: "assistant_mcp_error",
      message: "The MCP endpoint failed.",
      path: getRequestPathname(request),
      userId: context.userId,
    });

    return noStore(
      Response.json(
        {
          error: { code: -32603, message: "Internal error." },
          id: null,
          jsonrpc: "2.0",
        },
        { status: 500 },
      ),
    );
  } finally {
    await server.close().catch(() => undefined);
  }
}

// There is no stream to hold open and no session to end. A GET or DELETE
// from a signed-in assistant is told so; one without a valid token gets
// the sign-in challenge, which is how some clients find out how to connect.
async function notAllowed(request: Request): Promise<Response> {
  const context = await requireAssistantContext(request);

  if (context instanceof Response) {
    return noStore(context);
  }

  return noStore(
    Response.json(
      {
        error: { code: -32000, message: "Method not allowed." },
        id: null,
        jsonrpc: "2.0",
      },
      { headers: { allow: "POST" }, status: 405 },
    ),
  );
}

export const GET = notAllowed;
export const DELETE = notAllowed;
