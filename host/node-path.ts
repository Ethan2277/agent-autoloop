// Homebrew keeps a version's files under `Cellar`, and deletes that directory at the next upgrade; `opt` beside it is
// the link that follows. A program named by its Cellar path dies the next time the machine is upgraded.
import { realpathSync } from "node:fs";

const CELLARS = ["/opt/homebrew", "/usr/local"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const resolve = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * The path that keeps working across an upgrade: `opt` when it names this executable, and also when this executable's
 * own directory is already gone and `opt` still resolves. A long-running process outlives the version directory it
 * started from, so the children it starts need the link, not that path.
 */
export function stablePath(executable: string, cellars = CELLARS) {
  const cellar = new RegExp(`^(${cellars.map(escape).join("|")})/Cellar/([^/]+)/[^/]+/bin/([^/]+)$`).exec(executable);
  if (!cellar) return executable;
  const opt = `${cellar[1]}/opt/${cellar[2]}/bin/${cellar[3]}`;
  const linked = resolve(opt);
  // No link, or one that goes nowhere: there is nothing better than what is already running.
  if (!linked) return executable;
  const current = resolve(executable);
  // Deleted by an upgrade while this process kept running: only the link can start anything now.
  if (!current) return opt;
  return current === linked ? opt : executable;
}
