// Failure modes: loading history becomes this turn's answer; a restarted bridge forgets the agent's session; thought/tool
// output becomes a receipt; unknown permissions are approved; paths escape through symlinks; an RPC error looks successful;
// a turn the agent took and then lost isn't marked as started, so the worker runs its prompt again; a session that couldn't
// be loaded is marked as started, so the worker never starts a new one; an agent is told a version number left behind by a
// release. Going on in a session, a failure before the prompt (the program exits at once, initialize fails, loading breaks
// off) is taken for a session that can't be gone on in, so the work is done again in a new one; an agent that refuses the
// session or can't go on in any isn't let go to a new one; an agent that only has session/resume is told session/load; a
// session something else has open just now is taken for one the agent refused, so the work is done again in a new one.
// A U+2028 or U+2029 in anything the agent says, which JSON leaves as it is, cuts the line and ends the turn.
// With edit access, a link in the folder that goes nowhere, or through such a link, passes for a new file inside it, and
// writing through it lands outside. A permission request that gives only the tool call's id is judged as if it had no kind;
// what an earlier message said of the call hides what this one says, or a field left empty wipes what was known. A thought
// in the middle of a message loses its first half; a finished tool call between two messages with no id runs them together,
// so a "没跑成" after it reads as work done; a line that can't be read, which an agent must not write, is passed over, so one
// with no newline takes the answer with it and the run hangs until its time limit. A failed turn doesn't say so until the agent and its stdout are gone, which may be never; its half-written answer counts; or what the
// agent itself said on stderr is lost from the reason. A turn a real agent ends with no text at all, which OpenCode 1.1.2
// does when the model it called refuses, is reported as a turn that didn't finish: it contradicts the stop reason it
// quotes and names no cause. An agent with no command line doesn't say what's missing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import acp from "../plugins/acp/agent.ts";
import { bridge, permission } from "../plugins/acp/bridge.ts";
import { versionName } from "../host/version.ts";
import { acpAgent } from "./helpers.ts";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "fake.mjs");
writeFileSync(
  fake,
  `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=(sessionUpdate,text)=>send({method:'session/update',params:{sessionId:'agent-session',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize'){writeFileSync(${JSON.stringify(join(home, "client-version"))},m.params.clientInfo.version);send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});}
if(m.method==='session/new')send({id:m.id,result:{sessionId:'agent-session'}});
if(m.method==='session/load'){if(m.params.sessionId!=='agent-session')return send({id:m.id,error:{code:-1,message:'bad session'}});update('agent_message_chunk','旧历史');send({id:m.id,result:{}});}
if(m.method==='session/prompt'){if(m.params.prompt[0].text==='中途断了'){update('tool_call','');process.exit(9);}update('agent_thought_chunk','思考');update('agent_message_chunk','中间消息');update('tool_call','');update('agent_message_chunk',m.params.prompt[0].text);send({id:m.id,result:{stopReason:'end_turn'}});}
});`,
);
const bridged = (command: string[], resume: string | null, prompt = "完成了", access = "read") =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/acp/bridge.ts"),
        JSON.stringify({ command, cwd: home, prompt, access, resume }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
const run = (resume: string | null, prompt = "完成了") => bridged([process.execPath, fake], resume, prompt);
/** One launch of a stand-in agent. */
const launch = (name: string, script: string, resume: string | null = null, prompt?: string, access?: string) =>
  bridged([process.execPath, acpAgent(home, name, script)], resume, prompt, access);
const refusing = (message: string) =>
  `(m) => send({ id: m.id, error: { code: -32000, message: ${JSON.stringify(message)} } })`;
const declaring = (capabilities: object) =>
  `on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(capabilities)} } });`;
test("ACP speaks v1, resumes across processes, discards history and returns only the final answer", async () => {
  for (const resume of [null, "agent-session"]) {
    const r = await run(resume);
    assert.equal(r.code, 0, r.err);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).text, "完成了");
    assert.equal(lines.at(-1).session, "agent-session");
    assert.ok(!r.out.includes("旧历史"));
    assert.ok(!r.out.includes("思考"));
  }
  const bad = await run("missing-session");
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /bad session/);
});
test("ACP says a turn started once the agent has the prompt, and never for a session it couldn't load", async () => {
  for (const resume of [null, "agent-session"]) {
    const ok = await run(resume);
    assert.equal(
      JSON.parse(ok.out.split("\n")[0]).started,
      true,
      "printed before the prompt goes, so it survives a kill",
    );
    assert.equal(acp.read(ok.out, null, "").started, true);
    assert.equal(acp.read(ok.out, ok.code, ok.err).text, "完成了");
    const lost = await run(resume, "中途断了");
    assert.notEqual(lost.code, 0);
    const reading = acp.read(lost.out, lost.code, lost.err);
    assert.deepEqual(
      [reading.started, reading.session, reading.text],
      [true, "agent-session", undefined],
      "a broken turn keeps its session and doesn't count as an answer",
    );
    assert.match(reading.error!, /ACP/);
  }
  const missing = await run("missing-session");
  const reading = acp.read(missing.out, missing.code, missing.err);
  assert.equal(reading.started, undefined);
  assert.match(reading.error!, /bad session/);
});
for (const [what, script] of [
  ["exits as soon as it starts", "process.exit(3);"],
  ["fails to initialize", `on.initialize = ${refusing("初始化坏了")};`],
  ["speaks another version", "on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 99 } });"],
  ["exits while loading the session", "on['session/load'] = () => process.exit(4);"],
  [
    "exits while resuming the session",
    `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = () => process.exit(4);`,
  ],
] as const) {
  test(`ACP going on in a session stays there when the agent ${what}`, async () => {
    const result = await launch(what.replaceAll(" ", "-"), script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
    assert.ok(reading.error);
    assert.equal(acp.read(result.out, null, "").started, true, "and it reads that way while it's going");
  });
}

test("ACP going on in a session stays there when the program can't be started at all", async () => {
  const result = await bridged([join(home, "not-there")], "agent-session");
  assert.notEqual(result.code, 0);
  const reading = acp.read(result.out, result.code, result.err);
  assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
});

test("ACP lets a new session start only when the agent says no to this one", async () => {
  for (const [name, script, why] of [
    ["refuses-load", `on['session/load'] = ${refusing("没有这个会话")};`, /没有这个会话/],
    [
      "refuses-resume",
      `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = ${refusing("没有这个会话")};`,
      /没有这个会话/,
    ],
    ["cannot-resume", declaring({}), /不支持恢复/],
    // What the official adapter says of a session that truly isn't there, and the same code as "in use" for another reason.
    [
      "no-rollout",
      `on['session/load'] = (m) => send({ id: m.id, error: { code: -32603, message: 'no rollout found' } });`,
      /no rollout found/,
    ],
    [
      "bad-request",
      `on['session/load'] = (m) => send({ id: m.id, error: { code: -32600, message: '不接受', data: { reason: 'other' } } });`,
      /不接受/,
    ],
  ] as const) {
    const result = await launch(name, script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.equal(reading.started, undefined, name);
    assert.match(reading.error!, why);
    assert.equal(acp.read(result.out, null, "").started, undefined, `${name}: and it reads that way while it's going`);
  }
  const fresh = await launch("fresh-breaks", `on.initialize = ${refusing("初始化坏了")};`);
  assert.equal(acp.read(fresh.out, fresh.code, fresh.err).started, undefined, "a new session has nothing to stay in");
});

test("ACP stays in a session something else has open, and says why in the agent's own words", async () => {
  const inUse = `(m) => send({ id: m.id, error: { code: -32600, message: '这个会话正在别处打开，关掉后再试', data: { reason: 'thread_active_writer' } } })`;
  for (const [name, script] of [
    ["in-use-load", `on['session/load'] = ${inUse};`],
    ["in-use-resume", `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = ${inUse};`],
  ] as const) {
    const result = await launch(name, script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.deepEqual([reading.started, reading.session], [true, "agent-session"], name);
    assert.match(reading.error!, /这个会话正在别处打开，关掉后再试/);
  }
});

test("ACP uses session/resume for an agent that only has that, and session/load for one that has both", async () => {
  const called = join(home, "resume-method");
  const record = `(m) => { appendFileSync(${JSON.stringify(called)}, JSON.stringify([m.method, m.params.sessionId, m.params.cwd, m.params.mcpServers])); send({ id: m.id, result: {} }); }`;
  const both = `on['session/load'] = ${record}; on['session/resume'] = ${record};`;
  const onlyResume = await launch(
    "only-resume",
    `${declaring({ sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(onlyResume.code, 0, onlyResume.err);
  assert.equal(acp.read(onlyResume.out, onlyResume.code, onlyResume.err).text, "做完了");
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/resume", "agent-session", home, []]);
  rmSync(called);
  const hasBoth = await launch(
    "has-both",
    `${declaring({ loadSession: true, sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(hasBoth.code, 0, hasBoth.err);
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/load", "agent-session", home, []]);
});

test("ACP reads U+2028 and U+2029 in what the agent says as part of the line", async () => {
  const result = await launch(
    "line-separators",
    `on['session/prompt'] = (m) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: '工具输出\\u2028第二行' });
      say('第一行\\u2028第二行\\u2029第三行');
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
  );
  assert.equal(result.code, 0, result.err);
  assert.equal(acp.read(result.out, result.code, result.err).text, "第一行 第二行 第三行");
});

test("ACP finds where the last message starts", async () => {
  const tool = (sessionUpdate: string, status?: string) => ({ sessionUpdate, toolCallId: "t", title: "工具", status });
  const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } };
  const say = (text: string, messageId?: string) => ({ text, messageId });
  for (const [why, steps, expected] of [
    ["a thought doesn't split a message with an id", [say("前半", "m1"), thought, say("后半", "m1")], "前半后半"],
    ["a tool call doesn't split one either", [say("前半", "m1"), tool("tool_call"), say("后半", "m1")], "前半后半"],
    [
      "nor does a finished one",
      [say("前半", "m1"), tool("tool_call_update", "completed"), say("后半", "m1")],
      "前半后半",
    ],
    ["a new id is a new message", [say("旧的", "m1"), say("新的", "m2")], "新的"],
    ["an id after none is a new message", [say("旧的"), say("新的", "m2")], "新的"],
    ["with no id, a thought is a boundary", [say("旧的"), thought, say("新的")], "新的"],
    ["with no id, a tool call is a boundary", [say("旧的"), tool("tool_call"), say("新的")], "新的"],
    [
      "with no id, a completed tool call is a boundary",
      [say("旧的"), tool("tool_call_update", "completed"), say("新的")],
      "新的",
    ],
    [
      "with no id, a failed tool call is a boundary",
      [say("旧的"), tool("tool_call_update", "failed"), say("新的")],
      "新的",
    ],
    ["a tool call still going isn't", [say("前半"), tool("tool_call_update", "in_progress"), say("后半")], "前半后半"],
    ["nor is one that only reports", [say("前半"), tool("tool_call_update"), say("后半")], "前半后半"],
    ["chunks with no boundary are one message", [say("一"), say("二"), say("三")], "一二三"],
  ] as const) {
    const result = await launch(
      `boundary-${why.replaceAll(/\W/g, "-")}`,
      `on['session/prompt'] = (m) => {
        for (const step of ${JSON.stringify(steps)}) {
          if (step.sessionUpdate) update(step);
          else say(step.text, step.messageId);
        }
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(acp.read(result.out, result.code, result.err).text, expected, why);
  }
});

test("ACP ends a turn as soon as it can't read a line from the agent", async () => {
  for (const [name, stray] of [
    ["a-stray-line", "这不是 JSON\\n"],
    ["a-stray-print-with-no-newline", "这不是 JSON"],
    ["a-blank-line", "\\n"],
    ["a-null", "null\\n"],
  ] as const) {
    // Passed over, a print with no newline takes the answer with it, and nothing would end the turn but this timer.
    const result = await launch(
      name,
      `setTimeout(() => process.exit(0), 3000);
      on['session/prompt'] = (m) => {
        say('做完了');
        process.stdout.write('${stray}');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
    );
    assert.notEqual(result.code, 0, name);
    const reading = acp.read(result.out, result.code, result.err);
    assert.equal(reading.text, undefined, name);
    assert.doesNotMatch(reading.error!, /退出/, `${name}: it didn't wait for the agent to go`);
  }
});

test("ACP says a turn has failed and why as soon as it has, so nothing has to wait for the agent to go", async () => {
  const result = await launch(
    "max-tokens",
    `on['session/prompt'] = (m) => { say('写了一半'); send({ id: m.id, result: { stopReason: 'max_tokens' } }); };`,
  );
  assert.notEqual(result.code, 0);
  const why = "ACP 没有完成这一轮：max_tokens";
  assert.deepEqual(JSON.parse(result.out.trim().split("\n").at(-1)!), {
    session: "agent-session",
    finished: true,
    error: why,
  });
  const going = acp.read(result.out, null, "");
  assert.deepEqual([going.finished, going.error, going.text], [true, why, undefined], "said while it's still there");
  // A run the worker had to stop after that counts as having ended by itself: it gets a code of 0.
  for (const reading of [
    acp.read(result.out, 0, ""),
    acp.read(result.out, 0, result.err),
    acp.read(result.out, 1, result.err),
  ]) {
    assert.deepEqual([reading.error, reading.session, reading.started], [why, "agent-session", true]);
    assert.equal(reading.text, undefined, "half an answer isn't an answer");
  }
  const talkative = acp.read(result.out, 0, `${result.err}${"它还在写日志\n".repeat(100)}`);
  assert.ok(talkative.error!.endsWith(why), "an agent that goes on talking doesn't push out the reason");
});

test("ACP says a turn came back empty, not that it failed to finish", async () => {
  // OpenCode 1.1.2 answers end_turn with nothing said when the model it called refused the request, so the reason read
  // "没有完成这一轮：end_turn" — contradicting the stop reason it quotes, and naming no cause at all.
  const result = await launch(
    "empty-answer",
    `on['session/prompt'] = (m) => send({ id: m.id, result: { stopReason: 'end_turn' } });`,
  );
  assert.notEqual(result.code, 0, "a turn with no answer is not a finished turn");
  const reading = acp.read(result.out, result.code, result.err);
  assert.equal(reading.text, undefined);
  assert.match(reading.error!, /没有回文字/);
  assert.doesNotMatch(reading.error!, /没有完成这一轮/, "it did finish; it just said nothing");
});

test("ACP's reason for a failure keeps what the agent itself said", async () => {
  const result = await launch(
    "says-why",
    `on['session/prompt'] = () => { console.error('登录过期了'); process.exit(1); };`,
  );
  const reading = acp.read(result.out, result.code, result.err);
  assert.match(reading.error!, /登录过期了/);
  assert.match(reading.error!, /ACP 在交回结果前退出：1/);
});

test("ACP doesn't make up a session for a turn that failed before it had one", async () => {
  const result = await launch("no-session", `on['session/new'] = ${refusing("开不了")};`);
  assert.deepEqual(JSON.parse(result.out.trim()), { finished: true, error: "开不了" });
  const bad = await launch("bad-session", `on['session/new'] = (m) => send({ id: m.id, result: { sessionId: 7 } });`);
  assert.deepEqual(JSON.parse(bad.out.trim()), { finished: true, error: "ACP 没有返回会话编号" });
});

test("ACP chooses only a one-time permission and respects structured kinds and resolved paths", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const ask = (access: string, toolCall: any) => permission({ access, cwd: home } as any, { options, toolCall });
  assert.equal(ask("read", { kind: "read" }).outcome, "selected");
  assert.equal(ask("read", { kind: "execute", title: "read file" }).optionId, "no");
  assert.equal(ask("edit", { kind: "edit", locations: [{ path: join(home, "new.txt") }] }).optionId, "once");
  mkdirSync(join(home, "work"));
  symlinkSync(tmpdir(), join(home, "work", "escape"));
  assert.equal(
    ask("edit", { kind: "edit", locations: [{ path: join(home, "work", "escape", "outside") }] }).optionId,
    "no",
  );
  assert.equal(ask("edit", { kind: "other" }).optionId, "no");
  assert.equal(ask("full", { kind: "other" }).optionId, "once");
});

test("ACP doesn't take a link that goes nowhere for a new file in the folder", () => {
  const options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const work = join(home, "links");
  const outside = join(home, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  const edit = (path: string, access = "edit") =>
    permission({ access, cwd: work } as any, { options, toolCall: { kind: "edit", locations: [{ path }] } }).optionId;
  symlinkSync(join(outside, "not-there"), join(work, "dangling"));
  symlinkSync(join(outside, "no-such-dir"), join(work, "dangling-dir"));
  symlinkSync(join(work, "dangling"), join(work, "link-to-dangling"));
  symlinkSync(join(work, "link-to-dangling"), join(work, "link-to-link"));
  symlinkSync("../outside/relative", join(work, "relative-dangling"));
  symlinkSync(join(work, "loop-b"), join(work, "loop-a"));
  symlinkSync(join(work, "loop-a"), join(work, "loop-b"));
  mkdirSync(join(work, "real"));
  symlinkSync(join(outside, "not-there"), join(work, "real", "deep"));
  for (const path of [
    "dangling",
    "dangling-dir/new.txt",
    "dangling-dir/new/deeper.txt",
    "link-to-dangling",
    "link-to-link",
    "relative-dangling",
    "loop-a",
    "loop-a/new.txt",
    "real/deep",
    "new-folder/../dangling",
  ]) {
    assert.equal(edit(join(work, path)), "no", path);
    assert.equal(edit(`${work}/${path}`), "no", `${path}, not normalised`);
  }
  // Win32 normalizes .. before traversing the filesystem; POSIX traverses the dangling link first.
  assert.equal(edit(`${work}/dangling/../inside.txt`), process.platform === "win32" ? "once" : "no");
  assert.equal(edit(join(work, "real", "new-file.txt")), "once", "a new file is still fine");
  assert.equal(edit(join(work, "new-folder", "new-file.txt")), "once", "in a new folder too");
  assert.equal(edit(join(work, "dangling"), "full"), "once", "full doesn't look at paths");
});
test("ACP judges a permission on all that's been said of the tool call, the request's own fields first", async () => {
  const inside = join(home, "inside.txt");
  const outside = join(tmpdir(), "outside.txt");
  const call = (toolCallId: string, fields: object) => ({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "工具",
    ...fields,
  });
  const change = (toolCallId: string, fields: object) => ({ sessionUpdate: "tool_call_update", toolCallId, ...fields });
  const location = (path: string) => ({ locations: [{ path }] });
  for (const [why, access, updates, request, expected] of [
    ["only the id", "read", [call("t", { kind: "read" })], { toolCallId: "t" }, "allow"],
    ["kind from a search", "read", [call("t", { kind: "search" })], { toolCallId: "t" }, "allow"],
    ["execute stays execute", "read", [call("t", { kind: "execute" })], { toolCallId: "t" }, "reject"],
    ["another call's kind", "read", [call("t", { kind: "read" })], { toolCallId: "other" }, "reject"],
    ["edit inside", "edit", [call("t", { kind: "edit", ...location(inside) })], { toolCallId: "t" }, "allow"],
    ["edit outside", "edit", [call("t", { kind: "edit", ...location(outside) })], { toolCallId: "t" }, "reject"],
    [
      "kind and place in two messages",
      "edit",
      [call("t", { kind: "edit" }), change("t", location(inside))],
      { toolCallId: "t" },
      "allow",
    ],
    [
      "an update moves it out",
      "edit",
      [call("t", { kind: "edit", ...location(inside) }), change("t", location(outside))],
      { toolCallId: "t" },
      "reject",
    ],
    [
      "an update changes the kind",
      "read",
      [call("t", { kind: "read" }), change("t", { kind: "execute" })],
      { toolCallId: "t" },
      "reject",
    ],
    [
      "the request's own kind first",
      "read",
      [call("t", { kind: "read" })],
      { toolCallId: "t", kind: "execute" },
      "reject",
    ],
    [
      "the request's own place first",
      "edit",
      [call("t", { kind: "edit", ...location(inside) })],
      { toolCallId: "t", ...location(outside) },
      "reject",
    ],
    [
      "empty fields change nothing",
      "edit",
      [call("t", { kind: "edit", ...location(inside) }), change("t", { kind: null, locations: null })],
      { toolCallId: "t", kind: null, locations: null },
      "allow",
    ],
    ["nothing known", "read", [], { toolCallId: "t" }, "reject"],
  ] as const) {
    const result = await launch(
      `permission-${why.replaceAll(/\W/g, "-")}`,
      `on['session/prompt'] = async (m) => {
        for (const change of ${JSON.stringify(updates)}) update(change);
        const { outcome } = await ask(${JSON.stringify(request)});
        say(outcome.optionId);
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };`,
      null,
      undefined,
      access,
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(acp.read(result.out, result.code, result.err).text, expected, why);
  }
});

test("ACP remembers what a permission request itself said of the tool call", async () => {
  const result = await launch(
    "permission-twice",
    `on['session/prompt'] = async (m) => {
      const first = await ask({ toolCallId: 't', kind: 'read' });
      const second = await ask({ toolCallId: 't' });
      say(first.outcome.optionId + ' ' + second.outcome.optionId);
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
  );
  assert.equal(acp.read(result.out, result.code, result.err).text, "allow allow");
});

test("ACP doesn't count tool calls from the history it's loading as this turn's", async () => {
  const result = await launch(
    "permission-history",
    `on['session/load'] = (m) => {
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: '旧的', kind: 'read' });
      send({ id: m.id, result: {} });
    };
    on['session/prompt'] = async (m) => {
      const { outcome } = await ask({ toolCallId: 'old' });
      say(outcome.optionId);
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };`,
    "agent-session",
  );
  assert.equal(acp.read(result.out, result.code, result.err).text, "reject");
});

test("ACP refuses incompatible versions and premature process exit", async () => {
  const original = await import("node:fs").then((fs) => fs.readFileSync(fake, "utf8"));
  try {
    writeFileSync(fake, original.replace("protocolVersion:1", "protocolVersion:99"));
    assert.notEqual((await run(null)).code, 0);
    writeFileSync(fake, "process.exit(0)");
    assert.notEqual((await run(null)).code, 0);
  } finally {
    writeFileSync(fake, original);
  }
});

test("the agent is told which version this is", async () => {
  await run(null);
  assert.equal(readFileSync(join(home, "client-version"), "utf8"), versionName());
});

test("over ACP, an agent with no command line says what's missing", async () => {
  const turn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: home,
    access: "read",
    contextFile: "",
    folder: "",
  } as const;
  await assert.rejects(bridge(turn), /ACP 要在 command 写启动命令/);
});
