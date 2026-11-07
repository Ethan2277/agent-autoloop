// When a start has to rebuild the projection from the log. Failure cases: a change to code outside the files that decide
// what's stored makes the next upgrade wait for a rebuild; a change that does decide it (how facts are stored, what's indexed,
// through a helper or a constant too, how card links are derived, the master key) leaves the old projection in use; a change
// to the read-only views doesn't show until something else brings a rebuild.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-format-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const code = join(dir, "code");
for (const name of ["kernel", "host", "protocol", "package.json"])
  cpSync(join(root, name), join(code, name), { recursive: true });
const home = join(dir, "home");

/** Starts this copy of the code as a new process does, and says which format it stored. */
function start() {
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(code, "host", "runtime.ts")).href)});`,
    ],
    {
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(root, "tests", "rules.fixture.json"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(started.status, 0, started.stderr);
  const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  const { format } = db.prepare("SELECT format FROM projection_meta").get() as { format: string };
  db.close();
  return format;
}

/** The format with this edit in place, which is then taken out again. */
function formatWith(file: string, before: string, after: string) {
  const path = join(code, file);
  const original = readFileSync(path, "utf8");
  assert.ok(original.includes(before), `${file} 里找不到：${before}`);
  writeFileSync(path, original.replace(before, after));
  try {
    return start();
  } finally {
    writeFileSync(path, original);
  }
}

test("a start with nothing changed keeps the format it stored", () => {
  assert.equal(start(), start());
});

test("what doesn't decide what's stored can change without a rebuild", () => {
  const usual = start();
  for (const [file, before, after] of [
    ["host/runtime.ts", "export const listKeys", "// a comment\nexport const listKeys"],
    ["host/runtime.ts", "const { problem } = reloadRules();", 'const { problem } = reloadRules(); void "other work";'],
    ["kernel/decide.ts", "const MAX_ATTEMPTS = 10;", "const MAX_ATTEMPTS = 11;"],
    ["host/state.ts", 'summary error usage"', 'summary error usage extra"'],
  ] as const) {
    assert.equal(formatWith(file, before, after), usual, `${file}: ${after}`);
  }
});

test("what decides what's stored brings a rebuild", () => {
  const usual = start();
  for (const [file, before, after] of [
    ["kernel/evolve.ts", "let seq = view.seq;", 'let seq = view.seq;\n  void "stored differently";'],
    ["kernel/evolve.ts", 'due: [["at"]],', 'due: [["at", "kind"]],'],
    ["kernel/evolve.ts", 'if (table === "run_events")', 'if (table === "run_events" && row)'],
    ["kernel/credentials.ts", 'createHmac("sha256", env.secret)', 'createHmac("sha512", env.secret)'],
    [
      "kernel/evolve.ts",
      "const field = (name: string) => `json_extract(data,'$.${name}')`;",
      "const field = (name: string) => `(data->>'$.${name}')`;",
    ],
    [
      "kernel/evolve.ts",
      '["events", "runs", "cards", "timers"]',
      '["events", "runs", "cards", "timers", "deliveries"]',
    ],
    [
      "kernel/credentials.ts",
      'digest(credential(env, "card", id, at))',
      'digest("other" + credential(env, "card", id, at))',
    ],
    ["host/runtime.ts", "WHERE collection='cards'\"", "WHERE collection='cards' AND 1\""],
  ] as const) {
    assert.notEqual(formatWith(file, before, after), usual, `${file}: ${after}`);
  }
  const key = join(home, "master.key");
  const original = readFileSync(key, "utf8");
  writeFileSync(key, "A".repeat(43));
  try {
    assert.notEqual(start(), usual, "another master key derives other card links");
  } finally {
    writeFileSync(key, original);
  }
});

test("a change to the read-only views shows at the next start, with no rebuild", () => {
  const usual = start();
  const path = join(code, "host", "state.ts");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace('summary error usage"', 'summary error usage rules_version"'));
  try {
    assert.equal(start(), usual);
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    assert.doesNotThrow(() => db.prepare("SELECT rules_version FROM runs").all());
    db.close();
  } finally {
    writeFileSync(path, original);
    start();
  }
});
