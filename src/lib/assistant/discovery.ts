import { getAuth } from "../auth/server.ts";
import { assistantConnectionsOn, isDiscoveryPath } from "./oauth.ts";

// The OAuth authorization server's metadata (RFC 8414), for AI assistants
// working out how to connect. The issuer is <BETTER_AUTH_URL>/api/auth, so
// clients ask at /.well-known/oauth-authorization-server/api/auth; the root
// address is answered too, for clients that ask there. Both give the
// metadata the OAuth provider serves at its own address, and both are 404
// while assistant connections are off.

const METADATA_PATH = "/api/auth/.well-known/oauth-authorization-server";

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

export async function serveAuthorizationServerMetadata(
  request: Request,
): Promise<Response> {
  if (!(await assistantConnectionsOn())) {
    return notFound();
  }

  return getAuth().handler(
    new Request(new URL(METADATA_PATH, request.url), {
      headers: request.headers,
      method: request.method,
    }),
  );
}

/**
 * For the auth API route: a 404 for any discovery document while assistant
 * connections are off, or null to carry on. The auth server refuses them as
 * well; this keeps the refusal visible where the route is.
 */
export async function refuseDiscoveryWhileOff(
  request: Request,
): Promise<Response | null> {
  if (!isDiscoveryPath(new URL(request.url).pathname)) {
    return null;
  }

  return (await assistantConnectionsOn()) ? null : notFound();
}
