import { NextResponse } from "next/server";

import { endAssistantConnection } from "@/lib/assistant/connections";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";

type ConnectionRouteContext = { params: Promise<{ clientId: string }> };

const noStore = { "cache-control": "private, no-store" };

// Disconnects one of the signed-in sender's assistants. It stops working on
// its next request. Someone else's connection is the same as none: 404.
export async function DELETE(
  request: Request,
  context: ConnectionRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    sessionResult.headers.set("cache-control", noStore["cache-control"]);

    return sessionResult;
  }

  const { clientId } = await context.params;
  const { user } = sessionResult;
  const ended = await endAssistantConnection({
    actor: { email: user.email, userId: user.id },
    clientId,
    reason: "revoked",
    userId: user.id,
  });

  if (!ended) {
    return NextResponse.json(
      { error: "That assistant isn't connected." },
      { headers: noStore, status: 404 },
    );
  }

  return new NextResponse(null, { headers: noStore, status: 204 });
}
