// `check` reads a rules file and nothing else. Failure cases: checking a draft opens the hub's database, creates a master
// key, or loads the draft into the running hub as its rules; only the installed rules file can be checked; a bad file
// passes, or a missing one crashes instead of saying so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-check-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fixture = readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8");
const draft = join(home, "draft.json");
writeFileSync(draft, fixture);

const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const clean = { ...process.env, ...env };
  delete clean.AGENT_AUTOLOOP_RULES;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: "utf8",
  });
};
const facts = (hubHome: string) => {
  const db = new DatabaseSync(join(hubHome, "hub.db"), { readOnly: true });
  try {
    return [Number(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n), db.prepare("SELECT fact FROM facts").all()];
  } finally {
    db.close();
  }
};

test("checking any file touches no hub: no database, no key, nothing written", () => {
  const empty = join(home, "empty-home");
  const done = cli({ AGENT_AUTOLOOP_HOME: empty }, "check", draft);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /规则没问题/);
  assert.ok(!existsSync(empty) || readdirSync(empty).length === 0, "the home stays as it was");
});

test("checking a draft next to a hub leaves its log as it was", () => {
  const hubHome = join(home, "hub-home");
  // A hub with its own rules and a log, as `key new` makes it.
  const made = cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: draft }, "key", "new", "owner", "owner");
  assert.equal(made.status, 0, made.stderr);
  const before = facts(hubHome);
  const changed = JSON.parse(fixture);
  changed.rules.pop();
  const other = join(home, "other.json");
  writeFileSync(other, JSON.stringify(changed));
  assert.equal(cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: draft }, "check", other).status, 0);
  // The old check loaded the file it checked into the hub: this one differs from what the hub runs.
  assert.equal(cli({ AGENT_AUTOLOOP_HOME: hubHome, AGENT_AUTOLOOP_RULES: other }, "check").status, 0);
  assert.deepEqual(facts(hubHome), before, "no rules fact, no fact at all");
});

test("without a file it checks the installed rules; a bad or missing file fails and says why", () => {
  const installed = join(home, "installed");
  const plain = cli({ AGENT_AUTOLOOP_HOME: installed }, "check");
  assert.equal(plain.status, 1);
  assert.ok(plain.stderr.includes(`读不到 ${join(installed, "rules.json")}`));
  const bad = JSON.parse(fixture);
  bad.rules[0].colour = "red";
  const badFile = join(home, "bad.json");
  writeFileSync(badFile, JSON.stringify(bad));
  const refused = cli({ AGENT_AUTOLOOP_HOME: installed }, "check", badFile);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /规则「意见」有不认识的字段 colour/);
  assert.ok(!existsSync(join(installed, "hub.db")));
});
