// A source asks, with its own key, what became of an event it sent. Failure cases: another source's key, or the owner's,
// a worker's, a channel's, none, reads it; another source's event answers differently from one that doesn't exist, so a
// source can tell which numbers are taken; a run waiting to try again reads as finished, or one that won't be tried again,
// was stopped by the owner, or lost its rule has no end to read; a run that also took another source's event hands over
// its summary or the events its receipt sent; another run's events show up as this one's; the number a resend got back
// as a duplicate finds nothing; an event the hub recorded under a source without that source sending it (what a receipt
// sent on its behalf, the owner's manual run) is read with that source's key.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("event-outcome");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
const notes = fixture.rules.find((rule: { name: string }) => rule.name === "意见");
notes.emits = { source: "ops", types: ["note.*"] };
const rulesFile = join(home, "rules.json");
const writeRules = (rules: unknown) => writeFileSync(rulesFile, JSON.stringify(rules));
writeRules(fixture);
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { checkSchema } = await import("../protocol/schema.ts");

const keys = {
  app: hub.addKey("source", "app"),
  ops: hub.addKey("source", "ops"),
  owner: hub.addKey("owner", "owner"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["events", "runs", "run_events", "cards", "timers", "pauses"] as const) hub.fixtureClear(table);
});

async function outcome(event: number | string, key = keys.app) {
  const response = await fetch(`${base}/v1/events/${event}`, { headers: { authorization: `Bearer ${key}` } });
  const json = await response.json();
  if (response.status === 200) assert.deepEqual(checkSchema("eventOutcome", json), []);
  return { status: response.status, json };
}
const send = (source: string, id: string, subject = "#1", type = "feedback.new") =>
  hub.ingest(source, { id, type, subject });
const take = (now = Date.now()) => hub.claimNext("w1", `claim-${now}-${Math.random()}`, now)!;

test("only the source that sent it reads it, and anyone else finds nothing there", async () => {
  const { event } = send("app", "f:1");
  for (const key of [keys.owner, keys.worker, keys.channel, "", "made-up"]) {
    assert.equal((await outcome(event, key)).status, 401);
  }
  const elsewhere = await outcome(event, keys.ops);
  const missing = await outcome(event + 1000, keys.ops);
  assert.equal(elsewhere.status, 404);
  assert.deepEqual(elsewhere, missing);
  for (const bad of ["0", "-1", "f:1", "1.5"]) assert.equal((await outcome(bad)).status, 404, bad);
});

test("from waiting, through a try that didn't get through, to done with the receipt's events", async () => {
  const sent = send("app", "f:2");
  const again = send("app", "f:2");
  assert.equal(again.event, sent.event);
  const queued = await outcome(again.event);
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.json.routed, ["意见"]);
  const [run] = queued.json.runs;
  assert.deepEqual([run.rule, run.state, run.attempts, run.error, run.finishedAt], ["意见", "queued", 0, null, null]);

  const first = take();
  assert.equal((await outcome(sent.event)).json.runs[0].state, "claimed");
  hub.finish(first.run, first.token, { outcome: "failed", error: "网络断了" });
  const retrying = (await outcome(sent.event)).json.runs[0];
  assert.deepEqual(
    [retrying.run, retrying.state, retrying.attempts, retrying.error],
    [first.run, "queued", 1, "网络断了"],
  );

  const second = take(Date.now() + 3600_000);
  const note = { id: "n:1", type: "note.made", subject: "#1", summary: "写好了", detail: "报告", link: "" };
  hub.finish(second.run, second.token, { outcome: "done", summary: "整理完了", events: [note] });
  const done = (await outcome(sent.event)).json.runs[0];
  assert.deepEqual([done.state, done.attempts, done.error, done.summary], ["done", 1, null, "整理完了"]);
  assert.ok(done.finishedAt);
  assert.deepEqual(done.events, [
    { id: "n:1", type: "note.made", subject: "#1", summary: "写好了", detail: "报告", link: "" },
  ]);
});

test("what the hub recorded under a source, without that source sending it, isn't the source's to read", async () => {
  const { event } = send("app", "f:sent");
  const job = take();
  hub.finish(job.run, job.token, { outcome: "done", summary: "写好了", events: [{ id: "n:made", type: "note.made" }] });
  const [made] = (await outcome(event)).json.runs[0].events;
  // Sending the same number again gets back the one the receipt made.
  const madeEvent = hub.ingest("ops", { id: made.id, type: "note.made" }).event;
  assert.equal((await outcome(madeEvent, keys.ops)).status, 404, "a receipt's event reads as the source's own");
  const manual = hub.execute("runRule", ["意见", "owner", { subject: "#9", reason: "看看" }]) as { event: number };
  assert.equal((await outcome(manual.event)).status, 404, "the owner's manual run reads as the source's own");
});

test("each run shows only what its own receipt sent", async () => {
  const one = send("app", "f:3", "#3");
  const two = send("app", "f:4", "#4");
  const [a, b] = [take(), take()];
  hub.finish(a.run, a.token, { outcome: "done", summary: "甲", events: [{ id: "n:a", type: "note.a" }] });
  hub.finish(b.run, b.token, { outcome: "nothing", summary: "乙" });
  const [first, second] = [(await outcome(one.event)).json, (await outcome(two.event)).json];
  assert.deepEqual(
    first.runs.map((run: any) => [run.summary, run.events.map((event: any) => event.id)]),
    [["甲", ["n:a"]]],
  );
  assert.deepEqual(
    second.runs.map((run: any) => [run.state, run.summary, run.events]),
    [["nothing", "乙", []]],
  );
});

test("an event the receipt sends again under a number already taken isn't shown as what it sent", async () => {
  hub.ingest("ops", { id: "n:taken", type: "note.ops", detail: "运维自己的" });
  const mine = send("app", "f:9", "#9");
  const job = take();
  hub.finish(job.run, job.token, {
    outcome: "done",
    summary: "好了",
    events: [{ id: "n:taken", type: "note.a", detail: "我的" }],
  });
  assert.deepEqual((await outcome(mine.event)).json.runs[0].events, []);
});

test("a run that ends without being done still reads as ended", async () => {
  const stopped = send("app", "f:5", "#5");
  const job = take();
  hub.cancel(job.run);
  hub.finish(job.run, job.token, { outcome: "cancelled" });
  const byOwner = (await outcome(stopped.event)).json.runs[0];
  assert.equal(byOwner.state, "cancelled");
  assert.ok(byOwner.finishedAt);

  const failing = send("app", "f:6", "#6");
  let now = Date.now();
  for (let tries = 0; tries < 10; tries++) {
    const next = take(now);
    hub.finish(next.run, next.token, { outcome: "failed", error: "登录过期" }, now);
    now += 2 * 3600_000;
  }
  const givenUp = (await outcome(failing.event)).json.runs[0];
  assert.deepEqual([givenUp.state, givenUp.attempts, givenUp.error], ["cancelled", 10, "登录过期"]);
  assert.match(givenUp.summary, /不再自动重试/);
  assert.ok(givenUp.finishedAt);

  const paused = await fetch(`${base}/v1/rules/${encodeURIComponent("意见")}/pause`, {
    method: "POST",
    headers: { authorization: `Bearer ${keys.owner}` },
    body: "{}",
  });
  assert.equal(paused.status, 200);
  const skipped = (await outcome(send("app", "f:7", "#7").event)).json;
  assert.deepEqual([skipped.routed, skipped.paused, skipped.runs], [[], ["意见"], []]);
});

test("a run that also took another source's event keeps its summary and events to itself", async () => {
  const mine = send("app", "f:8", "#8");
  // The rule now takes another source's events, so the next one for the same subject joins the queued run.
  writeRules({
    ...fixture,
    rules: fixture.rules.map((rule: any) =>
      rule === notes ? { ...rule, when: { source: "ops", types: ["fix.*"] } } : rule,
    ),
  });
  hub.reloadRules(rulesFile);
  const theirs = send("ops", "a:8", "#8", "fix.made");
  writeRules(fixture);
  hub.reloadRules(rulesFile);
  const job = take();
  assert.equal(job.context.events.length, 2);
  hub.finish(job.run, job.token, { outcome: "done", summary: "两件一起做了", events: [{ id: "n:8", type: "note.a" }] });
  for (const [event, key] of [
    [mine.event, keys.app],
    [theirs.event, keys.ops],
  ] as const) {
    const [run] = (await outcome(event, key)).json.runs;
    assert.deepEqual([run.run, run.state, run.summary, run.events], [job.run, "done", null, null]);
  }
});
