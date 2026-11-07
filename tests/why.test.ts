// Failure modes: why dumps rules or JSON by default; related runs/events leak into the timeline; a question loses its
// answer or continuation; receipt actions disappear; retry uses the wrong rules version; --json changes the raw facts;
// local time is replaced by UTC or a year, columns drift; a provisional session link is presented after the agent has supplied its real session.
import assert from "node:assert/strict";
import { rows } from "../kernel/evolve.ts";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("why");
const rulesFile = join(home, "rules.json");
const rulesSaying = (prompt: string) =>
  JSON.stringify({
    sources: { shop: { name: "商店" } },
    agents: { helper: { name: "助手", worker: "mac-mini", use: "command", command: ["true"] } },
    channels: {},
    rules: [
      {
        name: "处理订单",
        when: { source: "shop", types: ["order.created"] },
        to: "helper",
        cwd: "/tmp",
        parallel: 2,
        prompt,
        emits: { source: "shop", types: ["order.done"] },
      },
    ],
  });
writeFileSync(rulesFile, rulesSaying("private-rule-instructions"));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
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
      { env: { ...process.env, TZ: "Asia/Taipei" } },
    )
  ).stdout;
const start = Date.parse("2026-11-03T00:00:00Z");

test("why prints the real event, rules version, worker, session, receipt, answer and continuation as a timeline", async () => {
  hub.ingest("shop", { id: "order-42", type: "order.created", subject: "order-42" }, start + 1000);
  const job = hub.claimNext("mac-mini", "first", start + 2000)!;
  hub.started(job.run, job.token, { session: "pending", link: "https://example.com/sessions/pending" }, start + 2500);
  hub.started(job.run, job.token, { session: "example", link: "https://example.com/sessions/example" }, start + 3000);
  hub.finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "等你选择发货方式",
      ask: [{ title: "怎么发货？", text: "两种方式都能送达。", options: ["快递", "自提"], key: "shipping" }],
      notice: [{ title: "订单已核对", text: "库存充足" }],
      later: [{ key: "stock", at: "2026-11-04T00:00:00Z", about: "核对库存" }],
      events: [{ id: "checked-42", type: "order.done", subject: "order-42" }],
    },
    start + 4000,
  );
  const card = rows(hub.getView(), "cards").find((c) => c.run_id === job.run && c.kind === "ask")!;
  hub.answer(card.id, { choice: 1, by: "本人" }, start + 5000);
  const continued = hub.claimNext("mac-mini", "second", start + 6000)!;
  const output = await cli("why", String(job.run));
  for (const words of [
    "11-03 08:00:01",
    "shop",
    "order.created",
    "order-42",
    "规则版本",
    "mac-mini",
    "开始",
    "结束",
    "https://example.com/sessions/example",
    "等你选择发货方式",
    "怎么发货？",
    "自提",
    "本人",
    "订单已核对",
    "核对库存",
    "order.done",
    `回答后继续：第 ${continued.run} 轮`,
  ])
    assert.ok(output.includes(words), words + "\n" + output);
  assert.ok(!output.includes("private-rule-instructions"));
  assert.ok(!output.includes('"changes"'));
  assert.ok(!output.trim().startsWith("["));
  assert.ok(!output.includes("https://example.com/sessions/pending"));
  assert.deepEqual(JSON.parse(await cli("why", String(job.run), "--json")), hub.why(job.run));
  hub.finish(continued.run, continued.token, { outcome: "done", summary: "已安排自提" }, start + 7000);
});
test("why retains failed attempts and uses each attempt's rules version without printing the rules", async () => {
  hub.ingest("shop", { id: "retry", type: "order.created", subject: "retry" }, start + 10000);
  const first = hub.claimNext("mac-mini", "retry-1", start + 11000)!;
  hub.finish(first.run, first.token, { outcome: "failed", error: "连接断开" }, start + 12000);
  const before = hub.getView().get("config", "rules")!.version;
  writeFileSync(rulesFile, rulesSaying("changed-private-instructions"));
  hub.reloadRules();
  const afterVersion = hub.getView().get("config", "rules")!.version;
  hub.claimNext("mac-mini", "retry-2", start + 312000);
  const output = await cli("why", String(first.run));
  assert.ok(output.includes("连接断开"));
  assert.ok(output.includes(`规则版本 #${before}`));
  assert.ok(output.includes(`规则版本 #${afterVersion}`));
  assert.ok(!output.includes("private-instructions"));
});
