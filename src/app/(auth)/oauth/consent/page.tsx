import { redirect } from "next/navigation";

import {
  ConsentShell,
  ConsentUnavailable,
} from "@/components/auth/consent-shell";
import { readConsentRequest } from "@/lib/assistant/consent";
import { assistantConnectionsOn } from "@/lib/assistant/oauth";
import { signedOAuthQuery } from "@/lib/assistant/signed-query";
import { getAuth, getAuthSession } from "@/lib/auth/server";

// Where the OAuth provider sends a signed-in sender to approve an AI
// assistant. Everything shown comes from the request the provider signed
// and from the provider's own record of the client, never from the rest of
// the address, which anyone could have written.

type ConsentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function toSearchParams(
  query: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        params.append(key, item);
      }
    }
  }

  return params;
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const search = toSearchParams(await searchParams);

  if (!(await getAuthSession())) {
    // Signed out since the provider sent them here. Signing in again picks
    // the authorization up and comes back.
    const signed = signedOAuthQuery(search);

    redirect(signed ? `/login?${signed}` : "/login");
  }

  if (!(await assistantConnectionsOn())) {
    return (
      <ConsentUnavailable message="AI assistant connections are turned off on this site." />
    );
  }

  const request = await readConsentRequest(search, {
    secret: (await getAuth().$context).secret,
  });

  if (!request) {
    return (
      <ConsentUnavailable message="This request has expired or isn't valid. Start connecting again from your AI assistant." />
    );
  }

  return (
    <ConsentShell
      clientName={request.clientName}
      oauthQuery={request.oauthQuery}
      redirectHost={request.redirectHost}
    />
  );
}
