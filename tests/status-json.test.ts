// Failure modes: --json changes the state instead of printing it; the human output stops being the plain one; an
// unknown flag is ignored and the command quietly does something else; a client can't tell where in the log the state
// was read, so it replays the whole log or misses what came between; an owner's card can't be tied to the matter it's
// about.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("status-json");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
  if (hub.db.isOpen) hub.db.close();
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, owner: hub.addKey("owner", "reader") }),
);
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("state exposes only pending timers on the first page", () => {
  hub.ingest("app", { id: "timer-state", type: "feedback.new", subject: "#timer" }, at(0));
  const job = hub.claimNext("w1", "timer-state", at(0))!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", later: [{ key: "verify", at: new Date(at(100)).toISOString(), about: "核对结果" }] },
    at(1),
  );
  assert.deepEqual(hub.stateOf(at(2)).timers, [
    { rule: "意见", lane: "#timer", key: "verify", about: "核对结果", at: new Date(at(100)).toISOString() },
  ]);
  assert.deepEqual(hub.stateOf(at(2), job.run + 1).timers, []);
  hub.execute("tick", [], at(101));
  assert.deepEqual(hub.stateOf(at(101)).timers, []);
});

test("the state says where in the log it was read, so a client goes on from there in the stream", () => {
  const read = hub.stateOf(at(3));
  assert.equal(read.seq, hub.logAfter(0).at(-1)!.seq);
  hub.ingest("app", { id: "after-the-state", type: "nobody.takes", subject: "#later" }, at(4));
  const since = hub.logAfter(read.seq);
  assert.ok(since.length > 0, "what came after it is in the stream from there");
  assert.equal(hub.stateOf(at(5)).seq, since.at(-1)!.seq);
});

test("the owner's cards say which matter they're about and what the asker left for itself", () => {
  hub.ingest("app", { id: "card-lane", type: "feedback.new", subject: "#77" }, at(6));
  const job = hub.claimNext("w1", "card-lane", at(6))!;
  const ask = { title: "要不要退款", text: "他说坏了", options: ["退", "不退"], about: "退款走后台第三页" };
  hub.finish(job.run, job.token, { outcome: "done", ask: [ask] }, at(7));
  const card = hub.stateOf(at(8)).cards.find((open: { title: string }) => open.title === ask.title)!;
  assert.equal(card.lane, "#77");
  assert.equal(card.about, ask.about);
});

test("status --json prints the same state the hub serves, and the plain output stays human", async () => {
  hub.execute(
    "rules",
    [
      hub.parseRules(
        JSON.stringify({
          sources: { local: { name: "本机" } },
          agents: { helper: { name: "助手", worker: "this-machine", use: "command", command: ["true"] } },
          channels: {},
          rules: [],
        }),
        Date.now(),
      ),
    ],
    Date.now(),
  );
  const state = JSON.parse(await cli("status", "--json"));
  assert.deepEqual(Object.keys(state).sort(), Object.keys(hub.stateOf()).sort());
  assert.equal(state.timezone, hub.stateOf().timezone);
  assert.ok(Array.isArray(state.runs));
  assert.ok(Array.isArray(state.cards));
  const human = await cli("status");
  assert.ok(!human.trim().startsWith("{"));
  assert.match(human, /在跑|排队|等你/);
  assert.doesNotMatch(human, /\x1b/, "no colour codes when it isn't a terminal");
});

test("an unknown flag is refused instead of ignored", async () => {
  await assert.rejects(cli("status", "--wat"), /不认识的参数/);
});
