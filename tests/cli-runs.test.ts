// Listing earlier runs with `agent-autoloop runs`. Failure modes: only the newest page is ever read, so a rule's runs
// from yesterday never show and `why` can't be given their number; a run still going, or an old one still unsettled that the
// hub adds to its first page, is listed twice or out of order; the next page skips or repeats a run; a page number that
// isn't one reaches the hub as a bad address instead of saying how to use the command.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { findRuns, runsText } from "../cli/runs.ts";

const now = "2026-11-10T02:00:00.000Z";
const run = (id: number, rule: string, state = "done") => ({
  id,
  rule,
  state,
  attempts: 0,
  claimedAt: now,
  finishedAt: state === "claimed" || state === "queued" ? null : now,
  notBefore: null,
  summary: `第 ${id} 轮的结果`,
  error: "",
  events: [],
});
const ids = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

/** A hub of `total` runs, newest first, in pages of 60 the way /v1/state gives them; every seventh is rule B. */
function hub(total: number, active: ReturnType<typeof run>[] = []) {
  const asked: (number | undefined)[] = [];
  const all = ids(total, 1).map((id) => run(id, id % 7 === 0 ? "B" : "A"));
  const page = async (before?: number) => {
    asked.push(before);
    const older = all.filter((one) => before === undefined || one.id < before);
    const shown = older.slice(0, 60);
    const hasMore = older.length > 60;
    const extra = before === undefined ? active.filter((one) => !shown.some((s) => s.id === one.id)) : [];
    const runs = [...shown.map((one) => active.find((a) => a.id === one.id) ?? one), ...extra].sort(
      (a, b) => b.id - a.id,
    );
    return { now, timezone: "Asia/Shanghai", runs, hasMore, nextBefore: hasMore ? shown[59].id : null };
  };
  return { page, asked };
}

test("a rule's runs older than the first page are found, and the next page starts after the last one shown", async () => {
  const { page } = hub(300);
  const found = await findRuns(page, { rule: "B" });
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(300, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  assert.equal(found.more, found.runs.at(-1)!.id);
  const next = await findRuns(page, { rule: "B", before: found.more! });
  assert.deepEqual(
    next.runs.map((one) => one.id),
    ids(found.more! - 1, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  const last = await findRuns(page, { rule: "B", before: next.more! });
  assert.deepEqual(
    last.runs.map((one) => one.id),
    [14, 7],
  );
  assert.equal(last.more, null);
});

test("--before starts the list there", async () => {
  const { page, asked } = hub(100);
  const found = await findRuns(page, { before: 50 });
  assert.equal(asked[0], 50);
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(49, 30),
  );
});

test("runs still going are left to status, and an old unsettled one the first page adds is listed once, in order", async () => {
  const { page } = hub(130, [run(130, "A", "claimed"), run(129, "A", "queued"), run(5, "B", "unknown")]);
  const found = await findRuns(page, { rule: "B", want: 100 });
  const shown = found.runs.map((one) => one.id);
  assert.deepEqual(shown, [...ids(130, 1).filter((id) => id % 7 === 0), 5]);
  assert.equal(new Set(shown).size, shown.length);
  const all = await findRuns(page, { want: 3 });
  assert.deepEqual(
    all.runs.map((one) => one.id),
    [128, 127, 126],
  );
});

test("each run is one entry with its number, how it ended and its rule; more says how to go on", async () => {
  const { page } = hub(30);
  const text = runsText(await findRuns(page, { rule: "A", want: 2 }), { rule: "A", color: false, columns: 100 });
  assert.match(text, /#30 +做完了 +A\n +第 30 轮的结果/);
  assert.match(text, /#29 +做完了 +A/);
  assert.match(text, /agent-autoloop runs A --before 29/);
  const none = runsText(await findRuns(page, { rule: "C" }), { rule: "C", color: false, columns: 100 });
  assert.match(none, /「C」没有做完的轮次/);
});

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-runs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a --before that isn't a run number says how to use it instead of asking the hub", async () => {
  for (const before of ["x", "0", "1.5"]) {
    const ran = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, "runs", "--before", before],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "home") } },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error) => error as { code: number; stderr: string },
    );
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /用法：agent-autoloop runs/);
  }
});
