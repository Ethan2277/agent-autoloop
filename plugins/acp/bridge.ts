// A turn run over the Agent Client Protocol: a process of its own that talks to the ACP agent on stdio and prints what
// the worker's adapter reads, one JSON object per line.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commandLine } from "../../host/command.ts";
import { eachLine } from "../../host/lines.ts";
import { versionName } from "../../host/version.ts";
import type { Turn } from "../../worker/agents.ts";

/** The agent said no, as opposed to going away, saying nothing, or having what was asked for in use. */
class Refused extends Error {}

const isLink = (file: string) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Where a path really is, though it may not be there yet; null if it goes through a link with nothing at the end of it.
 * Writing through one creates what it points at, so it can't count as a new file where the link is.
 */
function resolved(file: string): string | null {
  if (existsSync(file)) return realpathSync(file);
  const folder = resolved(dirname(file));
  if (folder === null) return null;
  const path = resolve(folder, basename(file));
  return isLink(path) ? null : path;
}

export function permission(turn: Pick<Turn, "access" | "cwd">, params: any) {
  const tool = params.toolCall ?? {};
  const inside = (location: any) => {
    if (typeof location.path !== "string" || !isAbsolute(location.path)) return false;
    const target = resolved(location.path);
    if (target === null) return false;
    const path = relative(realpathSync(turn.cwd), target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const editsInside =
    turn.access === "edit" && tool.kind === "edit" && tool.locations?.length > 0 && tool.locations.every(inside);
  const allowed = turn.access === "full" || tool.kind === "read" || tool.kind === "search" || editsInside;
  const option = params.options?.find((option: any) => option.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export async function bridge(turn: Turn) {
  if (!turn.command?.length) throw new Error("ACP 要在 command 写启动命令");
  // The last go may have done its work in this session, so whatever breaks now says nothing about whether a new session
  // would do it again. Only the agent's own no takes this back; see goOn.
  if (turn.resume) console.log(JSON.stringify({ session: turn.resume, started: true }));
  const [program, args] = commandLine(turn.command);
  const child = spawn(program, args, { cwd: turn.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  let session = "";
  let collecting = false;
  let text = "";
  let message: string | undefined;
  let boundary = false;
  const send = (body: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`ACP 在交回结果前退出：${code}`)));
  child.stdin.on("error", fail);

  const toolCalls = new Map<string, object>();
  /** All that's been said of a tool call. A message may give only its id; a field left out or null changes nothing. */
  const toolCall = (said: any) => {
    const fields = Object.entries(said ?? {}).filter(([, value]) => value !== null && value !== undefined);
    const known = { ...toolCalls.get(said?.toolCallId), ...Object.fromEntries(fields) };
    if (said?.toolCallId) toolCalls.set(said.toolCallId, known);
    return known;
  };

  const onUpdate = (update: any) => {
    if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) toolCall(update);
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      // An id says which message this is. Only with none does what came in between have to tell.
      if (update.messageId ? update.messageId !== message : boundary) text = "";
      message = update.messageId;
      boundary = false;
      text += update.content.text;
    } else if (
      ["tool_call", "agent_thought_chunk", "user_message_chunk"].includes(update.sessionUpdate) ||
      (update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(update.status))
    ) {
      boundary = true;
    }
  };
  const onLine = (line: string) => {
    const incoming = JSON.parse(line);
    if (incoming.method === "session/update" && collecting && incoming.params?.sessionId === session) {
      onUpdate(incoming.params.update);
    } else if (incoming.method && incoming.id !== undefined) {
      const { id, method, params } = incoming;
      if (method === "session/request_permission" && params?.sessionId === session) {
        send({ id, result: { outcome: permission(turn, { ...params, toolCall: toolCall(params.toolCall) }) } });
      } else send({ id, error: { code: -32601, message: "不支持这个方法" } });
    } else if (pending.has(incoming.id)) {
      const request = pending.get(incoming.id)!;
      pending.delete(incoming.id);
      if (incoming.error) {
        // Open somewhere else just now isn't a no to the session: a new one would do its work again. The reason and not
        // the code, which is generic: another agent's no under it has to stay a no, or it would never get a new session.
        const inUse = incoming.error.data?.reason === "thread_active_writer";
        request.reject(new (inUse ? Error : Refused)(incoming.error.message));
      } else request.resolve(incoming.result);
    }
  };
  let over = false;
  eachLine(
    child.stdout,
    (line) => {
      if (over) return;
      try {
        onLine(line);
      } catch (error) {
        fail(error as Error);
      }
    },
    // An agent that dies ends its output first, and its exit says more. One still there after this has hung up on us.
    () => setTimeout(() => fail(new Error("ACP 在交回结果前关掉了输出")), 1000).unref(),
  );

  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const goOn = async (can: any) => {
    const method = can?.loadSession ? "session/load" : can?.sessionCapabilities?.resume ? "session/resume" : null;
    try {
      if (!method) throw new Refused("这个 ACP Agent 不支持恢复会话");
      await rpc(method, { sessionId: session, cwd: turn.cwd, mcpServers: [] });
    } catch (error) {
      if (error instanceof Refused) console.log(JSON.stringify({ started: false }));
      throw error;
    }
  };
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  try {
    const clientInfo = { name: "agent-autoloop", version: versionName() };
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
    if (init.protocolVersion !== 1) throw new Error(`不支持 ACP 版本 ${init.protocolVersion}`);
    if (turn.resume) {
      session = turn.resume;
      await goOn(init.agentCapabilities);
    } else {
      const { sessionId } = await rpc("session/new", { cwd: turn.cwd, mcpServers: [] });
      if (typeof sessionId !== "string" || !sessionId) throw new Error("ACP 没有返回会话编号");
      session = sessionId;
    }
    // Before the prompt goes: the agent can start on it at once, and this has to be there if the bridge is killed then.
    console.log(JSON.stringify({ session, started: true }));
    collecting = true;
    const prompt = [{ type: "text", text: turn.prompt }];
    const result = await rpc("session/prompt", { sessionId: session, prompt });
    if (result.stopReason !== "end_turn") throw new Error(`ACP 没有完成这一轮：${result.stopReason}`);
    // end_turn with nothing said is not a turn that stopped early: an agent whose model refused answers this way, and the
    // old reason quoted "end_turn" back as if it had failed, leaving no cause to look for.
    if (!text.trim()) throw new Error("ACP 说这一轮结束了，但没有回文字");
    console.log(JSON.stringify({ session, text, finished: true }));
  } catch (error) {
    // Now and not on the way out: the agent, or what it left holding its output, can keep this process here for good,
    // and this is what lets the worker end it.
    console.log(JSON.stringify({ session: session || undefined, finished: true, error: (error as Error).message }));
    throw error;
  } finally {
    over = true;
    process.removeListener("SIGTERM", stop);
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (import.meta.main) {
  bridge(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
