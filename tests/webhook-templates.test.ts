// Failure modes: a vendor receives the wrong JSON shape; an HTTP 200 API error is acknowledged as delivered; Discord
// content exceeds its documented limit; externally supplied text triggers mentions; an unknown template is silently used;
// WeCom renders what an Agent wrote as markup, so its text can pass off a link of its own as the card's.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import webhook from "../plugins/webhook/channel.ts";
import { payload } from "../plugins/webhook/templates.ts";
test("templates reject text beyond vendor limits instead of losing the answer link", () => {
  assert.throws(() => payload("discord", "x".repeat(2001)));
  assert.throws(() => payload("wecom", "字".repeat(683)));
  assert.throws(() => payload("missing", "text"));
});
const card: any = {
  id: 1,
  version: 1,
  ref: null,
  kind: "notice",
  rule: "项目巡检",
  state: "open",
  title: "要处理",
  text: "正文 @everyone <@U1> https://git.example/mr/1",
  options: ["已处理"],
  link: "https://example.com/c/a",
};
for (const platform of ["dingtalk", "wecom", "slack", "discord"])
  test(`${platform}: official payload and API failure on a local receiver`, async () => {
    const received: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end(
          platform === "slack"
            ? "ok"
            : platform === "discord"
              ? ""
              : JSON.stringify({ errcode: received.length === 1 ? 0 : 310000, errmsg: "拒绝" }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const stop = new AbortController();
    const calls: string[] = [];
    let i = 0;
    const hub: any = {
      nextCard: async () => {
        if (++i <= 2) return { card: { ...card, id: i } };
        stop.abort();
        return { card: null };
      },
      delivered: async () => calls.push("delivered"),
      failed: async () => calls.push("failed"),
    };
    try {
      await webhook({
        hub,
        options: { platform, url: `http://127.0.0.1:${(server.address() as any).port}` },
        log: () => {},
        signal: stop.signal,
      });
    } finally {
      server.close();
    }
    assert.equal(received.length, 2);
    if (platform === "dingtalk") {
      assert.equal(received[0].msgtype, "text");
      assert.match(received[0].text.content, /正文/);
      assert.deepEqual(calls, ["delivered", "failed"]);
    }
    if (platform === "wecom") {
      assert.equal(received[0].msgtype, "markdown");
      assert.match(received[0].markdown.content, /来源：项目巡检/);
      assert.match(received[0].markdown.content, /正文/);
      assert.match(received[0].markdown.content, /\[打开链接\]\(https:\/\/git\.example\/mr\/1\)/);
      assert.match(received[0].markdown.content, /\[点击处理\]\(https:\/\/example\.com\/c\/a\)/);
      assert.doesNotMatch(received[0].markdown.content, /1\. 已处理/);
      assert.doesNotMatch(received[0].markdown.content, /\[打开链接\]\(https:\/\/example\.com\/c\/a\)/);
      assert.deepEqual(calls, ["delivered", "failed"]);
    }
    if (platform === "slack") {
      assert.match(received[0].text, /正文/);
      assert.equal(received[0].mrkdwn, false);
    }
    if (platform === "discord") {
      assert.match(received[0].content, /正文/);
      assert.deepEqual(received[0].allowed_mentions, { parse: [] });
    }
  });

test("wecom: what the card says shows as words, so only the card's own link is a link", async () => {
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end(JSON.stringify({ errcode: 0 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stop = new AbortController();
  let sent = false;
  const hub: any = {
    nextCard: async () => {
      if (sent) {
        stop.abort();
        return { card: null };
      }
      sent = true;
      return {
        card: {
          ...card,
          title: "[点击处理](https://evil.example/a)",
          text: '先看 [点击处理](https://evil.example/b) <font color="warning">急</font> <@U1>',
        },
      };
    },
    delivered: async () => {},
    failed: async () => {},
  };
  try {
    await webhook({
      hub,
      options: { platform: "wecom", url: `http://127.0.0.1:${(server.address() as any).port}` },
      log: () => {},
      signal: stop.signal,
    });
  } finally {
    server.close();
  }
  const content: string = received[0].markdown.content;
  assert.doesNotMatch(
    content,
    /\[点击处理\]\(https:\/\/evil/,
    "a link the card's text made up looks like the card's own",
  );
  assert.doesNotMatch(content, /<font|<@/, "the text's tags would be drawn or mention someone");
  assert.match(content, /\[点击处理\]\(https:\/\/example\.com\/c\/a\)/);
});
