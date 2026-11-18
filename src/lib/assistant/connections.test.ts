import assert from "node:assert/strict";
import { test } from "node:test";

import { checkConnection } from "./connections.ts";

// An assistant's connection is held to the install's session limits, as if
// it were a session that began when the sender approved it.

const APPROVED = 1_795_000_000;
const noLimits = { sessionIdleMinutes: null, sessionMaxHours: null };

test("checkConnection refuses a connection that is gone", () => {
  assert.deepEqual(checkConnection(null, noLimits, APPROVED), {
    ok: false,
    reason: "gone",
  });
});

test("checkConnection refuses a connection at the install's maximum session age", () => {
  const limits = { sessionIdleMinutes: null, sessionMaxHours: 8 };
  const row = { approvedAt: APPROVED, lastUsedAt: APPROVED + 8 * 3600 - 5 };

  assert.deepEqual(checkConnection(row, limits, APPROVED + 8 * 3600 - 1), {
    ok: true,
    touch: false,
  });
  assert.deepEqual(checkConnection(row, limits, APPROVED + 8 * 3600), {
    ok: false,
    reason: "too_old",
  });
});

test("checkConnection refuses a connection left unused for the idle timeout", () => {
  const limits = { sessionIdleMinutes: 30, sessionMaxHours: null };
  const lastUsedAt = APPROVED + 600;
  const row = { approvedAt: APPROVED, lastUsedAt };

  assert.deepEqual(checkConnection(row, limits, lastUsedAt + 30 * 60 - 1), {
    ok: true,
    touch: true,
  });
  assert.deepEqual(checkConnection(row, limits, lastUsedAt + 30 * 60), {
    ok: false,
    reason: "idle",
  });
  // Never used: idle since it was approved.
  assert.deepEqual(
    checkConnection(
      { approvedAt: APPROVED, lastUsedAt: null },
      limits,
      APPROVED + 30 * 60,
    ),
    { ok: false, reason: "idle" },
  );
});

test("checkConnection asks for the use to be written once 60 s have passed since the last", () => {
  const row = { approvedAt: APPROVED, lastUsedAt: APPROVED + 100 };

  assert.deepEqual(checkConnection(row, noLimits, APPROVED + 159), {
    ok: true,
    touch: false,
  });
  assert.deepEqual(checkConnection(row, noLimits, APPROVED + 160), {
    ok: true,
    touch: true,
  });
});

test("checkConnection keeps a connection approved 30 days ago when both limits are off", () => {
  const thirtyDays = 30 * 24 * 3600;
  const row = { approvedAt: APPROVED, lastUsedAt: null };

  assert.deepEqual(checkConnection(row, noLimits, APPROVED + thirtyDays), {
    ok: true,
    touch: true,
  });
});
