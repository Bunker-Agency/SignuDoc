import { toNextJsHandler } from "better-auth/next-js";

import { refuseDiscoveryWhileOff } from "@/lib/assistant/discovery";
import { getAuth } from "@/lib/auth/server";
import { rejectBots } from "@/lib/security/botid";

type AuthHandlers = ReturnType<typeof toNextJsHandler>;

let cachedHandlers: AuthHandlers | null = null;

// Built on the first request rather than at import time, so that `next build`
// does not need a database or auth secret to collect page data.
function getHandlers(): AuthHandlers {
  cachedHandlers ??= toNextJsHandler(getAuth());

  return cachedHandlers;
}

// The OAuth discovery documents for AI assistants are answered by the auth
// server before its hooks run, so they are refused here while assistant
// connections are off (and again inside the auth server).

export async function DELETE(request: Request) {
  return (
    (await refuseDiscoveryWhileOff(request)) ?? getHandlers().DELETE(request)
  );
}

export async function GET(request: Request) {
  return (await refuseDiscoveryWhileOff(request)) ?? getHandlers().GET(request);
}

export async function PATCH(request: Request) {
  return (
    (await refuseDiscoveryWhileOff(request)) ?? getHandlers().PATCH(request)
  );
}

export async function POST(request: Request) {
  // Sign-in, sign-up and the routes that send email are checked by BotID
  // first, where that is turned on.
  return (
    (await refuseDiscoveryWhileOff(request)) ??
    (await rejectBots(request)) ??
    getHandlers().POST(request)
  );
}

export async function PUT(request: Request) {
  return (await refuseDiscoveryWhileOff(request)) ?? getHandlers().PUT(request);
}
