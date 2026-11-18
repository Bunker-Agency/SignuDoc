import { serveProtectedResourceMetadata } from "@/lib/assistant/protected-resource";

// The same metadata at the root, for clients that ask there. 404 while AI
// assistant connections are off.
export function GET() {
  return serveProtectedResourceMetadata();
}
