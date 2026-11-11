// Failure modes: an owner question with backticks in its title or text cuts the receipt short; a short commit from the health
// check can't be fetched, so every change needs a release and a docs-only PR never finishes; a failure on an ordinary issue is
// covered up by the 404 from looking it up as a PR; one item whose label record can't be read fails the whole poll; a failed
// round writes its error over the delivery status, so the next one forgets the commit had findings and reviews it again;
// an obsolete Ship run requires a remote compare that fails, hiding the successful release of this merge; a manual retry
// reuses its scratch folder and fails because the origin already exists; closing a labelled PR leaves its status pending.
// Nothing here reaches GitHub: `gh` is a stand-in first on PATH, and the Git remote is a local folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { waitLive } from "../plugins/delivery/delivery.ts";
import { createIO, github, isGitHubHiccup, type DeliveryOptions } from "../plugins/delivery/github.ts";
import { poll } from "../plugins/delivery/poll.ts";
import { settings } from "../plugins/delivery/project.ts";
import { run } from "../plugins/delivery/run.ts";
import { readMessage } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-run-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
const routes = join(root, "routes.json");
const calls = join(root, "calls.txt");
const statuses = join(root, "statuses.txt");
const bodies = join(root, "bodies.json");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { FAKE_GH_CALLS, FAKE_GH_ROUTES, FAKE_GH_STATUSES, FAKE_GH_BODIES } = process.env;
const args = process.argv.slice(2);
appendFileSync(FAKE_GH_CALLS, args.join(" ") + "\\n");
const answer = JSON.parse(readFileSync(FAKE_GH_ROUTES, "utf8"))[args[1]];
const written = /\\/statuses\\/(\\w+)$/.exec(args[1]);
const asked = /\\/commits\\/(\\w+)\\/status\\?/.exec(args[1]);
const listing = /\\/commits\\/(\\w+)\\/statuses\\?/.exec(args[1]);
const pr = /\\/pulls\\/\\d+$/.test(args[1]);
if (args[1] === "user") { console.log("42"); process.exit(0); }
if (answer?.fail || (answer === undefined && !written && !asked && !listing)) {
  console.error(answer?.fail ?? "gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (written) {
  appendFileSync(FAKE_GH_STATUSES, JSON.stringify({ sha: written[1], creator: { id: 42 }, ...JSON.parse(readFileSync(0, "utf8")) }) + "\\n");
  console.log("{}");
} else if (asked) {
  const lines = readFileSync(FAKE_GH_STATUSES, "utf8").split("\\n").filter(Boolean);
  const newestFirst = lines.map((line) => JSON.parse(line)).filter((item) => item.sha === asked[1]).reverse();
  console.log(JSON.stringify({ statuses: newestFirst.filter((item, at) => newestFirst.findIndex((other) => other.context === item.context) === at) }));
} else if (listing && answer === undefined) {
  const rows = readFileSync(FAKE_GH_STATUSES, "utf8").split("\\n").filter(Boolean).map(JSON.parse);
  console.log(JSON.stringify([rows.filter((item) => item.sha === listing[1]).reverse()]));
} else if (pr) {
  const bodies = JSON.parse(readFileSync(FAKE_GH_BODIES, "utf8"));
  if (args.includes("PATCH")) {
    bodies[args[1]] = JSON.parse(readFileSync(0, "utf8")).body;
    writeFileSync(FAKE_GH_BODIES, JSON.stringify(bodies));
  }
  console.log(JSON.stringify({ ...answer, body: bodies[args[1]] ?? answer.body }));
} else {
  console.log(JSON.stringify(args.includes("--slurp") ? [answer] : answer));
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_ROUTES = routes;
process.env.FAKE_GH_CALLS = calls;
process.env.FAKE_GH_STATUSES = statuses;
process.env.FAKE_GH_BODIES = bodies;
writeFileSync(statuses, "");
writeFileSync(bodies, "{}");
/** What the stand-in answers from here on, by the path after `gh api`, and a clean list of what it was asked. */
const answers = (table: object) => {
  writeFileSync(routes, JSON.stringify(table));
  writeFileSync(calls, "");
};
const issue = (number: number, fields: object = {}) => ({
  number,
  state: "open",
  title: "需要决定",
  body: "请决定",
  html_url: `https://github.com/example/app/issues/${number}`,
  labels: [{ name: "ask-owner" }],
  ...fields,
});
const about = (number: number) => ({ events: [{ subject: `example/app#${number}` }] });

test("an owner question with backticks reaches the hub whole", async () => {
  const title = "```标题";
  answers({ "repos/example/app/issues/5": issue(5, { title, body: "还有\n```\n没收尾的代码块" }) });
  const { problem, receipt } = readMessage(await run("example/app", about(5)));
  assert.equal(problem, undefined);
  const [card] = (receipt as any).ask;
  assert.equal(card.title, title);
  assert.match(card.text, /没收尾的代码块/);
});

const remote = join(root, "remote");
const gitConfig = join(root, "gitconfig");
writeFileSync(
  gitConfig,
  `[url "file://${remote}"]\n\tinsteadOf = https://github.com/example/app.git\n[user]\n\tname = t\n\temail = t@t\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: remote, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function publish(name: string, words: string) {
  writeFileSync(join(remote, name), words);
  git("add", "-A");
  git("commit", "-q", "-m", words);
  return git("rev-parse", "HEAD");
}
mkdirSync(join(remote, "docs"), { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(remote, "app.ts"), "1");
writeFileSync(join(remote, "AGENTS.md"), "## 审查要点\n要点\n");
const live = publish("docs/a.md", "first");
const docsOnly = publish("docs/a.md", "second");
const code = publish("app.ts", "2");
const internal = ["docs/*.md"];
const ioIn = (name: string, options?: DeliveryOptions) => {
  const folder = join(root, name);
  mkdirSync(folder);
  return createIO("example/app", folder, options);
};

test("a short commit from the health check is made full before comparing", async () => {
  const short = live.slice(0, 7);
  answers({ [`repos/example/app/commits/${short}`]: { sha: live } });
  const io = ioIn("short");
  assert.equal(await io.releaseRequired(short, docsOnly, internal), false);
  assert.equal(await io.releaseRequired(short, code, internal), true);
});
test("a full commit is compared as it is, without asking GitHub", async () => {
  answers({});
  const io = ioIn("full");
  assert.equal(await io.releaseRequired(live, docsOnly, internal), false);
  assert.ok(!readFileSync(calls, "utf8").includes("commits/"));
});
test("a short commit GitHub doesn't know means a release", async () => {
  answers({});
  assert.equal(await ioIn("unknown").releaseRequired("abcdef0", docsOnly, internal), true);
});

test("Ship uses local ancestry for older runs and the short healthy version", async () => {
  answers({
    "repos/example/app/actions/workflows/ship.yml/runs?branch=main&event=push&per_page=100": {
      workflow_runs: [
        { id: 2, event: "push", head_sha: docsOnly, status: "completed", conclusion: "success" },
        { id: 1, event: "push", head_sha: live, status: "completed", conclusion: "success" },
      ],
    },
    [`repos/example/app/compare/${docsOnly}...${live}`]: { fail: "gh: HTTP 502" },
  });
  const io = ioIn("ship-history");
  io.live = async () => ({ sha: live.slice(0, 7), release: "live-before" });
  const config = settings({
    repo: "example/app",
    internal,
    review: { points: "AGENTS.md" },
    health: { url: "https://example.invalid/health", field: "commit", pattern: "(?<sha>[0-9a-f]{7,40})" },
  });
  assert.deepEqual(await waitLive(docsOnly, config, io), { phase: "docs_only", ship: 2, release: "live-before" });
  assert.doesNotMatch(readFileSync(calls, "utf8"), /compare\/|commits\//);
});

test("a manual retry can fetch main in its existing scratch folder", async () => {
  const folder = join(root, "retry-objects");
  const first = createIO("example/app", folder);
  await first.prepareShip?.();
  const retry = createIO("example/app", folder);
  await retry.prepareShip?.();
  assert.equal(await retry.contains(live, docsOnly), true);
});

test("the toolkit trusts only a commit on main containing its latest tool changes", async () => {
  const installedFile = `repos/example/app/contents/ops/delivery/kit.json?ref=${code}`;
  const checks = (installed: string, onMain: string, current: string) => ({
    [installedFile]: { content: Buffer.from(JSON.stringify({ kit: installed })).toString("base64") },
    "repos/example/tools/git/ref/heads/main": { object: { sha: code } },
    [`repos/example/tools/commits?sha=${code}&path=delivery&per_page=1`]: [{ sha: docsOnly }],
    [`repos/example/tools/compare/${installed}...${code}`]: { status: onMain },
    [`repos/example/tools/compare/${docsOnly}...${installed}`]: { status: current },
  });
  const io = ioIn("kit", { toolkit: "example/tools" });
  answers(checks(docsOnly, "ahead", "identical"));
  assert.equal(await io.verifyTools?.(code), null);
  answers(checks(live, "ahead", "behind"));
  assert.match((await io.verifyTools?.(code)) ?? "", /不是 main 上的最新版/);
  answers(checks(live, "diverged", "ahead"));
  assert.match((await io.verifyTools?.(code)) ?? "", /不是 main 上的最新版/);
  assert.equal(ioIn("own-kit", { toolkit: "example/app" }).verifyTools, undefined);
});

test("GitHub's own 5xx and GraphQL failures keep their classification through the CLI", async () => {
  const api = github("example/app");
  for (const failure of ["gh: something failed (HTTP 502)", "Something went wrong while executing your query"]) {
    answers({ "repos/example/app/pulls/1": { fail: failure } });
    await assert.rejects(() => api("pulls/1"), isGitHubHiccup);
  }
  answers({ "repos/example/app/pulls/1": { fail: "secondary rate limit (HTTP 403)" } });
  await assert.rejects(
    () => api("pulls/1"),
    (error) => !isGitHubHiccup(error),
  );
});

test("a failure on an ordinary issue is reported as it happened", async () => {
  answers({
    "repos/example/app/issues/5": issue(5),
    "repos/example/app/issues/5/labels/ask-owner": { fail: "permission denied" },
  });
  const answered = { ...about(5), answers: [{ text: "已处理" }] };
  await assert.rejects(() => run("example/app", answered), /permission denied/);
  assert.ok(!readFileSync(calls, "utf8").includes("pulls/5"));
});
test("a failed delivery still marks the commit it stopped on", async () => {
  const fork = { number: 7, state: "open", labels: [{ name: "deliver" }], base: { ref: "main" } };
  const pr = { ...fork, head: { sha: "abc", repo: { full_name: "fork/app" } } };
  answers({
    "repos/example/app/issues/7": { ...fork, pull_request: {} },
    "repos/example/app/pulls/7": pr,
    "repos/example/app/statuses/abc": {},
  });
  await assert.rejects(() => run("example/app", about(7)), /本仓库/);
  assert.match(readFileSync(calls, "utf8"), /statuses\/abc --method POST/);
});
test("an item whose label record can't be read does not hold up the others", async () => {
  answers({
    "repos/example/app/issues?state=all&labels=deliver&per_page=100": [
      { number: 1, pull_request: {} },
      { number: 2, pull_request: {} },
    ],
    "repos/example/app/issues?state=all&labels=ask-owner&per_page=100": [],
    "repos/example/app/issues/1/events?per_page=100": [],
    "repos/example/app/issues/2/events?per_page=100": [{ event: "labeled", id: 9, label: { name: "deliver" } }],
    "repos/example/app/pulls/1": { state: "open", head: { sha: "aaa" } },
    "repos/example/app/pulls/2": { state: "open", head: { sha: "bbb" } },
  });
  const events = await poll("example/app");
  assert.deepEqual(
    events.map((event) => event.id),
    ["example/app#1:0:aaa", "example/app#2:9:bbb"],
  );
});

const reviewer = join(root, "reviewer.mjs");
const plan = join(root, "plan.json");
const reviews = join(root, "reviews.txt");
writeFileSync(
  reviewer,
  `import fs from "node:fs";
for await (const _ of process.stdin);
fs.appendFileSync(${JSON.stringify(reviews)}, "x");
const { findings } = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
console.log(JSON.stringify({ findings }));
`,
);
/** What the stand-in reviewer finds. */
const reviewFinds = (findings: object[]) => writeFileSync(plan, JSON.stringify({ findings }));
const timesReviewed = () => readFileSync(reviews, "utf8").length;
const lastStatus = (context: string) =>
  readFileSync(statuses, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => item.context === context)
    .at(-1);
const startOver = () => {
  writeFileSync(statuses, "");
  writeFileSync(reviews, "");
  writeFileSync(bodies, "{}");
};
const settingsPath = `repos/example/app/contents/ops/delivery.json?ref=${live}`;
const settingsFile = {
  content: Buffer.from(
    JSON.stringify({
      repo: "example/app",
      internal,
      review: { points: "AGENTS.md", status: "my-review", command: [process.execPath, reviewer] },
      health: { url: "http://127.0.0.1:1/health", field: "commit", pattern: "(?P<sha>[0-9a-f]{40})" },
    }),
  ).toString("base64"),
};
const openPr = {
  number: 8,
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: null,
  auto_merge: null,
  labels: [{ name: "deliver" }],
  head: { sha: code, repo: { full_name: "example/app" } },
  base: { ref: "main" },
  user: { login: "owner" },
};
/** PR 8 of the local remote, on its way to main at the first commit. */
const delivering = (pr: object) => ({
  "repos/example/app/issues/8": { number: 8, labels: [{ name: "deliver" }], pull_request: {} },
  "repos/example/app/pulls/8": pr,
  "repos/example/app/git/ref/heads/main": { object: { sha: live } },
  [settingsPath]: settingsFile,
  [`repos/example/app/compare/${live}...${code}`]: { status: "ahead" },
});
test("a closed unmerged handoff records failure before clearing its queue labels", async () => {
  startOver();
  answers({ ...delivering({ ...openPr, state: "closed" }), edit: {} });
  const phases: string[] = [];
  const message = await run("example/app", about(8), true, {
    notifyCommand: join(root, "must-not-notify"),
    report: (phase) => {
      phases.push(phase);
    },
  });
  assert.match(message, /已关闭/);
  assert.equal(lastStatus("delivery")?.state, "failure");
  assert.match(lastStatus("delivery").description, /已关闭/);
  assert.deepEqual(phases, ["returned"]);
  const called = readFileSync(calls, "utf8");
  assert.ok(called.indexOf(`/statuses/${code}`) < called.indexOf("pr edit"));
});
const dataLoss = [{ title: "数据会丢", text: "先修复" }];

test("a failed round in between does not open a commit with findings to another review", async () => {
  startOver();
  reviewFinds(dataLoss);
  answers(delivering(openPr));
  const first = readMessage(await run("example/app", about(8), true));
  assert.equal((first.receipt as any).notice.length, 1);
  assert.equal(timesReviewed(), 1);
  // The settings can't be read this time, and the failure goes on the delivery status over what the review wrote there.
  answers({ ...delivering(openPr), [settingsPath]: { fail: "HTTP 502" } });
  await assert.rejects(() => run("example/app", about(8), true), /HTTP 502/);
  assert.doesNotMatch(lastStatus("delivery").description, /审查发现问题/);
  // A review now would miss the problem, and nothing else would stand between it and the merge.
  reviewFinds([]);
  answers(delivering(openPr));
  const third = await run("example/app", about(8), true).catch((error) => error.message);
  assert.equal(timesReviewed(), 1);
  assert.equal(lastStatus("my-review").state, "failure");
  assert.match(third, /第 1 条还没有处理/);
});

const merged = { ...openPr, state: "closed", merged_at: "now", merge_commit_sha: code };
const failedShip = {
  ...delivering(merged),
  "repos/example/app/actions/workflows/ship.yml/runs?branch=main&event=push&per_page=100": {
    workflow_runs: [{ id: 1, head_sha: code, event: "push", status: "completed", conclusion: "failure" }],
  },
};
test("a failed release is a plain failure", async () => {
  startOver();
  answers(failedShip);
  await assert.rejects(() => run("example/app", about(8), true), /发布没有通过/);
  assert.equal(lastStatus("delivery").state, "failure");
  assert.equal(timesReviewed(), 0);
});
