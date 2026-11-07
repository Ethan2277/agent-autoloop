// Failure modes: a clean Windows install cannot be invoked, cannot complete ask/answer/resume, or uninstall removes data
// or leaves a running hub. The Agent and notification transport are stand-ins; no real message or desktop alert is sent.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(tmpdir(), "agent-autoloop-install-"));
const home = path.join(work, "hub with spaces");
const person = path.join(work, "person");
mkdirSync(person);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  USERPROFILE: person,
  AGENT_AUTOLOOP_HOME: home,
  AGENT_AUTOLOOP_REPO: pathToFileURL(root).href,
};
delete env.AGENT_AUTOLOOP_RULES;
delete env.AGENT_AUTOLOOP_PUBLIC_URL;
delete env.AGENT_AUTOLOOP_COMMIT;
const cli = path.join(home, "app/bin/agent-autoloop.ts");
let up: ChildProcess | undefined;
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
};
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Windows install smoke timed out");
}

try {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const installed = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "install.ps1"),
      "--no-service",
      "--command",
      "node",
      "--port",
      String(port),
    ],
    { env, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /先运行/);
  assert.ok(existsSync(path.join(home, "app/bin/agent-autoloop.cmd")));
  const expected = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.ok(run("--version").includes(expected));

  const script = path.join(work, "agent with spaces.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, 'utf8'));
console.log(context.answers.length ? '你选了绿色，试跑通过' : '问了一个问题\\n\\n\`\`\`agent-autoloop\\n' + JSON.stringify({ask:[{title:'试跑：选一个颜色',text:'这是一次试跑',options:['蓝色','绿色'],key:'try-color'}]}) + '\\n\`\`\`');`,
  );
  const rulesFile = path.join(home, "rules.json");
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  rules.agents.agent.command = [process.execPath, script];
  writeFileSync(rulesFile, JSON.stringify(rules));
  const plugin = path.join(home, "plugins", "test-desktop");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    path.join(plugin, "channel.ts"),
    `import { appendFileSync } from 'node:fs';
export default async function({hub,signal}) { while(!signal.aborted) {
const {card}=await hub.nextCard(1); if(!card) continue;
appendFileSync(${JSON.stringify(path.join(work, "notified"))},card.title+'\\n');
await hub.delivered(card.id,card.version,'test-'+card.id); } }`,
  );
  const configFile = path.join(home, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.channels.desktop.use = "test-desktop";
  writeFileSync(configFile, JSON.stringify(config));
  const output = openSync(path.join(work, "up.log"), "a");
  up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "up"], {
    env,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  closeSync(output);
  const healthy = () =>
    fetch(`http://127.0.0.1:${port}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
  await until(healthy);
  const tried = run("try");
  const card = /agent-autoloop answer (\d+)/.exec(tried)?.[1];
  assert.ok(card, tried);
  await until(() => existsSync(path.join(work, "notified")));
  run("answer", card, "2");
  await until(() => run("status").includes("试跑通过"));
  console.log(run("status"));
  run("update");
  run("uninstall", "--yes");
  if (up.exitCode === null) await once(up, "exit");
  assert.ok(existsSync(configFile), "uninstall removed data");
  assert.ok(!existsSync(path.join(home, "app")), "uninstall left the program");
  assert.equal(await healthy(), false, "uninstall left the hub running");
  console.log("install-smoke: Windows install, ask, answer, resume, update and uninstall passed.");
} finally {
  if (up && up.exitCode === null) {
    up.kill();
    await once(up, "exit");
  }
  rmSync(work, { recursive: true, force: true });
}
