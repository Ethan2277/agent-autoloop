// How `agent-autoloop status` lays out the state for a person. Failure modes: colour codes reach a pipe, a file or an
// Agent reading the output, or show up despite NO_COLOR; a Chinese, Japanese or Korean character is counted as one column,
// so columns after it drift and lines wrap past the edge; what waits for the owner sinks below what only reports; a
// notice dealt with spreads its whole text over the list, or loses it, though that's the only place what `tell` said is read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { colorFor, render, width } from "../cli/status.ts";

const now = "2026-11-07T02:00:00.000Z"; // 10:00 in Asia/Shanghai
const run = (id: number, state: string, rule: string, more: object = {}) => ({
  id,
  rule,
  state,
  attempts: 0,
  claimedAt: now,
  finishedAt: state === "claimed" || state === "queued" ? null : now,
  notBefore: null,
  summary: "",
  error: "",
  stopping: false,
  events: [{ source: "schedule", type: "schedule.tick", subject: "", summary: "" }],
  ...more,
});
const state = {
  now,
  timezone: "Asia/Shanghai",
  spending: {
    today: { rounds: 0, tokens: 0, cost: 0, missingTokens: 0, missingCost: 0 },
    week: { rounds: 0, tokens: 0, cost: 0, missingTokens: 0, missingCost: 0 },
  },
  totals: { running: 1, queued: 0, retrying: 0, unknown: 0, doneToday: 1 },
  agents: [{ name: "Claude", worker: "m4", online: false, seenAt: "2026-11-06T13:00:00.000Z" }],
  channels: [{ name: "飞书", online: true, seenAt: now }],
  sources: [{ id: "app", name: "应用" }],
  lines: [
    { name: "早报", every: "每天 9:00", next: "2026-11-08T01:00:00.000Z", paused: null },
    { name: "a", every: "每小时", next: "2026-11-07T03:00:00.000Z", paused: null },
  ],
  elsewhere: [],
  cards: [
    {
      id: 7,
      kind: "ask",
      title: "选一个",
      text: "看[说明](https://example.com/x)",
      options: ["红", "绿"],
      recommend: 1,
    },
  ],
  recentCards: [
    {
      id: 6,
      kind: "notice",
      state: "closed",
      title: "告诉你",
      text: `第一段${"很长".repeat(80)}\n\n第二段看[链接](https://example.com/notice)`,
      options: [],
      choice: null,
      answer: null,
    },
  ],
  runs: [run(3, "claimed", "早报"), run(2, "done", "早报", { summary: "好了" })],
  unrouted: [{ source: "app", type: "x.new", subject: "#1", summary: "" }],
};

test("colour only on a terminal without NO_COLOR, and none at all when it's off", () => {
  assert.equal(colorFor({ isTTY: true }, {}), true);
  assert.equal(colorFor({ isTTY: false }, {}), false);
  assert.equal(colorFor({}, {}), false);
  assert.equal(colorFor({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.doesNotMatch(render(state, { color: false, columns: 100 }), /\x1b/);
  assert.match(render(state, { color: true, columns: 100 }), /\x1b\[/);
});

test("Chinese, Japanese and Korean characters take two columns, and columns line up after them", () => {
  assert.equal(width("中a"), 3);
  assert.equal(width("日本語"), 6);
  assert.equal(width("한"), 2);
  assert.equal(width("\x1b[1m中\x1b[0m"), 2);
  const lines = render(state, { color: false, columns: 100 }).split("\n");
  const timed = lines.slice(lines.indexOf("定时") + 1, lines.indexOf("定时") + 3);
  const nextAt = timed.map((line) => width(line.slice(0, line.indexOf("下次"))));
  assert.equal(nextAt[0], nextAt[1], timed.join("\n"));
  const text = render(
    { ...state, cards: [{ ...state.cards[0], text: "长".repeat(200) }] },
    { color: false, columns: 60 },
  );
  for (const line of text.split("\n")) assert.ok(width(line) <= 60, line);
});

test("what waits for the owner comes first, then what's going on, then what only reports", () => {
  const text = render(state, { color: false, columns: 100 });
  const order = ["在线", "等你 1", "正在做", "最近几轮", "最近的卡片", "定时", "没有规则接的事件"];
  const at = order.map((heading) => text.split("\n").indexOf(heading));
  assert.ok(
    at.every((index) => index > 0),
    at.join(","),
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
  );
  assert.match(text.split("\n")[0], /^等你 1 · 在跑 1/);
  const notice = text.split("\n").filter((line) => line.includes("第一段"));
  assert.equal(notice.length, 1, "a notice dealt with takes one line, not its whole text");
  assert.match(notice[0], /…$/);
  assert.doesNotMatch(text, /第二段/);
  assert.match(text, /https:\/\/example\.com\/x/);
  assert.doesNotMatch(text, /\]\(/, "a link shows as its words and its address, not markdown");
});
