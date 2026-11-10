// Failure modes: runtime Markdown, executable/symlink documents, renames, an unknown/divergent live
// commit or an earlier unreleased code change suppresses Ship; PR settings replace main's settings; HTTP health escapes
// the explicit localhost-only test switch. Git objects are read without a checkout, hooks, filters or project imports.
// Reviewers by agent are listed with no account trusted to declare one, or a model or depth becomes a command option.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { settings, matches, releaseRequired, readMainSettings, liveRelease } from "../plugins/delivery/project.ts";
const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (name: string, text: string) => {
  mkdirSync(join(root, name, ".."), { recursive: true });
  writeFileSync(join(root, name), text);
};
const commit = () => {
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
  return git("rev-parse", "HEAD");
};
git("init", "-q", "-b", "main");
write("app.ts", "original");
write("docs/a.md", "original");
const config = {
  repo: "example/app",
  internal: ["docs/**/*.md"],
  review: { points: "AGENTS.md", status: "agent-review" },
};
test("the default review status is neutral and projects can override it", () => {
  assert.equal(settings({ ...config, review: { points: "AGENTS.md" } }).review.status, "agent-review");
  assert.equal(
    settings({ ...config, review: { points: "AGENTS.md", status: "project-review" } }).review.status,
    "project-review",
  );
});
test("reviewers by agent need trusted accounts, and a model or depth that can't be read as an option", () => {
  const review = (extra: object) => settings({ ...config, review: { points: "AGENTS.md", ...extra } }).review;
  assert.deepEqual(review({}).agents, {});
  const agents = { codex: null, claude: { model: "gpt-6.1-sol", effort: "xhigh" }, gemini: { command: ["reviewer"] } };
  assert.deepEqual(review({ trusted: [1], agents }).agents, agents);
  for (const wrong of [
    { agents: { codex: null } },
    { trusted: [1.5], agents: { codex: null } },
    { trusted: [1], agents: { Codex: null } },
    { trusted: [1], agents: { claude: { model: "--unsafe" } } },
    { trusted: [1], agents: { claude: { effort: "x high" } } },
    { trusted: [1], agents: { claude: { model: "gpt-6.1-sol", command: ["reviewer"] } } },
    { trusted: [1], agents: { claude: ["codex", "codex"] } },
    { trusted: [1], agents: { claude: { reviewers: 2 } } },
  ])
    assert.throws(() => review(wrong));
});
write("ops/delivery.json", JSON.stringify(config));
const base = commit();
git("update-ref", "refs/remotes/origin/main", base);
test("release scope compares the entire healthy-live range and both sides of renames", () => {
  write("docs/a.md", "docs");
  const docs = commit();
  assert.equal(releaseRequired(root, base, docs, config.internal), false);
  write("app.ts", "code");
  const code = commit();
  write("docs/a.md", "more docs");
  const head = commit();
  assert.equal(releaseRequired(root, code, head, config.internal), false);
  assert.equal(releaseRequired(root, base, head, config.internal), true);
  git("reset", "--hard", base);
  git("mv", "app.ts", "docs/app.md");
  assert.equal(releaseRequired(root, base, commit(), config.internal), true);
});
test("executable or symlink documents and unknown history always need release", () => {
  for (const mode of ["executable", "symlink"]) {
    git("reset", "--hard", base);
    if (mode === "executable") {
      chmodSync(join(root, "docs/a.md"), 0o755);
      git("update-index", "--chmod=+x", "docs/a.md");
    } else {
      rmSync(join(root, "docs/a.md"));
      symlinkSync("../app.ts", join(root, "docs/a.md"));
    }
    assert.equal(releaseRequired(root, base, commit(), config.internal), true);
  }
  assert.equal(releaseRequired(root, "0".repeat(40), base, config.internal), true);
  git("reset", "--hard", base);
  write("docs/a.md", "left");
  const left = commit();
  git("reset", "--hard", base);
  write("docs/a.md", "right");
  assert.equal(releaseRequired(root, left, commit(), config.internal), true);
});
test("only main provides configuration, with exact path patterns and explicit local health opt-in", () => {
  write("ops/delivery.json", JSON.stringify({ ...config, internal: ["**/*"] }));
  assert.deepEqual(readMainSettings(root).internal, config.internal);
  assert.ok(matches("docs/a/b.md", ["docs/**/*.md"]));
  assert.ok(!matches("docs/a/b.md", ["docs/*.md"]));
  const health = {
    url: "http://127.0.0.1:34567/health",
    field: "commit",
    pattern: "(?P<sha>[0-9a-f]{40})",
    require: { ok: true },
  };
  assert.throws(() => settings({ ...config, health }));
  assert.ok(settings({ ...config, health }, true));
  assert.throws(() => settings({ ...config, health: { ...health, url: "http://localhost:1234" } }, true));
  assert.throws(() => settings({ ...config, health: { ...health, url: "http://192.168.1.2" } }, true));
  assert.throws(() => settings({ ...config, review: { ...config.review, command: "sh bad" } }));
});
test("unhealthy, redirected or malformed health cannot authorize skipping a release", async () => {
  const s = settings({
    ...config,
    health: {
      url: "https://example.invalid/health",
      require: { ok: true },
      field: "release",
      pattern: "release-(?P<sha>[0-9a-f]{40})",
    },
  });
  const sha = "a".repeat(40);
  assert.deepEqual(await liveRelease(s, async () => Response.json({ ok: true, release: `release-${sha}` })), {
    sha,
    release: `release-${sha}`,
  });
  for (const response of [
    Response.json({ ok: false, release: `release-${sha}` }),
    new Response("bad"),
    Response.json({ ok: true, release: "wrong" }),
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }),
  ])
    assert.equal(await liveRelease(s, async () => response), null);
});
