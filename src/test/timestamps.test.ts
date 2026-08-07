import assert from "node:assert/strict";
import test from "node:test";
import { parseTimestamp } from "../gateway/timestamps.js";

test("accepts epoch milliseconds unchanged", () => {
  assert.equal(parseTimestamp(1_775_000_000_000), 1_775_000_000_000);
});

test("promotes epoch seconds to milliseconds", () => {
  assert.equal(parseTimestamp(1_775_000_000), 1_775_000_000_000);
});

test("parses ISO-8601 and numeric strings", () => {
  assert.equal(parseTimestamp("2026-08-06T10:00:00.000Z"), Date.parse("2026-08-06T10:00:00.000Z"));
  assert.equal(parseTimestamp("1775000000"), 1_775_000_000_000);
  assert.equal(parseTimestamp("1775000000000"), 1_775_000_000_000);
});

test("treats a missing or zeroed timestamp as unknown instead of 1970", () => {
  // A zero rendered as relative time is what showed sessions as decades old.
  for (const value of [0, -1, "", "   ", null, undefined, {}, [], Number.NaN, "not a date"]) {
    assert.equal(parseTimestamp(value), undefined, `for ${JSON.stringify(value)}`);
  }
});

test("rejects values outside a plausible range", () => {
  assert.equal(parseTimestamp(1), undefined);
  assert.equal(parseTimestamp("1970-01-02T00:00:00.000Z"), undefined);
  // Microseconds mistaken for milliseconds land far in the future.
  assert.equal(parseTimestamp(1_775_000_000_000_000), undefined);
});
