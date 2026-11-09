// What's different about each agent. Failure cases: a level of access maps to the wrong flag, full access is given unasked,
// a retry starts a new conversation instead of going on, an error or a turn that never finished counts as an answer, a
// reconnect Codex announced and got over before its turn finished fails the finished run, a program's warning is taken
// for its answer, a finished Claude run printed as one JSON array is read as a failure, the
// session isn't picked out, a command line's placeholder isn't filled in, or a background Codex run assumes it inherited
// an application's browser connection. A turn that got going and then broke, or was killed before it finished, doesn't
// say it started, so the worker runs its prompt again; one that never got going says it did, so the worker doesn't start a
// new session for it; what Claude said before a background task ended is taken for its answer, or starts the wait for a
// turn that won't exit; the raw messages of a broken Claude run become the reason it failed. A receipt an Agent wrote
// and then lost because a background task called it back for another turn is dropped, so the card it asked for never
// exists and the work looks untouched; or, carried along, it replaces one the last turn wrote wrongly, so a cancelled
// review comes back. A line of output that's JSON
// but no message, like `null`, stops a plugin reading anything. A command line's placeholder pass rewrites the prompt
// itself — a `{cwd}` or a `$&` the person wrote arrives as the folder or as `{prompt}` — so the program is asked
// something other than what the event said. A built-in agent starts the program it finds, not the one its rules name,
// so a wrapper that sends Claude Code to another service is never run.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

process.env.PATH = `/nonexistent:${process.env.PATH}`;
const { findProgram } = await import("../worker/agents.ts");
// Command construction must also run on CI machines without Codex installed.
const shell = process.env.SHELL;
const lookup = join(setup("adapters"), "lookup.sh");
writeFileSync(lookup, '#!/bin/sh\nprintf "%s\\n" /test/codex\n', { mode: 0o755 });
process.env.SHELL = lookup;
findProgram("codex");
if (shell === undefined) delete process.env.SHELL;
else process.env.SHELL = shell;
type Adapter = import("../worker/agents.ts").Adapter;
const claude: Adapter = (await import("../plugins/claude/agent.ts")).default;
const codex: Adapter = (await import("../plugins/codex/agent.ts")).default;
const command: Adapter = (await import("../plugins/command/agent.ts")).default;
const dsh: Adapter = (await import("../plugins/dsh/agent.ts")).default;

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};
const has = (argv: string[], ...parts: string[]) => {
  const at = argv.indexOf(parts[0]);
  return at >= 0 && parts.every((part, i) => argv[at + i] === part);
};

// The program itself is looked up once: these only care about what follows it.
const stubbed = (adapter: Adapter, t: object) => {
  try {
    return adapter.command({ ...turn, ...t });
  } catch {
    return null;
  }
};

test("a built-in agent starts the program its rules name, with its own arguments after it", () => {
  for (const adapter of [claude, codex, dsh]) {
    const argv = adapter.command({ ...turn, program: "/opt/bin/via-gateway" });
    assert.equal(argv[0], "/opt/bin/via-gateway");
    assert.ok(argv.includes("做这件事") || argv.some((part) => part.includes("做这件事")), "the prompt still goes in");
  }
});

test("Claude Code: access, new and going on, model", { skip: !stubbed(claude, {}) }, () => {
  const argv = stubbed(claude, {})!;
  assert.ok(has(argv, "-p", "做这件事"));
  assert.ok(has(argv, "--session-id", "new-id"));
  assert.ok(has(argv, "--permission-mode", "acceptEdits"));
  // It has to print as it goes: run as "json" it prints nothing until the end, and one cut short leaves no trace.
  assert.ok(has(argv, "--output-format", "stream-json"));
  assert.ok(argv.includes("--verbose"), "Claude Code refuses stream-json in print mode without it");
  assert.ok(!argv.includes("--model"));
  assert.ok(has(stubbed(claude, { access: "read" })!, "--permission-mode", "plan"));
  assert.ok(has(stubbed(claude, { access: "full" })!, "--permission-mode", "bypassPermissions"));
  const again = stubbed(claude, { resume: "old-id", model: "m", effort: "high" })!;
  assert.ok(has(again, "--resume", "old-id"));
  assert.ok(!again.includes("--session-id"));
  assert.ok(has(again, "--model", "m"));
  assert.ok(has(again, "--effort", "high"));
});

test("Claude Code: reading its result", () => {
  const line = (over: object) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "好了",
      session_id: "s",
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
      ...over,
    });
  assert.deepEqual(claude.read(`noise\n${line({})}\n`, 0, ""), {
    text: "好了",
    session: "s",
    usage: { input: 10, output: 2, cached: 6 },
    sessionUsage: { cost: 0.5 },
    finished: true,
  });
  assert.match(
    claude.read(line({ is_error: true, result: "Failed to authenticate\nmore" }), 1, "").error!,
    /^Failed to authenticate$/,
  );
  assert.equal(claude.read(line({ is_error: true, result: "x" }), 1, "").session, "s");
  assert.equal(claude.read(line({ subtype: "error_max_turns", result: undefined }), 1, "").error, "error_max_turns");
  // With verbose on, Claude Code prints every message as one JSON array on a single line.
  const array = `[{"type":"system","subtype":"init"},{"type":"assistant"},${line({})}]\n`;
  assert.equal(claude.read(array, 0, "").text, "好了");
  assert.deepEqual(claude.read("", null, ""), {}, "still going");
  assert.equal(claude.read("", 1, "boom").error, "boom");
  assert.equal(claude.read("", 0, "").error, "没留下结果");
  assert.equal(claude.link!("s"), "claude://resume?session=s");
});

// What `claude -p --output-format stream-json --verbose` really prints, cut down to what's read.
const stream = (...messages: object[]) => `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
const init = { type: "system", subtype: "init", session_id: "s" };
const hook = { type: "system", subtype: "hook_started", session_id: "s" };
const thinking = { type: "assistant", session_id: "s", message: { content: [{ type: "thinking" }] } };
const tool = { type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", name: "Bash" }] } };
const toolResult = { type: "user", session_id: "s", message: { content: [{ type: "tool_result", content: "机密" }] } };
const said = (result: string, num_turns = 1) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result,
  num_turns,
  session_id: "s",
});
const tasks = (...running: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: running.map((task_id) => ({ task_id, task_type: "local_bash" })),
  session_id: "s",
});

test("Claude Code: a turn that got going says so, however it ended", () => {
  const cut = stream(hook, init, tool, toolResult);
  assert.deepEqual(claude.read(cut, null, ""), { session: "s", started: true }, "still going, or vanished");
  const killed = claude.read(cut, 143, "");
  assert.equal(killed.session, "s");
  assert.equal(killed.started, true);
  assert.equal(killed.error, "没留下结果");
  assert.equal(claude.read(stream(init), null, "").started, true, "it has the prompt, in a conversation that's there");
  const failed = { ...said("API Error: 500"), is_error: true };
  assert.equal(claude.read(stream(init, thinking, failed), 1, "").started, true);
  assert.equal(claude.read(stream(failed), 1, "").started, true, "only the last line, it took a turn");
  assert.equal(claude.read(stream(init, tool, said("好了", 2)), 0, "").text, "好了");
});

test("Claude Code: a resume that never got going doesn't say it started, and says why", () => {
  const missing = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    session_id: "old",
    errors: ["No conversation found with session ID: old"],
  };
  const reading = claude.read(stream(missing), 1, "No conversation found with session ID: old");
  assert.equal(reading.started, undefined);
  assert.equal(reading.error, "No conversation found with session ID: old");
  assert.equal(claude.read("", 1, "No conversation found").started, undefined, "printed as json: nothing on stdout");
  assert.equal(claude.read(stream(hook), 1, "boom").started, undefined, "a hook runs before it has the prompt");
  assert.deepEqual(claude.read(stream(hook), null, ""), { session: "s" });
});

test("Claude Code: the raw messages of a broken run aren't the reason it failed", () => {
  assert.equal(claude.read(stream(init, tool, toolResult), 1, "连接断了").error, "连接断了");
  assert.doesNotMatch(claude.read(stream(init, tool, toolResult), 1, "").error!, /机密|tool_result/);
  assert.equal(
    claude.read("Invalid API key\n", 1, "").error,
    "Invalid API key",
    "its complaint on stdout still counts",
  );
});

test("Claude Code: what it said before a background task ended isn't its answer", () => {
  const waiting = stream(init, tool, tasks("t1"), toolResult, said("已启动", 2));
  assert.deepEqual(claude.read(waiting, null, ""), { session: "s", started: true }, "still going, so not over");
  assert.equal(claude.read(waiting, 137, "").text, undefined, "killed while waiting: it never got to its answer");
  assert.equal(claude.read(waiting, 137, "").error, "没留下结果");
  assert.equal(claude.read(waiting, 0, "").text, "已启动", "it ended by itself: that was its last word");
  const ended = stream(init, tool, tasks("t1"), toolResult, said("已启动", 2), tasks());
  assert.equal(claude.read(ended, null, "").finished, true, "nothing left to come back for");
  assert.equal(claude.read(ended, null, "").text, "已启动");
  for (const next of [init, thinking, toolResult]) {
    const going = stream(init, tool, tasks("t1"), toolResult, said("已启动", 2), tasks(), next);
    assert.deepEqual(claude.read(going, null, ""), { session: "s", started: true }, "a later turn is going");
    assert.equal(claude.read(going, 1, "").error, "没留下结果", "and it broke");
  }
  const done = stream(init, tool, tasks("t1"), said("已启动", 2), tasks(), init, thinking, said("结束了"));
  assert.equal(claude.read(done, null, "").finished, true);
  assert.equal(claude.read(done, 0, "").text, "结束了");
});

test("Claude Code: a receipt it wrote isn't lost when a background task calls it back", () => {
  const block = (receipt: object) => "```agent-autoloop\n" + JSON.stringify(receipt) + "\n```";
  const ask = { title: "要不要修", text: "这个缺陷要不要修", options: ["修", "不修"], recommend: 0, key: "k" };
  // The task ends after the answer, so Claude Code is called back for another turn that says nothing about the ask.
  const called = stream(
    init,
    tool,
    tasks("t1"),
    toolResult,
    said(`查清楚了，等你决定。\n\n${block({ ask: [ask] })}`, 30),
    tasks(),
    init,
    tool,
    said("没事可做：已经发过卡了"),
  );
  const read = claude.read(called, 0, "");
  assert.ok(read.text!.startsWith("没事可做：已经发过卡了"), "the last turn's word is still the answer");
  const handed = resultFrom(readMessage(read.text!), {});
  assert.equal(handed.problem, undefined, "and it is handed in as a receipt the hub can read");
  assert.deepEqual(handed.result.ask, [ask]);
  assert.equal(handed.result.outcome, "nothing", "the last turn's own words decide the outcome");
  // Called back more than once, the latest receipt it wrote is the one that still counts.
  const twice = stream(
    init,
    said(`第一次\n\n${block({ notice: [{ title: "旧的", text: "旧的通知" }] })}`),
    init,
    said(`第二次\n\n${block({ notice: [{ title: "新的", text: "新的通知" }] })}`),
    init,
    said("没事可做：都发过了"),
  );
  const notices = (text: string) => readMessage(text).receipt?.notice as { title: string; text: string }[] | undefined;
  assert.equal(notices(claude.read(twice, 0, "").text!)?.[0].title, "新的");
  // Its own receipt is not replaced by an older one, and with none before it nothing is invented.
  const own = stream(
    init,
    said(`先说一句\n\n${block({ notice: [{ title: "旧的", text: "旧的通知" }] })}`),
    init,
    said(`最后\n\n${block({ later: [{ key: "c", at: "2026-11-08T09:00:00+08:00", about: "复查" }] })}`),
  );
  const kept = readMessage(claude.read(own, 0, "").text!).receipt as {
    notice?: unknown;
    later?: { key: string }[];
  };
  assert.equal(kept.later?.[0].key, "c", "it keeps the receipt of its own last turn");
  assert.equal(kept.notice, undefined, "and no older one is added beside it");
  assert.equal(claude.read(stream(init, said("先说一句"), init, said("最后一句")), 0, "").text, "最后一句");
  // A last turn that wrote a receipt wrongly is asked to write it again, not handed an older one in its place.
  const earlier = said(
    `先说一句\n\n${block({ later: [{ key: "c", at: "2026-11-08T09:00:00+08:00", about: "复查" }] })}`,
  );
  const mislabelled = "最后\n\n```json\n" + JSON.stringify({ later: [{ key: "c", cancel: true }] }) + "\n```";
  const unclosed = "最后\n\n```agent-autoloop\n" + JSON.stringify({ later: [{ key: "c", cancel: true }] }) + "```";
  for (const last of [mislabelled, unclosed]) {
    const message = readMessage(claude.read(stream(init, earlier, init, said(last)), 0, "").text!);
    assert.equal(message.receipt, undefined, "the older receipt stands in for the one it got wrong");
    assert.ok(message.problem, "and it isn't asked to write its own again");
  }
});

test("Codex: access, new and going on", { skip: !stubbed(codex, {}) }, () => {
  const argv = stubbed(codex, {})!;
  assert.deepEqual(argv.slice(1, 4), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(argv.at(-1)!.endsWith("做这件事"));
  assert.ok(argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(stubbed(codex, { access: "read" })!.includes('sandbox_mode="read-only"'));
  assert.ok(stubbed(codex, { access: "full" })!.includes('sandbox_mode="danger-full-access"'));
  const again = stubbed(codex, { resume: "thread-1", model: "m", effort: "xhigh" })!;
  assert.deepEqual(again.slice(1, 3), ["exec", "resume"]);
  assert.equal(again.at(-2), "thread-1");
  assert.equal(again.at(-1), argv.at(-1));
  assert.ok(has(again, "-m", "m"));
  assert.ok(again.includes('model_reasoning_effort="xhigh"'));
});

test("Codex: new and resumed runs use only browser access configured for the background task", () => {
  for (const resume of [null, "thread-1"]) {
    const prompt = codex.command({ ...turn, resume }).at(-1)!;
    assert.match(prompt, /后台 codex exec/);
    assert.match(prompt, /本轮实际可用的浏览器工具/);
    assert.match(prompt, /规则或 Skill.*浏览器入口/);
    assert.match(prompt, /桌面应用.*浏览器连接/);
    assert.match(prompt, /业务.*回执.*本轮/);
    assert.ok(prompt.endsWith(turn.prompt));
    assert.doesNotMatch(prompt, /~\/\.local\/bin\/|\/Users\//);
  }
});

test("Codex: only a finished turn's last message is its answer", () => {
  const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const started = { type: "thread.started", thread_id: "t" };
  const warning = { type: "item.completed", item: { type: "error", message: "under development" } };
  const said = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
  const ended = { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 3, output_tokens: 1 } };
  assert.deepEqual(codex.read(lines(started, warning, said("中途"), said("好了"), ended), 0, ""), {
    session: "t",
    text: "好了",
    finished: true,
    sessionUsage: { input: 9, output: 1, cached: 3 },
  });
  // A reconnect Codex announced and then got over (it fell back to another transport and carried on) is not how the
  // turn ended: twelve finished runs with receipts were thrown away and redone over one of these.
  const reconnect = { type: "error", message: "Reconnecting... 5/5 (request timed out)" };
  assert.deepEqual(codex.read(lines(started, reconnect, said("好了"), ended), 0, ""), {
    session: "t",
    text: "好了",
    finished: true,
    sessionUsage: { input: 9, output: 1, cached: 3 },
  });
  assert.deepEqual(
    codex.read(lines(started, said("中途")), null, ""),
    { session: "t" },
    "still going: only the session so far",
  );
  assert.equal(codex.read(lines(started, said("中途")), 1, "").error, "Codex 没有完成并留下实际结果");
  assert.equal(
    codex.read(lines(started, ended), 0, "").error,
    "Codex 没有完成并留下实际结果",
    "finished with nothing to say",
  );
  assert.deepEqual(codex.read(lines(started, { type: "turn.failed", error: { message: "额度用完了" } }), 1, ""), {
    session: "t",
    finished: true,
    error: "额度用完了",
  });
  assert.equal(codex.read("", 1, "cannot resume: active writer").error, "cannot resume: active writer");
  assert.equal(codex.link!("t"), "codex://threads/t");
});

test("Codex: a turn that got going says so, however it ended; one that never did doesn't", () => {
  const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
  const thread = { type: "thread.started", thread_id: "t" };
  const warning = { type: "item.completed", item: { type: "error", message: "under development" } };
  const turn = { type: "turn.started" };
  const running = { type: "item.started", item: { type: "command_execution" } };
  const cut = lines(thread, warning, turn, running);
  assert.deepEqual(codex.read(cut, null, ""), { session: "t", started: true }, "still going, or vanished");
  assert.deepEqual(codex.read(cut, 143, ""), {
    session: "t",
    started: true,
    error: "Codex 没有完成并留下实际结果",
  });
  assert.equal(codex.read(lines(thread, turn, { type: "turn.failed" }), 1, "").started, true);
  assert.equal(codex.read(lines(thread, warning), 1, "boom").started, undefined, "a warning isn't the turn");
  const missing = "Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)";
  assert.equal(codex.read("", 1, missing).started, undefined);
  assert.equal(codex.read("", 1, "cannot resume: active writer").started, undefined);
});

test("a plain command: placeholders filled in, stdout is its last message, a bad exit code is a failure", () => {
  const argv = command.command({
    ...turn,
    model: "m",
    command: ["tool", "--model={model}", "-p", "{prompt}", "--ctx", "{context}"],
  });
  assert.deepEqual(argv, ["tool", "--model=m", "-p", "做这件事", "--ctx", "/ctx.json"]);
  assert.deepEqual(command.read("好了\n", 0, ""), { text: "好了\n" });
  assert.deepEqual(command.read("中途", null, ""), {});
  assert.match(command.read("", 3, "boom").error!, /退出码 3：boom/);
  assert.equal(command.link, undefined, "it has no session to go on in");
});

test("a plain command's prompt reaches the program as it was written, whatever it contains", () => {
  // The prompt is what someone asked for; the placeholders belong to the command line, not to the words put in it.
  const written = [
    "把 {cwd} 这个词原样打印出来",
    "价格是 $& 元",
    "路径 $` 和 $' 也要留下",
    "{context} 和 {prompt} 都是字面",
  ];
  for (const prompt of written) {
    const argv = command.command({ ...turn, prompt, command: ["tool", "-p", "{prompt}"] });
    assert.deepEqual(argv, ["tool", "-p", prompt], `${prompt} 传到程序时被改写了`);
  }
  // The command line itself still fills in, and one that names the prompt twice gets it twice.
  const both = command.command({ ...turn, model: "m", command: ["tool", "{prompt}", "{model}"] });
  assert.deepEqual(both, ["tool", "做这件事", "m"]);
});

test("a program that isn't there says so", () => {
  assert.throws(() => findProgram("surely-not-installed-anywhere"), /找不到 surely-not-installed-anywhere/);
});

test("a line of output that's JSON but no message is noise to every plugin", () => {
  const noise = 'null\n42\n"words"\n[]\n';
  for (const adapter of [claude, codex, command, dsh]) {
    assert.doesNotThrow(() => adapter.read(noise, null, ""));
    assert.doesNotThrow(() => adapter.read(noise, 0, ""));
  }
});
