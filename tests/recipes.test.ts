// Failure modes: a recipe's rules don't pass `agent-autoloop check`, or check would pass anything; a rule names a Skill the
// recipe doesn't ship, or the README doesn't say where to put it; a README promises one access level while the rules give
// another; the curl in ops-alerts no longer reaches its rule, or the outside system's key can set off the restart; the
// issue watcher prints something the worker can't read (a body's line break or backslash breaking its JSON), or an event
// the rules wouldn't let through, or asks GitHub for something else when called with one argument.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";

const ROOT = join(import.meta.dirname, "..");
const RECIPES = join(ROOT, "examples", "recipes");
const NAMES = [
  "morning-brief",
  "github-issues",
  "ops-alerts",
  "feedback",
  "website-watch",
  "feishu-brief",
  "inbox-triage",
  "browser-handoff",
];
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-recipes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_")),
  ) as NodeJS.ProcessEnv;
const agentAutoloop = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "bin", "agent-autoloop.ts"), ...args],
    {
      env: { ...cleanEnv(), ...env },
      encoding: "utf8",
    },
  );
const readRules = (name: string) => JSON.parse(readFileSync(join(RECIPES, name, "rules.json"), "utf8"));
const readDoc = (name: string) => readFileSync(join(RECIPES, name, "README.md"), "utf8");
const check = (rulesFile: string) =>
  agentAutoloop(["check"], {
    AGENT_AUTOLOOP_RULES: rulesFile,
    AGENT_AUTOLOOP_HOME: mkdtempSync(join(scratch, "home-")),
  });

for (const name of NAMES) {
  test(`${name}: agent-autoloop check passes its rules`, () => {
    const checked = check(join(RECIPES, name, "rules.json"));
    assert.equal(checked.status, 0, checked.stderr);
  });

  test(`${name}: every Skill a rule names is here, and the README says where it goes`, () => {
    const skills = readRules(name).rules.flatMap((rule: { skill?: string }) => rule.skill ?? []);
    assert.equal(skills.length, 1);
    const skill = readFileSync(join(RECIPES, name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^name: ${skills[0]}$`, "m"));
    assert.match(readDoc(name), new RegExp(`~/\\.codex/skills/${skills[0]}/`));
    assert.match(readDoc(name), new RegExp(`~/\\.claude/skills/${skills[0]}/`));
  });

  test(`${name}: the README states the access level the rules actually give`, () => {
    const { agents } = readRules(name);
    const real = Object.values<{ use: string; access: string }>(agents).filter((agent) => agent.use !== "command");
    assert.equal(real.length, 1);
    const stated = /权限：`(read|edit|full)`/.exec(readDoc(name));
    assert.ok(stated, "README 要写明权限");
    assert.equal(stated[1], real[0].access);
  });
}

test("agent-autoloop check refuses a recipe that was changed for the worse", () => {
  const broken = readRules("morning-brief");
  broken.rules[0].to = "nobody";
  const file = join(scratch, "broken.json");
  writeFileSync(file, JSON.stringify(broken));
  const checked = check(file);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /不是已登记的 Agent/);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("ops-alerts: the curl in the README reaches the rule, and that key can't set off the restart", async () => {
  const home = mkdtempSync(join(scratch, "ops-"));
  const port = await freePort();
  const env = { AGENT_AUTOLOOP_HOME: home };
  writeFileSync(join(home, "rules.json"), readFileSync(join(RECIPES, "ops-alerts", "rules.json")));
  const key = agentAutoloop(["key", "new", "source", "shop"], env).stdout.trim().split("\n").at(-1)!;
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, hub: { listen: `127.0.0.1:${port}` } }));
  const hub = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "bin", "agent-autoloop.ts"), "up"],
    { env: { ...cleanEnv(), ...env }, stdio: "ignore" },
  );
  try {
    for (let tries = 0; tries < 100; tries++) {
      const up = await fetch(`${url}/healthz`).catch(() => null);
      if (up?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const curl = /```bash\n(curl [\s\S]*?)```/.exec(readDoc("ops-alerts"))?.[1];
    assert.ok(curl, "README 里要有一条 curl");
    const sent = spawnSync("sh", ["-c", curl.replaceAll("http://127.0.0.1:3350", url)], {
      env: { ...cleanEnv(), SHOP_KEY: key },
      encoding: "utf8",
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(JSON.parse(sent.stdout).routed, ["查线上报错"]);
    const restart = await fetch(`${url}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "from-outside", type: "restart", subject: "checkout" }),
    });
    assert.deepEqual((await restart.json()).routed, []);
  } finally {
    hub.kill("SIGTERM");
    await new Promise((resolve) => hub.once("exit", resolve));
  }
});

// Stands in for gh and does what gh does with --jq, so the watcher's own filter really runs.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" > "$GH_LOG"
while [ $# -gt 0 ]; do
  [ "$1" = "--jq" ] && filter=$2
  shift
done
exec jq -c "$filter" "$GH_ISSUES"
`;

function watch(args: string[]) {
  const dir = mkdtempSync(join(scratch, "gh-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const issues = [
    {
      number: 12,
      title: 'Crash on "C:\\new"',
      url: "https://example.com/issues/12",
      body: 'line one\nline two with a "quote" and a back\\slash\n\ttabbed',
    },
    { number: 13, title: "No body", url: "https://example.com/issues/13", body: "" },
    { number: 14, title: "Long", url: "https://example.com/issues/14", body: "字".repeat(5000) },
  ];
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  const done = spawnSync("sh", [join(ROOT, "examples", "watch-github-issues.sh"), ...args], {
    env: {
      ...cleanEnv(),
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: join(dir, "log"),
      GH_ISSUES: join(dir, "issues.json"),
    },
    encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  return { said: done.stdout, asked: readFileSync(join(dir, "log"), "utf8"), issues };
}

test("github-issues: what the watcher prints goes through the worker whole, and the rules let it in", () => {
  const { said, issues } = watch(["owner/repo"]);
  const { result, problem } = resultFrom(readMessage(said), {});
  assert.equal(problem, undefined);
  assert.equal(result.outcome, "done");
  const events = result.events!;
  assert.equal(events[0].id, "issue-12");
  assert.equal(events[0].subject, "#12");
  assert.equal(events[0].summary, issues[0].title);
  assert.equal(events[0].detail, issues[0].body, "the body has to reach an Agent that can't go and read it");
  assert.equal(events[0].link, issues[0].url);
  assert.equal(events[1].detail, "");
  assert.equal([...events[2].detail].length, 4000);
  const rules = readRules("github-issues").rules;
  const watcher = rules.find((rule: { emits?: unknown }) => rule.emits);
  const handler = rules.find((rule: { skill?: string }) => rule.skill);
  for (const { type } of events) {
    assert.ok(watcher.emits.types.includes(type));
    assert.ok(handler.when.types.includes(type));
  }
  assert.equal(handler.when.source, watcher.emits.source);
});

test("github-issues: the watcher's search is optional, and the rules use it to leave old issues alone", () => {
  assert.doesNotMatch(watch(["owner/repo"]).asked, /--search/);
  assert.match(watch(["owner/repo", "created:>=2026-11-04"]).asked, /--search created:>=2026-11-04/);
  const { agents } = readRules("github-issues");
  assert.ok(agents.watcher.command.some((part: string) => part.startsWith("created:>=")));
});
