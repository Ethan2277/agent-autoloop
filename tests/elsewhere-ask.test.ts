// A scheduled task elsewhere (say, in the Claude app) that asks you something. Failure cases: its question reaches you
// without options, so there is nothing to tap; the same question still open is asked again; your answer is only written
// down and nothing goes on with it; what goes on with it runs on an agent, in a folder or with words the task's request chose
// rather than rules.json; it goes to another worker's agent; reloading the rules drops it before it starts; the card stays
// open after the round that carried it out; a task that never said where it goes on can ask, so the answer has nowhere to
// go; a worker asks as a task that isn't its own; a source asks; a question without two options, or sent together with a
// plain message, gets in.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-elsewhere-ask-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const rulesFile = join(dir, "rules.json");
const weekly = {
  name: "每周清理",
  source: "app",
  to: "a1",
  cron: "0 6 * * 0",
  where: "应用里的定时任务",
  cwd: "~/code/app",
  skill: "weekly-sweep",
  prompt: "按其中“他回答了”一节处理。",
};
const rulesWith = (where: string) => ({
  sources: { app: { name: "应用" } },
  agents: {
    a1: { name: "甲", worker: "w1", use: "claude" },
    a2: { name: "乙", worker: "w2", use: "codex" },
  },
  channels: { chat: { name: "聊天", answerers: ["me"] } },
  rules: [],
  elsewhere: [
    { ...weekly, where },
    { name: "日报", source: "app", to: "a1", cron: "0 9 * * *", where: "应用里的定时任务" },
  ],
});
writeFileSync(rulesFile, JSON.stringify(rulesWith("应用里的定时任务")));
setup("elsewhere-ask", rulesFile);

const { serve } = await import("../host/http.ts");
const hub = await import("./hub.ts");
const { addKey, answer, claimNext, delivered, finish, nextCard, reloadRules } = hub;
const { one } = await import("./storage.ts");

const question = {
  title: "开源 #12 要不要合并？",
  text: "它加了一个新命令，对用户没有影响。",
  options: ["合并", "关闭并说明原因"],
  recommend: 0,
  about: "选合并就合进 main；选关闭就回复原因后关闭。",
};

test("its question comes with options, and your answer goes on where rules.json says, on the task's own agent", () => {
  const asked = hub.ask("每周清理", { ...question, key: "pr-12" }, at(0));
  assert.equal(asked.duplicate, false);
  const again = hub.ask("每周清理", { ...question, key: "pr-12" }, at(1));
  assert.deepEqual(again, { card: asked.card, duplicate: true }, "still open: not asked twice");

  const card = nextCard("chat", at(1))!;
  assert.equal(card.id, asked.card);
  assert.deepEqual([card.kind, card.state, card.options, card.recommend], ["ask", "open", question.options, 0]);
  delivered("chat", card.id, card.version, "om_1", at(1));
  answer(card.id, { choice: 1, by: "me", channel: "chat", ref: "om_1" }, at(2));

  assert.equal(claimNext("w2", "c0", at(3)), null, "not the other worker's agent");
  // Rules read again before anyone takes it: the round is still there.
  writeFileSync(rulesFile, JSON.stringify(rulesWith("应用里的定时任务（改了说明）")));
  assert.deepEqual(reloadRules(rulesFile), {});
  const job = claimNext("w1", "c1", at(3))!;
  const { name, cwd, skill, prompt, emits } = job.rule;
  assert.deepEqual(
    [name, cwd, skill, prompt, emits],
    ["每周清理", "~/code/app", "weekly-sweep", weekly.prompt, undefined],
  );
  assert.equal(job.agent.id, "a1");
  assert.equal(job.session, null);
  assert.equal(job.context.answers.length, 1);
  const [given] = job.context.answers;
  assert.deepEqual(
    [given.card, given.title, given.options, given.choice, given.about, given.by],
    [asked.card, question.title, question.options, 1, question.about, "me"],
  );

  finish(job.run, job.token, { outcome: "done", summary: "已回复原因并关闭" }, at(4));
  const row = one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE id = ?", [asked.card])!;
  assert.deepEqual(row, { state: "done", result: "已回复原因并关闭" });
  const later = hub.ask("每周清理", { ...question, key: "pr-12" }, at(5));
  assert.equal(later.duplicate, false, "once it's been answered, asking again is a new question");
  // The same matter told afterwards under the same key is news, not a repeat of the question.
  assert.equal(hub.tell("elsewhere:每周清理:pr-12", "每周清理", "已关闭", at(6)).duplicate, false);
});

test("only a task that says where it goes on can ask, and only as itself; a message and a question don't mix", async () => {
  const keys = { app: addKey("source", "app"), w1: addKey("worker", "w1"), w2: addKey("worker", "w2") };
  const server = serve(0, "127.0.0.1", { commit: "abc123" });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const tell = async (key: string, body: object) => {
    const response = await fetch(`${base}/v1/tell`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const asked = await tell(keys.w1, { task: "每周清理", ask: question });
  assert.equal(asked.status, 200);
  const card = one<{ kind: string; state: string; options: string; title: string }>(
    "SELECT kind, state, options, title FROM cards WHERE id = ?",
    [asked.json.card],
  )!;
  assert.deepEqual(card, {
    kind: "ask",
    state: "open",
    options: JSON.stringify(question.options),
    title: question.title,
  });

  const refused = async (key: string, body: object, status: number, why: string) =>
    assert.equal((await tell(key, body)).status, status, why);
  assert.equal(
    (await tell(keys.w1, { task: "每周清理", ask: question })).json.duplicate,
    true,
    "same question, still open",
  );
  await refused(keys.w1, { task: "日报", ask: question }, 400, "no cwd: nobody to go on with the answer");
  await refused(keys.w2, { task: "每周清理", ask: question }, 401, "not a task of its agents");
  await refused(keys.app, { key: "x3", ask: question }, 400, "a source has no task to go on");
  await refused(keys.w1, { task: "每周清理", ask: { ...question, options: ["只有一个"] } }, 400, "one option");
  await refused(keys.w1, { task: "每周清理", text: "顺便说一句", ask: question }, 400, "both at once");
  await refused(keys.w1, { task: "每周清理", key: "x6", ask: question }, 400, "the question's key is its own");
  const told = await tell(keys.w1, { task: "日报", key: "x7", text: "日报好了" });
  assert.equal(told.status, 200, "a task without cwd still tells");
});
