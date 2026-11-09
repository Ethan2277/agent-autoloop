// Login services: launchd on macOS, systemd on Linux, Task Scheduler on Windows. Each starts the hub at login and again if
// it stops.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";
import { stablePath } from "./node-path.ts";
import { powershell, processCommandSync, psQuote } from "./command.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const BACKGROUND = path.join(import.meta.dirname, "background.ts");
const LAUNCHER = path.join(import.meta.dirname, "background.js");
const windowsArgument = (word: string) => `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const task = () => `Get-ScheduledTask | Where-Object { $_.TaskName -eq ${psQuote(label())} -and $_.TaskPath -eq '\\' }`;

/** What the login task starts. Started straight from it, node gets a console window on the desktop, and the task doesn't
 * start it again when it exits. wscript has no console: background.js starts the hub hidden and again when it stops. */
export function windowsLauncher() {
  return {
    program: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    args: ["//B", "//Nologo", "//E:JScript"]
      .concat(
        [LAUNCHER, process.execPath, "--disable-warning=ExperimentalWarning", BACKGROUND, HOME].map(windowsArgument),
      )
      .join(" "),
    directory: HOME,
  };
}

/** PowerShell that puts a shortcut starting the same thing in `folder` (a PowerShell expression). */
export function startupShortcut(folder = "[Environment]::GetFolderPath('Startup')") {
  const { program, args, directory } = windowsLauncher();
  return (
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path (${folder}) ${psQuote(`${label()}.lnk`)})); ` +
    `$s.TargetPath = ${psQuote(program)}; $s.Arguments = ${psQuote(args)}; $s.WorkingDirectory = ${psQuote(directory)}; $s.Save()`
  );
}

/** For an account that can't, or shouldn't, have the login task: the desktop starts it, with the desktop's rights. */
export const startupInstead = () =>
  "可以改用「启动」文件夹：在 PowerShell 里运行下面这行，以后登录时由桌面以普通权限拉起中台，退出后照样自动重启，" +
  "现在注销再登录一次就开始跑。这样起的中台不算系统服务：doctor 会说服务没在跑；重新运行安装器更新时加 --no-service，" +
  "不然它又去建登录任务；更新之后注销再登录一次才用上新版。\n\n" +
  startupShortcut();

function installWindowsService() {
  removeService();
  stopUp();
  const { program, args, directory } = windowsLauncher();
  try {
    powershell(`
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute ${psQuote(program)} -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(directory)}
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName ${psQuote(label())} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName ${psQuote(label())}
  `);
  } catch (error) {
    // The built-in Administrator with UAC on can't make any task without elevating, however the task is written.
    if (!String((error as { stderr?: string }).stderr ?? error).includes("0x80070005")) throw error;
    throw new Error(`Windows 不让这个账号建登录任务（拒绝访问）。${startupInstead()}`);
  }
}

/**
 * Whether a process holds an administrator's full token while the desktop of its session doesn't: more than the person
 * signed in has. With UAC off, or an Administrator that isn't filtered, the desktop has it too and the Startup folder
 * gives no less. Not knowing (it ended, or isn't ours to ask about) counts as no.
 */
export function aboveDesktop(pid: number) {
  return (
    powershell(`Add-Type @"
using System; using System.Diagnostics; using System.Runtime.InteropServices;
public static class Token {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static bool Elevated(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid), token;
    if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      if (!OpenProcessToken(process, 0x8, out token)) throw new System.ComponentModel.Win32Exception();
      int value, length;
      try { if (!GetTokenInformation(token, 20, out value, 4, out length)) throw new System.ComponentModel.Win32Exception(); }
      finally { CloseHandle(token); }
      return value != 0;
    } finally { CloseHandle(process); }
  }
  public static bool AboveDesktop(int pid) {
    try {
      if (!Elevated(pid)) return false;
      int session = Process.GetProcessById(pid).SessionId;
      foreach (Process shell in Process.GetProcessesByName("explorer"))
        if (shell.SessionId == session) return !Elevated(shell.Id);
    } catch {}
    return false;
  }
}
"@
[Token]::AboveDesktop(${pid})`) === "True"
  );
}
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type UnitOptions = {
  home: string;
  executable: string;
  program: string;
};

const systemdItem = (text: string, escapeDollar = false) => {
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("systemd unit 的值不能包含控制字符");
  let escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (escapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
};

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const executable = stablePath(process.execPath);
  const searchPath = [path.dirname(executable), ...systemPaths].join(":");
  const program = [executable, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit(options: UnitOptions = { home: HOME, executable: process.execPath, program: PROGRAM }) {
  const environment = systemdItem(`AGENT_AUTOLOOP_HOME=${options.home}`);
  const command = [options.executable, "--disable-warning=ExperimentalWarning", options.program, "up"]
    .map((part) => systemdItem(part, true))
    .join(" ");
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=${environment}
ExecStart=${command}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return installWindowsService();
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    // launchd refuses to load a plist others can write, as an unhelpful "Bootstrap failed: 5"; and rewriting one a
    // umask-0 install left world-writable keeps its mode, so the mode is set on every install.
    chmodSync(plistFile(), 0o644);
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  if (process.platform === "win32") {
    const removed =
      powershell(`$task = ${task()}; if ($task -and $task.Actions.Arguments.Contains(${psQuote(windowsArgument(BACKGROUND))})) {
      $task | Stop-ScheduledTask
      $task | Unregister-ScheduledTask -Confirm:$false
      'removed'
    }`);
    // Stopping the task ends wscript, not the hub it started, and nothing starts that again now.
    if (removed === "removed") stopUp();
    return;
  }
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file)) return;
  const service = readFileSync(file, "utf8");
  const ownsService =
    process.platform === "darwin"
      ? service.includes(xml(PROGRAM))
      : service.includes(systemdItem(PROGRAM, true)) || service.includes(PROGRAM);
  if (!ownsService) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

/** The process that left its number in up.pid, if it still is that process: the number may be someone else's by now. */
export function runningUp() {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  let command = "";
  try {
    command = processCommandSync(Number(pid));
  } catch {}
  return /agent-autoloop(\.ts)?"? up\b/.test(command) ? Number(pid) : null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const pid = runningUp();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
}

/** The service this program installs and can restart. */
export function serviceRunning() {
  if (process.platform === "win32")
    return powershell(`$task = ${task()}; [string]($task -and $task.State -eq 'Running')`) === "True";
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}

/** Whether its manager has the service going or starting: one stopped by hand, or no manager at all, isn't waited for. */
function serviceStarting() {
  if (process.platform !== "linux") return serviceRunning();
  const state = spawnSync("systemctl", ["--user", "is-active", label()], { encoding: "utf8" }).stdout?.trim();
  return state === "active" || state === "activating" || state === "reloading";
}

/**
 * A manager says it has started the hub before the hub can answer, and whatever runs next finds nothing there. Waits for
 * it while its manager has it: true once it answers, false if it doesn't in time, null when there's nothing to wait for.
 */
export async function untilAnswering(url: string, patience = 20_000) {
  if (!serviceStarting()) return null;
  const end = Date.now() + patience;
  for (;;) {
    const answered = await fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) return true;
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Where the service's own output goes. */
export const serviceLogs = () =>
  process.platform === "linux" ? `journalctl --user -u ${label()}` : path.join(HOME, "logs", "up.log");

/** The name of a system-level unit running this, as a server run by root might have. It's its owner's to restart. */
export function systemUnit() {
  if (process.platform === "win32") return null;
  if (process.platform === "darwin") return null;
  return spawnSync("systemctl", ["is-active", "--quiet", label()], { stdio: "ignore" }).status === 0 ? label() : null;
}

/** New code counts once what's running starts again. What can't be restarted from here is said back, for the owner. */
export function restartService() {
  if (serviceRunning()) return void installService();
  const name = systemUnit();
  return name ? `这台电脑用的是系统级服务，运行 systemctl restart ${name} 才会用上新版。` : undefined;
}
