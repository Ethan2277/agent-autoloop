// Failure modes: an HTTP 200 error page or redirect is called healthy; a continuing outage wakes the model or notifies
// again; recovery closes an unrelated card; Feishu is read as the bot, pages or selected fields are lost, an unrelated
// report is included, credentials fail but an old snapshot is summarized, or report text leaks into notifications. Mail
// is read as the bot, a sender the user asked to skip still has its body read, a long body is kept whole or cut short of
// what the reader is told, an empty inbox wakes the model, or a mailbox that returned only some bodies is saved as read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { probe, receipt } from "../examples/recipes/website-watch/check.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-business-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const target = { id: "site", name: "示例网站", url: "https://example.com/health", contains: '"ok":true' };
const empty = { events: [{ id: "tick-1" }], open: [] };

test("website checks status and body without following redirects, and records transport failures", async () => {
  const response = (status: number, body: string) =>
    (async (_url, options) => {
      assert.equal(options?.redirect, "manual");
      return new Response(body, { status });
    }) as typeof fetch;
  assert.equal((await probe(target, response(200, '{"ok":true}'))).ok, true);
  for (const [status, body] of [
    [200, "登录后继续"],
    [503, '{"ok":true}'],
    [302, "跳转"],
  ] as const) {
    assert.equal((await probe(target, response(status, body))).ok, false);
  }
  assert.equal(
    (
      await probe(target, async () => {
        throw new TypeError("network");
      })
    ).ok,
    false,
  );
});

test("website outage wakes once while its card is open, recovery closes only that site's card", () => {
  const first = receipt(target, { ok: false, reason: "返回 503" }, empty);
  assert.equal(first.events?.[0].type, "site.down");
  assert.equal(first.notice?.length, 1);
  const pending = {
    ...empty,
    open: [
      { card: 7, title: first.notice![0].title },
      { card: 8, title: "另一网站异常" },
    ],
  };
  assert.deepEqual(receipt(target, { ok: false, reason: "返回 503" }, pending), {});
  const recovered = receipt(target, { ok: true, reason: "已核实状态和关键内容" }, pending);
  assert.deepEqual(
    recovered.resolve?.map((r) => r.card),
    [7],
  );
  assert.equal(recovered.events?.[0].type, "site.recovered");
  assert.deepEqual(receipt(target, { ok: true, reason: "正常" }, empty), {});
});

test("a Chinese health URL remains a valid event link in the worker receipt", () => {
  const result = receipt({ ...target, url: "https://例子.测试/健康" }, { ok: false, reason: "连接失败" }, empty);
  const parsed = resultFrom(readMessage(`已检查\n\`\`\`agent-autoloop\n${JSON.stringify(result)}\n\`\`\``), {});
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events![0].link, new URL("https://例子.测试/健康").href);
});

function collect(mode = "ok") {
  const dir = mkdtempSync(join(scratch, "brief-"));
  const cli = join(dir, "lark-cli");
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'auth') {
  console.error(JSON.stringify({ok:false,error:{type:'authorization',message:'secret must not be copied'}})); process.exit(1);
}
let data;
if (args[0] === 'api') {
 const body = JSON.parse(args[args.indexOf('--data')+1]);
 const task = {task_id:'report-1',rule_name:'工作周报',from_user_id:'ou_demo',commit_time:body.commit_start_time+60,form_contents:[{field_name:'本周进展',field_value:'敏感原文'}]};
 data = {items:[task,{...task,task_id:'outside',from_user_id:'ou_other'},{...task,task_id:'wrong-rule',rule_name:'自由汇报'}],has_more:false};
} else {
 const offset = Number(args[args.indexOf('--offset')+1]);
 const file = args[args.indexOf('--output')+1];
 fs.writeFileSync(file, JSON.stringify({record_id:'record-'+offset,项目:'演示项目',状态:'进行中'})+'\\n');
 data = {records_count:1,has_more:offset===0,next_offset:offset+1,rev:'1'};
 fs.writeFileSync(file.replace(/\\.ndjson$/, '.manifest.json'), JSON.stringify(data));
}
console.log(JSON.stringify({ok:true,identity:'user',data}));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({
      reportRule: "工作周报",
      reportUsers: ["ou_demo"],
      tables: [
        {
          name: "项目表",
          baseToken: "demo",
          tableId: "tbl_demo",
          fields: ["项目", "状态"],
          url: "https://example.com/projects",
        },
      ],
    }),
  );
  writeFileSync(join(dir, "context.json"), JSON.stringify({ answers: [], open: [], events: [] }));
  writeFileSync(join(dir, "weekly-input.json"), '{"id":"old","reports":["old data"]}');
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/feishu-brief/collect.ts"), "sources.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "context.json") },
    },
  );
  return { dir, run, parsed: resultFrom(readMessage(run.stdout), {}) };
}

test("Feishu collection uses the reader, filters reports and fields, and consumes all table pages", () => {
  const { dir, run, parsed } = collect();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "brief.ready");
  assert.doesNotMatch(run.stdout, /敏感原文|演示项目/);
  const snapshot = JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.reports.map((r: { task_id: string }) => r.task_id),
    ["report-1"],
  );
  assert.equal(snapshot.tables[0].records.length, 2);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.every((args) => args[args.indexOf("--as") + 1] === "user"));
  const baseCalls = calls.filter((args) => args[0] === "base");
  assert.equal(baseCalls.length, 2);
  assert.ok(baseCalls.every((args) => args.includes("--field-id") && args.includes("状态")));
  assert.equal(snapshot.id, parsed.result.events![0].id);
});

test("Feishu authorization failure asks once and never publishes the old snapshot or CLI details", () => {
  const { dir, run, parsed } = collect("auth");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask?.length, 1);
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /secret must not|old data/);
  assert.equal(JSON.parse(readFileSync(join(dir, "weekly-input.json"), "utf8")).id, "old");
});

function triage(mode = "ok") {
  const dir = mkdtempSync(join(scratch, "inbox-"));
  const cli = join(dir, "lark-cli");
  const summaries = [
    {
      message_id: "m-budget",
      thread_id: "t-budget",
      subject: "季度预算确认",
      head_from: { name: "王莉", mail_address: "wang@example.com" },
      folder_id: "INBOX",
      label_ids: ["UNREAD"],
      date_formatted: "2026-11-07 09:12",
      body_preview: "预算表见附件，请确认",
    },
    {
      message_id: "m-bulk",
      thread_id: "t-bulk",
      subject: "本周产品动态",
      head_from: { name: "通知机器人", mail_address: "noreply@example.com" },
      folder_id: "INBOX",
      date_formatted: "2026-11-07 08:00",
      body_preview: "无需回复",
    },
    {
      message_id: "m-long",
      thread_id: "t-long",
      subject: "一份很长的说明",
      head_from: { name: "张三", mail_address: "zhang@example.com" },
      folder_id: "INBOX",
      date_formatted: "2026-11-06 22:41",
      body_preview: "很长的正文",
    },
  ];
  const bodies = { "m-budget": "机密正文：预算四十二万", "m-long": "长".repeat(3000) };
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'auth') {
  console.error(JSON.stringify({ ok: false, error: { type: 'authorization', message: 'secret must not be copied' } }));
  process.exit(1);
}
const summaries = ${JSON.stringify(summaries)};
const bodies = ${JSON.stringify(bodies)};
let data;
if (args[1] === '+triage') {
  data = { messages: mode === 'empty' ? [] : summaries };
} else {
  const ids = args[args.indexOf('--message-ids') + 1].split(',');
  data = {
    messages: ids.map((id) => ({ message_id: id, body_plain_text: bodies[id] ?? '' })),
    total: ids.length,
    unavailable_message_ids: mode === 'partial' ? [ids[0]] : [],
  };
}
console.log(JSON.stringify({ ok: true, identity: 'user', data }));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({
      folderId: "INBOX",
      onlyUnread: true,
      lookbackHours: 24,
      maxMessages: 30,
      bodyChars: 1200,
      skipSenders: ["noreply@example.com"],
    }),
  );
  writeFileSync(join(dir, "context.json"), JSON.stringify({ answers: [], open: [], events: [] }));
  writeFileSync(join(dir, "inbox-input.json"), '{"id":"old","messages":["old data"]}');
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../examples/recipes/inbox-triage/collect.ts"), "sources.json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "context.json") },
    },
  );
  return { dir, run, parsed: resultFrom(readMessage(run.stdout), {}) };
}

test("mail is read as the user, a skipped sender's body is never read, and a long body is cut to a stated length", () => {
  const { dir, run, parsed } = triage();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.events?.[0].type, "inbox.ready");
  assert.doesNotMatch(run.stdout, /机密正文|长{100}/, "邮件正文不写进日志");
  const snapshot = JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8"));
  assert.deepEqual(
    snapshot.messages.map((m: { message_id: string }) => m.message_id),
    ["m-budget", "m-long"],
  );
  assert.equal(snapshot.messages[0].body, "机密正文：预算四十二万");
  assert.equal([...snapshot.messages[1].body].length, 1200);
  assert.equal(snapshot.messages[1].truncated, true);
  assert.equal(snapshot.messages[0].truncated, false);
  assert.equal(snapshot.id, parsed.result.events![0].id);
  const calls: string[][] = readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.every((args) => args[args.indexOf("--as") + 1] === "user"));
  const read = calls.find((args) => args.includes("--message-ids"))!;
  assert.deepEqual(read[read.indexOf("--message-ids") + 1].split(","), ["m-budget", "m-long"]);
  assert.ok(read.includes("--html=false"), "只取纯文本正文，不拉 HTML");
  const filter = calls.find((args) => args.includes("--filter"))!;
  assert.equal(JSON.parse(filter[filter.indexOf("--filter") + 1]).folder_id, "INBOX");
});

test("an empty inbox says so, keeps the old snapshot, and asks the mailbox for no bodies", () => {
  const { dir, run, parsed } = triage("empty");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "nothing");
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(readFileSync(join(dir, "calls.jsonl"), "utf8"), /--message-ids/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});

test("a mailbox that returned only some bodies is not saved as a complete snapshot", () => {
  const { dir, run } = triage("partial");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /没有返回部分邮件的正文/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});

test("mail authorization failure asks once and keeps the previous snapshot", () => {
  const { dir, run, parsed } = triage("auth");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(parsed.result.outcome, "done");
  assert.equal(parsed.result.ask?.length, 1);
  assert.equal(parsed.result.events, undefined);
  assert.doesNotMatch(run.stdout + run.stderr, /secret must not|old data/);
  assert.equal(JSON.parse(readFileSync(join(dir, "inbox-input.json"), "utf8")).id, "old");
});
