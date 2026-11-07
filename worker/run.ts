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
  try {
    const [program, args] = commandLine(argv);
    const child = spawn(program, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => {
      console.error(error.message);
      publish(127);
    });
    child.on("exit", (code) => publish(code ?? 1));
  } catch (error) {
    console.error((error as Error).message);
    publish(127);
  }
}
