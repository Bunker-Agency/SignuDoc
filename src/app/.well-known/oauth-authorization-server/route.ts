import { serveAuthorizationServerMetadata } from "@/lib/assistant/discovery";

// The same metadata at the root, for clients that ask there. 404 while AI
// assistant connections are off.
export function GET(request: Request) {
  return serveAuthorizationServerMetadata(request);
}
