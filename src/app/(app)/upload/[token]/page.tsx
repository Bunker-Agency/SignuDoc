import { redirect } from "next/navigation";

import { AssistantUploadShell } from "@/components/assistant/upload-shell";
import { assistantConnectionsOn } from "@/lib/assistant/oauth";
import { lookupUploadRequest } from "@/lib/assistant/upload-requests";
import { getAuthSession } from "@/lib/auth/server";
import { supportsDirectUploads } from "@/lib/services/storage";
import { buildPendingUploadPrefix } from "@/lib/services/storage-keys";

type UploadPageProps = {
  params: Promise<{ token: string }>;
};

function Notice({ children }: { children: string }) {
  return (
    <section className="panel p-5 sm:p-8" role="alert">
      <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
        {children}
      </p>
    </section>
  );
}

// The page a one-time upload link opens. The link alone is not enough here:
// whoever opens it must be signed in as the sender it was made for.
export default async function AssistantUploadPage({ params }: UploadPageProps) {
  const { token } = await params;
  const session = await getAuthSession();

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/upload/${token}`)}`);
  }

  if (!(await assistantConnectionsOn())) {
    return (
      <Notice>AI assistant connections are turned off on this site.</Notice>
    );
  }

  const found = await lookupUploadRequest(token);

  if (!found) {
    return <Notice>This upload link isn&apos;t valid.</Notice>;
  }

  if (found.userId !== session.user.id) {
    return <Notice>This upload link belongs to someone else.</Notice>;
  }

  if (found.status === "done") {
    return <Notice>This upload link has already been used.</Notice>;
  }

  if (found.status === "expired") {
    return (
      <Notice>
        This upload link has expired. Ask your assistant for a new one.
      </Notice>
    );
  }

  return (
    <AssistantUploadShell
      clientName={found.clientName}
      directUploadPrefix={
        supportsDirectUploads()
          ? buildPendingUploadPrefix(session.user.id)
          : null
      }
      title={found.title}
      token={token}
    />
  );
}
