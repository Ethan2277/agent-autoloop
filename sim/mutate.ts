import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edits: [string, string, string, string][] = [
  ["event-duplicate", "decide.ts", "if (existing) {", "if (false && existing) {"],
  ["source-boundary", "decide.ts", "rule.when.source === source", "true"],
  ["parallel-lane", "decide.ts", 'id, rule.parallel ? event.subject : "")', 'id, "")'],
  ["session-in-use", "decide.ts", "going.some((other) => (other.session ?? other.resume) === session)", "false"],
  ["resume-after-stop", "decide.ts", 'last?.state !== "cancelled" && ', ""],
  ["group-capacity", "decide.ts", "claimed.filter((other) => other.grp === run.grp).length <", "0 <"],
  ["lane-exclusion", "decide.ts", "!claimed.some((other) => other.grp === run.grp && other.lane === run.lane)", "true"],
  ["worker-boundary", "decide.ts", "!agents.includes(rule.to)", "false"],
  ["retry-delay", "decide.ts", "5 * MINUTE * 2 ** (attempts - 1)", "0 * MINUTE * 2 ** (attempts - 1)"],
  [
    "receipt-replay",
    "decide.ts",
    "if (prior && prior.last_issued !== null &&",
    "if (false && prior && prior.last_issued !== null &&",
  ],
  ["receipt-conflict", "decide.ts", "if (prior.last_result !== hash)", "if (false)"],
  ["run-capability", "decide.ts", 'credential(draft.env, "run", id, run.issued) !== token', "false"],
  ["answer-first", "decide.ts", 'if (card.state !== "open")', "if (false)"],
  ["answer-person", "decide.ts", 'if (allowed && !allowed.includes(given.by ?? ""))', "if (false)"],
  ["answer-message", "decide.ts", "if (!delivery?.ref || delivery.ref !== given.ref)", "if (false)"],
  [
    "answer-wakeup",
    "decide.ts",
    "if (rule) enqueue(draft, rule, eventId, card.lane,",
    "if (false) enqueue(draft, rule, eventId, card.lane,",
  ],
  ["quiet-delivery", "decide.ts", "if (card.quiet ||", "if (false ||"],
  ["delivery-lease", "decide.ts", "not_before: iso(now + MINUTE)", "not_before: iso(now)"],
  ["delivery-version", "decide.ts", "version: Math.max(delivery.version, version)", "version: version"],
  ["timer-fire", "decide.ts", "Date.parse(timer.at) <= now", "Date.parse(timer.at) > now"],
  [
    "cron-latest",
    "decide.ts",
    "latestBefore(cron, Date.parse(schedule.next_at), now, timezone)",
    "Date.parse(schedule.next_at)",
  ],
  ["retry-deadline", "due.ts", 'if (notBefore > now) add("retry"', 'if (notBefore < now) add("retry"'],
  ["due-after-change", "decide.ts", 'if (!draft.changes.length && type !== "tick")', 'if (type !== "tick")'],
  ["due-at-tick", "decide.ts", 'if (!draft.changes.length && type !== "tick")', "if (!draft.changes.length)"],
  ["offline-hides-new-work", "due.ts", "waiting.every((run) => run.created_at <= card.closed_at)", "true"],
  ["offline-closed-comes-back", "due.ts", "waiting.every((run) => run.created_at <= card.closed_at)", "false"],
  ["link-expiry", "http.ts", "call.now - Date.parse(card.created_at) > LINK_LIFETIME", "false"],
  ["links-in-use", "http.ts", "if (!card || !linksInUse)", "if (!card)"],
  ["projection-drop", "evolve.ts", "if (row === null)", 'if (row === null || table === "cards")'],
  ["log-order", "store.ts", "ORDER BY seq", "ORDER BY seq DESC"],
  ["stale-commit", "store.ts", "if (latest !== view.seq)", "if (false)"],
  ["log-append", "store.ts", "for (const fact of facts) insert.run", "for (const fact of []) insert.run"],
  ["transaction-removed", "store.ts", "return transaction(db, () => {", "return ((work) => work())(() => {"],
];
const tests = [
  "kernel",
  "events",
  "cards",
  "runs",
  "schedule",
  "stream",
  "purity",
  "queue-costs",
  "http",
  "resume-thread",
].map((n) => `tests/${n}.test.ts`);
export function mutate() {
  const root = join(import.meta.dirname, "..");
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-mutation-"));
  // An inherited test-runner context bypasses the child CLI's test selection.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", ...tests], {
      cwd: folder,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    // All of it: a test that reads a folder left out here fails the baseline here and nowhere else (#119, then #128).
    for (const name of readdirSync(root).filter((name) => ![".git", ".claude", "node_modules"].includes(name)))
      cpSync(join(root, name), join(folder, name), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(folder, "node_modules"));
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.ok(Number(/# tests (\d+)/.exec(baseline.stdout)?.[1]) > 50, "基线必须确实执行行为测试");
    const mutations = edits.map(([name, file, before, after]) => ({
      name,
      file,
      change: (text: string) => {
        assert.ok(text.includes(before), name);
        // Everywhere: a guard that's written twice, as the store's transaction is, stands if only one is taken away.
        return text.replaceAll(before, after);
      },
    }));
    const survived: string[] = [];
    const invalid: string[] = [];
    let killed = 0;
    for (const mutation of mutations) {
      const file = join(folder, "kernel", mutation.file);
      const original = readFileSync(file, "utf8");
      try {
        writeFileSync(file, mutation.change(original));
        const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        if (syntax.status !== 0) {
          invalid.push(mutation.name);
          continue;
        }
        const result = run();
        if (result.status === 0) survived.push(mutation.name);
        else {
          assert.ok(!result.error, `${mutation.name}: ${result.error}`);
          killed++;
        }
        console.log(`${mutation.name}: ${result.status === 0 ? "漏过" : "抓到"}`);
      } finally {
        writeFileSync(file, original);
      }
    }
    return { total: mutations.length, killed, survived, invalid, ratio: killed / mutations.length };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(mutate(), null, 2));
