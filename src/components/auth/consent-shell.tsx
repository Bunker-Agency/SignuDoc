"use client";

import Link from "next/link";
import { useState } from "react";

import { useBranding } from "@/components/layout/branding-provider";
import { ShellButton } from "@/components/shared/form-shell";

// The consent page an AI assistant's authorization sends a signed-in sender
// to. Approve and Deny go to the OAuth provider with fetch, which answers
// with where to go next (the assistant's own address, with a code or a
// refusal), and the page goes there. A form post to the assistant would
// break the site's form-action rule.

type ConsentShellProps = {
  clientName: string;
  /** The provider's signed request, sent back as it came. */
  oauthQuery: string;
  redirectHost: string;
};

const headingClassName =
  "text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)";

function describeConsentError(code: string | undefined): string {
  switch (code) {
    case "ASSISTANT_CONNECTIONS_OFF":
      return "AI assistant connections are turned off on this site.";
    case "TWO_STEP_SETUP_REQUIRED":
      return "Set up two-step sign-in before you connect an AI assistant.";
    case "EMAIL_NOT_VERIFIED":
      return "Verify your email address before you connect an AI assistant.";
    case "invalid_signature":
      return "This request has expired. Start connecting again from your AI assistant.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export function ConsentShell({
  clientName,
  oauthQuery,
  redirectHost,
}: ConsentShellProps) {
  const { productName } = useBranding();
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    if (pending) {
      return;
    }

    setPending(accept ? "approve" : "deny");
    setError(null);

    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        code?: string;
        error?: string;
        redirect?: boolean;
        url?: string;
      } | null;

      if (response.ok && payload?.redirect && typeof payload.url === "string") {
        // Stays busy while the browser leaves.
        window.location.assign(payload.url);
        return;
      }

      setError(describeConsentError(payload?.code ?? payload?.error));
    } catch {
      setError(describeConsentError(undefined));
    }

    setPending(null);
  }

  return (
    <section className="panel w-full max-w-[520px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Connect an AI assistant</p>
          <h1 className={headingClassName}>Allow this assistant?</h1>
        </div>

        <div className="rounded-xl border border-(--border) px-5 py-4">
          <p className="text-lg font-bold break-words text-(--fg)">
            {clientName}
          </p>
          <p className="text-sm text-(--secondary)">as it describes itself</p>
        </div>

        <div className="space-y-3 text-sm leading-6 text-(--fg)">
          <p className="text-(--secondary)">If you approve, it can:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>See your envelopes and their status</li>
            <li>Create, edit and delete your drafts</li>
          </ul>
          <p>
            It can&apos;t send anything. You always press Send yourself in{" "}
            {productName}.
          </p>
          <p className="text-(--secondary)">
            It will return you to{" "}
            <span className="font-bold break-all text-(--fg)">
              {redirectHost}
            </span>
            .
          </p>
        </div>

        {error ? (
          <p className="notice notice-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ShellButton
            disabled={pending !== null}
            loading={pending === "deny"}
            onClick={() => void answer(false)}
            type="button"
            variant="secondary"
          >
            Deny
          </ShellButton>
          <ShellButton
            disabled={pending !== null}
            loading={pending === "approve"}
            onClick={() => void answer(true)}
            type="button"
          >
            Approve
          </ShellButton>
        </div>
      </div>
    </section>
  );
}

/** In place of the consent page when there's nothing to approve. */
export function ConsentUnavailable({ message }: { message: string }) {
  return (
    <section className="panel w-full max-w-[460px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Connect an AI assistant</p>
          <h1 className={headingClassName}>Can&apos;t connect</h1>
        </div>

        <p className="notice notice-danger" role="alert">
          {message}
        </p>

        <Link
          className="w-fit text-sm font-bold text-(--accent-ink) underline-offset-4 hover:underline"
          href="/dashboard"
        >
          Go to your dashboard
        </Link>
      </div>
    </section>
  );
}
