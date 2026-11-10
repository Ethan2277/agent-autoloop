// Failure modes: a labelled PR is never picked up; local review executes PR files; draft checks authorize a merge;
// delivery reports success before Ship and health agree; the fixture leaks a repository, child process or database.
// This opt-in test creates and deletes exactly the named private repository, using the existing gh/Codex logins.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [repo, flag] = process.argv.slice(2);
assert.ok(
  repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && flag === "--run",
  "用法：node scripts/delivery-e2e.ts owner/name --run（会创建并删除这个私有仓库）",
);
const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-e2e-"));
const work = join(root, "seed");
const home = join(root, "hub");
const engine = join(import.meta.dirname, "..");
mkdirSync(work);
mkdirSync(home);
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const { gh, github } = await import("../plugins/delivery/github.ts");
const { poll } = await import("../plugins/delivery/poll.ts");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: work, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (name: string, text: string) => {
  mkdirSync(join(work, name, ".."), { recursive: true });
  writeFileSync(join(work, name), text);
};
const commit = (message: string) => {
  git("add", "-A");
  git("-c", "user.name=Agent Autoloop Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git("rev-parse", "HEAD");
};
let live = "0".repeat(40);
let created = false;
let completed = false;
let worker: any;
let hub: any;
let server: any;
let number = 0;
let merged = "";
let ship = 0;
const health = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, commit: live }));
});
health.listen(0, "127.0.0.1");
await once(health, "listening");
const healthURL = `http://127.0.0.1:${(health.address() as any).port}/health`;
const start = Date.now();
const api = github(repo);
try {
  git("init", "-q", "-b", "main");
  write("AGENTS.md", "## 审查要点\n\napp.txt 只能包含一个版本标记；不执行仓库里的代码或设置。\n");
  write("app.txt", "版本一\n");
  write(
    "ops/delivery.json",
    JSON.stringify(
      {
        repo,
        internal: ["docs/**/*.md"],
        review: { points: "AGENTS.md", status: "agent-review" },
        health: { url: healthURL, field: "commit", pattern: "(?P<sha>[0-9a-f]{40})", require: { ok: true } },
      },
      null,
      2,
    ),
  );
  const action = join(work, ".github/actions/delivery");
  mkdirSync(action, { recursive: true });
  for (const name of ["action.yml", "action.ts", "project.ts"])
    cpSync(join(engine, "plugins/delivery", name), join(action, name));
  write(
    ".github/workflows/check.yml",
    `name: Check
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
jobs:
  draft:
    if: github.event.pull_request.draft
    runs-on: ubuntu-latest
    steps:
      - run: echo 草稿只做快速检查
  check:
    if: '!github.event.pull_request.draft'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '24'
      - run: node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; assert.ok(["版本一","版本二"].includes(fs.readFileSync("app.txt","utf8").trim()));'
`,
  );
  write(
    ".github/workflows/ship.yml",
    `name: Ship
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: ./.github/actions/delivery
        id: scope
        with:
          test-local-health: 'true'
      - if: steps.scope.outputs.release == 'true' && steps.scope.outputs.superseded != 'true'
        run: echo 发布步骤完成，测试控制器核对成功后更新本机健康版本
`,
  );
  live = commit("初始化临时交付测试项目");
  gh(["repo", "create", repo, "--private", "--description", "agent-autoloop 临时交付测试"]);
  created = true;
  assert.equal(JSON.parse(gh(["repo", "view", repo, "--json", "isPrivate"])).isPrivate, true);
  git("remote", "add", "origin", `https://github.com/${repo}.git`);
  git("push", "-u", "origin", "main");
  for (const name of ["deliver", "deliver-attended", "deliver-review", "ask-owner"])
    gh(["label", "create", name, "--repo", repo]);
  git("switch", "-c", "verify-delivery");
  write("app.txt", "版本二\n");
  const head = commit("验证交付流程的版本变化");
  git("push", "-u", "origin", "verify-delivery");
  const body = join(root, "pr-body.md");
  writeFileSync(body, "将版本标记从版本一改为版本二，验证审查、完整检查、合并、Ship 和本机健康版本。\n");
  const url = gh([
    "pr",
    "create",
    "--repo",
    repo,
    "--head",
    "verify-delivery",
    "--base",
    "main",
    "--draft",
    "--title",
    "验证完整交付流程",
    "--body-file",
    body,
  ]);
  number = Number(url.split("/").at(-1));
  assert.ok(number);
  gh(["pr", "edit", String(number), "--repo", repo, "--add-label", "deliver,deliver-attended"]);
  console.log(JSON.stringify({ stage: "labelled", repo, number, head }));
  writeFileSync(
    process.env.AGENT_AUTOLOOP_RULES,
    JSON.stringify({
      sources: { github: { name: "GitHub" } },
      agents: {
        delivery: {
          name: "交付",
          worker: "test",
          use: "delivery",
          command: [repo, "--test-local-health"],
          access: "read",
          timeout: 20,
        },
      },
      channels: {},
      rules: [
        {
          name: "交付",
          when: { source: "github", types: ["pull_request.*"] },
          to: "delivery",
          cwd: root,
          prompt: "按项目 main 的设置完成交付",
          parallel: 1,
        },
      ],
    }),
  );
  hub = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  server = serve(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = hubClient(base, hub.addKey("source", "github"));
  const owner = hubClient(base, hub.addKey("owner", "me"));
  worker = createWorker({ hub: hubClient(base, hub.addKey("worker", "test")), name: "test", capacity: 1, wait: 0 });
  // GitHub's filtered issue list can lag a successful label mutation on a fresh repository.
  let events = await poll(repo);
  for (let attempt = 0; !events.length && attempt < 20; attempt++) {
    await delay(1000);
    events = await poll(repo);
  }
  assert.equal(events.length, 1);
  await source.event(events[0]);
  while (Date.now() - start < 1200000) {
    await worker.tick();
    const state = await owner.state();
    if (state.runs.some((r: any) => r.error)) throw new Error(state.runs.find((r: any) => r.error).error);
    const pr = await api(`pulls/${number}`);
    if (pr.merged_at) {
      merged = pr.merge_commit_sha;
      const runs = (await api(`actions/workflows/ship.yml/runs?head_sha=${merged}&event=push`)).workflow_runs;
      const completed = runs.find(
        (r: any) => r.head_sha === merged && r.status === "completed" && r.conclusion === "success",
      );
      if (completed && live !== merged) {
        live = merged;
        ship = completed.id;
        console.log(JSON.stringify({ stage: "ship-success-health-updated", merged, ship }));
      }
    }
    if (state.runs.some((r: any) => r.state === "done")) {
      assert.ok(merged && ship);
      assert.equal(live, merged);
      assert.ok(state.runs.some((r: any) => r.summary.includes("健康版本已核实")));
      const statuses = (await api(`commits/${head}/status`)).statuses;
      for (const context of ["agent-review", "delivery"])
        assert.equal(statuses.find((s: any) => s.context === context)?.state, "success");
      const checks = (await api(`actions/workflows/check.yml/runs?head_sha=${head}&event=pull_request`)).workflow_runs;
      const full = checks.find((r: any) => r.conclusion === "success" && r.status === "completed");
      assert.ok(full);
      assert.ok(!(await api(`pulls/${number}`)).labels.some((l: any) => l.name === "deliver"));
      completed = true;
      console.log(
        JSON.stringify({
          passed: true,
          machine: cpus()[0].model,
          repo,
          number,
          head,
          merged,
          ship,
          health: live,
          ms: Date.now() - start,
        }),
      );
      break;
    }
    if (state.cards.length) throw new Error("审查发现问题：" + state.cards.map((c: any) => c.text).join("\n"));
    await delay(1000);
  }
  assert.ok(completed, "完整交付未在 20 分钟内完成");
} finally {
  for (const entry of worker?.entries() ?? [])
    if (entry.pid) {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {}
    }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  hub?.db.close();
  health.closeAllConnections();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  if (created) {
    try {
      gh(["repo", "delete", repo, "--yes"]);
      console.log(JSON.stringify({ deleted: repo }));
    } catch (error) {
      console.error(`临时仓库没有删掉：${repo}，${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
  rmSync(root, { recursive: true, force: true });
}
