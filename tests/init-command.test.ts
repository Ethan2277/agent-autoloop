// `init --command` turning what a person typed into the command line in rules.json. Failure modes: a quoted path with a
// space in it is cut at the space, quotes and all, and installs without a word, to fail only when a rule first runs; a quote
// left open is taken as part of a word; a program that isn't there installs as if it were, and every run of every rule then
// fails. Run the real program in a home of its own; no service, hub or Agent is started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-init-command-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
function init(command: string) {
  const home = join(dir, `home-${++homes}`);
  const ran = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", program, "init", "--command", command, "--no-service"],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, encoding: "utf8", timeout: 60_000 },
  );
  return { code: ran.status, stderr: ran.stderr, home };
}

test("a quoted path with a space in it stays one word, without its quotes", () => {
  const folder = join(dir, "a folder with a space");
  mkdirSync(folder);
  const script = join(folder, "agent.mjs");
  writeFileSync(script, "console.log(process.argv.at(-1));\n");
  const ran = init(`node "${script}" '{prompt}'`);
  assert.equal(ran.code, 0, ran.stderr);
  const rules = JSON.parse(readFileSync(join(ran.home, "rules.json"), "utf8"));
  assert.deepEqual(rules.agents.agent.command, ["node", script, "{prompt}"]);
});

test("a quote left open stops it and installs nothing", () => {
  const ran = init(`node "/somewhere/agent.mjs {prompt}`);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /引号/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("a program that isn't there stops it and installs nothing", () => {
  for (const missing of ["definitely-not-a-program-xyz {prompt}", `"${join(dir, "nowhere", "agent")}" {prompt}`]) {
    const ran = init(missing);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /找不到/);
    assert.equal(existsSync(join(ran.home, "config.json")), false);
    assert.equal(existsSync(join(ran.home, "rules.json")), false);
  }
});
