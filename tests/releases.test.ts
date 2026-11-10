// What someone installing or updating gets. Failure cases: they get main as it stands, checked or not, instead of the newest
// release; version numbers sort as text, so v1.9.0 beats v1.10.0; a tag that isn't a release is taken for one; an install
// made before releases, sitting on main, is left there; a copy from a repository given by hand is sent to tags it was never
// asked to follow, or run over with the installer and left unable to update; a failed look at the releases counts as being
// up to date or as there being none, which would install main, or an update with nothing new restarts the service; installing says
// something about detached HEADs; a copy that fetched only its own tag can't say which release it is. No network: git's own insteadOf points the public address at a repository made here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { updateCode } from "../cli/update.ts";
import { releaseOf } from "../host/version.ts";

const PUBLISHED = "https://github.com/KKKKhazix/agent-autoloop.git";
const script = join(import.meta.dirname, "..", "install.sh");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-releases-")));
after(() => rmSync(dir, { recursive: true, force: true }));

const original = join(dir, "published");
const gitConfig = join(dir, "gitconfig");
writeFileSync(
  gitConfig,
  `[url "file://${original}"]\n\tinsteadOf = ${PUBLISHED}\n[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** What's published: a program that only says it was run, a commit for each version, and main ahead of them all. */
mkdirSync(join(original, "bin"), { recursive: true });
git(original, "init", "-q");
function publish(words: string, tag?: string) {
  const program = join(original, "bin", "agent-autoloop.ts");
  writeFileSync(program, `#!/bin/sh\necho "${words} $*" >> "$RAN"\n`);
  chmodSync(program, 0o755);
  git(original, "add", "-A");
  git(original, "commit", "-q", "-m", words);
  if (tag) git(original, "tag", tag);
  return git(original, "rev-parse", "HEAD");
}
const versions: Record<string, string> = {};
for (const tag of ["v1.2.0", "v1.9.0", "v1.10.0"]) versions[tag] = publish(tag, tag);
publish("a test tag", "v2.0.0-rc1");
publish("a non-release tag", "local-backup");
const tip = publish("main, not released");

let copies = 0;
const copy = (...args: string[]) => {
  const target = join(dir, `copy-${++copies}`);
  git(dir, "clone", "-q", "--depth", "1", ...args, target);
  return target;
};
const at = (root: string) => git(root, "rev-parse", "HEAD");

test("an update goes to the newest release, by version number, not to main", () => {
  const root = copy("--branch", "v1.2.0", PUBLISHED);
  const done = updateCode(root);
  assert.deepEqual(done, { changed: true, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
  assert.equal(releaseOf(root), "v1.10.0");
});

test("with nothing newer it says so, and nothing has changed", () => {
  const root = copy("--branch", "v1.10.0", PUBLISHED);
  assert.deepEqual(updateCode(root), { changed: false, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
  assert.equal(releaseOf(root), "v1.10.0");
});

test("an install made before releases leaves main for the newest release", () => {
  const root = copy(PUBLISHED);
  assert.equal(at(root), tip);
  assert.deepEqual(updateCode(root), { changed: true, to: "v1.10.0" });
  assert.equal(at(root), versions["v1.10.0"]);
});

test("a copy from a repository given by hand follows that repository", () => {
  const root = copy(`file://${original}`);
  const before = at(root);
  assert.equal(before, tip);
  const moreRecent = publish("newer on main");
  assert.deepEqual(updateCode(root), { changed: true, to: null });
  assert.equal(at(root), moreRecent);
  assert.deepEqual(updateCode(root), { changed: false, to: null });
});

test("a failed look at the releases is a failure, not news that nothing changed", () => {
  const root = copy("--branch", "v1.9.0", PUBLISHED);
  git(root, "config", "remote.origin.url", PUBLISHED);
  writeFileSync(gitConfig, readFileSync(gitConfig, "utf8").replace(`file://${original}`, `file://${dir}/nowhere`));
  try {
    assert.throws(() => updateCode(root));
    assert.equal(at(root), versions["v1.9.0"]);
  } finally {
    writeFileSync(gitConfig, readFileSync(gitConfig, "utf8").replace(`file://${dir}/nowhere`, `file://${original}`));
  }
});

/**
 * install.sh as someone runs it: its `git` is real, and the program it sets up only says it was run. PATH is folders of this
 * test's own and nothing else, because the script puts its command in the first one it can write to.
 */
function runInstaller(person: string, env: NodeJS.ProcessEnv = {}) {
  const ran = join(person, "ran");
  const bin = join(person, "bin");
  const tools = join(person, "tools");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const found = (name: string) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  for (const name of ["git", "node", "mkdir", "ln", "cat", "chmod", "sed", "sort", "tail"]) {
    if (!existsSync(join(tools, name))) symlinkSync(found(name), join(tools, name));
  }
  return spawnSync("/bin/sh", [script, "--no-service"], {
    env: {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: person,
      PATH: `${bin}:${tools}`,
      RAN: ran,
      AGENT_AUTOLOOP_HOME: join(person, "hub"),
      ...env,
    },
    encoding: "utf8",
  });
}

function install(person: string, env: NodeJS.ProcessEnv = {}) {
  const done = runInstaller(person, env);
  assert.equal(done.status, 0, done.stderr);
  return {
    app: join(person, "hub", "app"),
    said: () => readFileSync(join(person, "ran"), "utf8"),
    out: done.stdout,
    err: done.stderr,
  };
}

test("the installer installs the newest release, and running it again moves on to a newer one", () => {
  const person = join(dir, "someone");
  mkdirSync(person);
  const first = install(person);
  assert.equal(at(first.app), versions["v1.10.0"]);
  assert.match(first.said(), /^v1\.10\.0 init --no-service/);
  assert.doesNotMatch(first.out + first.err, /detached/i);

  writeFileSync(join(person, "hub", "config.json"), "{}");
  const newer = publish("v1.11.0", "v1.11.0");
  const again = install(person);
  assert.equal(at(again.app), newer);
  assert.match(again.out, /更新好了/);
  assert.equal(existsSync(join(again.app, ".git")), true);
});

test("a repository given to the installer by hand is installed as it stands", () => {
  const person = join(dir, "by-hand");
  mkdirSync(person);
  const expected = at(original);
  const it = install(person, { AGENT_AUTOLOOP_REPO: `file://${original}` });
  assert.equal(at(it.app), expected);
});

test("the installer stops when it can't look at the releases, rather than installing main", () => {
  const person = join(dir, "no-look");
  mkdirSync(join(person, "tools"), { recursive: true });
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const git = join(person, "tools", "git");
  writeFileSync(git, `#!/bin/sh\n[ "$1" = ls-remote ] && exit 128\nexec "${real}" "$@"\n`);
  chmodSync(git, 0o755);
  const done = runInstaller(person);
  assert.notEqual(done.status, 0);
  assert.equal(existsSync(join(person, "hub", "app")), false);
});

test("the installer run over a copy from elsewhere leaves it following there, and update goes on working", () => {
  const person = join(dir, "over-by-hand");
  mkdirSync(person);
  const it = install(person, { AGENT_AUTOLOOP_REPO: `file://${original}` });
  writeFileSync(join(person, "hub", "config.json"), "{}");
  const newer = publish("newer still, on main");
  install(person);
  assert.equal(at(it.app), newer, "not sent to a release");
  assert.equal(git(it.app, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.deepEqual(updateCode(it.app), { changed: false, to: null });
});
