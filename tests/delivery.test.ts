// Failure modes: missing labels/forks dispatch; draft or skipped checks authorize merging; a push
// during review or main advancing after checks gets an unreviewed attestation; a dropped merge is repeated; auto-merge
// survives a refusal; health hides a failed/unfinished Ship; a later release changes an already completed handoff;
// a successful label deletion with a lost response turns a completed deployment into a false failure;
// switching to review-only while checks run still merges the PR; a PR behind main ends the run after requesting a
// sync and waits out the hub's growing retry delay while main keeps moving; commits GitHub synced beyond the main that was
// read are reviewed as the branch's own; a delivery withdrawn while main moves on still syncs and reviews again; settings read
// before main moved decide what a round against the newer main does, so a health check added there is skipped; another event
// on a commit with findings reviews it again, and a review that misses them this time merges it; findings leave an earlier
// attestation of the commit standing; a merged PR without the label is followed and written to, so a later failed release turns
// a completed delivery into a failure; a PR someone merged during review doesn't have its release
// followed; right after ready the newest run is still a draft one and stands for the full check; a matrix job never
// matches the required name, so a passed check waits forever; a PR retargeted during checks is merged into the other branch; a
// delivery withdrawn during checks leaves its status pending for good; a status write failing right after findings closes the
// commit to further reviews with nobody told what they found; labels that only partly come off leave a merged PR stuck as failed
// with no marker for the retry to go by, or leave a review-only PR looking like a full delivery that the retry then merges;
// a change merged without a review, by its agent's exemption, is attested as reviewed, or passes as reviewed when a review
// is asked for while it waits for its check; an out-of-date project toolkit is allowed to merge, an enabled auto-merge
// survives a failed recheck of that toolkit; a lost auto-merge response triggers a second mutation; a lost branch-update
// response ignores the already-synchronized head instead of continuing the same handoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver, fullCheck, waitLive, disableAuto, type DeliveryIO } from "../plugins/delivery/delivery.ts";
import { settings } from "../plugins/delivery/project.ts";
const config = settings({
  repo: "example/app",
  internal: ["docs/**/*.md"],
  review: { points: "AGENTS.md", status: "my-review" },
  health: {
    url: "https://example.invalid/health",
    field: "commit",
    pattern: "(?P<sha>[0-9a-f]{40})",
    require: { ok: true },
  },
});
const pr = () => ({
  number: 1,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: "head", ref: "branch", repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
});
const run = (id = 1, head_sha = "merged", status = "completed", conclusion: string | null = "success") => ({
  id,
  head_sha,
  event: "push",
  status,
  conclusion,
  html_url: `https://example.invalid/${id}`,
});
function fixture() {
  const state: any = {
    pr: pr(),
    main: "main",
    reviewed: 0,
    merges: 0,
    statuses: [] as any[],
    writes: [] as string[],
    checks: 0,
  };
  const io: DeliveryIO = {
    async api(path, body, method) {
      if (body || method) {
        state.writes.push(path);
        if (path.startsWith("statuses/")) {
          state.statuses.push({ path, ...body });
          return {};
        }
      }
      const combined = /^commits\/(.+)\/status/.exec(path);
      if (combined)
        return { statuses: state.statuses.filter((s: any) => s.path === `statuses/${combined[1]}`).reverse() };
      if (path === "pulls/1") return structuredClone(state.pr);
      if (path === "git/ref/heads/main") return { object: { sha: state.main } };
      if (path.startsWith("contents/ops/delivery.json"))
        return { content: Buffer.from(JSON.stringify(config)).toString("base64") };
      if (path.startsWith("actions/workflows/check.yml")) {
        state.checks++;
        return { workflow_runs: [{ ...run(1, "head"), event: "pull_request" }] };
      }
      if (path.startsWith("actions/runs/1/jobs"))
        return { jobs: [{ name: "check", conclusion: "success", status: "completed" }] };
      if (path.startsWith("actions/workflows/ship.yml")) return { workflow_runs: [run()] };
      if (path === "pulls/1/ready") {
        state.pr.draft = false;
        return {};
      }
      if (path.startsWith("issues/1/labels/")) return {};
      throw new Error(`unexpected ${path}`);
    },
    async review() {
      state.reviewed++;
      return [];
    },
    async merge() {
      state.merges++;
      state.pr.merged_at = "now";
      state.pr.merge_commit_sha = "merged";
    },
    async disableAuto() {
      state.pr.auto_merge = null;
    },
    async contains(a, b) {
      return a === b || (a === "main" && b === "head");
    },
    async releaseRequired() {
      return true;
    },
    async live() {
      return { sha: "merged", release: "merged" };
    },
    async wait() {
      throw new Error("still waiting");
    },
  };
  return { io, state };
}
test("review, full check, exact-head attestation, merge, Ship and health all finish", async () => {
  const { io, state } = fixture();
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 1);
  assert.ok(
    state.statuses.some((s: any) => s.path === "statuses/head" && s.context === "my-review" && s.state === "success"),
  );
  assert.ok(state.statuses.some((s: any) => s.context === "delivery" && s.state === "success"));
});
test("a change exempt from review merges with an attestation that says so", async () => {
  const { io, state } = fixture();
  io.review = async () => ({ exempt: "codex" });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  const attested = state.statuses.find((s: any) => s.context === "my-review");
  assert.equal(attested.state, "success");
  assert.match(attested.description, /codex.*免审/);
});
test("a missing label or closed PR launches nothing; forks are refused", async () => {
  for (const change of [{ labels: [] }, { state: "closed" }]) {
    const { io, state } = fixture();
    Object.assign(state.pr, change);
    await deliver("example/app", 1, io);
    assert.equal(state.reviewed, 0);
    assert.equal(state.merges, 0);
  }
  const { io, state } = fixture();
  state.pr.head.repo.full_name = "fork/app";
  await assert.rejects(() => deliver("example/app", 1, io), /本仓库/);
  assert.equal(state.reviewed, 0);
});
test("a PR pushed during review gets no attestation and is never merged", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.pr.head.sha = "someone-else";
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /提交/);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
function syncing(io: DeliveryIO, state: any) {
  const api = io.api;
  const parents = new Map<string, string>();
  io.contains = async (a, b) => {
    for (let commit: string | undefined = b; commit; commit = parents.get(commit)) {
      if (commit === a || commit === `synced-${a}` || (a === "main" && commit === "head")) return true;
    }
    return false;
  };
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") {
      state.writes.push(path);
      parents.set(`synced-${state.main}`, state.pr.head.sha);
      state.pr.head.sha = `synced-${state.main}`;
      return {};
    }
    if (path.startsWith("actions/workflows/check.yml"))
      return { workflow_runs: [{ ...run(1, state.pr.head.sha), event: "pull_request" }] };
    return api(path, body, method);
  };
}
test("a branch-update response lost after acceptance is read back and the new head is reviewed", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  state.pr.head.sha = "behind";
  const api = io.api;
  io.api = async (path, body, method) => {
    const result = await api(path, body, method);
    if (path === "pulls/1/update-branch") throw new Error("connection lost");
    return result;
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.deepEqual(
    state.writes.filter((path: string) => path.endsWith("/update-branch")),
    ["pulls/1/update-branch"],
  );
  assert.equal(latest(state, "my-review").path, "statuses/synced-main");
});
test("main advancing after review syncs in the same run and attests only the re-reviewed head", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  const result = await deliver("example/app", 1, io);
  assert.equal(result.merged, "merged");
  assert.equal(state.reviewed, 2);
  assert.equal(state.merges, 1);
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context === "my-review").map((s: any) => s.path),
    ["statuses/synced-new-main"],
  );
});
test("main that keeps advancing stops after three rounds without merging", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.main = `main-${++state.reviewed}`;
    return [];
  };
  await assert.rejects(() => deliver("example/app", 1, io), /main/);
  assert.equal(state.reviewed, 3);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("the review leaves out what GitHub synced beyond the main it was asked for", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api, contains } = io;
  // main moves on before GitHub applies the update, so the new head holds a main newer than the one read first.
  io.api = async (path, body, method) => {
    if (path === "pulls/1/update-branch") state.main = "newer";
    return api(path, body, method);
  };
  io.contains = async (a, b) => (a === "main" && b === "synced-newer") || contains(a, b);
  const bases: string[] = [];
  io.review = async (_pr, _config, base) => {
    bases.push(base);
    return [];
  };
  state.pr.head.sha = "behind";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(bases, ["newer"]);
});
test("each round follows the settings of the main it reviews against", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path === "contents/ops/delivery.json?ref=new-main") {
      const changed = { ...config, review: { ...config.review, status: "newer-review" } };
      return { content: Buffer.from(JSON.stringify(changed)).toString("base64") };
    }
    return api(path, body, method);
  };
  io.review = async () => {
    if (++state.reviewed === 1) state.main = "new-main";
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(
    state.statuses.filter((s: any) => s.context !== "delivery").map((s: any) => s.context),
    ["newer-review"],
  );
});
test("a delivery withdrawn while main moves on stops without touching the branch again", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  io.review = async () => {
    state.reviewed++;
    state.main = "new-main";
    state.pr.labels = [];
    return [];
  };
  assert.equal((await deliver("example/app", 1, io)).summary, "交付标记已撤回");
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 0);
  assert.ok(!state.writes.includes("pulls/1/update-branch"));
});
test("a PR retargeted during checks is not merged", async () => {
  const { io, state } = fixture();
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/runs/1/jobs")) state.pr.base.ref = "release";
    return api(path, body, method);
  };
  await assert.rejects(() => deliver("example/app", 1, io), /main/);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("a delivery withdrawn during checks does not leave its status pending", async () => {
  const { io, state } = fixture();
  const phases: string[] = [];
  io.report = (phase) => {
    phases.push(phase);
  };
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/runs/1/jobs")) state.pr.labels = [];
    return api(path, body, method);
  };
  assert.equal((await deliver("example/app", 1, io)).summary, "交付标记已撤回");
  assert.equal(state.merges, 0);
  const last = state.statuses.filter((s: any) => s.context === "delivery").at(-1);
  assert.equal(last.state, "success");
  assert.match(last.description, /撤回/);
  assert.match(last.description, /未合并/);
  assert.equal(phases.at(-1), "withdrawn");
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("findings and review-only mode stop before merge", async () => {
  const first = fixture();
  first.io.review = async () => [{ title: "数据会丢", text: "先修复" }];
  const result = await deliver("example/app", 1, first.io);
  assert.equal(result.findings?.length, 1);
  assert.equal(first.state.merges, 0);
  const second = fixture();
  second.state.pr.labels.push({ name: "deliver-review" });
  assert.equal((await deliver("example/app", 1, second.io)).reviewOnly, true);
  assert.equal(second.state.merges, 0);
});
const latest = (state: any, context: string) => state.statuses.filter((s: any) => s.context === context).at(-1);
const problem = [{ title: "数据会丢", text: "先修复" }];
test("another event on a commit with findings ends the run: no second review, no new status", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.reviewed++;
    return problem;
  };
  await deliver("example/app", 1, io);
  const written = state.statuses.length;
  io.review = async () => {
    state.reviewed++;
    return [];
  };
  const again = await deliver("example/app", 1, io);
  assert.equal(state.reviewed, 1);
  assert.equal(state.merges, 0);
  assert.equal(again.findings, undefined);
  assert.equal(state.statuses.length, written);
  assert.equal(latest(state, "delivery").state, "failure");
});
test("a new commit after findings is reviewed and delivered", async () => {
  const { io, state } = fixture();
  io.review = async () => problem;
  await deliver("example/app", 1, io);
  const { api } = io;
  io.api = async (path, body, method) =>
    path.startsWith("actions/workflows/check.yml")
      ? { workflow_runs: [{ ...run(1, "fixed"), event: "pull_request" }] }
      : api(path, body, method);
  io.contains = async () => true;
  io.review = async () => {
    state.reviewed++;
    return [];
  };
  state.pr.head.sha = "fixed";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
});
test("only findings stop the run: another failure on the commit does not", async () => {
  const { io, state } = fixture();
  state.statuses.push({
    path: "statuses/head",
    context: "delivery",
    state: "failure",
    description: "完整检查没有通过",
  });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
});
test("a commit with findings that someone merged by hand still goes on to Ship", async () => {
  const { io, state } = fixture();
  io.review = async () => {
    state.reviewed++;
    return problem;
  };
  await deliver("example/app", 1, io);
  Object.assign(state.pr, { state: "closed", merged_at: "other", merge_commit_sha: "merged" });
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 1);
  assert.equal(latest(state, "delivery").state, "success");
});
test("a status write failing on findings leaves the commit open to a review that reports them", async () => {
  for (const context of ["delivery", "my-review"]) {
    const { io, state } = fixture();
    io.review = async () => problem;
    const { api } = io;
    let failing = true;
    io.api = async (path, body, method) => {
      if (failing && body?.context === context && body.state === "failure") {
        failing = false;
        throw new Error("HTTP 502");
      }
      return api(path, body, method);
    };
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    assert.deepEqual((await deliver("example/app", 1, io)).findings, problem);
    assert.equal(latest(state, "my-review").state, "failure");
    assert.equal(state.merges, 0);
  }
});
test("findings name the commit they were found on", async () => {
  const { io, state } = fixture();
  syncing(io, state);
  state.pr.head.sha = "behind";
  io.review = async () => problem;
  assert.equal((await deliver("example/app", 1, io)).head, "synced-main");
});
test("findings replace an earlier attestation of the same commit", async () => {
  const { io, state } = fixture();
  state.statuses.push({ path: "statuses/head", context: "my-review", state: "success", description: "通过" });
  io.review = async () => problem;
  await deliver("example/app", 1, io);
  assert.equal(latest(state, "my-review").state, "failure");
  assert.equal(latest(state, "delivery").state, "failure");
  assert.equal(state.merges, 0);
});
test("review-only added during checks stops before the merge attestation", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/workflows/check.yml")) state.pr.labels.push({ name: "deliver-review" });
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).reviewOnly, true);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("review-only added while an exempt change waits for its check gets it reviewed, not called reviewed", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/workflows/check.yml"))
      state.pr.labels = [{ name: "deliver" }, { name: "deliver-review" }];
    return api(...args);
  };
  const asked: boolean[] = [];
  io.review = async (pr) => {
    asked.push(pr.labels.some((label: any) => label.name === "deliver-review"));
    return asked.at(-1) ? [] : { exempt: "codex" };
  };
  assert.equal((await deliver("example/app", 1, io)).reviewOnly, true);
  assert.deepEqual(asked, [false, true]);
  assert.equal(state.merges, 0);
});

test("a merge response lost after acceptance is read back, never repeated", async () => {
  const { io, state } = fixture();
  const merge = io.merge;
  io.merge = async (...args) => {
    await merge(...args);
    throw new Error("connection lost");
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
});
test("auto-merge uses the checked head and reads back a lost response before retrying", async () => {
  const { io, state } = fixture();
  const requested: string[] = [];
  io.enableAuto = async (requestedPR) => {
    requested.push(requestedPR.head.sha);
    state.pr.auto_merge = {};
    throw new Error("connection lost");
  };
  io.wait = async () => {
    state.pr.merged_at = "now";
    state.pr.merge_commit_sha = "merged";
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.deepEqual(requested, ["head"]);
  assert.equal(state.merges, 0);
});
test("a toolkit falling behind while auto-merge waits is refused with auto-merge off", async () => {
  const { io, state } = fixture();
  io.enableAuto = async () => {
    state.pr.auto_merge = {};
  };
  io.verifyTools = async () => (state.pr.auto_merge ? "交付工具不是最新版" : null);
  io.wait = async () => {};
  await assert.rejects(() => deliver("example/app", 1, io), /不是最新版/);
  assert.equal(state.pr.auto_merge, null);
  assert.equal(state.merges, 0);
});
test("a release without deployable changes reports both its merge and successful Ship", async () => {
  const { io, state } = fixture();
  const reported: any[] = [];
  io.report = (phase, head, metadata) => {
    reported.push({ phase, head, ...metadata });
  };
  io.live = async () => ({ sha: "live-before", release: "live-before" });
  io.releaseRequired = async () => false;
  assert.match((await deliver("example/app", 1, io)).summary, /无需发布/);
  assert.deepEqual(reported.at(-1), { phase: "docs_only", head: "head", merge: "merged", ship: 1 });
  assert.equal(latest(state, "delivery").state, "success");
});
test("label removal reads back a lost response and does not report a false delivery failure", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") {
      state.pr.labels = [];
      throw new Error("Label does not exist (HTTP 404)");
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 1);
  const second = fixture();
  const before = second.io.api;
  second.io.api = async (...args) => {
    if (args[0] === "issues/1/labels/deliver") throw new Error("permission denied");
    return before(...args);
  };
  await assert.rejects(() => deliver("example/app", 1, second.io), /permission denied/);
});
/** Labels really come off here, except that one of them fails the first time. */
function labelFailsOnce(io: DeliveryIO, state: any, failing: string) {
  const { api } = io;
  let failed = false;
  io.api = async (path, body, method) => {
    const label = /^issues\/1\/labels\/(.+)$/.exec(path)?.[1];
    if (!label) return api(path, body, method);
    if (label === failing && !failed) {
      failed = true;
      throw new Error("HTTP 502");
    }
    state.pr.labels = state.pr.labels.filter((item: any) => item.name !== label);
    return {};
  };
}
test("a merged PR whose labels only partly came off finishes on the retry", async () => {
  for (const failing of ["deliver-attended", "deliver-review", "deliver"]) {
    const { io, state } = fixture();
    state.pr.labels.push({ name: "deliver-attended" }, { name: "deliver-review" });
    Object.assign(state.pr, { state: "closed", merged_at: "before", merge_commit_sha: "merged" });
    labelFailsOnce(io, state, failing);
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    assert.equal((await deliver("example/app", 1, io)).merged, "merged");
    assert.equal(latest(state, "delivery").state, "success");
    assert.deepEqual(state.pr.labels, []);
  }
});
test("a review-only PR whose labels only partly came off is never merged by the retry", async () => {
  for (const failing of ["deliver-attended", "deliver-review", "deliver"]) {
    const { io, state } = fixture();
    state.pr.labels.push({ name: "deliver-attended" }, { name: "deliver-review" });
    labelFailsOnce(io, state, failing);
    await assert.rejects(() => deliver("example/app", 1, io), /HTTP 502/);
    await deliver("example/app", 1, io);
    assert.equal(state.merges, 0);
    assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
  }
});
test("a different client merging during checks is followed without a second merge call", async () => {
  const { io, state } = fixture();
  const api = io.api;
  io.api = async (...args) => {
    if (args[0].startsWith("actions/runs/1/jobs")) {
      state.pr.merged_at = "other";
      state.pr.merge_commit_sha = "merged";
    }
    return api(...args);
  };
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.merges, 0);
});
test("a PR merged during review goes on to Ship", async () => {
  for (const pushed of ["head", "pushed-then-merged"]) {
    const { io, state } = fixture();
    io.review = async () => {
      Object.assign(state.pr, { state: "closed", merged_at: "other", merge_commit_sha: "merged" });
      state.pr.head.sha = pushed;
      return problem;
    };
    const result = await deliver("example/app", 1, io);
    assert.equal(result.merged, "merged");
    assert.equal(state.merges, 0);
    assert.equal(latest(state, "delivery").state, "success");
    assert.ok(!state.statuses.some((s: any) => s.state === "failure"));
  }
});
test("a merged PR resumes directly at Ship without reviewing or merging again", async () => {
  const { io, state } = fixture();
  state.pr.merged_at = "before";
  state.pr.merge_commit_sha = "merged";
  state.pr.state = "closed";
  assert.equal((await deliver("example/app", 1, io)).merged, "merged");
  assert.equal(state.reviewed, 0);
  assert.equal(state.merges, 0);
});
test("a merged PR without the label is left alone: no status, and no later release can fail it", async () => {
  const { io, state } = fixture();
  Object.assign(state.pr, { labels: [], state: "closed", merged_at: "before", merge_commit_sha: "merged" });
  const { api } = io;
  io.api = async (path, body, method) =>
    path.startsWith("actions/workflows/ship.yml")
      ? { workflow_runs: [run(1, "merged", "completed", "failure")] }
      : api(path, body, method);
  assert.equal((await deliver("example/app", 1, io)).summary, "没有待交付的标记");
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.statuses, []);
});
test("only the latest exact-head full workflow and successful required job count", async () => {
  for (const [workflow, job, want] of [
    [run(1, "head"), { name: "draft", conclusion: "success" }, "waiting"],
    [run(1, "old"), { name: "check", conclusion: "success" }, "waiting"],
    [run(1, "head"), { name: "check", conclusion: "skipped" }, "waiting"],
    [run(1, "head", "completed", "failure"), { name: "check", conclusion: "skipped" }, "failed"],
    [run(1, "head"), { name: "check", conclusion: "success", status: "completed" }, "passed"],
  ] as const) {
    const { io } = fixture();
    io.api = async (p) =>
      p.includes("/jobs") ? { jobs: [job] } : { workflow_runs: [{ ...workflow, event: "pull_request" }] };
    assert.equal(await fullCheck("head", config, io), want);
  }
});
/** A draft whose newest run passed in the draft days: `next` is the run that going ready starts, once a wait has gone by. */
function draftWithPassedRun(next?: any) {
  const { io, state } = fixture();
  state.pr.draft = true;
  const runs = [{ ...run(1, "head"), event: "pull_request" }];
  const jobsOf: string[] = [];
  const { api } = io;
  io.api = async (path, body, method) => {
    if (path.startsWith("actions/workflows/check.yml")) return { workflow_runs: runs };
    if (path.startsWith("actions/runs/")) {
      jobsOf.push(path);
      return { jobs: [{ name: "check", conclusion: "success", status: "completed" }] };
    }
    return api(path, body, method);
  };
  if (next) {
    io.wait = async () => {
      if (runs.length === 1) runs.push({ ...next, event: "pull_request" });
    };
  }
  return { io, state, jobsOf };
}
test("a run from the draft days does not stand for the full check once ready", async () => {
  const { io, state } = draftWithPassedRun();
  await assert.rejects(() => deliver("example/app", 1, io), /still waiting/);
  assert.ok(state.writes.includes("pulls/1/ready"));
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("the run that going ready starts decides, passed or failed", async () => {
  const passed = draftWithPassedRun(run(2, "head"));
  assert.equal((await deliver("example/app", 1, passed.io)).merged, "merged");
  assert.deepEqual(passed.jobsOf, ["actions/runs/2/jobs?filter=latest&per_page=100"]);
  const failed = draftWithPassedRun(run(2, "head", "completed", "failure"));
  await assert.rejects(() => deliver("example/app", 1, failed.io), /检查/);
  assert.equal(failed.state.merges, 0);
});
test("a matrix job counts as the required job, every leg of it", async () => {
  const done = { conclusion: "success", status: "completed" };
  const leg = (name: string, fields: object = done) => ({ name, ...fields });
  for (const [jobs, conclusion, want] of [
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)")], "success", "passed"],
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)", { status: "in_progress" })], null, "waiting"],
    [[leg("check (ubuntu-latest)"), leg("check (macos-latest)", { conclusion: "failure" })], "failure", "failed"],
    [[leg("check-lint"), leg("checkout")], "success", "waiting"],
  ] as const) {
    const { io } = fixture();
    const status = conclusion ? "completed" : "in_progress";
    io.api = async (p) =>
      p.includes("/jobs")
        ? { jobs }
        : { workflow_runs: [{ ...run(1, "head", status, conclusion), event: "pull_request" }] };
    assert.equal(await fullCheck("head", config, io), want);
  }
});
test("a cancelled draft-only workflow does not fail the new ready check", async () => {
  const { io } = fixture();
  io.api = async (p) =>
    p.includes("/jobs")
      ? { jobs: [{ name: "draft", conclusion: "cancelled" }] }
      : { workflow_runs: [{ ...run(1, "head", "completed", "cancelled"), event: "pull_request" }] };
  assert.equal(await fullCheck("head", config, io), "waiting");
});
test("failed full checks never attest or merge and existing auto-merge is confirmed off", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  const api = io.api;
  io.api = async (...args) =>
    args[0].startsWith("actions/workflows/check")
      ? { workflow_runs: [{ ...run(1, "head", "completed", "failure"), event: "pull_request" }] }
      : api(...args);
  await assert.rejects(() => deliver("example/app", 1, io), /检查/);
  assert.equal(state.pr.auto_merge, null);
  assert.equal(state.merges, 0);
  assert.ok(!state.statuses.some((s: any) => s.context === "my-review"));
});
test("auto-merge cancellation reads back dropped requests and refuses unknown state", async () => {
  const { io, state } = fixture();
  state.pr.auto_merge = {};
  io.disableAuto = async () => {
    state.pr.auto_merge = null;
    throw new Error("lost");
  };
  await disableAuto(1, io);
  state.pr.auto_merge = {};
  io.disableAuto = async () => {};
  io.wait = async () => {};
  await assert.rejects(() => disableAuto(1, io), /自动合并/);
});
test("auto-merge read-back failure is retried but never treated as disabled", async () => {
  const { io } = fixture();
  let reads = 0;
  io.wait = async () => {};
  io.api = async () => {
    if (++reads === 1) throw new Error("HTTP 502");
    return { auto_merge: null };
  };
  await disableAuto(1, io);
  assert.equal(reads, 2);
  reads = 0;
  io.api = async () => {
    reads++;
    throw new Error("HTTP 502");
  };
  await assert.rejects(() => disableAuto(1, io), /无法确认自动合并/);
  assert.equal(reads, 3);
});
test("live health cannot hide incomplete or failed Ship", async () => {
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ] as const) {
    const { io } = fixture();
    io.api = async () => ({ workflow_runs: [run(1, "merged", status, conclusion)] });
    await assert.rejects(() => waitLive("merged", config, io));
  }
});
test("a completed delivery ignores later queued/failed releases; a successor needs to be live", async () => {
  for (const status of ["queued", "completed"]) {
    const { io } = fixture();
    io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
    io.api = async () => ({ workflow_runs: [run(), run(2, "later", status, "failure")] });
    await waitLive("merged", config, io);
  }
  const { io } = fixture();
  io.contains = async (a, b) => a === b || (a === "merged" && b === "later");
  io.api = async () => ({ workflow_runs: [run(1, "merged", "completed", "cancelled"), run(2, "later")] });
  await assert.rejects(() => waitLive("merged", config, io), /waiting/);
  io.live = async () => ({ sha: "later", release: "later" });
  await waitLive("merged", config, io);
});
