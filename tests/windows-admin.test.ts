// Failure modes on Windows: a home written as an 8.3 short name (a TEMP like C:\Users\ADMINI~1\Temp) takes the hub down
// with a libuv assertion the first time its rules folder changes; a hub with more rights than the signed-in desktop is
// taken for one without, so a login task that runs it elevated goes unnoticed, or one with the desktop's own rights (UAC
// off, an unfiltered Administrator, an ordinary account) is removed; the startup shortcut offered instead starts
// something other than what the task would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { powershell, psQuote } from "../host/command.ts";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-windows-admin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const short = windows
  ? powershell(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psQuote(scratch)}).ShortPath`)
  : scratch;
process.env.AGENT_AUTOLOOP_HOME = join(short, "home");
process.env.AGENT_AUTOLOOP_RULES = join(short, "home", "rules.json");
process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
mkdirSync(join(scratch, "home"));
copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));

test(
  "a hub whose home is an 8.3 short name keeps going when its rules folder changes",
  { skip: !windows },
  async (t) => {
    if (short === scratch) return t.skip("this volume has no 8.3 names");
    const { serve } = await import("../host/http.ts");
    const server = serve(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { db } = await import("../host/runtime.ts");
    t.after(() => {
      server.close();
      server.closeAllConnections();
      db.close();
    });
    writeFileSync(join(scratch, "home", "unrelated.txt"), "x");
    copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const port = (server.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  },
);

/** The number of a process a login task starts at `level` in the signed-in session; it ends itself within a minute. */
function taskProcess(level: "Highest" | "Limited") {
  const output = join(scratch, `${level}.pid`);
  const name = `agent-autoloop-test-${level}-${process.pid}`;
  powershell(`
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "$PID | Set-Content -LiteralPath '${output.replaceAll("'", "''")}'; Start-Sleep 60"`)}
    Register-ScheduledTask -TaskName ${psQuote(name)} -Action $action -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel ${level}) -Force | Out-Null
    Start-ScheduledTask -TaskName ${psQuote(name)}
    $end = (Get-Date).AddSeconds(30)
    while (!(Test-Path -LiteralPath ${psQuote(output)}) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
    Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false
  `);
  return Number(readFileSync(output, "utf8").trim());
}

// Making a task that runs at the highest level takes an elevated administrator and a signed-in desktop, as on the test
// machine and not on CI.
test(
  "a process with more rights than the desktop is told apart from one with the desktop's own",
  { skip: !windows || !!process.env.CI },
  async () => {
    const { aboveDesktop } = await import("../host/service.ts");
    const higher = taskProcess("Highest");
    const same = taskProcess("Limited");
    try {
      assert.equal(aboveDesktop(higher), true);
      assert.equal(aboveDesktop(same), false);
      // An elevated process in a session with no desktop (SSH, a service) has nothing to compare with.
      assert.equal(aboveDesktop(process.pid), false);
    } finally {
      for (const pid of [higher, same]) spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    }
  },
);

test("the startup shortcut runs exactly what the login task runs", { skip: !windows }, async () => {
  const { startupShortcut, windowsLauncher } = await import("../host/service.ts");
  // WScript.Shell saves shortcuts through the system code page; the Administrator account this is for has an ASCII path.
  const folder = join(scratch, "Start ' Menu");
  mkdirSync(folder);
  powershell(startupShortcut(psQuote(folder)));
  const shortcut = powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(
    (Get-ChildItem -LiteralPath ${psQuote(folder)} -Filter *.lnk | Select-Object -First 1).FullName)
    @($s.TargetPath, $s.Arguments, $s.WorkingDirectory) -join [char]10`).split("\n");
  const task = windowsLauncher();
  // The shortcut writes C:\Windows with the folder's own capitals, which Windows doesn't care about.
  assert.deepEqual(
    [shortcut[0].toLowerCase(), ...shortcut.slice(1)],
    [task.program.toLowerCase(), task.args, task.directory],
  );
});
