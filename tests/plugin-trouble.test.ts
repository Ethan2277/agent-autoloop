// One process holds the hub, the worker and the channels, and plugins run inside it. Failure cases: an agent plugin that
// can't read what it printed ends the process, and ends it again on every start because the run is still there; a channel
// plugin that returns at once goes round without a pause and the hub never answers again, with the process alive so nothing
// restarts it; a channel plugin's stray throw or unhandled rejection ends the process; the database held too long by
// another process makes a tick throw from a timer and ends the process, the rules change that tick brought is lost, the retry
// is lost to whatever comes along before it, or rules written wrong in that time are never told; a worker that stops isn't
// started again; losing the place the log goes makes the error about it go round for ever, with the hub no longer answering.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const homes: string[] = [];
const running: ChildProcess[] = [];
after(async () => {
  for (const child of running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  // Windows won't remove a folder a live process works in, and an agent let go just now may not have exited yet.
  for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const edit = (file: string, change: (value: any) => void) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** A real install in a home of its own, without the desktop channel, with these plugins in its folder. */
async function install(plugins: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-plugin-trouble-"));
  homes.push(home);
  const notifiers = join(home, "notifiers");
  mkdirSync(notifiers);
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(notifiers, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(notifiers, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    PATH: `${notifiers}${delimiter}${process.env.PATH}`,
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  const installed = cli("init", "--command", "echo hi {prompt}", "--port", String(port), "--no-service");
  assert.equal(installed.status, 0, installed.stderr);
  for (const [file, code] of Object.entries(plugins)) {
    mkdirSync(join(home, "plugins", file.split("/")[0]), { recursive: true });
    writeFileSync(join(home, "plugins", file), code);
  }
  edit(join(home, "rules.json"), (rules) => (rules.channels = {}));
  edit(join(home, "config.json"), (config) => delete config.channels);
  const log = join(home, "up.log");
  writeFileSync(log, "");
  const up = () => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    child.stderr!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    running.push(child);
    return child;
  };
  return { home, port, cli, up, said: () => readFileSync(log, "utf8") };
}

/** Each on a connection of its own: a hub that's stopped answering must not look like a reused one that closed. */
async function answers(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function until(done: () => boolean | Promise<boolean>, what: string, patience = 20_000) {
  const end = Date.now() + patience;
  while (!(await done())) {
    if (Date.now() > end) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

test("an agent plugin that can't read what it printed fails that run, and the hub stays up", async () => {
  // Node itself prints, so the program really runs everywhere: there's no /bin/echo on Windows.
  const it = await install({
    "unreadable/agent.ts": `export default {
      command: () => [${JSON.stringify(process.execPath)}, "-e", "console.log('ok')"],
      read() { throw new Error("no idea what this says"); },
    };`,
  });
  edit(join(it.home, "rules.json"), (rules) => {
    for (const agent of Object.values<any>(rules.agents)) {
      agent.use = "unreadable";
      delete agent.command;
    }
  });
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  const owner = () => JSON.parse(readFileSync(join(it.home, "config.json"), "utf8")).owner as string;
  const firstRun = async () => {
    const response = await fetch(`http://127.0.0.1:${it.port}/v1/state`, {
      headers: { authorization: `Bearer ${owner()}`, connection: "close" },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    return response?.ok ? (await response.json()).runs.at(-1) : undefined;
  };
  await until(async () => alive(up) === false || (await firstRun())?.attempts === 1, "这一轮算没跑成");
  assert.equal(alive(up), true, it.said());
  assert.match((await firstRun()).error, /读不懂/);
  assert.equal(await answers(it.port), true);
});

test("a channel plugin that returns at once doesn't stop the hub answering", async () => {
  const it = await install({ "quick/channel.ts": "export default async function quick() {}" });
  const key = it.cli("key", "new", "channel", "quick").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { quick: { use: "quick", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { quick: { name: "快" } }));
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  assert.equal(alive(up), true);
  await until(() => it.said().includes("[quick] stopped"), "日志说通道停了");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(it.said().split("[quick] stopped").length - 1, 1, "it waits before going again");
});

test("a worker that stops is started again, and the hub stays up", async (t) => {
  // A turn that ends on its own leaves nothing in hand, and an idle worker then sits out its whole fifty-second poll
  // before it looks at the folder again — so this one holds the turn open until the test writes `release`, and the
  // folder breaks while a run is still in hand. The two-minute bound is only so that an assertion failing before that
  // release cannot leave it polling for a file nobody will write.
  const hold = `const { existsSync } = require("node:fs");
const release = require("node:path").join(process.env.AGENT_AUTOLOOP_HOME, "release");
const giveUp = Date.now() + 120_000;
const look = () => (existsSync(release) || Date.now() > giveUp ? process.exit(0) : setTimeout(look, 50));
look();`;
  const it = await install({
    "busy/agent.ts": `const hold = ${JSON.stringify(hold)};
export default { command: () => [process.execPath, "-e", hold], read: () => ({}) };`,
  });
  edit(join(it.home, "rules.json"), (rules) => {
    for (const agent of Object.values<any>(rules.agents)) {
      agent.use = "busy";
      delete agent.command;
    }
  });
  // The agent outlives a stopped worker by design, so this lets it go, whether or not the test got that far.
  t.after(() => writeFileSync(join(it.home, "release"), ""));
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  const runs = join(it.home, "worker", "runs");
  // Started and not just about to: one that can't write to its folder while starting counts as the hub being out of reach,
  // and that waits 30 seconds before the next round.
  await until(() => it.said().includes("turn 1 started"), "这一轮开始");
  // With a run in hand it comes round every second, and something in the way of its folder stops the next round.
  rmSync(runs, { recursive: true, force: true });
  writeFileSync(runs, "");
  await until(() => alive(up) === false || it.said().includes("[worker] stopped"), "日志说接单程序停了");
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
});

test("with nowhere left to write to it stops, as it always has, instead of going round on the error", async () => {
  const it = await install({
    "stray/channel.ts": `export default async function stray({ signal }) {
      const noisy = setInterval(() => { throw new Error("thrown out of reach"); }, 100);
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      clearInterval(noisy);
    }`,
  });
  const key = it.cli("key", "new", "channel", "stray").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { stray: { use: "stray", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { stray: { name: "乱" } }));
  const up = it.up();
  await until(() => it.said().includes("thrown out of reach"), "日志记下抛错");
  up.stdout!.destroy();
  up.stderr!.destroy();
  await until(() => !alive(up), "进程退出");
  assert.equal(up.exitCode, 1);
});

test("a channel plugin's stray throw and unhandled rejection stay its own trouble", async () => {
  const it = await install({
    "stray/channel.ts": `export default async function stray({ signal }) {
      setTimeout(() => { throw new Error("thrown out of reach"); }, 200);
      setTimeout(() => { Promise.reject(new Error("rejected with nobody listening")); }, 300);
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    }`,
  });
  const key = it.cli("key", "new", "channel", "stray").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { stray: { use: "stray", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { stray: { name: "乱" } }));
  const up = it.up();
  await until(() => alive(up) === false || it.said().includes("thrown out of reach"), "日志记下抛错");
  await until(
    () => alive(up) === false || it.said().includes("rejected with nobody listening"),
    "日志记下没人接的 Promise",
  );
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
});

/** A real hub whose database another process holds while its rules change, until the tick that brought them has failed. */
async function heldWhileRulesChange(
  change: (rules: any) => void,
  { before = (_home: string) => {}, failures = 1 } = {},
) {
  const it = await install();
  before(it.home);
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  const db = new DatabaseSync(join(it.home, "hub.db"));
  db.exec("BEGIN IMMEDIATE");
  // Moved into place, so the watcher sees one change and no second tick is waiting on the lock when it's let go.
  const file = join(it.home, "rules.json");
  const rules = JSON.parse(readFileSync(file, "utf8"));
  change(rules);
  writeFileSync(`${file}.new`, JSON.stringify(rules, null, 2));
  renameSync(`${file}.new`, file);
  const failed = () => it.said().split("Error: database is locked").length - 1;
  await until(() => alive(up) === false || failed() >= failures, "这一次到点失败", 30_000);
  db.exec("ROLLBACK");
  const askFirst = () => {
    const row = db.prepare("SELECT data FROM projections WHERE collection='config' AND key='rules'").get()!;
    return JSON.parse(String(row.data)).value.askFirst as string[];
  };
  const cards = () =>
    db
      .prepare("SELECT data FROM projections WHERE collection='cards'")
      .all()
      .map((row) => JSON.parse(String(row.data)).title as string);
  const landed = async () => {
    assert.equal(alive(up), true, it.said());
    assert.equal(await answers(it.port), true);
    db.close();
  };
  return { it, up, askFirst, cards, landed };
}

test("the database held too long by another process fails a tick, not the hub, and the change still lands", async () => {
  const { up, askFirst, landed } = await heldWhileRulesChange((rules) => (rules.askFirst = ["只问这一件"]));
  await until(() => alive(up) === false || askFirst()[0] === "只问这一件", "新规则生效");
  await landed();
});

test("whatever comes along while a failed tick waits to go again doesn't lose it", async () => {
  // With no worker asking, the only other thing due is the card about it, ten minutes off. The second failure is the one to
  // wait for: a file watcher can report one change twice, and a tick waiting on the lock would go through when it's let go.
  const { it, up, askFirst, landed } = await heldWhileRulesChange((rules) => (rules.askFirst = ["只问这一件"]), {
    before: (home) => edit(join(home, "config.json"), (config) => delete config.worker),
    failures: 2,
  });
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  await until(() => alive(up) === false || askFirst()[0] === "只问这一件", "新规则生效");
  await landed();
});

test("rules written wrong while the database is held are told once it's free", async () => {
  const { up, cards, landed } = await heldWhileRulesChange((rules) => (rules.rules[0].to = "nobody"));
  await until(() => alive(up) === false || cards().includes("rules.json 写错了，还在用旧规则"), "告诉本人规则写错了");
  await landed();
});
