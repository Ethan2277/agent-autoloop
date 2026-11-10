// Updating the Windows login task must not take down a hub that works. Failure mode: the old task is unregistered and the
// running hub stopped before the new task is registered, so a registration Windows refuses leaves no hub at all.
// A fake PowerShell stands in for Windows; nothing real is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("windows-service-update");
const root = join(home, "windows");
const calls = join(home, "calls.jsonl");
const refuse = join(home, "refuse");
mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
process.env.SystemRoot = root;
// It answers the scripts by what they do: the task is ours, the process in up.pid is the hub, and registering fails
// while `refuse` exists.
writeFileSync(
  join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const script = Buffer.from(process.argv[process.argv.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(script) + "\\n");
if (script.includes("Register-ScheduledTask") && existsSync(${JSON.stringify(refuse)})) {
  process.stderr.write("Register-ScheduledTask : 参数错误。(0x80070057)");
  process.exit(1);
}
if (script.includes("Unregister-ScheduledTask")) process.stdout.write("removed");
if (script.includes("Win32_Process")) process.stdout.write("node agent-autoloop.ts up");
`,
);
chmodSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), 0o755);
Object.defineProperty(process, "platform", { value: "win32" });
const { installService } = await import("../host/service.ts");

/** A process standing in for the running hub, its number left in up.pid as `up` leaves it. Not a child of this one, so
 * once stopped it is gone rather than left unreaped. */
function runningHub() {
  const pid = Number(spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout);
  writeFileSync(join(home, "up.pid"), String(pid));
  return pid;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const scripts = (): string[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

test("a login task Windows won't register leaves the old task and the running hub alone", () => {
  const hub = runningHub();
  rmSync(calls, { force: true });
  writeFileSync(refuse, "");
  try {
    assert.throws(() => installService(), /0x80070057/);
    assert.ok(alive(hub), "the hub that was working was stopped");
    assert.ok(
      !scripts().some((script) => /Unregister-ScheduledTask|Stop-ScheduledTask/.test(script)),
      "the old task was taken away",
    );
  } finally {
    rmSync(refuse, { force: true });
    if (alive(hub)) process.kill(hub);
  }
});

test("once the new task is registered, the old hub is stopped and the task started again", () => {
  const hub = runningHub();
  rmSync(calls, { force: true });
  try {
    installService();
    assert.equal(alive(hub), false, "the old hub kept running beside the new one");
    const done = scripts();
    const registered = done.findIndex((script) => script.includes("Register-ScheduledTask"));
    const started = done.findLastIndex((script) => script.includes("Start-ScheduledTask"));
    assert.ok(registered >= 0 && started >= registered, "the task wasn't started after it was registered");
  } finally {
    if (alive(hub)) process.kill(hub);
  }
});
