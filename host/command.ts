// Node cannot exec a Windows npm .cmd shim. Run what it points at (a JavaScript entry or a native program) directly so
// multiline arguments never become cmd source.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows looks for a bare program name in its working folder first, and an Agent can write to a turn's folder. */
export const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * The file Windows runs for `name` from PATH, trying extensions in PATHEXT's order. Not where.exe: it prints in the console's
 * code page, so a folder outside it (a Chinese user name) came back as a path that isn't there. The current folder isn't
 * searched, so a project can't put its own program in place of the one installed.
 */
export function findOnPath(name: string, extensions = [".exe", ".com", ".cmd", ".bat", ".ps1"]) {
  if (/[\\/]/.test(name)) return null;
  const listed = (process.env.PATHEXT ?? "").toLowerCase().split(";");
  const order = [
    ...listed.filter((ext) => extensions.includes(ext)),
    ...extensions.filter((ext) => !listed.includes(ext)),
  ];
  const names = [
    ...(extensions.includes(path.extname(name).toLowerCase()) ? [name] : []),
    ...order.map((ext) => name + ext),
  ];
  for (const entry of (process.env.PATH ?? "").split(";")) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    for (const file of names.map((each) => path.join(folder, each))) if (existsSync(file)) return file;
  }
  return null;
}

export function commandLine(argv: string[]): [string, string[]] {
  if (process.platform !== "win32") return [argv[0], argv.slice(1)];
  let program = argv[0];
  if (!path.isAbsolute(program)) program = findOnPath(program) ?? program;
  if (/\.cmd$/i.test(program)) {
    const shim = readFileSync(program, "utf8");
    const entry = /"%(?:dp0%|~dp0)\\?([^"\r\n]+\.(?:[cm]?js|exe))"\s+%\*/i.exec(shim);
    if (!entry) throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
    // A package whose bin is a native program (Claude Code from npm) gets a shim that runs it with no node in front.
    if (/\.exe$/i.test(entry[1])) return [path.resolve(path.dirname(program), entry[1]), argv.slice(1)];
    const adjacentNode = path.join(path.dirname(program), "node.exe");
    return [
      existsSync(adjacentNode) ? adjacentNode : process.execPath,
      [path.resolve(path.dirname(program), entry[1]), ...argv.slice(1)],
    ];
  }
  if (/\.ps1$/i.test(program))
    return [POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", program, ...argv.slice(1)]];
  if (/\.bat$/i.test(program))
    throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
  return [program, argv.slice(1)];
}

const encoded = (script: string) => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script,
    "utf16le",
  ).toString("base64"),
];

export function powershell(script: string) {
  return execFileSync(POWERSHELL, encoded(script), {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const psQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;

const commandOf = (pid: number): [string, string[]] =>
  process.platform === "win32"
    ? [POWERSHELL, encoded(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`)]
    : ["ps", ["-p", String(pid), "-o", "command="]];

export function processCommandSync(pid: number) {
  return execFileSync(...commandOf(pid), { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Without stopping the process while it looks: the worker shares one with the hub, and PowerShell takes over a second to start. */
export async function processCommand(pid: number) {
  return (await execFileAsync(...commandOf(pid), { encoding: "utf8", windowsHide: true })).stdout;
}
