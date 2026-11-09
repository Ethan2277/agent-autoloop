// Failure modes: a native Windows install cannot launch an Agent; shell metacharacters alter its arguments; restarting
// the worker loses a running turn or its answer; cancelling a turn leaves its child processes running; a program in a
// folder whose name the console code page can't write (a Chinese user name) isn't found, so nothing installs or runs; a
// powershell.exe an Agent left in the turn's folder runs, outside its sandbox, in place of the system's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { POWERSHELL, powershell, psQuote } from "../host/command.ts";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-windows-"));
process.env.AGENT_AUTOLOOP_HOME = join(scratch, "安装 ' & % 目录");
// init links its manual into the user's Agents' folders; tests give it a profile of its own.
const person = join(scratch, "person");
mkdirSync(person);
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");
const waiting: any[] = [];
const results = new Map<number, any>();
let cancel: number[] = [];
const hub = {
  work: async () => ({ job: waiting.shift() ?? null, cancel }),
  started: async () => ({}),
  result: async (run: number, _token: string, value: unknown) => {
    results.set(run, value);
    return {};
  },
};
const worker = () => createWorker({ name: "windows", hub: hub as any, wait: 0 });
function job(run: number, command: string[]) {
  return {
    run,
    token: "test",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "Windows", cwd: scratch, prompt: "Read the input." },
    agent: { id: "a", name: "Agent", use: "command", access: "edit", command },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}
async function until(done: () => boolean, tick: () => Promise<unknown> = async () => {}) {
  const end = Date.now() + 30_000;
  while (!done() && Date.now() < end) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(done(), "Windows process did not reach the expected state");
}

test(
  "Windows preserves literal arguments and recovers a finished turn after worker restart",
  { skip: !windows },
  async () => {
    const agent = join(scratch, "literal.mjs");
    const argument = '中文 \' "quoted" %PATH% & echo injected\nsecond line';
    writeFileSync(agent, "process.stdout.write(process.argv[2]);");
    waiting.push(job(1, [process.execPath, agent, argument]));
    await worker().tick();
    const resumed = worker();
    await until(
      () => results.has(1),
      () => resumed.tick(),
    );
    assert.equal(results.get(1).outcome, "done", JSON.stringify(results.get(1)));
    assert.equal(
      readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/1-1/stdout-1.log"), "utf8"),
      argument,
    );
  },
);

test("Windows cancellation ends the Agent and its child before reporting cancelled", { skip: !windows }, async () => {
  const pidFile = join(scratch, "child.pid");
  const agent = join(scratch, "parent.mjs");
  writeFileSync(
    agent,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`,
  );
  waiting.push(job(2, [process.execPath, agent]));
  const running = worker();
  await running.tick();
  let pid = 0;
  try {
    await until(() => existsSync(pidFile));
    pid = Number(readFileSync(pidFile, "utf8"));
    const resumed = worker();
    await resumed.tick();
    assert.ok(!results.has(2), "a running Agent was treated as finished");
    cancel = [2];
    await until(
      () => results.has(2),
      () => resumed.tick(),
    );
    assert.equal(results.get(2).outcome, "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    cancel = [];
    if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  }
});

test("an npm command shim preserves a multiline prompt on Windows", { skip: !windows }, async () => {
  const agent = join(scratch, "npm-agent.cjs");
  const shim = join(scratch, "npm-agent.cmd");
  const argument = '中文 "quotes" %PATH% & echo injected\nsecond line';
  writeFileSync(agent, "process.stdout.write(process.argv[2]);");
  writeFileSync(shim, '@ECHO off\r\nSET "dp0=%~dp0"\r\nnode "%dp0%\\npm-agent.cjs" %*\r\n');
  waiting.push(job(3, [shim, argument]));
  const running = worker();
  await until(
    () => results.has(3),
    () => running.tick(),
  );
  assert.equal(results.get(3).outcome, "done", JSON.stringify(results.get(3)));
  assert.equal(readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/3-1/stdout-1.log"), "utf8"), argument);
});

// npm writes this shim for a package whose bin is a native program; Claude Code installed with npm is one.
test("an npm command shim for a native program runs it on Windows", { skip: !windows }, async () => {
  const bin = join(scratch, "node_modules", "native-agent", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "native-agent.exe"));
  const agent = join(scratch, "native-agent.cjs");
  const shim = join(scratch, "native-agent.cmd");
  const argument = '中文 "quotes" %PATH% & echo injected\nsecond line';
  writeFileSync(agent, "process.stdout.write(process.argv[2]);");
  writeFileSync(
    shim,
    '@ECHO off\r\nSET "dp0=%~dp0"\r\n"%dp0%\\node_modules\\native-agent\\bin\\native-agent.exe"   %*\r\n',
  );
  waiting.push(job(9, [shim, agent, argument]));
  const running = worker();
  await until(
    () => results.has(9),
    () => running.tick(),
  );
  assert.equal(results.get(9).outcome, "done", JSON.stringify(results.get(9)));
  assert.equal(readFileSync(join(process.env.AGENT_AUTOLOOP_HOME!, "worker/runs/9-1/stdout-1.log"), "utf8"), argument);
});

// where.exe prints in the console's code page; a Chinese folder name came back as a path that doesn't exist.
test(
  "an Agent on PATH under a folder the console code page can't write is found and runs",
  { skip: !windows },
  async () => {
    const folder = join(scratch, "张三 的工具");
    mkdirSync(folder);
    writeFileSync(join(folder, "cjk-agent.js"), "process.stdout.write('ran: ' + process.argv[2]);");
    writeFileSync(join(folder, "cjk-agent.cmd"), '@ECHO off\r\nnode "%~dp0\\cjk-agent.js" %*\r\n');
    const path = process.env.PATH;
    process.env.PATH = `${folder};${path}`;
    try {
      const { findProgram } = await import("../worker/agents.ts");
      const found = findProgram("cjk-agent");
      assert.ok(found && existsSync(found), `found ${found}`);
      waiting.push(job(5, ["cjk-agent", "参数"]));
      const running = worker();
      await until(
        () => results.has(5),
        () => running.tick(),
      );
      assert.equal(results.get(5).outcome, "done", JSON.stringify(results.get(5)));
      assert.equal(results.get(5).summary, "ran: 参数");
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "init finishes when PATH has an agent-autoloop under a folder the console code page can't write",
  { skip: !windows },
  () => {
    const folder = join(scratch, "李四 的命令");
    mkdirSync(folder);
    writeFileSync(join(folder, "agent-autoloop.cmd"), "@ECHO off\r\n");
    const home = join(scratch, "cjk init home");
    const initialized = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--command", "node"],
      {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person, PATH: `${folder};${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /先运行/);
  },
);

// Windows looks for a bare program name in its working folder first, and an Agent can write to the turn's folder.
test(
  "a powershell.exe left in the turn's folder doesn't run in place of the system's",
  { skip: !windows },
  async () => {
    const folder = join(scratch, "planted");
    mkdirSync(folder);
    copyFileSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
      join(folder, "powershell.exe"),
    );
    const agent = join(scratch, "planted-agent.mjs");
    writeFileSync(agent, "process.stdout.write('ran');");
    const input = job(6, [process.execPath, agent]);
    input.rule.cwd = folder;
    waiting.push(input);
    const running = worker();
    await until(
      () => results.has(6),
      () => running.tick(),
    );
    assert.equal(results.get(6).outcome, "done", JSON.stringify(results.get(6)));
  },
);

test("Windows ACP edit access rejects a sibling folder", { skip: !windows }, async () => {
  const { permission } = await import("../plugins/acp/bridge.ts");
  const answer = permission(
    { access: "edit", cwd: scratch },
    {
      toolCall: { kind: "edit", locations: [{ path: join(scratch, "..", "outside.txt") }] },
      options: [
        { kind: "allow_once", optionId: "yes" },
        { kind: "reject_once", optionId: "no" },
      ],
    },
  );
  assert.equal(answer.optionId, "no");
});

test("Windows keeps a turn after the worker process exits", { skip: !windows }, async () => {
  const agent = join(scratch, "outlive.mjs");
  writeFileSync(agent, 'setTimeout(() => console.log("survived"), 1000);');
  const input = job(4, [process.execPath, agent]);
  const module = pathToFileURL(join(import.meta.dirname, "../worker/worker.ts")).href;
  const launched = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { createWorker } = await import(${JSON.stringify(module)});
    const worker = createWorker({ name: 'child', hub: {
      work: async () => ({job: ${JSON.stringify(input)}, cancel: []}),
      started: async () => ({}), result: async () => ({})
    }});
    await worker.tick();
    process.exit(0);
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(launched.status, 0, launched.stderr);
  const resumed = worker();
  await until(
    () => results.has(4),
    () => resumed.tick(),
  );
  assert.equal(results.get(4).summary, "survived", JSON.stringify(results.get(4)));
});

test("Windows init prints a working native command", { skip: !windows }, () => {
  const home = join(scratch, "init home");
  const cli = join(import.meta.dirname, "../bin/agent-autoloop.ts");
  const initialized = spawnSync(process.execPath, [cli, "init", "--no-service", "--command", "node"], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person },
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(existsSync(join(home, "config.json")));
  assert.match(initialized.stdout, /先运行/);
});

// Agent discovery builds a command before any turn, so it has no context file to share with the Codex sandbox.
test("Windows init discovers Codex before a task has a context file", { skip: !windows }, (t) => {
  if (spawnSync("where.exe", ["codex"], { windowsHide: true }).status !== 0) return t.skip("Codex is not installed");
  const home = join(scratch, "codex init");
  const initialized = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--agent", "codex"],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person }, encoding: "utf8" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  assert.equal(rules.agents.codex.use, "codex");
});

test("Windows init keeps its keys private even inside a shared directory", { skip: !windows }, () => {
  const parent = join(scratch, "shared");
  const home = join(parent, "private");
  mkdirSync(parent);
  const granted = spawnSync("icacls.exe", [parent, "/grant", "*S-1-1-0:(OI)(CI)F"], { encoding: "utf8" });
  assert.equal(granted.status, 0, granted.stderr);
  const initialized = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "init", "--no-service", "--command", "node"],
    {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home, USERPROFILE: person },
      encoding: "utf8",
    },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const sids = powershell(
    `[IO.File]::GetAccessControl(${psQuote(join(home, "master.key"))}).Access.IdentityReference | ForEach-Object { $_.Translate([Security.Principal.SecurityIdentifier]).Value }`,
  );
  assert.ok(!sids.includes("S-1-1-0"), "Everyone can read the install's master key");
});

test("Windows notification text remains data in PowerShell", { skip: !windows }, async () => {
  const { notifyCommand } = await import("../plugins/desktop/channel.ts");
  const title = "中文 '; throw 'injected' & <tag> %PATH%\nsecond line";
  const [program, args] = notifyCommand(title, "win32");
  assert.equal(program, POWERSHELL);
  const script = Buffer.from(args.at(-1)!, "base64")
    .toString("utf16le")
    .replace("$icon.Visible = $true", "$icon.Visible = $false")
    .replace("$icon.ShowBalloonTip(5000)", "$words | ConvertTo-Json -Compress")
    .replace("Start-Sleep -Seconds 5", "");
  const result = spawnSync(program, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    title: "Agent 问你一个问题",
    body: `${title}\n运行 agent-autoloop status 查看`,
  });
});

// The elevated Codex sandbox uses another Windows account, which cannot read a private hub's context file by default.
test(
  "Windows Codex exposes its context to the sandbox, without exposing the master key",
  { skip: !windows || !!process.env.CI },
  async (t) => {
    const sid = powershell(
      `try { ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]).Value } catch [Security.Principal.IdentityNotMappedException] { }`,
    );
    if (!sid) return t.skip("Codex elevated sandbox is not installed");
    const home = join(scratch, "sandbox-data");
    const { privateDirectory } = await import("../host/files.ts");
    privateDirectory(home);
    const contextFile = join(home, "context.json");
    const key = join(home, "master.key");
    writeFileSync(contextFile, '{"answers":[]}');
    writeFileSync(key, "private");
    const { default: codex } = await import("../plugins/codex/agent.ts");
    codex.command({
      contextFile,
      folder: home,
      cwd: scratch,
      prompt: "Read the context.",
      access: "read",
      session: "",
      resume: null,
    });
    const rights = (file: string) =>
      powershell(
        `[IO.File]::GetAccessControl(${psQuote(file)}).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq ${psQuote(sid)} } | ForEach-Object { [int]$_.FileSystemRights }`,
      );
    const contextRights = Number(rights(contextFile));
    assert.ok(contextRights & 1, "the sandbox cannot read its context");
    assert.equal(contextRights & 2, 0, "the sandbox can overwrite its context");
    assert.equal(rights(key), "", "the sandbox was given the master key");
  },
);
