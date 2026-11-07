// The hub as the Windows login task runs it, through background.js: output goes straight to files, without PowerShell
// changing its encoding, and the hub's exit is this one's, so background.js starts both again.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

const home = process.argv[2];
mkdirSync(path.join(home, "logs"), { recursive: true });
const log = openSync(path.join(home, "logs", "up.log"), "a");
const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, "../bin/agent-autoloop.ts"), "up"],
  {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["ignore", log, log],
    windowsHide: true,
  },
);
closeSync(log);
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
