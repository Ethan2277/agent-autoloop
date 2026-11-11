// Failure modes: explain prints a rule's private prompt; a dry run writes to the hub instead of previewing; the
// preview ignores another rule for the same event; a bad subcommand is accepted silently; a dry run with another source's key
// previews this machine's source instead.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { explainRules, previewEvent } from "../cli/explain.ts";
import { InputError } from "../kernel/errors.ts";
import { at, setup } from "./helpers.ts";

const fixture = readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8");

test("the explanation shows rule and Agent claim limits independently", () => {
  const given = JSON.parse(fixture);
  given.rules[0].maxActive = 1;
  given.agents.a1.maxActive = 2;
  const lines = explainRules(JSON.stringify(given), at(0), "UTC");
  assert.match(
    lines.find((line) => line.startsWith("Agent："))!,
    /a1（[^）]+最多同时 2 轮/,
  );
  assert.match(
    lines.find((line) => line.startsWith("  意见："))!,
    /并发 3 · 本规则最多同时 1 轮/,
  );
});
const home = setup("rules-preview");
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("explain lists rules, agents, channels and next runs, but no prompt or skill text", () => {
  const lines = explainRules(fixture, at(0), "UTC").join("\n");
  for (const words of ["意见", "feedback.*", "a1", "权限 edit", "chat", "回答人 me", "每天 09:00", "下次", "巡检"])
    assert.ok(lines.includes(words), words + "\n" + lines);
  for (const privateText of ["按手册做。", "处理告警。", "记下来。", "写早报。"])
    assert.ok(!lines.includes(privateText), privateText);
});

test("explain shows a rule's channels, and can read a draft file", async () => {
  const given = JSON.parse(fixture);
  given.rules[0].channels = ["chat"];
  const lines = explainRules(JSON.stringify(given), at(0), "UTC").join("\n");
  assert.match(lines, /意见：.*只发 chat/);
  const draft = join(home, "draft.json");
  writeFileSync(draft, JSON.stringify(given));
  assert.match(await cli("rules", "explain", draft), /只发 chat/);
});

test("explain says where cards that name no channels go", () => {
  assert.ok(!explainRules(fixture, at(0), "UTC").join("\n").includes("默认只发"));
  const given = JSON.parse(fixture);
  given.defaultChannels = ["chat"];
  assert.match(explainRules(JSON.stringify(given), at(0), "UTC").join("\n"), /默认只发 chat/);
});

test("explain says which rules go on in the last round's session", () => {
  assert.ok(!explainRules(fixture, at(0), "UTC").join("\n").includes("接着上一轮的会话"));
  const given = JSON.parse(fixture);
  given.rules[0].resume = true;
  const lines = explainRules(JSON.stringify(given), at(0), "UTC");
  assert.ok(
    lines.some((line) => line.includes("feedback.*") && line.includes("接着上一轮的会话")),
    lines.join("\n"),
  );
});

test("a dry run says which rules would take the event, and doesn't need a hub", () => {
  assert.match(
    previewEvent(fixture, "app", { id: "1", type: "feedback.new", subject: "#1" }, at(0), "UTC").join("\n"),
    /意见 → a1/,
  );
  const alerts = previewEvent(fixture, "ops", { id: "2", type: "alert.raised" }, at(0), "UTC").join("\n");
  assert.ok(alerts.includes("告警 → a2") && alerts.includes("告警也记一笔 → a1"), alerts);
  assert.match(previewEvent(fixture, "app", { id: "3", type: "else.new" }, at(0), "UTC").join("\n"), /没有规则接/);
  assert.throws(() => previewEvent(fixture, "app", { id: "4", type: "not a type" }, at(0), "UTC"), InputError);
});

test("the commands read the local rules file and refuse an unknown subcommand", async () => {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", source: { name: "app", key: "test-only" } }),
  );
  assert.match(await cli("rules", "explain"), /意见/);
  const preview = await cli("emit", "feedback.new", "--dry-run", "--subject", "#1");
  assert.match(preview, /预演/);
  assert.match(preview, /意见 → a1/);
  await assert.rejects(cli("rules", "nope"), /用法/);
  await assert.rejects(cli("emit", "feedback.new", "--dry-run", "--key", "another-source"), /--key/);
});
