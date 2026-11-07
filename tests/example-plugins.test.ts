// Failure modes: an example imports something that only exists in this repository, so it loads here and breaks once
// `agent-autoloop add` has put it elsewhere; add leaves the entry where the loader doesn't look; hello-agent's read throws on
// output it doesn't expect (a throw stops the worker) or loses the session, or never says a turn it went on in started, so
// a resumed turn that broke is run again from scratch in a new session and does its work twice; hello-channel writes a card but never reports
// it, so the hub sends it again every minute; hello-source takes a wrong or missing signature, or gives an event the hub
// refuses; an example drifts from the engine's types; a command in the tutorial doesn't run as written; add takes a
// repository whose name can't be a plugin name without saying which name it worked out and turned down.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import helloAgent from "../examples/plugins/hello-agent/agent.ts";
import helloChannel from "../examples/plugins/hello-channel/channel.ts";
import helloSource from "../examples/plugins/hello-source/source.ts";
import type { ChannelContext } from "../host/channels.ts";
import type { Adapter } from "../worker/agents.ts";

// The examples carry their own types so they stand alone in a repository; these keep them in step with the engine's.
const adapter: Adapter = helloAgent;
const channel: (context: ChannelContext) => Promise<void> = helloChannel;
assert.ok(adapter && channel);

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "agent-autoloop.ts");
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-example-plugins-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_") && name !== "NODE_TEST_CONTEXT"),
  ) as NodeJS.ProcessEnv;
const agentAutoloop = (args: string[], home: string) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    env: { ...cleanEnv(), AGENT_AUTOLOOP_HOME: home },
    encoding: "utf8",
  });
const newKey = (home: string, kind: string, name: string) =>
  agentAutoloop(["key", "new", kind, name], home).stdout.trim().split("\n").at(-1)!;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until<T>(what: string, look: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = await look();
    if (seen) return seen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等不到：${what}`);
}

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};

test("hello-agent: starts a session or goes on in one, and reads any output without throwing", () => {
  const said = (argv: string[]) => JSON.parse(argv.at(-1)!);
  assert.equal(said(helloAgent.command(turn)).session, "new-id");
  assert.equal(said(helloAgent.command({ ...turn, resume: "old-id" })).session, "old-id");
  assert.match(said(helloAgent.command(turn)).text, /收到了 4 字的提示词，权限 edit/);
  assert.deepEqual(helloAgent.read('{"partial', null, ""), {}, "still running");
  assert.deepEqual(helloAgent.read('{"session":"s","text":"好了"}\n', 0, ""), { session: "s", text: "好了" });
  assert.ok(helloAgent.read("not json", 0, "").error);
  assert.equal(helloAgent.read("", 2, "boom").error, "boom");
  assert.ok(helloAgent.read("", 2, "").error);
});

test("hello-agent: a turn that took the prompt says so, so a resumed one that broke isn't run from scratch", () => {
  const argv = helloAgent.command({ ...turn, resume: "old-id" });
  const printed = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }).stdout;
  const took = printed.split("\n").find((line) => line.trim())!;
  // What the worker reads while it's still going, or once it was killed: the session it went on in, and that it has the
  // prompt. Read as never having started, a retry opens a new session and the work is done a second time.
  assert.deepEqual(helloAgent.read(took, null, ""), { session: "old-id", started: true }, "still going");
  assert.equal(helloAgent.read(took, 137, "").started, true, "killed after it got going");
  assert.equal(helloAgent.read(took, 137, "").session, "old-id", "so the retry goes on in the same session");
  // Its answer is the last line, and having taken the prompt is still part of what it says.
  assert.deepEqual(helloAgent.read(printed, 0, ""), {
    session: "old-id",
    started: true,
    text: "收到了 4 字的提示词，权限 edit。这是 hello-agent，什么也没做。",
  });
});

test("hello-channel: writes a new card, reports it, and leaves a card it has already written alone", async () => {
  const file = join(scratch, "unit-cards.txt");
  const stop = new AbortController();
  const card = { id: 5, version: 1, ref: null, kind: "ask", state: "open", title: "要不要删" };
  const queue = [
    { ...card, text: "占了 10 GB", options: ["删", "留着"], recommend: 1, choice: null, answer: null, result: null },
    {
      ...card,
      version: 2,
      ref: "already",
      text: "",
      options: [],
      recommend: null,
      choice: 0,
      answer: null,
      result: null,
    },
  ];
  const reported: unknown[][] = [];
  const hub = {
    nextCard: async () => {
      const next = queue.shift();
      if (!next) stop.abort();
      return { card: next ? { ...next, link: null } : null };
    },
    delivered: async (...args: unknown[]) => reported.push(args),
    failed: async (...args: unknown[]) => assert.fail(`failed: ${args}`),
    answer: async () => assert.fail("a file can't answer"),
  };
  await helloChannel({ hub, options: { file }, log: () => {}, signal: stop.signal } as unknown as ChannelContext);
  const written = readFileSync(file, "utf8");
  assert.match(written, /要不要删/);
  assert.match(written, /1\. 删/);
  assert.equal(written.match(/要不要删/g)?.length, 1, "an update isn't written again");
  assert.deepEqual(reported, [
    [5, 1, "file-5"],
    [5, 2, "already"],
  ]);
});

test("hello-channel: says so when it can't write", async () => {
  const stop = new AbortController();
  const failures: unknown[][] = [];
  const hub = {
    nextCard: async () => {
      if (failures.length) stop.abort();
      return { card: failures.length ? null : { id: 6, version: 1, ref: null, title: "t", text: "", options: [] } };
    },
    delivered: async () => assert.fail("it wasn't written"),
    failed: async (...args: unknown[]) => failures.push(args),
    answer: async () => {},
  };
  const options = { file: join(scratch, "no", "such", "folder", "cards.txt") };
  await helloChannel({ hub, options, log: () => {}, signal: stop.signal } as unknown as ChannelContext);
  assert.equal(failures[0][0], 6);
});

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("hello-source: only what's signed with the secret gets through", () => {
  const body = JSON.stringify({ id: "evt-1", kind: "paid", order: 42, note: "订单付款了" });
  const given = (signature: unknown, secret = "s3cret") => ({
    headers: { "x-shop-signature": signature as string },
    body,
    secret,
  });
  assert.deepEqual(helloSource(given(sign("s3cret", body))), [
    { id: "evt-1", type: "order.paid", subject: "order-42", summary: "订单付款了" },
  ]);
  assert.throws(() => helloSource(given(sign("wrong", body))), "signed with the wrong secret");
  assert.throws(() => helloSource(given(undefined)), "no signature");
  assert.throws(() => helloSource(given("sha256=short")), "a signature of another length");
  assert.throws(() => helloSource(given(sign("", body), "")), "no secret set up accepts nothing");
  const ping = JSON.stringify({ id: "evt-2", kind: "ping" });
  assert.deepEqual(
    helloSource({ headers: { "x-shop-signature": sign("s3cret", ping) }, body: ping, secret: "s3cret" }),
    [],
  );
});

/** A repository of its own, the way someone publishes a plugin: the entry file at its root. */
function repository(name: string, file: string, folder = name) {
  const dir = join(scratch, "repos", folder);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "examples", "plugins", name, file), join(dir, file));
  const git = (...args: string[]) => {
    const done = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "first");
  return dir;
}

test("the folder a repository installs into is the plugin name, in lower case, and a name no plugin can have is refused by it", () => {
  const refusedHome = mkdtempSync(join(scratch, "home-"));
  const refused = agentAutoloop(["add", repository("hello-agent", "agent.ts", "hello_agent")], refusedHome);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /hello_agent/, "it says which plugin name it worked out and turned down");
  assert.ok(!existsSync(join(refusedHome, "plugins", "hello_agent")), "nothing lands where the loader can't use it");

  const casedHome = mkdtempSync(join(scratch, "home-"));
  const added = agentAutoloop(["add", repository("hello-agent", "agent.ts", "Hello-Plugin")], casedHome);
  assert.equal(added.status, 0, added.stderr);
  assert.ok(
    existsSync(join(casedHome, "plugins", "hello-plugin", "agent.ts")),
    "the folder is the lowercased repository name, which is what rules and config say `use`",
  );
});

test("agent-autoloop add from a git repository, then all three run through a real hub", async () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const plugins = [
    ["hello-agent", "agent.ts"],
    ["hello-channel", "channel.ts"],
    ["hello-source", "source.ts"],
  ];
  for (const [name, file] of plugins) {
    const added = agentAutoloop(["add", repository(name, file)], home);
    assert.equal(added.status, 0, added.stderr);
    assert.ok(existsSync(join(home, "plugins", name, file)), `${name} 没装到加载器找的地方`);
  }
  const work = mkdtempSync(join(scratch, "work-"));
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify({
      sources: { shop: { name: "shop", adapter: "hello-source" } },
      agents: { hello: { name: "Hello", worker: "mac-mini", use: "hello-agent", access: "read" } },
      channels: { cards: { name: "文件" } },
      rules: [
        {
          name: "订单",
          when: { source: "shop", types: ["order.*"] },
          to: "hello",
          cwd: work,
          prompt: "处理这个订单。",
          tell: "always",
        },
      ],
    }),
  );
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const cards = join(scratch, "cards.txt");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url,
      hub: { listen: `127.0.0.1:${port}` },
      worker: { name: "mac-mini", key: newKey(home, "worker", "mac-mini") },
      channels: { cards: { use: "hello-channel", key: newKey(home, "channel", "cards"), file: cards } },
    }),
  );
  const owner = { authorization: `Bearer ${newKey(home, "owner", "me")}` };
  writeFileSync(join(home, "secrets.env"), "AGENT_AUTOLOOP_SECRET_SHOP=s3cret\n");
  const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "up"], {
    env: { ...cleanEnv(), AGENT_AUTOLOOP_HOME: home, SHELL: "/bin/sh" },
    stdio: "ignore",
  });
  const stream = new AbortController();
  try {
    await until("中台启动", () =>
      fetch(`${url}/healthz`)
        .then((up) => up.ok)
        .catch(() => false),
    );
    const body = JSON.stringify({ id: "evt-1", kind: "paid", order: 42, note: "订单付款了" });
    const post = (signature: string) =>
      fetch(`${url}/v1/in/shop`, { method: "POST", headers: { "x-shop-signature": signature }, body });
    assert.equal((await post(sign("wrong", body))).status, 401);
    const accepted = await post(sign("s3cret", body));
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).events[0].routed, ["订单"]);
    const run = await until("这一轮做完", async () => {
      const state = await (await fetch(`${url}/v1/state`, { headers: owner })).json();
      return state.runs.find((run: { state: string }) => run.state === "done");
    });
    assert.match(run.summary, /收到了 \d+ 字的提示词，权限 read/, "the rule's access reaches the plugin");
    assert.ok(run.session, "the session it printed is kept");
    await until("卡片写进文件", () => existsSync(cards) && readFileSync(cards, "utf8").includes(run.summary));
    const log = await fetch(`${url}/v1/stream?after=0`, { headers: owner, signal: stream.signal });
    const reader = log.body!.getReader();
    const decoder = new TextDecoder();
    let facts = "";
    await until("报告送达", async () => {
      facts += decoder.decode((await reader.read()).value, { stream: true });
      return /"type":"delivered"/.test(facts);
    });
  } finally {
    stream.abort();
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
  }
});

/** A block of the tutorial, run the way a reader would paste it: on this checkout, on a free port, with the real CLI. */
async function runBlock(heading: string, oldPort: number) {
  const tutorial = readFileSync(join(ROOT, "docs", "plugins.md"), "utf8");
  const block = new RegExp(`## ${heading}[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\`\`\``).exec(tutorial)?.[1];
  assert.ok(block, `docs/plugins.md 里“${heading}”下面要有一段命令`);
  const dir = mkdtempSync(join(scratch, "block-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const shim = join(bin, "agent-autoloop");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  const port = await freePort();
  const script = block.replaceAll("~/.agent-autoloop/app", ROOT).replaceAll(String(oldPort), String(port));
  const child = spawn("sh", ["-c", script], {
    cwd: ROOT,
    detached: true,
    env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh", TMPDIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  // The block starts a hub of its own in the background: if it never gets as far as stopping it, the group goes.
  const limit = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 60_000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(limit);
  return { code, out };
}

test("the tutorial's first block runs all three examples as written", async () => {
  const { code, out } = await runBlock("先跑起来", 3399);
  assert.equal(code, 0, out);
  assert.match(out, /agent-autoloop add from a git repository/);
});

test("the tutorial's conformance block passes as written", async () => {
  const { code, out } = await runBlock("一致性测试", 3398);
  assert.equal(code, 0, out);
  assert.match(out, /pass [1-9]/);
});
