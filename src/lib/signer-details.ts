import type { FieldType } from "./types/domain.ts";

export const MAX_SIGNER_DETAIL_LENGTH = 120;

export type SignerDetails = { company: string | null; jobTitle: string | null };

export type SignerDetailNeed = "optional" | "required" | null;

export function isSignerDetailFieldType(
  type: FieldType,
): type is "company" | "job_title" | "name" {
  return type === "name" || type === "job_title" || type === "company";
}

function needFor(
  fields: ReadonlyArray<{ required: boolean; type: FieldType }>,
  type: FieldType,
): SignerDetailNeed {
  const boxes = fields.filter((field) => field.type === type);

  if (boxes.length === 0) {
    return null;
  }

  // One required box is enough to need an answer, even if others are optional.
  return boxes.some((field) => field.required) ? "required" : "optional";
}

// What a signer has to be asked for, judged from the boxes placed for them.
// Their name is never asked: it is already known.
export function signerDetailsAsked(
  fields: ReadonlyArray<{ required: boolean; type: FieldType }>,
): { company: SignerDetailNeed; jobTitle: SignerDetailNeed } {
  return {
    company: needFor(fields, "company"),
    jobTitle: needFor(fields, "job_title"),
  };
}

export function signerDetailValueForField(
  type: FieldType,
  input: { name: string } & SignerDetails,
): string | null {
  switch (type) {
    case "name":
      return input.name;
    case "job_title":
      return input.jobTitle;
    case "company":
      return input.company;
    default:
      return null;
  }
}
