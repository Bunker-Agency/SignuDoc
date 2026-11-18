import assert from "node:assert/strict";
import { test } from "node:test";

import { fieldPlacementSchema, signingSubmissionSchema } from "./field.ts";

const validPlacement = {
  signerId: "signer-1",
  type: "text",
  page: 1,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.05,
  required: true,
};

test("a name box must be required", () => {
  assert.equal(
    fieldPlacementSchema.safeParse({
      ...validPlacement,
      type: "name",
      required: false,
    }).success,
    false,
  );
  assert.equal(
    fieldPlacementSchema.safeParse({ ...validPlacement, type: "name" }).success,
    true,
  );
});

test("job title and company boxes may be optional", () => {
  for (const type of ["job_title", "company"]) {
    assert.equal(
      fieldPlacementSchema.safeParse({
        ...validPlacement,
        type,
        required: false,
      }).success,
      true,
    );
  }
});

test("detail boxes take no choices or group", () => {
  assert.equal(
    fieldPlacementSchema.safeParse({
      ...validPlacement,
      type: "company",
      options: ["a", "b"],
    }).success,
    false,
  );
  assert.equal(
    fieldPlacementSchema.safeParse({
      ...validPlacement,
      type: "job_title",
      groupId: "g",
    }).success,
    false,
  );
});

test("signerDetails trims, limits and drops a name", () => {
  const base = { clientTimezoneOffsetMinutes: 0, fields: [] };
  const parsed = signingSubmissionSchema.parse({
    ...base,
    signerDetails: { jobTitle: "  CFO ", name: "Someone Else" },
  });

  assert.deepEqual(parsed.signerDetails, { jobTitle: "CFO" });
  assert.equal(
    signingSubmissionSchema.safeParse({
      ...base,
      signerDetails: { jobTitle: "   " },
    }).success,
    false,
  );
  assert.equal(
    signingSubmissionSchema.safeParse({
      ...base,
      signerDetails: { jobTitle: "x".repeat(121) },
    }).success,
    false,
  );
});
