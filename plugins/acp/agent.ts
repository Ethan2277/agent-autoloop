import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import { tail, type Adapter, type Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "bridge.ts"),
    JSON.stringify(turn),
  ],
  read(stdout, code, stderr) {
    let reading: Reading = {};
    for (const line of stdout.trim().split("\n")) {
      try {
        reading = { ...reading, ...JSON.parse(line) };
      } catch {
        /* A partial final line is read again after the next poll. */
      }
    }
    // Taken back by the bridge when the agent refused the session it was to go on in.
    if (!reading.started) delete reading.started;
    if (code !== null && (code !== 0 || !reading.finished || reading.error)) {
      // What the agent itself said, then why it failed. The bridge says that last, unless the agent went on talking.
      const said = tail(stderr);
      const error = said.endsWith(reading.error ?? "") ? said : tail(`${said}\n${reading.error}`);
      return { session: reading.session, started: reading.started, error: error || "ACP 没有完成这一轮" };
    }
    return reading;
  },
} satisfies Adapter;
