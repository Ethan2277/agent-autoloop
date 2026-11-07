// Failure modes: the Windows login task does not start the installed hub, its status is wrong, it leaves a window on the
// desktop, a hub that stops isn't started again, an update keeps the old process, or removal leaves the hub running.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { powershell, psQuote } from "../host/command.ts";

/** Titles of the terminal windows on the signed-in desktop. Only a task in that session can see them. */
function terminalWindows(scratch: string) {
  const probe = join(scratch, "windows.ps1");
  const output = join(scratch, "windows.txt");
  writeFileSync(
    probe,
    `param([string]$Output)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Desktop {
  delegate bool Each(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each each, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  public static List<string> Terminals() {
    var titles = new List<string>();
    EnumWindows((window, data) => {
      var name = new StringBuilder(256);
      GetClassName(window, name, 256);
      if (IsWindowVisible(window) && (name.ToString() == "ConsoleWindowClass" || name.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS")) {
        var text = new StringBuilder(1024);
        GetWindowText(window, text, 1024);
        titles.Add(text.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return titles;
  }
}
"@
[IO.File]::WriteAllLines("$Output.tmp", [string[]][Desktop]::Terminals())
Move-Item -Force "$Output.tmp" $Output
`,
  );
  const name = `agent-autoloop-test-windows-${process.pid}`;
  powershell(`
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${probe}" "${output}"`)}
    Register-ScheduledTask -TaskName ${psQuote(name)} -Action $action -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) -Force | Out-Null
    Start-ScheduledTask -TaskName ${psQuote(name)}
    $end = (Get-Date).AddSeconds(30)
    while (!(Test-Path ${psQuote(output)}) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
    Unregister-ScheduledTask -TaskName ${psQuote(name)} -Confirm:$false
  `);
  return readFileSync(output, "utf8").split(/\r?\n/).filter(Boolean);
}

test(
  "Windows login task runs the hub without a window, starts it again when it stops, updates and removes it",
  { skip: process.platform !== "win32" || !!process.env.CI },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-service-"));
    const home = join(scratch, "家 ' & 目录");
    const person = join(scratch, "person");
    mkdirSync(person);
    process.env.AGENT_AUTOLOOP_HOME = home;
    const socket = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("listening", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const initialized = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../bin/agent-autoloop.ts"),
        "init",
        "--no-service",
        "--command",
        "node",
        "--port",
        String(port),
      ],
      { encoding: "utf8", env: { ...process.env, USERPROFILE: person } },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const configFile = join(home, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.channels = {};
    writeFileSync(configFile, JSON.stringify(config));
    const service = await import("../host/service.ts");
    const healthy = () =>
      fetch(`http://127.0.0.1:${port}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
    async function until(done: () => boolean | Promise<boolean>, failure: string) {
      const end = Date.now() + 40_000;
      while (Date.now() < end) {
        if (await done()) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.fail(`${failure}\n${readFileSync(join(home, "logs/up.log"), "utf8")}`);
    }
    try {
      service.installService();
      await until(healthy, "the scheduled task did not start the hub");
      assert.ok(service.serviceRunning());
      assert.deepEqual(
        terminalWindows(scratch).filter((title) => title.includes("node.exe")),
        [],
        "the hub has a window on the desktop",
      );

      const first = service.runningUp();
      assert.ok(first);
      process.kill(first);
      await until(async () => {
        const now = service.runningUp();
        return now !== null && now !== first && (await healthy());
      }, "a hub that stopped was not started again");

      const second = service.runningUp();
      service.restartService();
      await until(() => {
        const now = service.runningUp();
        return now !== null && now !== second;
      }, "update kept the old process");

      service.removeService();
      assert.equal(service.serviceRunning(), false);
      assert.equal(service.runningUp(), null, "removal left the hub running");
    } finally {
      service.removeService();
      service.stopUp();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
