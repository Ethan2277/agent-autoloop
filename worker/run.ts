// A Windows turn outlives its worker. Its supervisor owns the process tree; this child preserves output and the exit code.
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandLine, POWERSHELL } from "../host/command.ts";

if (process.argv[2] === "--supervise") {
  // PowerShell cannot run detached; Node can. Its non-detached child is kept in Node's Windows job, so killing this
  // supervisor also closes PowerShell's job and its entire Agent tree.
  const child = spawn(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dirname, "windows.ps1"),
      "-RunFile",
      process.argv[3],
      "-Marker",
      process.argv[4],
    ],
    { stdio: "inherit", windowsHide: true },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const { argv, cwd, exit } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const publish = (code: number) => {
    writeFileSync(`${exit}.tmp`, String(code), { mode: 0o600 });
    renameSync(`${exit}.tmp`, exit);
  };
  // The command line Windows starts has a limit, and a long prompt passed on it reaches it; spawn may throw that at once.
  const said = (error: NodeJS.ErrnoException) =>
    error.code === "ENAMETOOLONG"
      ? `命令行太长：约 ${argv.join(" ").length} 个字符，Windows 最多 32767。` +
        "把规则里长的说明写进 Skill，提示词里只留一句加载它。"
      : error.message;
  try {
    const [program, args] = commandLine(argv);
    const child = spawn(program, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => {
      console.error(said(error));
      publish(127);
    });
    child.on("exit", (code) => publish(code ?? 1));
  } catch (error) {
    console.error(said(error as NodeJS.ErrnoException));
    publish(127);
  }
}
