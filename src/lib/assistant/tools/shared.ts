import type { z } from "zod";

import { resolveAppUrl } from "../../utils/env.ts";
import type { AssistantContext } from "../guard.ts";
import type { AssistantScope } from "../oauth.ts";

// What every assistant tool is made of. It lives apart from server.ts so a
// tool file can import it without importing the server that imports the
// tool file.

export type AssistantTool<I, O> = {
  description: string;
  input: z.ZodType<I>;
  name: string;
  rateLimit: { limit: number; windowMs: number };
  run: (context: AssistantContext, input: I, request: Request) => Promise<O>;
  scope: AssistantScope;
};

/**
 * A refusal in words the assistant can pass on to the sender. Its message
 * is shown to the assistant as it is, so it never carries more than the
 * sender could be told.
 */
export class AssistantToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantToolError";
  }
}

export function appBaseUrl(): string {
  const appUrl = resolveAppUrl()?.replace(/\/+$/, "");

  if (!appUrl) {
    throw new Error("APP_URL is not set.");
  }

  return appUrl;
}

/**
 * Where a draft is reviewed and where its fields are placed, as absolute
 * addresses the sender can open. Sending happens there, in SignuDoc.
 */
export function draftLinks(envelopeId: string): {
  prepareUrl: string;
  reviewUrl: string;
} {
  const base = `${appBaseUrl()}/envelopes/${encodeURIComponent(envelopeId)}`;

  return { prepareUrl: `${base}/prepare`, reviewUrl: `${base}/review` };
}

/** Where an envelope that is not a draft is read in SignuDoc. */
export function detailLink(envelopeId: string): string {
  return `${appBaseUrl()}/envelopes/${encodeURIComponent(envelopeId)}`;
}
