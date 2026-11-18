import { serveProtectedResourceMetadata } from "@/lib/assistant/protected-resource";

// Where MCP clients look for how to connect to /api/mcp (RFC 9728 section
// 3.1). 404 while AI assistant connections are off.
export function GET() {
  return serveProtectedResourceMetadata();
}
