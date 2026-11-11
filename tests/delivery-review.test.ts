// Failure modes: empty/failed reviews pass; findings are unhandled but attested; Codex reads developer
// config or memories, writes files, sees credentials, or executes a PR's programs/settings. Review receives a text snapshot;
// what an octopus merge brings never reaches the reviewer, so it passes unseen; Git escapes a Chinese path so it matches no
// pattern; a root file named like a commit is taken for one and the review can't finish; a Windows npm shim cannot start the reviewer.
// Reviewers by agent: an agent's exemption passes a path reviewed in depth, or a review asked for by label; a change nobody
// declared, or declared by an account the project doesn't trust or for another PR, takes a listed agent's reviewer; a new
// commit or a conflict resolved by hand keeps the declaration of the commit before it, while a clean sync with main loses it;
// the model and depth set for a reviewer never reach Codex; a declaration its account took back still counts; a path Git
// prints in quotes matches no pattern, so an exempt agent's change to a path reviewed in depth merges unreviewed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, codexCommand, declaredAgent, depth, reviewDelivery } from "../plugins/delivery/review.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../plugins/delivery/project.ts";

/** Exercise the production review entry with GitHub replies kept in memory. */
function reviewPullRequest(
  repo: string,
  snapshot: string,
  main: string,
  head: string,
  config: ReturnType<typeof settings>,
  source: { agent: string | null; required: boolean } = { agent: null, required: false },
) {
  const pr = { number: 7, head: { sha: head }, labels: source.required ? [{ name: "deliver-review" }] : [], body: "" };
  const states = new Map<string, any[]>();
  if (source.agent)
    states.set(head, [
      { context: "delivery-agent/7", state: "success", description: source.agent, creator: { id: 1 } },
    ]);
  return reviewDelivery(repo, snapshot, main, pr, config, {
    api: async (path, body, method) => {
      if (path.startsWith("statuses/")) {
        const sha = path.slice("statuses/".length);
        states.set(sha, [{ ...body, creator: { id: 1 } }, ...(states.get(sha) ?? [])]);
        return {};
      }
      assert.equal(path, "pulls/7");
      if (method === "PATCH") pr.body = body.body;
      return structuredClone(pr);
    },
    statuses: (sha) => states.get(sha) ?? [],
    reviewerId: () => 1,
  });
}
test("a review must explicitly report a valid findings list", () => {
  assert.deepEqual(parseReview('{"findings":[]}'), []);
  assert.equal(parseReview('{"findings":[{"title":"错误","text":"这里会丢数据"}]}').length, 1);
  for (const text of ["", "Reviewer failed", "{}", '{"findings":null}', '{"findings":[{}]}'])
    assert.throws(() => parseReview(text));
});
test("Codex ignores developer configuration and only reads the review snapshot", () => {
  const argv = codexCommand("/tmp/snapshot/output.json", "high");
  for (const flag of ["--ignore-user-config", "--ephemeral", "memories", "read-only"]) assert.ok(argv.includes(flag));
  assert.ok(argv.includes('default_permissions="review"'));
  const policy = argv.find((v) => v.startsWith("permissions.review.filesystem="))!;
  assert.match(policy, /workspace_roots/);
  assert.ok(!policy.includes(".codex"));
  assert.ok(!policy.includes(".ssh"));
});
test("review uses main's points and a text-only snapshot; ordinary internal docs skip the reviewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  try {
    const repo = join(root, "repo");
    const snap = join(root, "snapshot");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nmain-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('must not execute');");
    const main = commit();
    const reviewer = join(root, "reviewer.mjs");
    const called = join(root, "called");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';let input='';for await(const b of process.stdin)input+=b;if(!input.includes('main-points'))process.exit(1);fs.writeFileSync(${JSON.stringify(called)},'yes');console.log('{"findings":[]}');`,
    );
    const shim = join(root, "reviewer.cmd");
    if (process.platform === "win32") writeFileSync(shim, '@ECHO off\r\nnode "%~dp0reviewer.mjs" %*\r\n');
    const s = settings({
      repo: "example/app",
      internal: ["docs/*.md"],
      review: { points: "AGENTS.md", command: process.platform === "win32" ? [shim] : [process.execPath, reviewer] },
    });
    writeFileSync(join(repo, "docs/a.md"), "docs");
    const docs = commit();
    assert.deepEqual(await reviewPullRequest(repo, snap, main, docs, s), { docsOnly: true });
    assert.ok(!existsSync(called));
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nbranch-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('changed');");
    const head = commit();
    assert.deepEqual(await reviewPullRequest(repo, snap, main, head, s), []);
    assert.ok(existsSync(called));
    assert.deepEqual(readdirSync(join(snap, "1")), ["changes.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/** A project with one commit on main, and stand-in reviewers that leave a mark when they're called and find nothing. */
function project(review: (stand: (name: string) => string[]) => object = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  const stand = (name: string) => {
    const reviewer = join(root, `${name}.mjs`);
    const mark = JSON.stringify(join(root, name));
    writeFileSync(reviewer, `import fs from 'node:fs';fs.writeFileSync(${mark},'yes');console.log('{"findings":[]}');`);
    return [process.execPath, reviewer];
  };
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  const commit = () => {
    git("add", "-A");
    git(...identity, "commit", "-qm", "test");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nmain-points\n");
  writeFileSync(join(repo, "app.ts"), "export const version = 1;\n");
  const main = commit();
  const config = settings({
    repo: "example/app",
    internal: ["docs/*.md"],
    review: { points: "AGENTS.md", command: stand("called"), ...review(stand) },
  });
  const snapshot = join(root, "snapshot");
  return {
    repo,
    main,
    git,
    identity,
    commit,
    write: (name: string, content: string) => {
      mkdirSync(join(repo, name, ".."), { recursive: true });
      writeFileSync(join(repo, name), content);
    },
    review: (head: string, source?: { agent: string | null; required: boolean }) =>
      reviewPullRequest(repo, snapshot, main, head, config, source),
    changes: () => readFileSync(join(snapshot, "1", "changes.txt"), "utf8"),
    reviewed: (name = "called") => existsSync(join(root, name)),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("a branch with an octopus merge is reported, not reviewed without what the merge brought", async () => {
  using p = project();
  for (const name of ["one", "two"]) {
    p.git("switch", "-q", "-c", name, "main");
    p.write(`${name}.txt`, name);
    p.commit();
  }
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("topic.txt", "topic");
  p.commit();
  p.git(...p.identity, "merge", "-q", "--no-commit", "one", "two");
  p.write("app.ts", "export const version = 'slipped in by the merge';\n");
  const head = p.commit();
  assert.equal(p.git("rev-list", "--parents", "-n1", head).split(" ").length, 4);
  const result = await p.review(head);
  assert.ok("blocked" in result);
  assert.match(result.blocked, /章鱼合并/);
  assert.ok(!p.reviewed());
});
test("an ordinary merge still goes to the reviewer", async () => {
  using p = project();
  p.git("switch", "-q", "-c", "one", "main");
  p.write("one.txt", "one");
  p.commit();
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("two.txt", "two");
  p.commit();
  p.git(...p.identity, "merge", "-q", "--no-edit", "one");
  assert.deepEqual(await p.review(p.git("rev-parse", "HEAD")), []);
  assert.ok(p.reviewed());
});
test("a Chinese path still matches the settings", async () => {
  using p = project();
  p.write("docs/说明.md", "docs");
  assert.deepEqual(await p.review(p.commit()), { docsOnly: true });
  assert.ok(!p.reviewed());
});
test("a root file named like a commit is reviewed as a file", async () => {
  using p = project();
  p.write("a".repeat(40), "named like a commit");
  assert.deepEqual(await p.review(p.commit()), []);
  assert.ok(p.reviewed());
  assert.match(p.changes(), /named like a commit/);
});
test("an exempt agent's change skips the reviewer, unless a review is asked for or it touches a path reviewed in depth", async () => {
  const exempt = () => ({ agents: { codex: null }, trusted: [1], xhigh: ["ops/*"] });
  using p = project(exempt);
  p.write("app.ts", "export const version = 2;\n");
  const head = p.commit();
  assert.deepEqual(await p.review(head, { agent: "codex", required: false }), { exempt: "codex" });
  assert.ok(!p.reviewed());
  assert.deepEqual(await p.review(head, { agent: "codex", required: true }), []);
  assert.ok(p.reviewed());
  using q = project(exempt);
  q.write("ops/deploy.sh", "echo deploy\n");
  assert.deepEqual(await q.review(q.commit(), { agent: "codex", required: false }), []);
  assert.ok(q.reviewed());
});
test("a change goes to the reviewer listed for its agent; one nobody declared or by an agent not listed, to the default", async () => {
  const listed = (stand: (name: string) => string[]) => ({
    agents: { claude: { command: stand("for-claude") } },
    trusted: [1],
  });
  using p = project(listed);
  p.write("app.ts", "export const version = 2;\n");
  const head = p.commit();
  await p.review(head, { agent: "claude", required: false });
  assert.ok(p.reviewed("for-claude") && !p.reviewed());
  await p.review(head, { agent: "gemini", required: false });
  assert.ok(p.reviewed());
  using q = project(listed);
  q.write("app.ts", "export const version = 2;\n");
  await q.review(q.commit());
  assert.ok(q.reviewed() && !q.reviewed("for-claude"));
});
test("the model and depth set for a reviewer reach Codex, and a path reviewed in depth raises the depth", () => {
  const argv = codexCommand("/tmp/snapshot/output.json", "xhigh", "another-model");
  assert.equal(argv[argv.indexOf("-m") + 1], "another-model");
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'));
  assert.equal(depth(undefined, false), "high");
  assert.equal(depth("medium", false), "medium");
  assert.equal(depth("medium", true), "xhigh");
  assert.equal(depth("max", true), "max");
});
test("only a trusted account's declaration for this PR names the agent, on this commit or the one a clean sync with main left it on", () => {
  using p = project();
  const status = (change = {}) => ({
    context: "delivery-agent/7",
    state: "success",
    description: "codex",
    creator: { id: 1 },
    ...change,
  });
  const on =
    (commit: string, entry = status()) =>
    (sha: string) =>
      sha === commit ? [entry] : [];
  const agent = (head: string, statuses: (sha: string) => any[], main = p.main) =>
    declaredAgent(p.repo, main, head, 7, [1], statuses);
  p.git("switch", "-q", "-c", "side", "main");
  p.write("side.txt", "side");
  p.commit();
  p.git("switch", "-q", "-c", "topic", "main");
  p.write("app.ts", "export const version = 2;\n");
  const own = p.commit();
  assert.equal(agent(own, on(own)), "codex");
  for (const wrong of [
    { creator: { id: 2 } },
    { context: "delivery-agent/8" },
    { state: "pending" },
    { description: "Not A Name" },
  ])
    assert.equal(agent(own, on(own, status(wrong))), null);
  const tookBack = (sha: string) => (sha === own ? [status({ state: "failure" }), status()] : []);
  assert.equal(agent(own, tookBack), null);
  p.write("more.txt", "more");
  const next = p.commit();
  assert.equal(agent(next, on(own)), null);
  p.git(...p.identity, "merge", "-q", "--no-edit", "side");
  assert.equal(agent(p.git("rev-parse", "HEAD"), on(next)), null);
  p.git("reset", "-q", "--hard", next);
  p.git("switch", "-q", "main");
  p.write("other.txt", "other");
  const moved = p.commit();
  p.git("switch", "-q", "topic");
  p.git(...p.identity, "merge", "-q", "--no-edit", "main");
  const synced = p.git("rev-parse", "HEAD");
  assert.equal(agent(synced, on(next), moved), "codex");
  const tookBackAfter = (sha: string) => (sha === synced ? [status({ state: "failure" })] : on(next)(sha));
  assert.equal(agent(synced, tookBackAfter, moved), null);
  p.git("reset", "-q", "--hard", next);
  p.git("switch", "-q", "main");
  p.write("app.ts", "export const version = 3;\n");
  const clashing = p.commit();
  p.git("switch", "-q", "topic");
  assert.throws(() => p.git(...p.identity, "merge", "-q", "--no-edit", "main"));
  p.write("app.ts", "export const version = 4;\n");
  assert.equal(agent(p.commit(), on(next), clashing), null);
});
test(
  "a path Git prints in quotes is still one the project reviews in depth",
  { skip: process.platform === "win32" && "Windows has no file names with a quote in them" },
  async () => {
    using p = project(() => ({ agents: { codex: null }, trusted: [1], xhigh: ["ops/*"] }));
    p.write('ops/de"ploy.sh', "echo deploy\n");
    assert.deepEqual(await p.review(p.commit(), { agent: "codex", required: false }), []);
    assert.ok(p.reviewed());
  },
);
