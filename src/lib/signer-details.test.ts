import assert from "node:assert/strict";
import { test } from "node:test";

import {
  signerDetailsAsked,
  signerDetailValueForField,
} from "./signer-details.ts";

test("signerDetailsAsked: no detail boxes asks for nothing", () => {
  assert.deepEqual(
    signerDetailsAsked([
      { type: "signature", required: true },
      { type: "name", required: true },
    ]),
    { company: null, jobTitle: null },
  );
});

test("signerDetailsAsked: a required box wins over an optional one", () => {
  assert.deepEqual(
    signerDetailsAsked([
      { type: "company", required: false },
      { type: "company", required: true },
      { type: "job_title", required: false },
    ]),
    { company: "required", jobTitle: "optional" },
  );
});

test("signerDetailValueForField maps each type", () => {
  const input = {
    name: "Jordan Lee",
    jobTitle: "Head of Operations",
    company: null,
  };

  assert.equal(signerDetailValueForField("name", input), "Jordan Lee");
  assert.equal(
    signerDetailValueForField("job_title", input),
    "Head of Operations",
  );
  assert.equal(signerDetailValueForField("company", input), null);
  assert.equal(signerDetailValueForField("text", input), null);
});
