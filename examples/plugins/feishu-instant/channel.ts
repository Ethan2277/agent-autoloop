// A Feishu channel that answers a click inside Feishu's own callback, so the card turns to "你选了…" as the spinner
// stops, instead of springing back to the options until a separate update lands seconds later.
//
// What differs from the built-in channel (plugins/feishu/channel.ts), whose card layout this reuses as is:
//   - It holds the long connection itself, with the official Node SDK, which can reply to a callback with a card.
//     lark-cli's `event consume` always replies with a bare 200.
//   - It sends and updates messages through one SDK client that keeps its token and connections, instead of starting
//     a new lark-cli process (and new connections) for every call.
// The answer still goes to the hub first; the reply draws the card the hub gives back once it has counted it, the same
// version the hub then hands this channel to send. A hub that gives none back gets a short note instead.
//
// Only one connection per app should be listening: Feishu hands each click to one of them at random. Don't run
// `lark-cli event consume` for this app while this is in use.
//
//   config.json  "channels": { "feishu": { "use": "feishu-instant", "key": "…", "user": "ou_…", "appId": "cli_…" } }
//   secrets.env  AGENT_AUTOLOOP_FEISHU_APP_SECRET=…
// Without the App ID or the secret it runs the built-in lark-cli channel unchanged. Setup: README.md beside this file.
import { realpathSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import lark from "@larksuiteoapi/node-sdk";

// The engine's types, kept here so this folder works wherever it's copied.
type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  link: string | null;
};
type ChannelContext = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
    answer(card: number, body: { choice?: number; text?: string; by?: string; ref?: string }): Promise<any>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};
type BuiltIn = { default: (context: ChannelContext) => Promise<void>; render: (card: Card) => object };

const SECRET = "AGENT_AUTOLOOP_FEISHU_APP_SECRET";
/** Feishu waits 3 seconds for the reply and shows an error after that. The hub is on this machine and answers in
 *  milliseconds; past this, reply without a card and let the update that follows the answer redraw it. */
const ANSWER_WITHIN = 2000;
const TIMED_OUT = Symbol("timed out");

type Toast = { type: "info" | "success" | "error" | "warning"; content: string };
type Reply = { toast?: Toast; card?: { type: "raw"; data: object } };
type Click = { reply: Reply; drawn: number | null };

/** The built-in Feishu channel of the engine running this (`node …/bin/agent-autoloop.ts up`), found from the
 *  engine rather than from where this file sits, so a copy anywhere draws cards exactly as the built-in does. */
async function builtIn(): Promise<BuiltIn> {
  const engine = path.dirname(path.dirname(realpathSync(process.argv[1]!)));
  return import(pathToFileURL(path.join(engine, "plugins", "feishu", "channel.ts")).href);
}

/** Feishu may send these as objects or as JSON in a string. */
function parsed(value: unknown): any {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default async function feishuInstant(context: ChannelContext) {
  const { hub, options, log, signal } = context;
  const { default: builtin, render } = await builtIn();
  const appId = typeof options.appId === "string" ? options.appId : "";
  const appSecret = process.env[SECRET] ?? "";
  if (!appId || !appSecret) {
    log(`${appId ? `${SECRET} not in secrets.env` : "no appId in config.json"}; running the built-in lark-cli channel`);
    return builtin(context);
  }
  const owner = typeof options.user === "string" ? options.user : "";
  if (!owner) throw new Error("飞书通道要在 config.json 写 user（你的 open_id）");

  // One client for every call: it keeps the token, and these keep the connections.
  lark.defaultHttpInstance.defaults.httpsAgent = new https.Agent({ keepAlive: true });
  const at =
    (level: string) =>
    (...parts: unknown[]) =>
      log(
        `[sdk ${level}] ${parts
          .flat()
          .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
          .join(" ")}`,
      );
  const logger = { error: at("error"), warn: at("warn"), info: at("info"), debug: () => {}, trace: () => {} };
  const credentials = { appId, appSecret, domain: lark.Domain.Feishu, logger };
  const client = new lark.Client({ ...credentials, loggerLevel: lark.LoggerLevel.warn });

  async function call(what: string, request: () => Promise<any>) {
    let response: any;
    try {
      response = await request();
    } catch (error: any) {
      throw new Error(`${what}: ${JSON.stringify(error?.response?.data ?? said(error)).slice(0, 300)}`);
    }
    if (response?.code) throw new Error(`${what}: ${response.code} ${response.msg ?? ""}`);
    return response;
  }
  const send = async (key: string, content: string) =>
    (
      await call("send", () =>
        client.im.v1.message.create({
          params: { receive_id_type: "open_id" },
          data: { receive_id: owner, msg_type: "interactive", content, uuid: key },
        }),
      )
    ).data.message_id as string;
  const update = (ref: string, content: string) =>
    call("update", () => client.im.v1.message.patch({ path: { message_id: ref }, data: { content } }));

  /** A click being handled, and the version its reply drew. The hub sends that version too; drawing it again would
   *  race the reply for nothing. */
  const clicks = new Map<number, Promise<number | null>>();

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
        const click = clicks.get(card.id);
        const drawn = click ? await click : null;
        // Used now, or about an older version; one about a newer version waits for it.
        if (drawn !== null && drawn <= card.version && clicks.get(card.id) === click) clicks.delete(card.id);
        let ref = card.ref;
        const alreadyDrawn = ref !== null && drawn === card.version;
        if (!alreadyDrawn) {
          const content = JSON.stringify(render(card));
          if (ref) {
            try {
              await update(ref, content);
            } catch (error) {
              // As the built-in does: an open card's buttons still work on the first message; a settled one is better
              // sent again than left showing the options.
              if (card.state === "open") throw error;
              log(`card ${card.id}: couldn't update ${ref} (${error}); sending it again`);
              await send(`agent-autoloop-card-${card.id}-v${card.version}`, content);
            }
          } else ref = await send(`agent-autoloop-card-${card.id}`, content);
        }
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the message that was sent counts; the hub checks both, before anything is drawn. */
  async function answer(id: number, data: any, value: any, form: any): Promise<Click> {
    const choice = Number.isInteger(value?.choice) ? value.choice : form ? 0 : null;
    if (choice === null) return { reply: {}, drawn: null };
    const note = typeof form?.note === "string" ? form.note : undefined;
    const given: { choice: number; by?: string; ref?: string; text?: string } = {
      choice,
      by: data.operator?.open_id,
      ref: data.context?.open_message_id ?? data.open_message_id,
    };
    if (note !== undefined) given.text = note;
    let result: any;
    try {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ANSWER_WITHIN)));
      result = await Promise.race([hub.answer(id, given), late]).finally(() => clearTimeout(timer));
    } catch (error) {
      log(`card ${id}: click by ${given.by} not counted: ${said(error)}`);
      return { reply: { toast: { type: "error", content: `没记上：${said(error)}` } }, drawn: null };
    }
    if (result === TIMED_OUT) {
      log(`card ${id}: the hub took over ${ANSWER_WITHIN} ms; replying without a card`);
      return { reply: { toast: { type: "info", content: "收到了，正在记录" } }, drawn: null };
    }
    const what = note !== undefined ? "note submitted" : "answered";
    log(`card ${id}: ${what} by ${given.by}, ${result.changed ? "counted" : "already settled"}`);
    if (!result.changed) return { reply: { toast: { type: "info", content: "这张卡片已经处理过了" } }, drawn: null };
    const card: Card | undefined = result.card;
    if (!card) return { reply: { toast: { type: "success", content: "已记录" } }, drawn: null };
    return { reply: { card: { type: "raw", data: render(card) } }, drawn: card.version };
  }

  async function clicked(data: any): Promise<Reply> {
    const value = parsed(data.action?.value);
    const form = parsed(data.action?.form_value);
    // A form's submit button can't carry a value, so its name holds the card's number.
    const named = /^handling_note_submit_(\d+)$/.exec(String(data.action?.name ?? ""));
    const id = Number.isInteger(value?.card) ? value.card : named ? Number(named[1]) : null;
    if (!Number.isInteger(id)) return {};
    const work = answer(id, data, value, form).catch((error): Click => {
      log(`card ${id}: click not handled: ${said(error)}`);
      return { reply: { toast: { type: "error", content: "没记上，请稍后再点一次" } }, drawn: null };
    });
    const drawn = work.then((click) => click.drawn);
    // Set before the hub hears of the answer, so the version it then sends finds this here.
    clicks.set(id, drawn);
    const { reply, drawn: version } = await work;
    if (version === null && clicks.get(id) === drawn) clicks.delete(id);
    return reply;
  }

  const dispatcher = new lark.EventDispatcher({ logger, loggerLevel: lark.LoggerLevel.warn }).register({
    "card.action.trigger": (data: any) => clicked(data),
    // The app is also told when you read its messages; nothing to do, and unhandled it logs a warning each time.
    "im.message.message_read_v1": () => {},
  });
  const connection = new lark.WSClient({ ...credentials, loggerLevel: lark.LoggerLevel.info });
  const stop = () => connection.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await connection.start({ eventDispatcher: dispatcher });
    await deliver();
  } finally {
    signal.removeEventListener("abort", stop);
    connection.close();
  }
}
