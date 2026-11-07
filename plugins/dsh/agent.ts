// DSH (DeepSeek Harness), 0.2.2 or newer: `dsh headless` answers one task and exits. With --json it prints one event per line:
// the opening `session` has the id a later turn goes on in, each `step_end` has that step's tokens, and the last line, `final`,
// has the answer and why the last turn ended. A turn can end with the run still going, waiting on background work that may
// start another turn, so only `final` says it's over. A resumed session keeps the permissions it was saved with unless told
// otherwise, so they're given every time; nobody is there to approve anything, so a call that needs it is refused rather than
// left waiting. It has no desktop session to open.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Adapter, type Reading, type Usage } from "../../worker/agents.ts";
import { addUsage } from "../../protocol/validate.ts";

const PRESET = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
const NOT_FINISHED = "DSH 没跑完这一轮";
const NO_RESULT = "DSH 没有完成并留下实际结果";
const WHY_NOT: Record<string, string> = {
  aborted: "这一轮被中止了",
  blocked: "这一轮被卡住了，没有完成",
  "max-tokens": "这一轮用完了输出上限",
};

/** dsh reports each step's tokens as inputTokens / outputTokens / cacheReadTokens. */
function stepUsage(reported: any): Usage | undefined {
  if (!reported || typeof reported !== "object") return undefined;
  const step: Usage = {};
  if (typeof reported.inputTokens === "number") step.input = reported.inputTokens;
  if (typeof reported.outputTokens === "number") step.output = reported.outputTokens;
  if (typeof reported.cacheReadTokens === "number") step.cached = reported.cacheReadTokens;
  return Object.keys(step).length ? step : undefined;
}

export default {
  command: (turn) => [
    turn.program ?? findProgram("dsh"),
    "headless",
    "--json",
    "--permission-mode",
    PRESET[turn.access],
    "--approval-policy",
    "never",
    ...(turn.resume ? ["--session-id", turn.resume] : []),
    turn.prompt,
  ],
  read(stdout, code, stderr) {
    let session: string | undefined;
    let final: { text?: unknown; reason?: { kind?: string; error?: { message?: string } } | null } | undefined;
    let failed: string | undefined;
    let usage: Usage | undefined;
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event || typeof event !== "object") continue;
      if (event.type === "session" && typeof event.sessionId === "string") session = event.sessionId;
      else if (event.type === "status" && event.phase === "step_end") usage = addUsage(usage, stepUsage(event.usage));
      else if (event.type === "final") final = event;
      // With --json a mistake in how it was started goes here and nowhere else.
      else if (event.type === "error" && typeof event.message === "string") failed = event.message;
    }
    const reading: Reading = { ...(session && { session }), ...(usage && { usage }) };
    // It has this turn's prompt in a Session that's there. From here on the work may be half done, so a later turn goes
    // on in the same Session instead of starting over.
    if (session) reading.started = true;
    if (final) {
      reading.finished = true;
      const kind = final.reason?.kind;
      if (kind === "completed") {
        if (typeof final.text === "string" && final.text.trim()) reading.text = final.text;
        else reading.error = NO_RESULT;
      } else if (kind === "error") reading.error = final.reason?.error?.message || NOT_FINISHED;
      else reading.error = WHY_NOT[kind ?? ""] ?? NOT_FINISHED;
    } else if (code !== null) {
      const why = failed || tail(stderr);
      if (code !== 0) reading.error = `退出码 ${code}：${why || "没留下原因"}`;
      else reading.error = why || NO_RESULT;
    }
    return reading;
  },
  check(program) {
    try {
      const help = execFileSync(...commandLine([program ?? findProgram("dsh"), "headless", "--help"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // The options this needs came in 0.2.2, and npm's `latest` is behind that for now.
      if (!help.includes("--approval-policy"))
        return "DSH 版本太旧，要 0.2.2 或更新：npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local";
      return null;
    } catch (error) {
      return `DSH 用不了：运行 dsh headless "hi" 看看（${(error as Error).message.split("\n")[0]}）`;
    }
  },
} satisfies Adapter;
