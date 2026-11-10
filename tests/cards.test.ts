// What reaches the owner. A card's words never change; only its state does. Failure cases: asking the same thing while it
// is open makes a second card, or closed it blocks asking again; an answer takes a choice that doesn't exist, carries
// more words or a longer reference than the protocol allows, counts twice,
// or beats a resolve that came first (only one may change an open card); an answer from someone not on the channel's list,
// or on a message that isn't the one sent, counts; an answer through a channel gives back a card other than the one that
// channel is sent next, so what it draws at once differs from what the hub has; an answer doesn't wake the thread that
// asked, wakes another thread, is lost because its run was merged, or doesn't carry the session and what the asker left for itself; the card doesn't show
// what was done once its run finishes; a run resolves a card outside what it was given to check, or a bad id spoils its own
// result; resolving wakes nobody. Delivery: a channel gets a card it has, gets none it should, loses a report and sends a second
// message (the ref sticks, and a stale report doesn't undo a newer one); a stale failure delays a newer version; a failed
// send retries at once, or for ever; a channel that never came counts as having failed; a card solved before it was sent
// bothers the owner; two channels don't each get their own copy; an answer in one channel doesn't update the other.
// Words on an answer or a notice that aren't text crash instead of being refused; an answer to a card whose rule has gone
// crashes or starts something; closing or reporting a failure on a card that isn't there, or wasn't handed over, crashes.
// A stopped run's receipt takes effect, or the answer it carried shows as carried out. A failed run merged with what came
// in meanwhile loses the session of the answer in it, or has it wiped by what had none. A run with events from two
// sources is given, or closes, cards that have no source. A channel that takes a card and never reports gets it for ever.
// A card closed while its first message is on the way never gets that message updated.
// A rule that lists its channels has its cards, and the notices of its runs, sent to others as well; one that lists none
// stops reaching every channel; a notice of nobody's rule reaches only some. With defaultChannels, a card that names no
// channels of its own (a tell, the hub's own alert, a task elsewhere asking, a rule without a list) still reaches every
// channel, so several channels each repeat it (issue #221); and a rule that lists its own is held to the default.
// Receipt FYIs must arrive closed without buttons, stay out of later open lists, and never wake work when clicked;
// ordinary notices, questions, quiet rules, and the one-day FYI delivery window must keep their existing behavior.
// The why timeline must show receipt FYIs without adding empty closures or repeating hub-generated end notices.
// The answers material carries the chosen text, or a 0-based choice gets read as the first option (issue #197: an Agent
// reported 绿色 as 蓝色).
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
import { render } from "../plugins/feishu/channel.ts";
import { formatWhy } from "../cli/why.ts";

setup("cards");
const { ingest } = await import("./hub.ts");
const { cancel, claimNext, execute, finish, heartbeat, started, sweep, why } = await import("./hub.ts");
const { answer, resolve, nextCard, delivered, failed, tell, cardByToken, getView } = await import("./hub.ts");
const { AuthError, InputError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (n: number, step = "new") => ({ id: `feedback:${n}:${step}`, type: `feedback.${step}`, subject: `#${n}` });
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const question = {
  title: "要不要删旧表",
  text: "占了 10 GB。",
  options: ["删", "留着"],
  recommend: 1,
  about: "表名 old_x，删之前先备份",
  key: "drop-old-x",
};
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** A run on subject #n that ends by asking. */
function asked(n: number, now = at(0)) {
  ingest("app", note(n), now);
  const job = claim("w1", now)!;
  started(job.run, job.token, { session: `s-${n}`, link: `app://s-${n}` }, now);
  finish(job.run, job.token, { outcome: "done", summary: "等你决定", session: `s-${n}`, ask: [question] }, now);
  return { job, id: one<{ id: number }>("SELECT id FROM cards WHERE run_id = ?", [job.run])!.id };
}

/** Does `then` with the rules changed by `change`, and puts them back. */
function underRules(change: (rules: any) => void, then: () => void) {
  const before = getView().get("config", "rules")!.value;
  const changed = structuredClone(before);
  change(changed);
  execute("rules", [changed], at(0));
  try {
    then();
  } finally {
    execute("rules", [before], at(0));
  }
}

test("the same question isn't asked twice while it's open, and can be asked again once it's closed", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(2));
  assert.equal(all("SELECT id FROM cards").length, 1);
  resolve(id, "不用了", "owner", at(3));
  ingest("app", note(1, "decided"), at(4));
  job = claim("w1", at(4))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(5));
  assert.equal(all("SELECT id FROM cards").length, 2);
  // The key's scope is the thread: another subject asks on its own.
  asked(2, at(6));
  assert.equal(all("SELECT id FROM cards").length, 3);
});

test("an answer wakes the thread that asked, in its session, with what it left for itself; the card then shows what was done", () => {
  clean();
  const { id } = asked(1);
  assert.equal(claim("w1", at(1)), null, "asking ended the run; nothing runs while it waits");
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, true);
  assert.equal(card(id).state, "decided");
  const job = claim("w1", at(2))!;
  assert.equal(job.rule.name, "意见");
  assert.equal(job.session, "s-1");
  assert.deepEqual(
    job.context.events.map((e) => [e.type, e.subject]),
    [["card.answered", "#1"]],
  );
  assert.deepEqual(
    job.context.answers.map((a) => [a.card, a.title, a.options[a.choice!], a.about, a.by]),
    [[id, "要不要删旧表", "留着", "表名 old_x，删之前先备份", "me"]],
  );
  const before = card(id).version;
  finish(job.run, job.token, { outcome: "done", summary: "留着，已记下" }, at(3));
  assert.deepEqual([card(id).state, card(id).result], ["done", "留着，已记下"]);
  assert.equal(card(id).version, before + 1);
});

test("the answers material carries the chosen text so the 0-based choice can't be read as the first option", () => {
  clean();
  const { id } = asked(1);
  answer(id, { choice: 1, by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  assert.deepEqual([job.context.answers[0].choice, job.context.answers[0].chosen], [1, "留着"]);
  // A free-text answer has no choice: the chosen text is the answer itself.
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(2));
  const second = one<{ id: number }>("SELECT id FROM cards WHERE id != ?", [id])!.id;
  answer(second, { text: "先备份再删", by: "me" }, at(3));
  const free = claim("w1", at(3))!;
  assert.deepEqual([free.context.answers[0].choice, free.context.answers[0].chosen], [null, "先备份再删"]);
});

test("an answer while another run holds the thread joins the next run, and a merged run still carries it", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  const going = claim("w1", at(1))!;
  answer(id, { choice: 0, by: "me" }, at(2));
  assert.equal(claim("w1", at(2)), null, "one run at a time on a thread");
  ingest("app", note(1, "decided"), at(3));
  finish(going.run, going.token, { outcome: "done", summary: "补充看过了" }, at(4));
  const next = claim("w1", at(4))!;
  assert.deepEqual(
    next.context.events.map((e) => e.type),
    ["card.answered", "feedback.decided"],
  );
  assert.equal(next.context.answers[0].card, id);
  assert.equal(next.session, "s-1");
});

test("a failed run that carried an answer keeps it for the retry; the card stays decided until it's carried out", () => {
  clean();
  const { id } = asked(1);
  answer(id, { choice: 0, by: "me" }, at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "failed", error: "断网" }, at(2));
  assert.equal(card(id).state, "decided");
  job = claim("w1", at(8))!;
  assert.equal(job.context.answers[0].card, id);
  finish(job.run, job.token, { outcome: "nothing", summary: "已经有人删了" }, at(9));
  assert.deepEqual([card(id).state, card(id).result], ["done", "已经有人删了"]);
});

test("a failed run merged with what came in meanwhile goes on in the asker's session, whichever of them carried it", () => {
  clean();
  // The answer comes in while another run holds the thread, so it waits on its own until that run fails.
  const first = asked(1);
  ingest("app", note(1, "followup"), at(1));
  const going = claim("w1", at(1))!;
  answer(first.id, { choice: 0, by: "me" }, at(2));
  finish(going.run, going.token, { outcome: "failed", error: "断网" }, at(3));
  const merged = claim("w1", at(8))!;
  assert.equal(merged.run, going.run);
  assert.equal(merged.session, "s-1");
  assert.deepEqual(
    merged.context.events.map((e) => e.type),
    ["feedback.followup", "card.answered"],
  );
  // The other way round: the run going is the one with the session, and what waits has none to wipe it with.
  const second = asked(2, at(10));
  answer(second.id, { choice: 0, by: "me" }, at(11));
  const answering = claim("w1", at(11))!;
  assert.equal(answering.session, "s-2");
  ingest("app", note(2, "followup"), at(12));
  finish(answering.run, answering.token, { outcome: "failed", error: "断网" }, at(13));
  const retried = claim("w1", at(18))!;
  assert.equal(retried.run, answering.run);
  assert.equal(retried.session, "s-2");
  assert.deepEqual(
    retried.context.events.map((e) => e.type),
    ["card.answered", "feedback.followup"],
  );
});

test("a stopped run's receipt takes no effect, and the answer it carried isn't shown as carried out", () => {
  clean();
  const { id } = asked(1);
  const other = asked(2).id;
  answer(id, { choice: 0, by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  cancel(job.run, at(2));
  finish(
    job.run,
    job.token,
    {
      outcome: "cancelled",
      summary: "已停止",
      ask: [{ title: "还要问", text: "x", options: ["a", "b"] }],
      notice: [{ title: "还要说", text: "x" }],
      resolve: [{ card: other, reason: "顺手结了" }],
      later: [{ key: "k", at: new Date(at(60)).toISOString(), about: "再看" }],
    },
    at(3),
  );
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "cancelled");
  assert.deepEqual([card(id).state, card(id).result], ["decided", null]);
  assert.equal(card(other).state, "open");
  assert.equal(all("SELECT id FROM cards").length, 2);
  assert.deepEqual(all("SELECT id FROM timers"), []);
});

test("an answer to a card whose rule has gone still counts, and wakes nobody", () => {
  clean();
  const { id } = asked(1);
  underRules(
    (rules) => {
      rules.rules = rules.rules.filter((rule: { name: string }) => rule.name !== "意见");
    },
    () => {
      assert.deepEqual(answer(id, { choice: 1, by: "me" }, at(1)), { changed: true, state: "decided" });
      assert.equal(card(id).choice, 1);
      const event = one<{ routed: string }>("SELECT routed FROM events WHERE type = 'card.answered'")!;
      assert.deepEqual(JSON.parse(event.routed), []);
      assert.deepEqual(all("SELECT id FROM runs WHERE state = 'queued'"), []);
    },
  );
});

test("a run with events from two sources has nothing to check: a card without a source isn't one of its own", () => {
  clean();
  const { id } = asked(1);
  // A worker stopped mentioning a run on #2: the hub's own card about that has the group, but no source.
  ingest("app", note(2), at(0));
  const quiet = claim("w1", at(0))!;
  heartbeat("w1", [], at(6));
  sweep(at(6));
  const hubs = one<{ id: number }>("SELECT id FROM cards WHERE key = ?", [`run:${quiet.run}:unknown`])!.id;
  underRules(
    (rules) => {
      rules.rules[0].when = { source: "ops", types: ["feedback.*"] };
    },
    () => {
      // #1 takes an event from the new source, and the answer to what it asked under the old one joins it.
      ingest("ops", { id: "moved", type: "feedback.new", subject: "#1" }, at(7));
      answer(id, { choice: 0, by: "me" }, at(7));
      const job = claim("w1", at(8))!;
      assert.deepEqual(
        job.context.events.map((e) => e.source),
        ["ops", "app"],
      );
      assert.deepEqual(job.context.open, []);
      const receipt = finish(
        job.run,
        job.token,
        { outcome: "done", resolve: [{ card: hubs, reason: "看过了" }] },
        at(9),
      );
      assert.deepEqual(
        receipt.rejected.map((r) => r.card),
        [hubs],
      );
      assert.equal(card(hubs).state, "open");
    },
  );
});

test("an answer counts once; a choice must exist; only one of answering and resolving changes an open card", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { choice: 2, by: "me" }, at(1)), InputError);
  assert.throws(() => answer(id, { by: "me" }, at(1)), InputError);
  assert.throws(() => answer(9999, { choice: 0, by: "me" }, at(1)), NotFound);
  assert.equal(answer(id, { choice: 0, by: "me" }, at(1)).changed, true);
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, false);
  assert.equal(card(id).choice, 0);
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
  assert.equal(resolve(id, "晚了", "owner", at(3)), false, "already decided");
  assert.equal(card(id).state, "decided");

  const other = asked(2, at(4)).id;
  assert.equal(resolve(other, "问题自己好了", "owner", at(5)), true);
  assert.equal(
    answer(other, { choice: 0, by: "me" }, at(6)).changed,
    false,
    "resolved first: the late answer starts nothing",
  );
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
});

test("a free-text answer counts as an answer", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { text: " ", by: "me" }, at(1)), InputError);
  answer(id, { text: "都不选，改成归档", by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  assert.deepEqual([job.context.answers[0].choice, job.context.answers[0].text], [null, "都不选，改成归档"]);
});

test("an answer is bounded by the protocol's limits, and a refused one changes nothing", () => {
  clean();
  const words = (n: number) => "可".repeat(n);
  const first = asked(1);
  const before = getView().seq;
  assert.throws(() => answer(first.id, { text: words(4001), by: "me" }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "好的", by: "名".repeat(501) }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "好的", by: 42 } as any, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "好的", ref: "r".repeat(501) }, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: "好的", ref: 42 } as any, at(1)), InputError);
  assert.throws(() => answer(first.id, { text: 42 } as any, at(1)), InputError);
  assert.equal(getView().seq, before, "a refused answer writes no fact");
  assert.equal(card(first.id).state, "open", "a refused answer leaves the card open");
  // The limit itself is allowed.
  assert.equal(
    answer(first.id, { text: words(4000), by: "名".repeat(500), ref: "r".repeat(500) }, at(1)).changed,
    true,
  );
  // A channel's own message id has the same bound.
  const second = asked(2);
  const version = card(second.id).version;
  const beforeDelivery = getView().seq;
  assert.throws(() => delivered("chat", second.id, version, "r".repeat(501), at(2)), InputError);
  assert.throws(() => delivered("chat", second.id, version, 42 as any, at(2)), InputError);
  assert.equal(getView().seq, beforeDelivery, "a refused report writes no fact");
  delivered("chat", second.id, version, "r".repeat(500), at(2));
  assert.ok(getView().seq > beforeDelivery);
});

test("a channel's answer must come from someone on its list, on the message it sent", () => {
  clean();
  const { id } = asked(1);
  const given = nextCard("chat", at(1))!;
  delivered("chat", id, given.version, "om_1", at(1));
  assert.throws(() => answer(id, { choice: 0, by: "someone-else", channel: "chat", ref: "om_1" }, at(2)), AuthError);
  assert.throws(() => answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_forwarded" }, at(2)), AuthError);
  assert.equal(card(id).state, "open");
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(2)).changed, true);
});

test("a channel's answer gives back the card exactly as that channel is sent it next", () => {
  clean();
  const { id } = asked(1);
  delivered("chat", id, nextCard("chat", at(1))!.version, "om_1", at(1));
  const decided = answer(id, { choice: 1, text: "先备份", by: "me", channel: "chat", ref: "om_1" }, at(2)).card;
  assert.deepEqual(decided, nextCard("chat", at(2)));
  clean();
  ingest("app", note(2), at(3));
  const job = claim("w1", at(3))!;
  finish(job.run, job.token, { outcome: "done", notice: [{ title: "要你做一件事", text: "开权限" }] }, at(3));
  const notice = nextCard("chat", at(3))!;
  delivered("chat", notice.id, notice.version, "om_2", at(3));
  const closed = answer(notice.id, { choice: 0, text: "开好了", by: "me", channel: "chat", ref: "om_2" }, at(4)).card;
  assert.deepEqual(closed, nextCard("chat", at(4)));
});

test("a run may resolve only what it was given to check, and a bad id doesn't spoil its own result", () => {
  clean();
  const mine = asked(1).id;
  const elsewhere = (() => {
    // Same source, other group.
    ingest("ops", { id: "a", type: "alert.raised", subject: "x" }, at(0));
    const w2 = claim("w2", at(0))!;
    const w1 = claim("w1", at(0))!;
    finish(w1.run, w1.token, { outcome: "nothing" }, at(0));
    finish(w2.run, w2.token, { outcome: "done", notice: [{ title: "别的组", text: "x" }] }, at(0));
    return one<{ id: number }>("SELECT id FROM cards WHERE title = '别的组'")!.id;
  })();
  ingest("app", note(2), at(1));
  const job = claim("w1", at(2))!;
  assert.deepEqual(
    job.context.open.map((c) => c.card),
    [mine],
  );
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "好了",
      resolve: [
        { card: mine, reason: "原站恢复了" },
        { card: elsewhere, reason: "越界" },
        { card: 9999, reason: "没这张" },
      ],
    },
    at(3),
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [elsewhere, 9999],
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.reason),
    ["不在本轮核对范围", "不在本轮核对范围"],
  );
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.deepEqual([card(mine).state, card(mine).result], ["closed", "原站恢复了"]);
  assert.equal(card(elsewhere).state, "open");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "resolving wakes nobody");
});

test("a card made after this run was claimed isn't in its scope", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  ingest("app", note(2), at(1));
  const other = claim("w1", at(1))!;
  finish(other.run, other.token, { outcome: "done", notice: [{ title: "后来的", text: "x" }] }, at(2));
  const later = one<{ id: number }>("SELECT id FROM cards")!.id;
  const receipt = finish(job.run, job.token, { outcome: "done", resolve: [{ card: later, reason: "看过了" }] }, at(3));
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [later],
  );
});

test("each channel gets each card once, and an update when its state changes; a lost report sends no second message", () => {
  clean();
  const { id } = asked(1);
  const first = nextCard("chat", at(1))!;
  assert.deepEqual(
    [first.id, first.version, first.ref, first.kind, first.state, first.options, first.recommend],
    [id, 1, null, "ask", "open", ["删", "留着"], 1],
  );
  assert.equal(nextCard("chat", at(1)), null, "out with the channel for a minute");
  // The report was lost: it comes round again under the same message identity.
  const again = nextCard("chat", at(3))!;
  assert.equal(again.id, id);
  delivered("chat", id, 1, "om_1", at(3));
  assert.equal(nextCard("chat", at(10)), null);
  const plain = nextCard("plain", at(10))!;
  assert.equal(plain.id, id, "the other channel has its own copy");
  delivered("plain", id, 1, "p_1", at(10));
  answer(id, { choice: 1, by: "me", channel: "chat", ref: "om_1" }, at(11));
  const update = nextCard("chat", at(11))!;
  assert.deepEqual([update.version, update.ref, update.state, update.choice], [2, "om_1", "decided", 1]);
  assert.equal(nextCard("plain", at(11))!.ref, "p_1", "and the other channel hears of it too");
  // A late report of the older version changes nothing.
  delivered("chat", id, 2, "om_1", at(12));
  delivered("chat", id, 1, "om_other", at(13));
  const row = one<{ version: number; ref: string }>(
    "SELECT version, ref FROM deliveries WHERE card_id = ? AND channel = 'chat'",
    [id],
  )!;
  assert.deepEqual([row.version, row.ref], [2, "om_1"]);
});

test("a rule that lists channels has its cards go only there; one that lists none, or a notice of no rule, goes to all", () => {
  clean();
  underRules(
    (rules) => {
      rules.rules.find((rule: { name: string }) => rule.name === "意见").channels = ["plain"];
    },
    () => {
      const { id } = asked(1);
      assert.equal(nextCard("chat", at(1)), null, "chat isn't on the rule's list");
      assert.equal(nextCard("plain", at(1))?.id, id);
      tell("hub:test", "中台", "谁都该知道", at(2));
      assert.ok(nextCard("chat", at(2)), "a notice of no rule still reaches every channel");
    },
  );
  clean();
  const { id } = asked(2);
  assert.equal(nextCard("chat", at(1))?.id, id, "without a list, every channel gets it");
  assert.equal(nextCard("plain", at(1))?.id, id);
});

test("defaultChannels takes every card that names no channels of its own; a rule's own list still wins", () => {
  clean();
  underRules(
    (rules) => {
      rules.defaultChannels = ["plain"];
      rules.rules.find((rule: { name: string }) => rule.name === "意见").channels = ["chat"];
    },
    () => {
      const told = tell("source:app:k", "应用", "只说一次", at(1)).card;
      assert.equal(nextCard("chat", at(1)), null, "a tell isn't repeated on chat");
      assert.equal(nextCard("plain", at(1))?.id, told);
      delivered("plain", told, 1, "p_1", at(1));
      const { id } = asked(1);
      assert.equal(nextCard("chat", at(2))?.id, id, "the rule's own list, not the default");
      assert.equal(nextCard("plain", at(2)), null);
    },
  );
  clean();
  underRules(
    (rules) => {
      rules.defaultChannels = ["plain"];
    },
    () => {
      const { id } = asked(2);
      assert.equal(nextCard("chat", at(1)), null, "a rule without a list goes where the default says");
      assert.equal(nextCard("plain", at(1))?.id, id);
    },
  );
});

test("a failed send is retried further and further apart, then given up within the hour; a channel that never came hasn't failed", () => {
  clean();
  const id = tell("source:app:k", "应用", "周报来了", at(0)).card;
  const tries = [0, 1, 3, 7, 15, 25, 35, 45, 55];
  for (const minute of tries) {
    const given = nextCard("chat", at(minute));
    assert.equal(given?.id, id, `try at ${minute}`);
    assert.equal(nextCard("chat", at(minute)), null);
    failed("chat", id, given!.version, "飞书挂了", at(minute));
  }
  assert.equal(nextCard("chat", at(56)), null);
  assert.equal(nextCard("chat", at(500)), null, "given up");
  assert.equal(one<{ given_up: number }>("SELECT given_up FROM deliveries WHERE channel = 'chat'")!.given_up, 1);
  // Past an hour a channel can no longer drop a repeat, so it stops; the channel that hasn't come still gets it.
  assert.equal(nextCard("plain", at(500))?.id, id);
  // A failure of an older version doesn't hold back the newer one.
  clean();
  const { id: asking } = asked(1, at(0));
  const v1 = nextCard("chat", at(0))!;
  delivered("chat", asking, v1.version, "om_1", at(0));
  answer(asking, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1));
  const v2 = nextCard("chat", at(1))!;
  failed("chat", asking, 1, "旧的失败", at(1));
  assert.ok(nextCard("chat", at(1)), "a stale failure doesn't delay the update");
  assert.equal(v2.version, 2);
});

test("a channel that takes a card and never reports stops getting it: after the last try, or once an hour is up", () => {
  clean();
  const id = tell("source:app:k", "应用", "周报", at(0)).card;
  for (const minute of [0, 1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(nextCard("chat", at(minute))?.id, id, `try at ${minute}`);
  assert.equal(nextCard("chat", at(9)), null, "that was the last try");
  const givenUp = (channel: string) =>
    one<{ given_up: number }>("SELECT given_up FROM deliveries WHERE channel = ?", [channel])?.given_up;
  assert.equal(givenUp("chat"), 1);
  assert.equal(nextCard("chat", at(30)), null);

  clean();
  const { id: asking } = asked(1, at(60));
  assert.equal(nextCard("chat", at(60))?.id, asking);
  assert.equal(nextCard("chat", at(60 + 58)), null, "too late for a channel to drop a repeat");
  assert.equal(givenUp("chat"), 1);
  assert.equal(nextCard("plain", at(60 + 58))?.id, asking, "the channel that hasn't come still gets it");
});

test("closing a card that isn't there, or reporting a failure on one the channel doesn't have, is refused", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => resolve(9999, "没这张", "owner", at(1)), NotFound);
  assert.throws(() => failed("chat", 9999, 1, "挂了", at(1)), NotFound);
  assert.throws(() => failed("chat", id, 1, "挂了", at(1)), NotFound, "it was never handed to this channel");
  assert.deepEqual(all("SELECT card_id FROM deliveries"), []);
});

test("a card closed while its first message is on the way still gets that message updated", () => {
  clean();
  const { id } = asked(1);
  const out = nextCard("chat", at(1))!;
  resolve(id, "问题自己好了", "owner", at(2));
  delivered("chat", id, out.version, "om_1", at(3));
  const update = nextCard("chat", at(3))!;
  assert.deepEqual([update.id, update.state, update.ref, update.version], [id, "closed", "om_1", 2]);
  delivered("chat", id, update.version, "om_1", at(3));
  assert.equal(nextCard("chat", at(4)), null);
});

test("a notice's handling note must be words, and one that isn't changes nothing", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(job.run, job.token, { outcome: "done", notice: [{ title: "要你做一件事", text: "开权限" }] }, at(0));
  const { id } = one<{ id: number }>("SELECT id FROM cards")!;
  assert.throws(() => answer(id, { text: 42 } as any, at(1)), InputError);
  assert.equal(card(id).state, "open");
});

test("a card solved before it was sent doesn't bother the owner; a closed one already sent is updated", () => {
  clean();
  const { id } = asked(1);
  resolve(id, "问题自己好了", "owner", at(1));
  assert.equal(nextCard("chat", at(2)), null);
  const sent = asked(2, at(3)).id;
  const v1 = nextCard("chat", at(3))!;
  delivered("chat", sent, v1.version, "om_2", at(3));
  resolve(sent, "问题自己好了", "owner", at(4));
  const update = nextCard("chat", at(4))!;
  assert.deepEqual(
    [update.id, update.state, update.ref, update.options, update.result],
    [sent, "closed", "om_2", ["删", "留着"], "问题自己好了"],
  );
});

test("a notice has one button that closes it; something only to know has none and isn't left open", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(job.run, job.token, { outcome: "done", notice: [{ title: "要你做一件事", text: "开权限" }] }, at(0));
  const id = one<{ id: number }>("SELECT id FROM cards")!.id;
  const shown = nextCard("chat", at(0))!;
  assert.deepEqual([shown.kind, shown.options], ["notice", ["已处理"]]);
  delivered("chat", id, shown.version, "om_1", at(0));
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1)).changed, true);
  assert.equal(card(id).state, "closed");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "nothing to wake");
  const closed = nextCard("chat", at(1))!;
  assert.deepEqual([closed.id, closed.state, closed.options], [id, "closed", []], "its message loses the button");
  delivered("chat", id, closed.version, "om_1", at(1));
  const fyi = tell("source:app:k2", "应用", "只是告诉你", at(2)).card;
  const given = nextCard("chat", at(2))!;
  assert.deepEqual([given.id, given.state, given.options], [fyi, "closed", []]);
});

test("a card closed as it's made says when, or whatever reads the state takes it for still waiting", () => {
  clean();
  tell("source:app:k3", "应用", "只是告诉你", at(1));
  ingest("app", note(1), at(2));
  const job = claim("w1", at(2))!;
  finish(job.run, job.token, { outcome: "done", notice: [{ title: "已设好", text: "每天九点", fyi: true }] }, at(3));
  const [told, receipt] = [nextCard("chat", at(3))!, nextCard("chat", at(3))!];
  assert.deepEqual([told.state, told.closedAt], ["closed", new Date(at(1)).toISOString()]);
  assert.deepEqual([receipt.state, receipt.closedAt], ["closed", new Date(at(3)).toISOString()]);
});

test("receipt FYIs arrive as grey closed cards; ordinary notices and questions still need handling", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      ask: [question],
      notice: [
        { title: "已设好", text: "每天九点检查", fyi: true },
        { title: "要开权限", text: "请开通权限" },
        { title: "要查告警", text: "请查看日志", fyi: false },
      ],
    },
    at(1),
  );
  const shown = Array.from({ length: 4 }, () => nextCard("chat", at(1))!);
  assert.deepEqual(
    shown.map((c) => [c.title, c.state, c.options]),
    [
      [question.title, "open", question.options],
      ["已设好", "closed", []],
      ["要开权限", "open", ["已处理"]],
      ["要查告警", "open", ["已处理"]],
    ],
  );
  for (const c of shown) delivered("chat", c.id, c.version, `om_${c.id}`, at(1));
  const fyi = shown[1];
  const grey = render(fyi);
  assert.equal(grey.header.template, "grey");
  assert.doesNotMatch(JSON.stringify(grey), /callback|已处理/);
  for (const c of [shown[0], shown[2], shown[3]]) {
    assert.equal(render(c).header.template, "blue");
    assert.match(JSON.stringify(render(c)), /callback/);
  }
  assert.deepEqual(answer(fyi.id, { choice: 0, by: "me", channel: "chat", ref: `om_${fyi.id}` }, at(2)), {
    changed: false,
    state: "closed",
  });
  assert.equal(claim("w1", at(2)), null, "a closed FYI cannot wake another round");
  ingest("app", note(1, "followup"), at(3));
  const next = claim("w1", at(3))!;
  assert.deepEqual(
    next.context.events.map((e) => e.type),
    ["feedback.followup"],
  );
  assert.deepEqual(next.context.answers, []);
  assert.deepEqual(
    next.context.open.map((c) => c.title),
    [question.title, "要开权限", "要查告警"],
  );
  finish(
    next.run,
    next.token,
    {
      outcome: "done",
      resolve: [{ card: shown[2].id, reason: "权限已开通" }],
    },
    at(4),
  );
  const resolved = nextCard("chat", at(4))!;
  assert.deepEqual([resolved.id, resolved.state, resolved.options], [shown[2].id, "closed", []]);
  assert.equal(answer(shown[3].id, { choice: 0, by: "me" }, at(4)).changed, true);
  assert.equal(answer(shown[0].id, { choice: 1, by: "me" }, at(5)).changed, true);
  assert.deepEqual(
    claim("w1", at(5))!.context.events.map((e) => e.type),
    ["card.answered"],
  );
});

test("a run that keeps failing says its FYI once, and the third failure in a row is still told", () => {
  clean();
  ingest("app", note(1), at(0));
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = claim("w1", at(attempt * 120))!;
    finish(
      job.run,
      job.token,
      { outcome: "failed", error: "boom", notice: [{ title: "已试过", text: "还在试", key: "retry", fyi: true }] },
      at(attempt * 120 + 1),
    );
  }
  const cards = all<{ key: string; state: string }>("SELECT key, state FROM cards ORDER BY id");
  assert.equal(cards.filter((card) => card.key.endsWith(":retry")).length, 1);
  assert.equal(cards.filter((card) => card.key.endsWith(":failing") && card.state === "open").length, 1);
});

test("why shows receipt FYIs while keeping hub end notices and empty closures hidden", () => {
  clean();
  ingest("ops", { id: "why-fyi", type: "alert.raised", subject: "probe" }, at(0));
  const job = claim("w2", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "本轮检查完成",
      notice: [
        { title: "仅告知的结果", text: "已经完成核实", fyi: true },
        { title: "仍需处理的结果", text: "请检查日志" },
      ],
    },
    at(1),
  );
  const output = formatWhy(job.run, why(job.run));
  assert.match(output, /通知：仅告知的结果/);
  assert.match(output, /已经完成核实/);
  assert.match(output, /通知：仍需处理的结果/);
  assert.match(output, /结束：本轮检查完成/);
  assert.doesNotMatch(output, /通知：告警|结案：仅告知的结果/);
  assert.equal(output.split("本轮检查完成").length - 1, 1);
});

test("a receipt FYI is deliverable for one day even though it starts closed", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      notice: [{ title: "已上线", text: "可以使用了", fyi: true }],
    },
    at(0),
  );
  assert.equal(nextCard("chat", at(24 * 60))?.state, "closed");
  assert.equal(nextCard("plain", at(24 * 60 + 1)), null);
});

for (const fyi of [undefined, false, true]) {
  test(`tell never keeps receipt notices quiet with fyi=${fyi} while questions still arrive`, () => {
    clean();
    ingest("ops", { id: "alert", type: "alert.raised", subject: "probe" }, at(0));
    const job = claim("w1", at(0))!;
    finish(
      job.run,
      job.token,
      {
        outcome: "done",
        ask: [question],
        notice: [{ title: "记下了", text: "留作记录", ...(fyi !== undefined && { fyi }) }],
      },
      at(0),
    );
    const shown = nextCard("chat", at(1))!;
    assert.deepEqual([shown.kind, shown.state, shown.options], ["ask", "open", question.options]);
    delivered("chat", shown.id, shown.version, "om_ask", at(1));
    assert.equal(nextCard("chat", at(2)), null, "quiet notices never reach the channel");
  });
}

test("what only needed saying is told once per key; given up, it can be told again", () => {
  clean();
  const first = tell("source:app:k", "应用", "周报", at(0));
  assert.equal(first.duplicate, false);
  assert.equal(tell("source:app:k", "应用", "周报", at(1)).duplicate, true);
  for (const minute of [0, 1, 3, 7, 15, 25, 35, 45, 55])
    failed("chat", first.card, nextCard("chat", at(minute))!.version, "挂了", at(minute));
  assert.equal(nextCard("chat", at(60)), null);
  const again = tell("source:app:k", "应用", "周报（更新）", at(70));
  assert.deepEqual(
    [again.card, again.duplicate],
    [first.card, false],
    "told again, it goes out at once with its new words",
  );
  assert.equal(nextCard("chat", at(70))?.text, "周报（更新）");
  assert.equal(nextCard("plain", at(70))?.text, "周报（更新）");
});

test("what only needed saying goes stale: a channel coming back after a day doesn't get yesterday's", () => {
  clean();
  tell("source:app:k", "应用", "昨天的事", at(0));
  assert.equal(nextCard("chat", at(25 * 60)), null);
  const { id } = asked(1, at(25 * 60));
  assert.equal(nextCard("chat", at(25 * 60))?.id, id, "what still needs an answer does");
});

test("a card's link goes only to a channel that allows it, and opens only that card", () => {
  clean();
  const { id } = asked(1);
  const link = nextCard("plain", at(1))!.link!;
  assert.match(link, /^https:\/\/hub\.test\/c\/[\w-]+$/);
  assert.equal(nextCard("chat", at(1))!.link, null, "a channel with buttons has no use for a link that answers");
  assert.equal(cardByToken(new URL(link).pathname.slice("/c/".length))!.id, id);
  assert.equal(cardByToken("made-up"), undefined);
});
