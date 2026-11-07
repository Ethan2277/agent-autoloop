// Claude Code: the user's own, installed and signed in by them. This only ever runs the official program.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";
import { readMessage, receiptBlock } from "../../worker/contract.ts";

const PERMISSIONS = { read: "plan", edit: "acceptEdits", full: "bypassPermissions" };

/** The newest Claude Code the desktop app ships, for those without a separate install. */
export function inTheApp() {
  const root = path.join(homedir(), "Library/Application Support/Claude/claude-code");
  if (!existsSync(root)) return [];
  // The app keeps its own files, such as auto-update-state.json, beside the version folders.
  const folders = (at: string) =>
    readdirSync(at, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const oldestFirst = folders(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return oldestFirst.reverse().flatMap((version) => {
    const builds = folders(path.join(root, version));
    return builds.map((build) => path.join(root, version, build, "claude.app/Contents/MacOS/claude"));
  });
}

export default {
  command: (turn) => [
    turn.program ?? findProgram("claude", inTheApp),
    "-p",
    turn.prompt,
    ...(turn.resume ? ["--resume", turn.resume] : ["--session-id", turn.session]),
    // As it goes: with "json" nothing comes out until the end, and a turn cut short leaves no sign it ever started.
    "--output-format",
    "stream-json",
    "--verbose",
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--effort", turn.effort] : []),
    "--permission-mode",
    PERMISSIONS[turn.access],
    "--add-dir",
    turn.folder,
    // Entering a worktree moves the whole transcript under the worktree's project folder (still so on 2.1.317): --resume
    // finds it, but the desktop app, opening the session link from the run's folder, showed only its first message.
    "--disallowedTools=EnterWorktree,ExitWorktree",
  ],
  read(stdout, code, stderr) {
    const messages = stdout.split("\n").flatMap((line) => {
      try {
        // With "json" and verbose on in its settings, every message comes as one array on a single line.
        return [JSON.parse(line)].flat();
      } catch {
        return [];
      }
    });
    const result = messages.findLast((message) => message?.type === "result");
    const session = messages.findLast((message) => message?.session_id)?.session_id;
    const started =
      result?.num_turns > 0 || messages.some((message) => message?.type === "assistant" || message?.subtype === "init");
    const known = { ...(session && { session }), ...(started && { started }) };
    // Each turn ends in a result, and a background task brings it back for another when it ends. Only one that's left
    // nothing to come back for is its answer, unless it has exited by itself: then it was its last word.
    const later = messages.slice(messages.lastIndexOf(result) + 1);
    const another = later.some(
      (message) => ["assistant", "user"].includes(message?.type) || message?.subtype === "init",
    );
    const tasks = messages.findLast((message) => message?.subtype === "background_tasks_changed")?.tasks ?? [];
    if (!result || another || (tasks.length && code !== 0)) {
      // Its messages are what it was doing, not what went wrong.
      return code === null
        ? known
        : { ...known, error: tail(stderr || (messages.length ? "" : stdout)) || "没留下结果" };
    }
    const usage = result.usage
      ? {
          input: result.usage.input_tokens ?? 0,
          output: result.usage.output_tokens ?? 0,
          cached: (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0),
        }
      : undefined;
    // Resumed, it goes on counting the price from the session so far, though its tokens start again.
    const sessionUsage = result.total_cost_usd === undefined ? undefined : { cost: result.total_cost_usd };
    const said = String(result.result ?? "");
    // A background task that ends after its answer calls the run back for another turn, and that turn's word replaces the
    // one that carried its receipt. What it asked of the hub is still what it wants, so the words stay the last turn's and
    // the receipt is carried along: dropped, the card it asked for never exists and the work looks untouched.
    // One it wrote wrongly is its own and is written again; only a turn with no receipt at all keeps the earlier one.
    const own = readMessage(said);
    const carried =
      own.receipt === undefined && own.problem === undefined
        ? messages
            .slice(0, messages.lastIndexOf(result))
            .filter((message) => message?.type === "result")
            .map((message) => receiptBlock(String(message.result ?? "")))
            .findLast((block) => block !== undefined)
        : undefined;
    const text = carried === undefined ? said : `${said}\n\n${carried}`;
    if (result.is_error || result.subtype !== "success") {
      const error = said.split("\n")[0] || result.errors?.[0] || result.subtype || "没留下结果";
      return { ...known, usage, sessionUsage, finished: true, error };
    }
    return { text, ...known, usage, sessionUsage, finished: true };
  },
  link: (session) => `claude://resume?session=${session}`,
  check(given) {
    try {
      const program = given ?? findProgram("claude", inTheApp);
      const status = JSON.parse(
        execFileSync(...commandLine([program, "auth", "status"]), { encoding: "utf8", timeout: 20_000 }),
      );
      return status.loggedIn ? null : "Claude Code 没有登录：运行 claude auth login";
    } catch (error) {
      return `Claude Code 用不了：${(error as Error).message.split("\n")[0]}`;
    }
  },
} satisfies Adapter;
