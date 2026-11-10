// The channels that ship and the webhook adapter. No real listener runs here: only one can hold an app's card clicks.
// Failure cases: a first send uses a key that changes with the version, or an update sends a new message; a failed send
// isn't reported; a click that isn't a card's is taken; a card's options don't show while it's open or still show after;
// the listener dying isn't started again, or a listener that can't start takes the whole hub down. A GitHub webhook with
// a bad signature, or with none, is taken; what isn't an identifier reaches the subject; a ping makes an event;
// replacement tokens in card text rewrite a webhook template. A settled card Feishu won't let the bot change stays at the
// version before the answer; an open one is sent again with buttons that don't count.
// A slow CLI call must not block the hub's HTTP loop while looking up a user, sending or updating a card.
// An ask card that only takes choices loses the account someone would type; words without a choice must still answer.
// A U+2028 or U+2029 in what someone typed, which JSON leaves as it is, cuts the click's line and loses the click.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu, { render } from "../plugins/feishu/channel.ts";
import webhook from "../plugins/webhook/channel.ts";
import github from "../plugins/github/source.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channels-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

test("a card shows its options while it's open, and what became of it after", () => {
  const open = render(base);
  const blocks = open.body.elements.filter((e) => e.tag === "interactive_container") as any[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].behaviors[0].value, { card: 5, choice: 1 });
  assert.equal(blocks[1].border_color, "blue", "what's recommended stands out");
  const said = (card: Card) => JSON.stringify(render(card).body.elements);
  assert.match(said({ ...base, state: "decided", choice: 1 }), /你选了「留着」，已记录/);
  assert.ok(!said({ ...base, state: "decided", choice: 1 }).includes("callback"));
  assert.match(said({ ...base, state: "done", choice: 0, result: "删了" }), /你选了「删」。已执行：删了/);
  assert.match(said({ ...base, state: "decided", answer: "归档" }), /你选了「归档」/);
  assert.match(said({ ...base, state: "closed", result: "问题自己好了" }), /不用决定了：问题自己好了/);
  assert.match(said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }), /已处理/);
  const noticeOpen = JSON.stringify(render({ ...base, kind: "notice", options: [] }).body.elements);
  assert.ok(noticeOpen.includes('"tag":"form"'), "a notice can take a line of your own");
  assert.ok(noticeOpen.includes("handling_note_submit_5"), "the submit button carries the card's number");
  assert.ok(noticeOpen.includes('"name":"note"'), "the form's field has a name, so its words come back");
  assert.ok(
    noticeOpen.includes('"form_action_type":"submit"'),
    "the way a Feishu 2.0 card marks a form's submit button",
  );
  const askOpen = JSON.stringify(render(base).body.elements);
  assert.ok(askOpen.includes("ask_text_submit_5"), "an ask card can take words too, not only a choice");
  assert.ok(askOpen.includes('"name":"note"'), "the ask form's field has a name, so its words come back");
  assert.ok(
    !said({ ...base, state: "decided", choice: 1 }).includes('"tag":"form"'),
    "a settled ask card has no form left to submit",
  );
  assert.match(
    said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理", answer: "清了 3GB" }),
    /处理说明：清了 3GB/,
  );
  assert.ok(!said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }).includes("处理说明"));
});

test("feishu CLI calls leave the HTTP loop available", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lark = join(dir, "async-lark");
  writeFileSync(
    lark,
    `#!${process.execPath}
if (process.argv[2] === 'event') { setInterval(() => {}, 1000); }
else {
  (async () => {
    if (process.argv[2] !== 'auth') for await (const chunk of process.stdin) {}
    await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify({ ok: true, identities: { user: { openId: 'ou_me' } }, data: { message_id: 'om_5' } }));
  })().catch(() => process.exit(1));
}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards = [base, { ...base, version: 2, ref: "om_5" }];
  let delivered = 0;
  const failed: unknown[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered() {
      delivered++;
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  try {
    await feishu({ hub: hub as any, options: { lark }, log: () => {}, signal: stop.signal });
    assert.deepEqual(failed, []);
    assert.equal(delivered, 2);
    assert.equal(requests, 3, "user lookup, send and patch each allowed HTTP to respond");
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("feishu: a lark-cli that can't be started is said, not left to take the hub down", async () => {
  const stop = new AbortController();
  const lines: string[] = [];
  const hub = { nextCard: () => new Promise((resolve) => setTimeout(() => resolve({ card: null }), 5)) };
  const log = (line: string) => {
    lines.push(line);
    stop.abort();
  };
  // Returning shows the listener's loop went on past the failure, to where it would start again. Without the time limit
  // a crash, which the test runner catches, would leave this waiting for good.
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]);
  await feishu({ hub: hub as any, options: { user: "ou_me", lark: join(dir, "not-there") }, log, signal });
  assert.match(lines[0] ?? "", /ENOENT/);
});

test("feishu: sends once per card, updates in place, reports failure, and only real clicks count", async () => {
  const log = join(dir, "lark.log");
  const lark = join(dir, "lark-cli");
  // A stand-in for lark-cli: records each call; `event consume` prints two clicks and waits to be stopped.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_value":"{\\"card\\":5,\\"choice\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    echo '{"action_value":"{\\"other\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    exec sleep 30 ;;
  *fail-me*) exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_5"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  // A card that can't be sent: lark-cli is told to fail by the words in it.
  writeFileSync(
    lark,
    readFileSync(lark, "utf8").replace(
      "*fail-me*) exit 1 ;;",
      '*+messages-send*) body=$(cat); case "$body" in *fail-me*) exit 1 ;; esac; echo \'{"ok":true,"data":{"message_id":"om_5"}}\' ;;',
    ),
  );
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5"), "the key doesn't change with the version");
  assert.ok(sends[0].includes("--user-id ou_me"));
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_5")),
    "an update changes the message that was sent",
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 1),
    ["delivered", 5, 1, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 2),
    ["delivered", 5, 2, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "failed"),
    ["failed", 6, 1],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 5, { choice: 1, by: "ou_me", ref: "om_5" }]],
  );
});

test("feishu: U+2028 and U+2029 in a handling note don't lose the click", async () => {
  const lark = join(dir, "lark-cli-separators");
  writeFileSync(
    lark,
    `#!/bin/sh
case "$*" in
  *"event consume"*)
    echo '{"action_name":"handling_note_submit_8","action_value":"","form_value":"{\\"note\\":\\"第一行 第二行 第三行\\"}","operator_id":"ou_me","message_id":"om_8"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_8"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const answers: unknown[][] = [];
  let answered = () => {};
  const click = new Promise<void>((resolve) => (answered = resolve));
  const hub = {
    async nextCard() {
      // Until the click comes, however busy this machine is, or until it's clear it won't.
      await Promise.race([click, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      stop.abort();
      return { card: null };
    },
    async answer(...args: unknown[]) {
      answers.push(args);
      answered();
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(answers, [[8, { choice: 0, by: "ou_me", ref: "om_8", text: "第一行 第二行 第三行" }]]);
});

test("feishu: a form submit carries the handling note, and the button's name finds its card", async () => {
  const log = join(dir, "lark-note.log");
  const lark = join(dir, "lark-cli-note");
  // A form submit has an empty action_value: the card's number is in the button's name, the note in form_value.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_name":"handling_note_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"已回他，下周发视频\\"}","operator_id":"ou_me","message_id":"om_7"}'
    echo '{"action_name":"handling_note_submit_7","action_value":"{\\"card\\":7,\\"choice\\":0}","operator_id":"ou_me","message_id":"om_7"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_7"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [{ ...base, id: 7, kind: "notice", options: [], ref: "om_7" }];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [
      ["answer", 7, { choice: 0, by: "ou_me", ref: "om_7", text: "已回他，下周发视频" }],
      ["answer", 7, { choice: 0, by: "ou_me", ref: "om_7" }],
    ],
    "a submitted note and a plain click both count, the click with no empty text",
  );
});

test("feishu: an ask card's text form answers with the words and no choice", async () => {
  const log = join(dir, "lark-free.log");
  const lark = join(dir, "lark-cli-free");
  // A free-text submit has no choice: the words are the answer, and an empty one answers nothing.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_name":"ask_text_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"账号 test-ops 密码 s3cret\\"}","operator_id":"ou_me","message_id":"om_7"}'
    echo '{"action_name":"ask_text_submit_7","action_tag":"button","action_value":"","form_value":"{\\"note\\":\\"   \\"}","operator_id":"ou_me","message_id":"om_7"}'
    exec sleep 30 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_7"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [{ ...base, id: 7, ref: "om_7" }];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 7, { by: "ou_me", ref: "om_7", text: "账号 test-ops 密码 s3cret" }]],
    "the words count without a choice, and an empty submit doesn't answer",
  );
});

test("a webhook channel posts words and the link once, and has nothing to do for an update", async () => {
  const seen: any[] = [];
  const target = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push(JSON.parse(text));
      res.statusCode = seen.length === 2 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const literal = '$& $` $\' {text} "},"admin":true';
  const cards: Card[] = [
    { ...base, text: literal },
    { ...base, version: 2, ref: "sent-5", state: "decided", choice: 0 },
    { ...base, id: 7 },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await webhook({
    hub: hub as any,
    options: {
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      body: { msgtype: "text", text: { content: "{text}" } },
    },
    log: () => {},
    signal: stop.signal,
  });
  target.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].text.content, `${base.title}\n\n${literal}\n\n1. 删\n2. 留着\n\n${base.link}`);
  assert.match(seen[0].text.content, /要不要删[\s\S]*1\. 删[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "sent-5"],
    ["delivered", 5, 2, "sent-5"],
    ["failed", 7, 1],
  ]);
});

test("GitHub: signed or not taken, and what it says becomes a plain event", () => {
  const secret = "s3cret";
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "首页打不开", body: "详情", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const headers = (b: string, over: object = {}) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    ...over,
  });
  assert.deepEqual(github({ headers: headers(body), body, secret }), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "首页打不开",
      detail: "详情",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
  assert.throws(() => github({ headers: headers(body, { "x-hub-signature-256": "sha256=00" }), body, secret }));
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body, secret }));
  assert.throws(() => github({ headers: headers(body), body, secret: "" }), "no secret set up takes nothing");
  assert.deepEqual(github({ headers: headers("{}", { "x-github-event": "ping" }), body: "{}", secret }), []);
  const odd = JSON.stringify({ repository: { full_name: "a/b c" } });
  assert.match(
    (github({ headers: headers(odd, { "x-github-event": "push" }), body: odd, secret }) as any)[0].subject,
    /^a\/b-c$/,
  );
});

/** A Feishu channel handed these cards, with a lark-cli that refuses every update: what it ran, and what it told the hub. */
async function refusedUpdates(given: Card[]) {
  const log = join(dir, "lark-patch.log");
  const lark = join(dir, "lark-patch");
  rmSync(log, { force: true });
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*) exec sleep 30 ;;
  *"messages patch"*) cat > /dev/null; exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_new"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: Card[] = [...given];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(id: number, version: number) {
      calls.push(["failed", id, version]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  return { lines: readFileSync(log, "utf8").trim().split("\n"), calls };
}

test("feishu: a settled card that can't be updated is sent again, once for each version", async () => {
  // Failure this guards: the bot didn't send the message being updated, so Feishu refuses and the update is dropped once the
  // tries run out. The reader is then stuck looking at the version before the answer.
  const { lines, calls } = await refusedUpdates([{ ...base, version: 2, ref: "om_old", state: "decided", choice: 1 }]);
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_old")),
    "the message that was sent is tried first",
  );
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.equal(sends.length, 1, "a refused update falls back to a new message");
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5-v2 "), "the second message is this version's");
  assert.deepEqual(calls, [["delivered", 5, 2, "om_old"]], "the hub goes on knowing the message it first heard of");
});

test("feishu: an open card that can't be updated isn't sent again, and a first message is keyed by the card alone", async () => {
  // Failure this guards: the hub only counts answers on the first message, so buttons on a second one would do nothing; a
  // first message keyed by its version comes twice when a report is lost and the card has moved on.
  const open = await refusedUpdates([{ ...base, version: 2, ref: "om_old" }]);
  assert.equal(open.lines.filter((l) => l.includes("+messages-send")).length, 0);
  assert.deepEqual(open.calls, [["failed", 5, 2]], "it's tried again later");

  const first = await refusedUpdates([{ ...base, version: 3, ref: null }]);
  const [send] = first.lines.filter((l) => l.includes("+messages-send"));
  assert.ok(send.includes("--idempotency-key agent-autoloop-card-5 "), send);
  assert.deepEqual(first.calls, [["delivered", 5, 3, "om_new"]]);
});
