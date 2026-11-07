// Failure modes: empty/failed reviews pass; findings are unhandled but attested; Codex reads developer
// config or memories, writes files, sees credentials, or executes a PR's programs/settings. Review receives a text snapshot;
// what an octopus merge brings never reaches the reviewer, so it passes unseen; Git escapes a Chinese path so it matches no
// pattern; a root file named like a commit is taken for one and the review can't finish; a Windows npm shim cannot start the reviewer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, codexCommand, reviewSnapshot } from "../plugins/delivery/review.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../plugins/delivery/project.ts";
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
    assert.deepEqual(await reviewSnapshot(repo, snap, main, docs, s), []);
    assert.ok(!existsSync(called));
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nbranch-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('changed');");
    const head = commit();
    assert.deepEqual(await reviewSnapshot(repo, snap, main, head, s), []);
    assert.ok(existsSync(called));
    assert.deepEqual(readdirSync(snap), ["changes.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
/** A project with one commit on main, and a stand-in reviewer that leaves a mark when it's called and finds nothing. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  const repo = join(root, "repo");
  const called = join(root, "called");
  const reviewer = join(root, "reviewer.mjs");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(
    reviewer,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(called)},'yes');console.log('{"findings":[]}');`,
  );
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
    review: { points: "AGENTS.md", command: [process.execPath, reviewer] },
  });
  const snapshot = join(root, "snapshot");
  return {
    repo,
    main,
    git,
    identity,
    commit,
    write: (name: string, content: string) => writeFileSync(join(repo, name), content),
    review: (head: string) => reviewSnapshot(repo, snapshot, main, head, config),
    changes: () => readFileSync(join(snapshot, "changes.txt"), "utf8"),
    reviewed: () => existsSync(called),
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
  const findings = await p.review(head);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /章鱼合并/);
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
  assert.deepEqual(await p.review(p.commit()), []);
  assert.ok(!p.reviewed());
});
test("a root file named like a commit is reviewed as a file", async () => {
  using p = project();
  p.write("a".repeat(40), "named like a commit");
  assert.deepEqual(await p.review(p.commit()), []);
  assert.ok(p.reviewed());
  assert.match(p.changes(), /named like a commit/);
});
