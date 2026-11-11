// A retry cannot inherit another head's errors or notify an owner who still has an agent waiting for the result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unattendedFailure, retryHandoff } from "../plugins/delivery/handoff.ts";

const head = "a".repeat(40);
const now = Date.parse("2026-10-30T12:00:00Z");

test("GitHub errors get an hour without using up the five regular retries", () => {
  const due = { key: "delivery-retry", about: JSON.stringify({ head, github: 59, execution: 3 }) };
  const next = retryHandoff([due], head, false, now);
  assert.deepEqual(JSON.parse(next!.about), { head, github: 59, execution: 4 });
  assert.equal(next!.at, "2026-10-30T12:01:00.000Z");
  assert.equal(retryHandoff([due], head, true, now), null);
  const unreachable = retryHandoff([due], head, true, now, false);
  assert.deepEqual(JSON.parse(unreachable!.about), { head, github: 60, execution: 3 });
  assert.deepEqual(JSON.parse(retryHandoff([due], "b".repeat(40), true, now)!.about).github, 1);
});

test("an attended return is eligible for notice only after three minutes and without a fresh handoff", () => {
  const labels = [{ name: "deliver-attended" }];
  const failed = { state: "failure", created_at: "2026-10-30T11:57:00Z", description: "请修复" };
  assert.equal(unattendedFailure(labels, failed, now), true);
  assert.equal(unattendedFailure(labels, failed, now - 1), false);
  assert.equal(unattendedFailure([...labels, { name: "deliver" }], failed, now), false);
  assert.equal(unattendedFailure(labels, { ...failed, state: "pending" }, now), false);
});
