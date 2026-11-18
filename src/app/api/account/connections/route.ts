import { NextResponse } from "next/server";

import { listAssistantConnections } from "@/lib/assistant/connections";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";

const noStore = { "cache-control": "private, no-store" };

// The signed-in sender's connected assistants, and only theirs. Works with
// assistant connections turned off too: leftovers can always be seen.
export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    sessionResult.headers.set("cache-control", noStore["cache-control"]);

    return sessionResult;
  }

  const connections = await listAssistantConnections(sessionResult.user.id);

  return NextResponse.json({ connections }, { headers: noStore });
}
