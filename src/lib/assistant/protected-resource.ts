import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

import { getAuth } from "../auth/server.ts";
import { assistantConnectionsOn, assistantResourceUrl } from "./oauth.ts";

// The protected resource metadata (RFC 9728): how an assistant finds out
// which authorization server to use for /api/mcp, and what it may ask for.
// Served at the path the provider's own 401 challenge names
// (/.well-known/oauth-protected-resource/api/mcp) and at the root. 404
// while assistant connections are off.

export async function serveProtectedResourceMetadata(): Promise<Response> {
  if (!(await assistantConnectionsOn())) {
    return new Response("Not Found", { status: 404 });
  }

  const metadata = await oauthProviderResourceClient(getAuth())
    .getActions()
    .getProtectedResourceMetadata({
      resource: assistantResourceUrl(process.env),
      scopes_supported: ["envelopes:read", "drafts:write", "offline_access"],
    });

  return Response.json(metadata, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
