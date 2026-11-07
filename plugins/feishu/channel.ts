// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connection that brings
// clicks back, so this machine needs no public address. Only one listener can hold an app's card clicks, so run this in
// one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import { execFile, spawn } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { eachLine } from "../../host/lines.ts";
import { commandLine } from "../../host/command.ts";

/** Feishu sends these values as JSON in a string, which may be empty. */
function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `你选了「${chosen}」，已记录，等待处理。`;
  if (card.state === "done") return `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card) {
  const outcome = outcomeOf(card);
  // Each option is a block across the card, its words wrapping: buttons in a row, one line high, cut long options off.
  const option = (label: string, index: number) => ({
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: index === card.recommend ? "blue" : "grey",
    corner_radius: "8px",
    padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  const afterwards = outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : [];
  const noteSaid =
    card.kind === "notice" && card.answer
      ? [{ tag: "div", text: { tag: "plain_text", content: `处理说明：${card.answer}` } }]
      : [];
  const noteForm =
    card.kind === "notice"
      ? [
          {
            tag: "form",
            name: "handling_note",
            elements: [
              {
                tag: "input",
                name: "note",
                input_type: "multiline_text",
                rows: 2,
                auto_resize: true,
                max_length: 1000,
                label: { tag: "plain_text", content: "处理说明（可不填）" },
                label_position: "top",
                placeholder: { tag: "plain_text", content: "比如：已回复他视频下周发；或：群发广告，不用管" },
              },
              {
                tag: "button",
                name: `handling_note_submit_${card.id}`,
                form_action_type: "submit",
                type: "primary",
                text: { tag: "plain_text", content: "记录并结案" },
              },
            ],
          },
        ]
      : [];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...(card.state === "open" ? [...noteForm, ...card.options.map(option)] : [...afterwards, ...noteSaid]),
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const lark = async (args: string[], input: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        ...commandLine([program, ...args]),
        { encoding: "utf8", timeout: 60_000, signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  /** Sends the card's words as a new message, or hands back the one an earlier try with this key already made. */
  async function sendMessage(key: string, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    const once = ["--idempotency-key", key];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", "-"], content)).data
      .message_id as string;
  }

  async function deliver() {
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
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) {
          try {
            await updateMessage(ref, content);
          } catch (error) {
            // The bot may not be the sender of the message it is told to change, and Feishu refuses that outright. An open
            // card stays as it is: the hub only counts answers on the message it first heard of, whose buttons still work.
            if (card.state === "open") throw error;
            // A settled one has no buttons: a second card is worse than one, a card frozen at the version before the answer
            // is worse than both. The key has the version so that a retry of this one makes no third.
            log(`card ${card.id}: couldn't update ${ref} (${error}); sending it again`);
            await sendMessage(`agent-autoloop-card-${card.id}-v${card.version}`, content);
          }
          // The key is the card alone, not its version: a report that got lost must not make a second message.
        } else ref = await sendMessage(`agent-autoloop-card-${card.id}`, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the card that was sent counts; the hub checks both. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const form = safeJson(event.form_value);
    const value = safeJson(event.action_value);
    // A form's submit button can't carry a value, so its name holds the card's number.
    const named = /^handling_note_submit_(\d+)$/.exec(String(event.action_name ?? ""));
    const cardId = Number.isInteger(value?.card) ? value.card : named ? Number(named[1]) : null;
    if (!Number.isInteger(cardId)) return;
    // A notice's only option is that it's been handled, so submitting the form picks it.
    const choice = Number.isInteger(value?.choice) ? value.choice : form ? 0 : null;
    if (choice === null) return;
    const note = typeof form?.note === "string" ? form.note : undefined;
    const given: { choice: number; by?: string; ref?: string; text?: string } = {
      choice,
      by: event.operator_id,
      ref: event.message_id,
    };
    if (note !== undefined) given.text = note;
    const answer = await hub.answer(cardId, given);
    const how = form ? "note submitted" : "answered";
    log(`card ${cardId}: ${how} by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      const consume = spawn(...commandLine([program, "event", "consume", "card.action.trigger", "--as", "bot"]), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Unheard, this would end the whole hub. A process that never started still closes, which starts it again below.
      consume.on("error", (error) => log(`the click listener couldn't run: ${error}`));
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      eachLine(consume.stderr, log);
      eachLine(consume.stdout, (line) => void clicked(line).catch((error) => log(`click not handled: ${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
