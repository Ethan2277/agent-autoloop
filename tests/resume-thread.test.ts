// A rule with resume takes a thread's next event on in the session its last round ended in. Failure cases: the next round
// starts a new session anyway, or starts one again when its first answer got lost; a round queued while another runs misses
// the session that round ended in; a round goes on in another subject's session; a rule without the option changes behaviour;
// a session goes over to the agent the rule was moved to; an answer or a retry loses the session it carries to a newer one;
// a round that is or may still be running has its session opened by a second process, by a new event, an answer or a due
// check; one such round stops its thread resuming for ever; a session that keeps failing is gone back into by each new event,
// ten tries each, though the card said it would start over; a due check hands the previous agent's session to a new agent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { invariants } from "../sim/invariants.ts";

const env = { secret: "resume", publicUrl: "https://hub.test" };
const given = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const rules = parseRules(
  JSON.stringify({
    ...given,
    rules: given.rules
      .filter((rule: { when: { source?: string } }) => rule.when.source)
      .map((rule: { name: string }) => (rule.name === "意见" ? { ...rule, resume: true } : rule)),
  }),
  0,
  "UTC",
);
const MINUTE = 60_000;

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  let events = 0;
  const message = (subject = "#1") => act("ingest", "app", { id: `e${++events}`, type: "feedback.new", subject });
  let claims = 0;
  const claim = () => act("claimNext", "w1", `c${++claims}`);
  /** A round from its event to its end, as far as what the next round sees. */
  const round = (session: string | null, subject = "#1", outcome = "done") => {
    message(subject);
    const job = claim();
    act("finish", job.run, job.token, { outcome, ...(session && { session }) });
    return job;
  };
  /** The worker keeps coming but stops mentioning what it has, until the hub can't say whether that's still running. */
  const loseTrack = () => {
    for (let minute = 0; minute < 7; minute++) {
      now += MINUTE;
      act("heartbeat", "w1", []);
      act("tick");
    }
  };
  return {
    act,
    message,
    claim,
    round,
    loseTrack,
    pass: (minutes: number) => void (now += minutes * MINUTE),
    run: (id: number) => view.get("runs", id)!,
    cards: () => rows(view, "cards"),
    check: () => invariants(view, log),
  };
}

test("a thread's next event goes on in the session its last round ended in, even if the claim's answer got lost", () => {
  const it = hub();
  assert.equal(it.round("S").session, null);
  it.message();
  const claim = "lost";
  assert.equal(it.act("claimNext", "w1", claim).session, "S");
  assert.equal(it.act("claimNext", "w1", claim).session, "S");
  it.check();
});

test("a round that found nothing to do has a session to go on in too", () => {
  const it = hub();
  it.round("S", "#1", "nothing");
  assert.equal(it.round("T").session, "S");
  assert.equal(it.round(null).session, "T");
});

test("what comes in while a round runs waits, and goes on in the session that round ends in", () => {
  const it = hub();
  it.message();
  const first = it.claim();
  it.message();
  it.message();
  assert.equal(it.claim(), null);
  it.act("finish", first.run, first.token, { outcome: "done", session: "S" });
  const next = it.claim();
  assert.equal(next.session, "S");
  assert.equal(next.context.events.length, 2);
  it.check();
});

test("another subject on the same rule has a session of its own", () => {
  const it = hub();
  it.round("S", "#1");
  it.round("T", "#2");
  assert.equal(it.round("U", "#3").session, null);
  assert.equal(it.round("T2", "#2").session, "T");
  assert.equal(it.round("S2", "#1").session, "S");
});

test("a rule without the option starts a new session each time", () => {
  const it = hub();
  const alert = (id: string) => it.act("ingest", "ops", { id, type: "alert.raised", subject: "x" });
  for (const id of ["1", "2"]) {
    alert(id);
    for (const worker of ["w2", "w1"]) {
      const job = it.act("claimNext", worker, `${worker}-${id}`);
      assert.equal(job.session, null);
      it.act("finish", job.run, job.token, { outcome: "done", session: `S-${worker}` });
    }
  }
});

test("a session doesn't go over to the agent the rule was moved to, nor back to the first one after that", () => {
  const it = hub();
  it.round("S");
  const moved = structuredClone(rules);
  moved.rules.find((rule) => rule.name === "意见")!.to = "a3";
  it.act("rules", moved);
  assert.equal(it.round(null).session, null);
  it.act("rules", rules);
  assert.equal(it.round("T").session, null);
});

test("a due check retains its context but not another agent's session after reassignment", () => {
  const it = hub();
  it.message();
  const first = it.claim();
  it.act("finish", first.run, first.token, {
    outcome: "done",
    session: "claude-session",
    later: [{ key: "复查", at: "2026-11-05T01:00:00Z", about: "核实上线" }],
  });
  const moved = structuredClone(rules);
  moved.rules.find((rule) => rule.name === "意见")!.to = "a2";
  it.act("rules", moved);
  it.pass(61);
  it.act("tick");
  const next = it.act("claimNext", "w2", "new-agent");
  assert.equal(next.agent.id, "a2");
  assert.equal(next.session, null);
  assert.equal(next.context.timers[0].about, "核实上线");
  it.check();
});

test("an answer goes back to the session it was asked in, not a newer one on the thread", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const ask = [{ title: "选哪个", text: "x", options: ["甲", "乙"] }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  it.round("T");
  it.act("answer", it.cards().find((card) => card.kind === "ask")!.id, { choice: 0 });
  const answered = it.claim();
  assert.equal(answered.session, "S");
  assert.equal(answered.context.answers.length, 1);
  it.check();
});

test("a round that goes wrong tries again in the session it went on in, whether or not it reported one", () => {
  const it = hub();
  it.round("S");
  it.message();
  const first = it.claim();
  assert.equal(first.session, "S");
  it.act("finish", first.run, first.token, { outcome: "failed", error: "没跑完" });
  it.pass(6);
  const second = it.claim();
  assert.equal(second.run, first.run);
  assert.equal(second.session, "S");
});

test("a session a round may still be running in isn't opened again; the thread goes on from the next round that ends", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  assert.equal(it.run(lost.run).state, "unknown");
  it.message();
  const next = it.claim();
  assert.equal(next.session, null);
  it.act("finish", next.run, next.token, { outcome: "done", session: "T" });
  assert.equal(it.round("T2").session, "T");
  it.check();
});

test("a round it lost track of that moved to a session of its own leaves the old one free", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "T" });
  it.loseTrack();
  assert.equal(it.round("U").session, "S");
});

test("a late result from a round it lost track of counts as how it ended", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.loseTrack();
  it.act("finish", lost.run, lost.token, { outcome: "done", session: "S2" });
  assert.equal(it.round("T").session, "S2");
});

test("a newer round ending in the session doesn't hide one that may still be running in it", () => {
  const it = hub();
  it.round("S");
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  const reportsTheSame = it.round("S");
  assert.equal(reportsTheSame.session, null);
  assert.equal(it.round("T").session, null);
});

test("an answer doesn't open a session a round may still be running in, and still gets where it's going", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const ask = [{ title: "选哪个", text: "x", options: ["甲", "乙"] }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.act("answer", it.cards().find((card) => card.kind === "ask")!.id, { choice: 0 });
  const answered = it.claim();
  assert.equal(answered.session, null);
  assert.equal(answered.context.answers.length, 1);
  it.check();
});

test("a due check doesn't open a session a round may still be running in, and still comes due", () => {
  const it = hub();
  it.message();
  const asking = it.claim();
  const later = [{ key: "复查", at: "2026-11-05T03:00:00.000Z", about: "看看好了没" }];
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", later });
  it.message();
  const lost = it.claim();
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.pass(180);
  it.act("tick");
  const due = it.claim();
  assert.equal(due.session, null);
  assert.equal(due.context.events[0].type, "timer.due");
  it.check();
});

test("without the option, an answer doesn't open a session a round may still be running in either", () => {
  const it = hub();
  const without = structuredClone(rules);
  delete without.rules.find((rule) => rule.name === "意见")!.resume;
  it.act("rules", without);
  it.message();
  const asking = it.claim();
  const ask = ["一", "二"].map((title) => ({ title, text: "x", options: ["甲", "乙"] }));
  it.act("finish", asking.run, asking.token, { outcome: "done", session: "S", ask });
  const [first, second] = it.cards().filter((card) => card.kind === "ask");
  it.act("answer", first.id, { choice: 0 });
  const lost = it.claim();
  assert.equal(lost.session, "S");
  it.act("started", lost.run, lost.token, { session: "S" });
  it.loseTrack();
  it.act("answer", second.id, { choice: 0 });
  assert.equal(it.claim().session, null);
});

test("a round still going keeps its session to itself when its rule's group changes under it", () => {
  const it = hub();
  it.round("S");
  it.message();
  const going = it.claim();
  assert.equal(going.session, "S");
  const regrouped = structuredClone(rules);
  regrouped.rules.find((rule) => rule.name === "意见")!.group = "新组";
  it.act("rules", regrouped);
  it.message();
  assert.equal(it.claim().session, null);
});

test("a round stopped for failing too often starts its thread over, as the card says", () => {
  const it = hub();
  it.round("S");
  it.message();
  for (let attempt = 0; attempt < 10; attempt++) {
    it.pass(61);
    const job = it.claim();
    assert.equal(job.session, "S");
    it.act("finish", job.run, job.token, { outcome: "failed", error: "太长了", session: "S" });
  }
  assert.ok(it.cards().some((card) => card.text.includes("从头开始")));
  assert.equal(it.round("T").session, null);
  assert.equal(it.round("U").session, "T");
  it.check();
});

test("a round the owner stopped starts its thread over too", () => {
  const it = hub();
  it.round("S");
  it.message();
  const stopped = it.claim();
  it.act("cancel", stopped.run);
  it.act("finish", stopped.run, stopped.token, { outcome: "cancelled" });
  assert.equal(it.run(stopped.run).state, "cancelled");
  assert.equal(it.round("T").session, null);
  assert.equal(it.round("U").session, "T");
  it.check();
});
