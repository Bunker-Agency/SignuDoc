"use client";

import { useState } from "react";

// Whether senders may connect an AI assistant. Administrators only.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function AssistantPanel({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function change(next: boolean) {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/security", {
        body: JSON.stringify({ assistantConnections: next }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        assistantConnections?: boolean;
        error?: string;
      } | null;

      if (!response.ok || typeof payload?.assistantConnections !== "boolean") {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      setEnabled(payload.assistantConnections);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-5 border-t border-(--border) pt-8" id="assistants">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          AI assistant connections
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Let senders connect an AI assistant such as Claude to prepare drafts
          for them. Assistants can&apos;t send anything: the sender always
          presses Send. Turning this off disconnects every assistant.
        </p>
      </div>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className={`pill ${enabled ? "pill-success" : "pill-neutral"}`}>
          {enabled ? "On" : "Off"}
        </span>
        <button
          aria-checked={enabled}
          className={enabled ? "btn-quiet btn-quiet-danger" : "btn-quiet"}
          disabled={isSaving}
          onClick={() => void change(!enabled)}
          role="switch"
          type="button"
        >
          {isSaving
            ? "Saving..."
            : enabled
              ? "Turn off assistant connections"
              : "Turn on assistant connections"}
        </button>
      </div>
    </div>
  );
}
