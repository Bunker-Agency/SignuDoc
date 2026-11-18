"use client";

import { UploadIcon } from "lucide-react";
import Link from "next/link";
import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/cn";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

type AssistantUploadShellProps = {
  /** The assistant's name, as it described itself. */
  clientName: string;
  /**
   * Where this user's browser may upload directly, ending in a slash, or
   * null when the PDF goes through the app.
   */
  directUploadPrefix: string | null;
  title: string;
  token: string;
};

async function sendPdf(input: {
  directUploadPrefix: string | null;
  file: File;
  token: string;
}): Promise<Response> {
  const endpoint = `/api/assistant/uploads/${input.token}`;

  if (input.directUploadPrefix) {
    const { uploadPresigned } = await import("@vercel/blob/client");
    const uploadKey = `${input.directUploadPrefix}${crypto.randomUUID()}.pdf`;

    await uploadPresigned(uploadKey, input.file, {
      access: "private",
      contentType: "application/pdf",
      handleUploadUrl: endpoint,
    });

    return fetch(endpoint, {
      body: JSON.stringify({ filename: input.file.name, uploadKey }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  const formData = new FormData();

  formData.append("file", input.file);

  return fetch(endpoint, { body: formData, method: "POST" });
}

/**
 * The drop zone for an upload link an assistant asked for. The envelope's
 * title was already given to the assistant, so only the PDF is asked for.
 */
export function AssistantUploadShell({
  clientName,
  directUploadPrefix,
  title,
  token,
}: AssistantUploadShellProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [envelopeId, setEnvelopeId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function upload(file: File | null) {
    setIsDragActive(false);

    if (!file || isBusy) {
      return;
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setErrorMessage(
        "Only PDF files are supported. Please upload a valid PDF.",
      );
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setErrorMessage("This file exceeds the 20 MB limit.");
      return;
    }

    setIsBusy(true);
    setErrorMessage(null);

    try {
      const response = await sendPdf({ directUploadPrefix, file, token });
      const payload = (await response.json().catch(() => null)) as {
        envelopeId?: string;
        error?: string;
      } | null;

      if (!response.ok || !payload?.envelopeId) {
        setErrorMessage(
          payload?.error ?? "Something went wrong. Please try again.",
        );
        setIsBusy(false);
        return;
      }

      setEnvelopeId(payload.envelopeId);
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setIsBusy(false);
    }
  }

  function openFilePicker() {
    if (!isBusy) {
      fileInputRef.current?.click();
    }
  }

  if (envelopeId) {
    return (
      <div className="space-y-5">
        <PageHeader description={title} title="Upload a document" />
        <section className="panel space-y-4 p-5 sm:p-8" role="status">
          <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
            Uploaded. Go back to your assistant to finish preparing it.
          </p>
          <Link
            className="btn-quiet inline-flex min-h-11 px-4"
            href={`/envelopes/${encodeURIComponent(envelopeId)}/prepare`}
          >
            Open the draft
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div
      className="space-y-5"
      onDragLeave={() => setIsDragActive(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragActive(!isBusy);
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        void upload(event.dataTransfer.files?.[0] ?? null);
      }}
    >
      <PageHeader
        description={`${clientName} (as it describes itself) asked for this PDF.`}
        title={`Upload: ${title}`}
      />
      <input
        accept=".pdf,application/pdf"
        aria-label="Upload PDF"
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          void upload(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      <section className="panel space-y-6 p-5 sm:p-8">
        <div
          aria-busy={isBusy}
          aria-label="Document upload dropzone"
          className={cn(
            "cursor-pointer rounded-[1.25rem] border-2 border-dashed px-6 py-10 text-center transition sm:px-10 sm:py-12",
            isBusy || isDragActive
              ? "border-(--accent) bg-(--accent-softer)"
              : errorMessage
                ? "border-[rgba(180,35,24,0.4)] bg-(--danger-soft)"
                : "border-(--border-strong) bg-(--surface) hover:border-(--accent) hover:bg-(--accent-softer)",
          )}
          onClick={openFilePicker}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openFilePicker();
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-(--accent-soft) text-(--accent)">
              <UploadIcon
                aria-hidden="true"
                className="size-5"
                strokeWidth={2.2}
              />
            </span>
            <div className="space-y-1.5">
              <p className="text-lg font-bold tracking-[-0.02em] text-(--fg)">
                {isBusy ? "Uploading..." : "Drag and drop your PDF here"}
              </p>
              {isBusy ? null : (
                <p className="text-sm text-(--secondary)">
                  or{" "}
                  <span className="font-bold text-(--accent-ink) underline underline-offset-4">
                    click to browse
                  </span>
                </p>
              )}
            </div>
            <p className="text-[0.8125rem] font-medium text-(--tertiary)">
              PDF only - 20 MB max
            </p>
          </div>
        </div>
        {errorMessage ? (
          <div
            className="rounded-2xl bg-(--danger-soft) px-5 py-4"
            role="alert"
          >
            <p className="text-sm font-semibold text-(--danger)">
              {errorMessage}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
