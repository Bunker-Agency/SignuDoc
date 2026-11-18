"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// oauthProviderClient: on the sign-in page an AI assistant's authorization
// sent the browser to, it sends the signed request along with the sign-in,
// so the authorization carries on once the sender is signed in.
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});
