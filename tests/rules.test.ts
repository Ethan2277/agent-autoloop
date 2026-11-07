// The rules file is what the owner changes by asking an Agent, so a mistake must be caught, say which rule and what is
// wrong, and leave the old rules running. Failure cases: a rule naming a source or agent that isn't there; two rules with
// one name; a rule matching no event or with both a source and a schedule; a schedule that is malformed or never comes; an
// unknown way of telling; an agent without a worker, with an unknown access level, a program to start that isn't one
// path, or a command without a command line; a
// rule that sends its work to an ACP agent with no command line, which only shows when it runs and then fails ten times, or
// an ACP agent like that which no rule uses and which never hurt anyone being refused; a rule with neither a skill nor a
// prompt, or without a folder; a misspelt field taken silently; a rule running more than one at a time without saying how many, or
// rules in one group disagreeing on it; an emit naming a source that isn't there; a rule's channels naming one that isn't there, or none at all; a scheduled task shown on the page naming a source or agent that isn't there or a malformed schedule, or saying how its answers go on without where (cwd), or where without how; a time zone
// that doesn't exist; the reserved source redefined; a null rule crashes reload instead of keeping the old rules.
// A good file changing on disk takes effect; a bad one doesn't, and says why. A file that is gone or can't be read
// crashes the hub, at reload or at restart, instead of keeping the rules it had. A file broken while the hub was down
// is never told, because nothing about it changes after startup has read it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("rules");
const { parseRules, RulesError, rules, ruleNamed, reloadRules, one } = await import("./hub.ts");
const { typeMatches } = await import("../kernel/rules.ts");

const good = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
const problem = (change: (r: any) => void, words: RegExp) => {
  const r = good();
  change(r);
  assert.throws(
    () => parseRules(JSON.stringify(r)),
    (error: Error) => {
      assert.ok(error instanceof RulesError);
      assert.match(error.message, words);
      return true;
    },
  );
};

test("the fixture loads, with defaults filled in", () => {
  const r = parseRules(JSON.stringify(good()));
  assert.equal(r.rules[0].tell, "needed");
  assert.equal(r.rules[2].group, "告警也记一笔", "a rule's group defaults to its own name");
  assert.ok(r.askFirst.includes("删数据"));
  assert.equal(r.sources.schedule.name, "定时");
  assert.equal(r.agents.a1.access, "edit", "the safe level unless the rule's author asks otherwise");
  assert.equal(r.agents.a2.access, "full");
  const wrapped = good();
  wrapped.agents.a1.program = "/opt/bin/claude-via-gateway";
  assert.equal(parseRules(JSON.stringify(wrapped)).agents.a1.program, "/opt/bin/claude-via-gateway");
});

test("a mistake says which rule and what is wrong", () => {
  problem((r) => {
    r.rules[0].to = "nobody";
  }, /规则「意见」.*to.*不是已登记的 Agent：nobody/);
  problem((r) => {
    r.rules[0].channels = ["chat", "nowhere"];
  }, /规则「意见」.*channels.*nowhere/);
  problem((r) => {
    r.rules[0].channels = [];
  }, /规则「意见」.*channels/);
  problem((r) => {
    r.rules[0].when.source = "nowhere";
  }, /规则「意见」.*来源.*nowhere/);
  problem((r) => {
    r.rules[1].name = "意见";
  }, /规则名「意见」重复了/);
  problem((r) => {
    r.rules[0].when.types = [];
  }, /规则「意见」.*types/);
  problem((r) => {
    r.rules[0].when.cron = "0 9 * * *";
  }, /规则「意见」.*when/);
  problem((r) => {
    r.rules[3].when.cron = "99 * * * *";
  }, /规则「早报」.*cron/);
  problem((r) => {
    r.rules[3].when.cron = "0 0 30 2 *";
  }, /规则「早报」.*不会到来/);
  problem((r) => {
    r.rules[0].tell = "sometimes";
  }, /规则「意见」.*tell/);
  problem((r) => {
    delete r.rules[0].cwd;
  }, /规则「意见」缺少 cwd/);
  problem((r) => {
    r.rules[0].cwd = "relative/path";
  }, /规则「意见」.*cwd/);
  problem((r) => {
    delete r.rules[1].prompt;
  }, /规则「告警」.*skill.*prompt/);
  problem((r) => {
    r.rules[0].oops = 1;
  }, /规则「意见」有不认识的字段 oops/);
  problem((r) => {
    delete r.rules[0].parallel;
    r.rules[1].group = "notes";
    r.rules[1].parallel = 2;
  }, /组「notes」.*parallel/);
  problem((r) => {
    r.rules[0].parallel = 0;
  }, /规则「意见」.*parallel/);
  problem((r) => {
    r.rules[0].resume = "thread";
  }, /规则「意见」.*resume/);
  problem((r) => {
    r.rules[4].emits.source = "nowhere";
  }, /规则「巡检」.*emits/);
  problem((r) => {
    delete r.agents.a1.worker;
  }, /Agent a1 缺少 worker/);
  problem((r) => {
    r.agents.a1.access = "root";
  }, /Agent a1.*access/);
  problem((r) => {
    r.agents.a1.program = ["/opt/bin/claude"];
  }, /Agent a1.*program/);
  problem((r) => {
    delete r.agents.a3.command;
  }, /Agent a3.*command/);
  problem((r) => {
    r.agents.a1.oops = 1;
  }, /Agent a1 有不认识的字段 oops/);
  problem((r) => {
    r.sources.schedule = { name: "x" };
  }, /schedule.*保留/);
  problem((r) => {
    r.sources["Bad Id"] = { name: "x" };
  }, /来源的编号/);
  problem((r) => {
    r.channels.chat.answerers = "me";
  }, /通道 chat.*answerers/);
  problem((r) => {
    r.elsewhere[0].to = "nobody";
  }, /定时任务「每周清理」.*to/);
  problem((r) => {
    r.elsewhere[0].source = "nowhere";
  }, /定时任务「每周清理」.*source/);
  problem((r) => {
    r.elsewhere[0].cron = "nope";
  }, /定时任务「每周清理」.*cron/);
  problem((r) => {
    r.elsewhere[0].name = "意见";
  }, /定时任务「意见」.*重名/);
  problem((r) => {
    r.elsewhere[0].skill = "weekly";
  }, /定时任务「每周清理」.*cwd/);
  problem((r) => {
    r.elsewhere[0].cwd = "code/app";
  }, /定时任务「每周清理」.*cwd/);
  problem((r) => {
    r.elsewhere[0].cwd = "~/code/app";
  }, /定时任务「每周清理」.*skill 和 prompt/);
  problem((r) => {
    r.timezone = "Mars/Olympus";
  }, /timezone/);
  problem((r) => {
    r.askFirst = "删数据";
  }, /askFirst/);
  assert.throws(() => parseRules("{ not json"), /不是 JSON/);
});

test("types match exactly, by prefix or all", () => {
  assert.ok(typeMatches(["feedback.*"], "feedback.new"));
  assert.ok(!typeMatches(["feedback.*"], "feedbackx.new"));
  assert.ok(typeMatches(["alert.raised"], "alert.raised"));
  assert.ok(!typeMatches(["alert.raised"], "alert.raised.more"));
  assert.ok(typeMatches(["*"], "anything"));
});

test("a null rule is a rules error and leaves the running configuration intact", () => {
  problem((r) => {
    r.rules = [null];
  }, /对象/);
  const file = join(home, "null-rules.json");
  const broken = good();
  broken.rules = [null];
  writeFileSync(file, JSON.stringify(broken));
  assert.match(reloadRules(file).problem!, /对象/);
  assert.equal(ruleNamed("意见")!.to, "a1");
});

test("what's loaded can be read back", () => {
  assert.equal(ruleNamed("早报")!.to, "a1");
  assert.equal(ruleNamed("没有这条"), undefined);
  assert.equal(rules.timezone, "Asia/Shanghai");
});

test("a good file changing on disk takes effect; a bad one leaves the old rules and says why", () => {
  const file = join(home, "rules.json");
  process.env.AGENT_AUTOLOOP_RULES = file;
  const changed = good();
  changed.rules[0].prompt = "新的说法。";
  writeFileSync(file, JSON.stringify(changed));
  assert.equal(reloadRules(file).problem, undefined);
  assert.equal(ruleNamed("意见")!.prompt, "新的说法。");
  const facts = () => one<{ count: number }>("SELECT COUNT(*) AS count FROM facts")!.count;
  const before = facts();
  assert.equal(reloadRules(file).problem, undefined);
  assert.equal(facts(), before, "nothing new on disk, so nothing goes in the log");
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  assert.match(reloadRules(file).problem!, /nobody/);
  assert.equal(ruleNamed("意见")!.prompt, "新的说法。", "the old rules keep running");
});

test("a rules file that can't be read is a problem, not a crash, and the old rules keep running", () => {
  assert.match(reloadRules(join(home, "gone.json")).problem!, /找不到/);
  assert.equal(ruleNamed("意见")!.prompt, "新的说法。");
  assert.match(reloadRules(home).problem!, /读不到/, "a folder where the file should be");
});

test("a rules file broken while the hub was down is told at the first tick, unless it's fixed by then", () => {
  const down = join(home, "down");
  mkdirSync(down);
  const file = join(down, "rules.json");
  const start = (afterStarting = "") => {
    const started = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href)});` +
          `const { rows } = await import(${JSON.stringify(new URL("../kernel/evolve.ts", import.meta.url).href)});` +
          `${afterStarting}; hub.tick();` +
          `console.log(JSON.stringify(rows(hub.getView(), "cards", { state: "open" }).map((card) => card.title)))`,
      ],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: down, AGENT_AUTOLOOP_RULES: file }, encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    return JSON.parse(started.stdout);
  };
  writeFileSync(file, JSON.stringify(good()));
  assert.deepEqual(start(), []);
  const broken = good();
  broken.rules[0].to = "nobody";
  writeFileSync(file, JSON.stringify(broken));
  assert.deepEqual(start(), ["rules.json 写错了，还在用旧规则"]);
  const fix = `(await import("node:fs")).writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(good()))})`;
  assert.deepEqual(start(fix), [], "fixed by then, and the card from before is gone too");
});

test("a hub restarting without its rules file comes up on the rules it had; a new one without any says why", () => {
  const start = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const hub = await import(${JSON.stringify(new URL("./hub.ts", import.meta.url).href)});` +
          `console.log(hub.ruleNamed("意见")?.prompt)`,
      ],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
  const restarted = start({ AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout.trim(), "新的说法。", "the rules it last loaded, not the fixture's");
  const fresh = start({ AGENT_AUTOLOOP_HOME: join(home, "fresh"), AGENT_AUTOLOOP_RULES: join(home, "gone.json") });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /找不到/);
});
