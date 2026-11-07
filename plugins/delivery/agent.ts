// The delivery as an agent: its process is run.ts, and what it prints is read the way any plain command's output is.
import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import command from "../command/agent.ts";
import type { Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "run.ts"),
    ...(turn.command ?? []),
  ],
  read: command.read,
} satisfies Adapter;
