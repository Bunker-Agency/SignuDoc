import { serveAuthorizationServerMetadata } from "@/lib/assistant/discovery";

// Where MCP clients look for the authorization server's metadata, for the
// issuer <BETTER_AUTH_URL>/api/auth (RFC 8414 section 3.1). 404 while AI
// assistant connections are off.
export function GET(request: Request) {
  return serveAuthorizationServerMetadata(request);
}
