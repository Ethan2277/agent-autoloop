import assert from "node:assert/strict";
import { decide, type Input } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { credential } from "../kernel/credentials.ts";
import { invariants } from "./invariants.ts";

export const environment = { secret: "test-simulation", publicUrl: "https://hub.test" };
export const rules = parseRules(
  JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "来源" } },
    agents: {
      a: { name: "甲", worker: "w1", use: "command", command: ["true"] },
      b: { name: "乙", worker: "w2", use: "command", command: ["true"] },
    },
    channels: { chat: { name: "通道", answerers: ["owner"] } },
    rules: [
      {
        name: "one",
        when: { source: "app", types: ["one"] },
        to: "a",
        cwd: "/tmp",
        prompt: "做事",
        group: "shared",
        parallel: 2,
      },
      {
        name: "two",
        when: { source: "app", types: ["two"] },
        to: "b",
        cwd: "/tmp",
        prompt: "做事",
        group: "shared",
        parallel: 2,
      },
    ],
  }),
  0,
  "UTC",
);

export class World {
  view = empty();
  log: Fact[] = [];
  checked = snapshot(this.view);
  now = 0;
  transitions = 0;
  constructor() {
    this.act({ type: "rules", args: [rules] });
  }
  act(input: Input) {
    const before = this.checked;
    const d = decide(this.view, input, this.now, environment);
    this.log.push(...d.facts);
    this.view = evolve(this.view, d.facts);
    this.transitions++;
    this.checked = invariants(this.view, this.log, before);
    return d.value;
  }
  call(type: string, ...args: any[]) {
    return this.act({ type, args });
  }
  restart() {
    this.view.close();
    this.view = evolve(empty(), this.log);
    this.checked = invariants(this.view, this.log);
    this.transitions++;
  }
  alarm() {
    if (rows(this.view, "due").some((d) => d.at <= this.now)) this.call("tick");
  }
  advance(ms: number) {
    this.now += ms;
    this.alarm();
  }
  finish(id: number, result: unknown = { outcome: "done" }) {
    const r = this.view.get("runs", id)!;
    return this.call("finish", id, credential(environment, "run", id, r.issued), result);
  }
  recover() {
    this.advance(86400000);
    for (const r of rows(this.view, "runs").filter((r) => ["claimed", "unknown"].includes(r.state))) this.finish(r.id);
    this.call("heartbeat", "w1", []);
    this.call("heartbeat", "w2", []);
    this.alarm();
    assert.ok(
      rows(this.view, "timers").every((t) => Date.parse(t.at) > this.now || t.event_id !== null),
      "故障停止后到期任务没被叫醒",
    );
    for (const c of rows(this.view, "cards").filter((c) => c.state === "open" && c.kind === "ask"))
      this.call("answer", c.id, { choice: 0 });
    for (let n = 0; n < 100; n++) {
      const job = this.call("claimNext", n % 2 ? "w2" : "w1", `recovery-${n}`);
      if (job) this.finish(job.run);
      if (!rows(this.view, "runs").some((r) => ["queued", "claimed", "unknown"].includes(r.state))) break;
    }
    assert.ok(
      rows(this.view, "runs").every((r) => ["done", "nothing", "cancelled"].includes(r.state)),
      "故障停止后仍没结局",
    );
    return rows(this.view, "runs").length;
  }
}
