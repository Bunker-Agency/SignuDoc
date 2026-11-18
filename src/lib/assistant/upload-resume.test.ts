import assert from "node:assert/strict";
import { test } from "node:test";

import { uploadResumePath } from "./signed-query.ts";

const next = (value: string) =>
  uploadResumePath(new URLSearchParams({ next: value }));

test("the sign-in page resumes only at a one-time upload link", () => {
  assert.equal(next("/upload/abc"), "/upload/abc");
  assert.equal(next("/upload/aB-_9"), "/upload/aB-_9");
  assert.equal(uploadResumePath(""), null);

  for (const bad of [
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/dashboard",
    "/upload/",
    "/upload/abc/../../dashboard",
    "/upload/abc?x=1",
    "/upload/%2e%2e/dashboard",
    "/upload/abc\\evil",
    "/upload//evil.com",
    "https://evil.com/upload/abc",
    " /upload/abc",
  ]) {
    assert.equal(next(bad), null, bad);
  }
});
