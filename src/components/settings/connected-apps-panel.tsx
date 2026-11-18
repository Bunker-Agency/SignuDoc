"use client";

import { useEffect, useState } from "react";

import { ShellButton } from "@/components/shared/form-shell";

// The AI assistants the signed-in sender has connected, with a way to
// disconnect each. Rendered only when assistant connections are on.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type Connection = {
  approvedAt: number;
  clientId: string;
  clientName: string;
  lastUsedAt: number | null;
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function formatDate(timestamp: number): string {
  return dateFormatter.format(new Date(timestamp * 1000));
}

export function ConnectedAppsPanel() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/account/connections");
        const payload = (await response.json().catch(() => null)) as {
          connections?: Connection[];
        } | null;

        if (cancelled) {
          return;
        }

        if (!response.ok || !payload?.connections) {
          setError(GENERIC_ERROR_MESSAGE);
          return;
        }

        setConnections(payload.connections);
      } catch {
        if (!cancelled) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function revoke(clientId: string) {
    setRevoking(clientId);
    setError(null);

    try {
      const response = await fetch(
        `/api/account/connections/${encodeURIComponent(clientId)}`,
        { method: "DELETE" },
      );

      // 404: already gone, which is what was asked for.
      if (!response.ok && response.status !== 404) {
        setError(GENERIC_ERROR_MESSAGE);
        return;
      }

      setConnections((current) =>
        (current ?? []).filter((item) => item.clientId !== clientId),
      );
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="panel p-6 sm:p-8" id="connected-apps">
      <div className="space-y-5">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Connected apps
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          AI assistants you have connected to your account. They can read your
          envelopes and prepare drafts, but they can&apos;t send anything.
          Revoke one and it stops working straight away.
        </p>
        {error ? (
          <p className="notice notice-danger" role="alert">
            {error}
          </p>
        ) : null}
        {connections === null ? (
          error ? null : (
            <p className="text-sm text-(--secondary)" role="status">
              Loading...
            </p>
          )
        ) : connections.length === 0 ? (
          <p className="text-sm text-(--secondary)">
            No assistants are connected.
          </p>
        ) : (
          <ul
            aria-label="Connected assistants"
            className="divide-y divide-(--border)"
          >
            {connections.map((connection) => (
              <li
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                key={connection.clientId}
              >
                <div className="space-y-1">
                  <p className="font-bold text-(--fg)">
                    {connection.clientName}
                  </p>
                  <p className="text-sm text-(--secondary)">
                    Connected {formatDate(connection.approvedAt)}
                    {" · "}
                    Last used{" "}
                    {connection.lastUsedAt === null
                      ? "never"
                      : formatDate(connection.lastUsedAt)}
                  </p>
                </div>
                <ShellButton
                  className="w-fit"
                  disabled={revoking !== null}
                  loading={revoking === connection.clientId}
                  onClick={() => void revoke(connection.clientId)}
                  variant="secondary"
                >
                  <span aria-hidden="true">Revoke</span>
                  <span className="sr-only">
                    Revoke {connection.clientName}
                  </span>
                </ShellButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
