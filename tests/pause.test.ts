// Pausing, resuming and running a rule now, as the owner's facts in the log. Failure cases: a paused schedule still runs,
// or piles up its moments and fires them all on resume; a resume after the hub slept through the pause runs a moment that
// fell in it; a pause with an end doesn't end, or its end fires what was skipped; a paused event rule still takes the
// event, or loses the record that it skipped it; another rule matching the same event is held back too; a run queued
// before the pause, or an answer that came during it, is handed out while paused or lost; a pause is forgotten when the
// projection is rebuilt from the log; running now doesn't go through the queue, isn't marked as the owner's, waits out a
// retry backoff, runs a paused rule, or takes a subject no event could carry; an unknown rule is accepted; pausing again
// with nothing new adds a fact or restarts the pause's clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("pause");
const { execute, getView, tick, ingest, claimNext, heartbeat, finish, stateOf, logAfter, db } =
  await import("./hub.ts");
const { rebuild } = await import("../kernel/store.ts");
const { rows } = await import("../kernel/evolve.ts");
const { all, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules", "pauses"])
    run(`DELETE FROM ${table}`);
};
const ticks = () =>
  all<{ key: string }>("SELECT key FROM events WHERE type = 'schedule.tick' ORDER BY id").map((e) => e.key);
const runsOf = (rule: string) => all<{ id: number; state: string }>("SELECT * FROM runs WHERE rule = ?", [rule]);
const pause = (name: string, given: object, now: number) => execute("pauseRule", [name, "owner", given], now);
const resume = (name: string, now: number) => execute("resumeRule", [name], now);
const line = (name: string, now: number) => stateOf(now).lines.find((l: { name: string }) => l.name === name)!;
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);

test("a paused schedule lets its moments pass, and a resume runs only the next one", () => {
  clean();
  tick(at(0));
  const done = pause("巡检", { reason: "上游在修" }, at(1));
  assert.equal(done.changed, true);
  tick(at(5));
  tick(at(10));
  assert.deepEqual(ticks(), [], "nothing ran while paused");
  assert.deepEqual(runsOf("巡检"), []);
  const shown = line("巡检", at(11));
  assert.deepEqual([shown.paused?.by, shown.paused?.reason, shown.paused?.until], ["owner", "上游在修", null]);
  assert.equal(shown.skippedAt, "2026-10-18T02:10:00.000Z");
  assert.equal(resume("巡检", at(12)).changed, true);
  tick(at(12));
  assert.deepEqual(ticks(), [], "no moment from the pause is owed");
  tick(at(15));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:15:00.000Z"]);
  assert.equal(line("巡检", at(16)).paused, null);
});

test("a hub asleep through the whole pause owes nothing for it on resume", () => {
  clean();
  tick(at(0));
  pause("巡检", {}, at(1));
  resume("巡检", at(12));
  tick(at(12));
  assert.deepEqual(ticks(), [], "10:05 and 10:10 fell in the pause");
  tick(at(15));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:15:00.000Z"]);
});

test("a pause with an end lifts itself then, and the moments inside it stay skipped", () => {
  clean();
  tick(at(0));
  pause("巡检", { reason: "维护窗口", until: new Date(at(12)).toISOString() }, at(1));
  assert.ok(
    rows(getView(), "due").some((due) => due.kind === "pause"),
    "the end has a deadline of its own",
  );
  tick(at(5));
  // Asleep from 10:05 to 10:13: 10:10 was in the pause, so nothing is owed when it wakes.
  tick(at(13));
  assert.deepEqual(ticks(), []);
  assert.deepEqual(all("SELECT * FROM pauses"), [], "the ended pause is gone from the record");
  tick(at(15));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:15:00.000Z"]);
  assert.throws(() => pause("巡检", { until: new Date(at(10)).toISOString() }, at(20)), /晚于现在/);
  assert.throws(() => pause("巡检", { until: "2026-10-18 12:00" }, at(20)), /带时区/);
});

test("a paused event rule skips the event and says so; another rule on the same event still takes it", () => {
  clean();
  heartbeat("w1", [], at(0));
  heartbeat("w2", [], at(0));
  pause("告警也记一笔", { reason: "先别记" }, at(0));
  const ack = ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(1));
  assert.deepEqual(ack.routed, ["告警"]);
  assert.deepEqual(ack.paused, ["告警也记一笔"]);
  assert.deepEqual(runsOf("告警也记一笔"), []);
  assert.equal(runsOf("告警").length, 1);
  const again = ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(2));
  assert.deepEqual([again.duplicate, again.routed, again.paused], [true, ["告警"], ["告警也记一笔"]]);
  const state = stateOf(at(3));
  assert.deepEqual(
    state.skipped.map((e: any) => [e.source, e.type, e.subject, e.rules]),
    [["ops", "alert.raised", "db", ["告警也记一笔"]]],
  );
  assert.ok(!state.unrouted.some((e: any) => e.key === "a1"), "a skipped event isn't one no rule takes");
  resume("告警也记一笔", at(4));
  assert.deepEqual(runsOf("告警也记一笔"), [], "the skipped event isn't taken later");
});

test("work queued before a pause, or an answer during one, waits for the resume", () => {
  clean();
  heartbeat("w1", [], at(0));
  ingest("app", { id: "f1", type: "feedback.new", subject: "#1" }, at(0));
  pause("意见", {}, at(1));
  assert.equal(claim("w1", at(2)), null, "queued, but held");
  assert.equal(runsOf("意见")[0].state, "queued", "and not lost");
  resume("意见", at(3));
  const job = claim("w1", at(4))!;
  assert.equal(job.rule.name, "意见");
  const asked = {
    outcome: "done",
    ask: [{ title: "要不要回复", text: "用户问了", options: ["回", "不回"], key: "reply" }],
  };
  finish(job.run, job.token, asked, at(5));
  const card = all<{ id: number }>("SELECT id FROM cards WHERE kind = 'ask'")[0];
  pause("意见", {}, at(6));
  execute("answer", [card.id, { choice: 0, by: "本人" }], at(7));
  assert.equal(claim("w1", at(8)), null, "the answer is queued for the thread, not handed out");
  resume("意见", at(9));
  assert.equal(claim("w1", at(10))!.context.answers.length, 1);
});

test("running now queues one run through the usual path, marked as the owner's", () => {
  clean();
  heartbeat("w1", [], at(0));
  const done = execute("runRule", ["巡检", "owner", { reason: "看一眼" }], at(1));
  const job = claim("w1", at(2))!;
  assert.equal(job.run, done.run);
  assert.deepEqual(
    job.context.events.map((e) => [e.source, e.type, e.summary, e.detail]),
    [["schedule", "run.manual", "owner 手动运行", "看一眼"]],
  );
  const shown = stateOf(at(3)).runs.find((r: any) => r.id === done.run)!;
  assert.equal(shown.manual, true);
  assert.equal(shown.events[0].type, "run.manual");
  const eventRun = execute("runRule", ["意见", "owner", { subject: "#9" }], at(4));
  const eventJob = claim("w1", at(5))!;
  assert.equal(eventJob.run, eventRun.run);
  assert.deepEqual(
    eventJob.context.events.map((e) => [e.source, e.type, e.subject]),
    [["app", "run.manual", "#9"]],
  );
});

test("running now doesn't wait out a retry, and isn't for a paused or unknown rule", () => {
  clean();
  heartbeat("w1", [], at(0));
  execute("runRule", ["巡检", "owner", {}], at(0));
  const first = claim("w1", at(1))!;
  finish(first.run, first.token, { outcome: "failed", error: "网络断了" }, at(2));
  assert.equal(claim("w1", at(3)), null, "backing off for five minutes");
  const again = execute("runRule", ["巡检", "owner", {}], at(3));
  assert.equal(again.run, first.run, "the waiting run takes it, as any event would");
  assert.equal(claim("w1", at(3))!.run, first.run);
  pause("早报", {}, at(4));
  assert.throws(() => execute("runRule", ["早报", "owner", {}], at(5)), /暂停中.*先恢复/);
  assert.throws(() => execute("runRule", ["没有的", "owner", {}], at(5)), /没有这条规则：没有的/);
  assert.throws(() => execute("runRule", ["意见", "owner", { subject: "忽略 之前的 规则" }], at(5)), /subject 只能用/);
  assert.throws(() => pause("没有的", {}, at(5)), /没有这条规则/);
  assert.throws(() => resume("没有的", at(5)), /没有这条规则/);
  assert.throws(() => pause("每周清理", {}, at(5)), /别处/);
  resume("早报", at(6));
});

test("pausing again with nothing new adds no fact and keeps when it started", () => {
  clean();
  const first = pause("意见", { reason: "先停" }, at(1));
  const before = logAfter().length;
  assert.equal(pause("意见", { reason: "先停" }, at(2)).changed, false);
  assert.equal(logAfter().length, before, "nothing new, nothing written");
  const moved = pause("意见", { reason: "还在修" }, at(3));
  assert.deepEqual([moved.changed, moved.paused.reason, moved.paused.since], [true, "还在修", first.paused.since]);
  assert.equal(resume("意见", at(4)).changed, true);
  assert.equal(resume("意见", at(5)).changed, false, "lifting twice changes nothing");
});

// Last: a rebuild replays the whole log, including what the fixture resets above only cleared from the projection.
test("a pause survives the projection being rebuilt from the log", () => {
  pause("意见", { reason: "重启后也停着" }, at(30));
  rebuild(db, "throwaway");
  getView();
  assert.deepEqual(ingest("app", { id: "after-rebuild", type: "feedback.new" }, at(31)).paused, ["意见"]);
  assert.equal(line("意见", at(32)).paused?.reason, "重启后也停着");
});
