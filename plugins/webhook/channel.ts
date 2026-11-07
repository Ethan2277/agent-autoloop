// The smallest channel there is: anything that takes a JSON POST (a group robot in DingTalk, WeCom, Slack, Discord…).
// Words and a link, no buttons: pair it with "links": true in rules.json so the link itself can answer that one card.
//   "channels": { "dingtalk": { "use": "webhook", "key": "…", "url": "https://…",
//                               "body": { "msgtype": "text", "text": { "content": "{text}" } } } }
import { accepted, payload } from "./templates.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";

function fill(template: unknown, text: string): unknown {
  if (typeof template === "string") return template.replaceAll("{text}", () => text);
  if (Array.isArray(template)) return template.map((item) => fill(item, text));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, text)]));
  }
  return template;
}

// WeCom draws its messages as Markdown: a link or a tag in what an Agent wrote would be drawn, and could pass off a link
// of its own as the card's. Full-width look-alikes keep the words and stop the markup; bare addresses still become links.
const asWords = (text: string) => text.replaceAll("](", "］(").replaceAll("<", "＜");

function words(card: Card, platform = "") {
  if (platform === "wecom")
    card = { ...card, title: asWords(card.title), text: asWords(card.text), options: card.options.map(asWords) };
  const source = platform === "wecom" && card.rule ? `来源：${asWords(card.rule)}` : "";
  if (
    platform === "wecom" &&
    card.kind === "notice" &&
    card.state === "open" &&
    card.options.length === 1 &&
    card.options[0] === "已处理" &&
    card.link
  )
    return [card.title, source, card.text, `[点击处理](${card.link})`].filter(Boolean).join("\n\n");
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const parts = [card.title, source, card.text, ...(card.state === "open" ? [choices, card.link] : [])];
  return parts.filter(Boolean).join("\n\n");
}

export default async function webhook({ hub, options, log, signal }: ChannelContext) {
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // It can't change a message once sent: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      const response = await fetch(options.url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options.platform
            ? payload(String(options.platform), words(card, String(options.platform)))
            : fill(options.body ?? { text: "{text}" }, words(card)),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      await accepted(String(options.platform ?? ""), response);
      await hub.delivered(card.id, card.version, `sent-${card.id}`);
    } catch (error) {
      log(`card ${card.id} not sent: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
