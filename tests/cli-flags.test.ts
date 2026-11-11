// Reading the command line: `init --help` used to install instead of printing how to use it, and a misspelt `--port`
// installed with the default in silence; `update --help` and `uninstall --yes --help` ran the real update or uninstall; any
// other command went ahead without what a flag it doesn't read had asked for, and a result given to `resolve` must not be
// taken for flags. All found here by running the real program in a home of its own and looking at what it wrote. Nothing is
// installed, updated or uninstalled, no service is touched and no Agent is called.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-flags-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
type Ran = { code: number; stdout: string; stderr: string; home: string };

/** One command, the way a person types it, in a home nothing has been installed into yet. */
async function run(args: string[]): Promise<Ran> {
  const home = join(dir, `home-${++homes}`);
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, timeout: 30_000 },
    );
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", home };
  }
}

test("init --help says how to use it and installs nothing", async () => {
  const ran = await run(["init", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop init/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("init -h does the same", async () => {
  const ran = await run(["init", "-h"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /--no-service/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("a flag init does not read stops it instead of installing with the default", async () => {
  const ran = await run(["init", "--prot", "3360", "--no-service"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--prot/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("words init does not read stop it too", async () => {
  for (const args of [["-p", "3360"], ["3360"]]) {
    const ran = await run(["init", ...args, "--no-service"]);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /不认识的参数/);
    assert.equal(existsSync(join(ran.home, "config.json")), false);
  }
});

test("the flags init does read still reach the config", async () => {
  const ran = await run(["init", "--command", "node {prompt}", "--port", "3361", "--no-service"]);
  assert.equal(ran.code, 0, ran.stderr);
  const config = JSON.parse(readFileSync(join(ran.home, "config.json"), "utf8")) as { url: string };
  assert.equal(config.url, "http://127.0.0.1:3361");
});

test("try --help says how to use it and runs nothing", async () => {
  const ran = await run(["try", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop try/);
});

test("update --help says how to use it and updates nothing", async () => {
  const ran = await run(["update", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop update/);
  assert.doesNotMatch(ran.stdout, /已经是最新的|更新好了/);
});

test("update -h does the same", async () => {
  const ran = await run(["update", "-h"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop update/);
});

test("a flag update does not read stops it instead of updating", async () => {
  const ran = await run(["update", "--yse"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--yse/);
});

test("uninstall --help says how to use it and uninstalls nothing", async () => {
  const ran = await run(["uninstall", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop uninstall/);
  assert.match(ran.stdout, /--yes/);
});

test("uninstall --yes --help prints usage and uninstalls nothing", async () => {
  const ran = await run(["uninstall", "--yes", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop uninstall/);
  assert.doesNotMatch(ran.stdout + ran.stderr, /已卸载|卸载完|删除自身/);
});

test("a flag uninstall does not read stops it instead of uninstalling", async () => {
  const ran = await run(["uninstall", "--yse"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--yse/);
});

const EVERY_OTHER_COMMAND = [
  "add",
  "answer",
  "ask",
  "backup",
  "check",
  "conformance",
  "doctor",
  "emit",
  "join",
  "key",
  "mcp",
  "restore",
  "rules",
  "service",
  "status",
  "stop",
  "tell",
  "try",
  "up",
  "why",
];

for (const command of EVERY_OTHER_COMMAND) {
  test(`${command} stops at a flag it does not read, and says how to use it when asked`, async () => {
    const wrong = await run([command, "--nonsense"]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /不认识的参数：--nonsense/);
    const asked = await run([command, "--help"]);
    assert.equal(asked.code, 0);
    assert.match(asked.stdout, new RegExp(`用法：agent-autoloop ${command}`));
    assert.equal(existsSync(join(asked.home, "config.json")), false);
  });
}

test("resolve takes a result in someone's own words, dashes and all", async () => {
  const words = await run(["resolve", "3", "--not", "a", "flag"]);
  assert.doesNotMatch(words.stderr, /不认识的参数/);
  const asked = await run(["resolve", "--help"]);
  assert.equal(asked.code, 0);
  assert.match(asked.stdout, /用法：agent-autoloop resolve/);
});

test("--help and -h on their own say how to use it", async () => {
  for (const flag of ["--help", "-h"]) {
    const ran = await run([flag]);
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /agent-autoloop init/);
  }
});
