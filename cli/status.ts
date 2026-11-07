// `agent-autoloop status` for a person: what waits for them first, then what's going on, then what only reports.
// Colour only on a terminal: a pipe, a file or an Agent reading it gets plain text, and scripts use --json.
import { spendLines } from "./spend.ts";

type Style = (text: string) => string;

/** https://no-color.org: set and not empty turns colour off. */
export const colorFor = (out: { isTTY?: boolean }, env: Record<string, string | undefined>) =>
  out.isTTY === true && !env.NO_COLOR;

// Hangul Jamo, CJK radicals through Yi, Hangul syllables, compatibility ideographs and forms, full-width forms, and the
// supplementary ideograph planes: the characters a terminal draws two columns wide.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;
const ANSI = /\x1b\[[0-9;]*m/g;
export const width = (text: string) =>
  [...text.replace(ANSI, "")].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
const pad = (text: string, to: number) => text + " ".repeat(Math.max(0, to - width(text)));

const CLOSING = "，。；：！？、）」』”,.;:!?)";
/** Plain text in lines no wider than `room`, at most `max` of them, the last cut with "…". */
function wrap(text: string, room: number, max = Infinity): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      // Closing punctuation stays with what it closes rather than starting a line.
      if (line && width(line + char) > room && !CLOSING.includes(char)) {
        // A Latin word goes to the next line whole; the space it breaks at isn't kept.
        const space = line.lastIndexOf(" ");
        const word = line.slice(space + 1);
        const whole = char !== " " && space > 0 && /^[\x21-\x7e]+$/.test(word) && /[\x21-\x7e]/.test(char);
        lines.push((whole ? line.slice(0, space) : line).trimEnd());
        line = whole ? word : "";
        if (char === " ") continue;
      }
      line += char;
    }
    lines.push(line);
  }
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && width(last + "…") > room) last = [...last].slice(0, -1).join("");
  kept[max - 1] = `${last}…`;
  return kept;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const unlinked = (text: string) => text.replace(LINK, "$1");

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function render(state: any, { color, columns }: { color: boolean; columns?: number }) {
  const room = Math.min(columns || 100, 120);
  const sgr =
    (code: string): Style =>
    (text) =>
      color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const [bold, dim, underline, red, green, yellow, magenta, cyan] = ["1", "2", "4", "31", "32", "33", "35", "36"].map(
    sgr,
  );
  const heading = sgr("1;34");

  const zone = state.timezone;
  const now = Date.parse(state.now);
  const dayOf = (at: number) => {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at).split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  const clock = (at: number) =>
    new Date(at).toLocaleString("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  /** Today's is just the time; yesterday, tomorrow and the coming week by name; further off by date. */
  const when = (iso: string) => {
    const at = Date.parse(iso);
    const days = dayOf(at) - dayOf(now);
    if (days === 0) return clock(at);
    if (days === -1) return `昨天 ${clock(at)}`;
    if (days === 1) return `明天 ${clock(at)}`;
    if (days > 1 && days < 7) return `${WEEK[new Date(dayOf(at) * 86_400_000).getUTCDay()]} ${clock(at)}`;
    const date = new Date(at).toLocaleString("zh-CN", { timeZone: zone, month: "numeric", day: "numeric" });
    return `${date} ${clock(at)}`;
  };
  const lasted = (iso: string) => {
    const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  };

  const out: string[] = [];
  const say = (line = "") => out.push(line);
  const section = (title: string) => {
    say();
    say(title);
  };

  const { totals } = state;
  const count = (label: string, n: number, style: Style) =>
    n > 0 ? `${label} ${bold(style(String(n)))}` : dim(`${label} 0`);
  say(
    [
      count("等你", state.cards.length, yellow),
      count("在跑", totals.running, cyan),
      count("排队", totals.queued - totals.retrying, yellow),
      totals.retrying ? count("等重派", totals.retrying, yellow) : "",
      totals.unknown ? count("不确定", totals.unknown, red) : "",
      `今天做完 ${totals.doneToday}`,
    ]
      .filter(Boolean)
      .join(dim(" · ")),
  );
  for (const line of spendLines(state.spending)) say(dim(line));

  const presence = [
    ...state.agents.map((agent: any) => ({ ...agent, where: agent.worker })),
    ...state.channels.map((channel: any) => ({ ...channel, where: "通道" })),
  ];
  if (presence.length) section(heading("在线"));
  const nameRoom = Math.max(0, ...presence.map((one) => width(one.name)));
  const whereRoom = Math.max(0, ...presence.map((one) => width(one.where)));
  for (const one of presence) {
    const head = `  ${one.online ? green("●") : red("○")} ${pad(one.name, nameRoom)}  `;
    if (one.online) say(head + dim(one.where));
    else
      say(
        `${head}${dim(pad(one.where, whereRoom))}  ${red(`离线，最后在线 ${one.seenAt ? when(one.seenAt) : "没见过"}`)}`,
      );
  }

  const paused = state.lines.filter((line: any) => line.paused);
  if (paused.length) section(`${heading("暂停中")}${dim("（恢复：agent-autoloop resume <规则>）")}`);
  for (const line of paused) say(`  ${line.name}${line.paused.reason ? dim(`：${line.paused.reason}`) : ""}`);

  const INDENT = "       ";
  if (state.cards.length) section(bold(yellow(`等你 ${state.cards.length}`)));
  for (const card of state.cards) {
    const label = card.kind === "ask" ? bold(yellow("决定")) : bold(magenta("留意"));
    say(`  ${label} ${dim(`#${card.id}`)} ${bold(card.title)}`);
    for (const paragraph of (card.text ?? "").split(/\n\s*\n/).filter((one: string) => one.trim())) {
      for (const line of wrap(unlinked(paragraph), room - INDENT.length)) say(INDENT + line);
      for (const [, words, url] of paragraph.matchAll(LINK)) say(`${INDENT}${underline(words)} ${dim(url)}`);
    }
    if (card.kind === "ask") {
      card.options.forEach((option: string, index: number) => {
        say(`${INDENT}${index + 1}. ${option}${index === card.recommend ? green("（推荐）") : ""}`);
      });
      say(dim(`${INDENT}回答：agent-autoloop answer ${card.id} <序号>`));
    } else say(dim(`${INDENT}处理完了：agent-autoloop answer ${card.id}`));
  }

  const sourceName = (id: string) => state.sources.find((one: any) => one.id === id)?.name ?? id;
  const because = (event: { source: string; type: string; subject: string; summary: string }) => {
    if (event.type === "card.answered") return `你回答了卡片「${event.summary}」`;
    if (event.type === "schedule.tick") return "到点了";
    if (event.type === "timer.due") return `约好的复查到了${event.subject ? `：${event.subject}` : ""}`;
    if (event.type === "run.manual") return event.summary;
    return `${sourceName(event.source)} ${event.type} ${event.summary || event.subject}`.trim();
  };
  const running = state.runs.filter((run: any) => run.state === "claimed");
  const queued = state.runs.filter((run: any) => run.state === "queued");
  if (running.length || queued.length) section(heading("正在做"));
  for (const run of running) {
    const stopping = run.stopping ? `  ${yellow("正在停")}` : "";
    say(`  ${dim(`#${run.id}`)} ${run.rule}  ${cyan(`已跑 ${lasted(run.claimedAt)}`)}${stopping}`);
    if (run.events[0]) for (const line of wrap(`因为${because(run.events[0])}`, room - 6, 1)) say(`      ${dim(line)}`);
  }
  for (const run of queued) {
    const retry = run.attempts > 0;
    say(`  ${dim(`#${run.id}`)} ${run.rule}  ${yellow(retry ? `等重派，${when(run.notBefore)} 再试` : "排队")}`);
    if (retry && run.error) for (const line of wrap(run.error, room - 6, 2)) say(`      ${red(line)}`);
  }

  const RUN_LOOK: Record<string, [string, Style]> = {
    done: ["做完了", green],
    nothing: ["没事可做", dim],
    cancelled: ["停了", yellow],
    unknown: ["不确定", red],
  };
  const finished = state.runs.filter((run: any) => run.state !== "claimed" && run.state !== "queued").slice(0, 8);
  if (finished.length) section(heading("最近几轮"));
  const ended = finished.map((run: any) => (run.finishedAt ? when(run.finishedAt) : ""));
  const timeRoom = Math.max(0, ...ended.map(width));
  const runRoom = Math.max(0, ...finished.map((run: any) => width(`#${run.id}`)));
  const lookRoom = Math.max(...Object.values(RUN_LOOK).map(([label]) => width(label)));
  finished.forEach((run: any, index: number) => {
    const [label, style] = RUN_LOOK[run.state] ?? [run.state, (text: string) => text];
    const before = `  ${pad(ended[index], timeRoom)} ${pad(`#${run.id}`, runRoom)} ${pad(label, lookRoom)} `;
    say(
      `  ${dim(pad(ended[index], timeRoom))} ${dim(pad(`#${run.id}`, runRoom))} ${style(pad(label, lookRoom))} ${run.rule}`,
    );
    const outcome = run.error || run.summary;
    if (!outcome) return;
    const look = run.error ? red : run.state === "nothing" ? dim : (text: string) => text;
    const indent = " ".repeat(width(before));
    for (const line of wrap(unlinked(outcome), room - indent.length, 2)) say(indent + look(line));
  });

  const CARD_LOOK: Record<string, [string, Style]> = {
    decided: ["已回答", cyan],
    done: ["已完成", green],
    closed: ["已关闭", dim],
  };
  const recent = state.recentCards.slice(0, 5);
  if (recent.length) section(heading("最近的卡片"));
  const cardRoom = Math.max(0, ...recent.map((card: any) => width(`#${card.id}`)));
  for (const card of recent) {
    const [label, style] =
      card.kind === "notice" && card.state === "closed"
        ? ["已处理", dim]
        : (CARD_LOOK[card.state] ?? [card.state, (text: string) => text]);
    const before = `  ${pad(`#${card.id}`, cardRoom)} ${pad(label, 6)} `;
    const [title] = wrap(card.title, room - width(before), 1);
    say(`  ${dim(pad(`#${card.id}`, cardRoom))} ${style(pad(label, 6))} ${bold(title)}`);
    const indent = " ".repeat(width(before));
    const parts: [string, Style][] = [];
    if (card.choice !== null && card.choice !== undefined) parts.push([`你选了 ${card.options[card.choice]}`, green]);
    if (card.answer) parts.push([`你说：${card.answer}`, (text) => text]);
    // A notice dealt with says so already in its label.
    if (card.result && card.result !== "已处理") parts.push([unlinked(card.result), (text) => text]);
    else if (card.state === "decided") parts.push(["Agent 接着在做", dim]);
    // What `tell` says is closed as soon as it's made, so this is where it's read; one line keeps the list a list.
    else if (card.kind === "notice" && card.text) parts.push([unlinked(card.text), dim]);
    if (!parts.length) continue;
    const plain = parts.map(([text]) => text.replace(/\s*\n\s*/g, " ")).join(" → ");
    const lines = wrap(plain, room - indent.length, card.kind === "notice" ? 1 : 2);
    if (lines.length === 1 && lines[0] === plain)
      say(indent + parts.map(([text, look]) => look(text)).join(dim(" → ")));
    else for (const line of lines) say(indent + line);
  }

  const timed = [...state.lines.filter((line: any) => line.every), ...state.elsewhere];
  if (timed.length) section(heading("定时"));
  const ruleRoom = Math.max(0, ...timed.map((line: any) => width(line.name)));
  const everyRoom = Math.max(0, ...timed.map((line: any) => width(line.every)));
  for (const line of timed) {
    const head = `  ${pad(line.name, ruleRoom)}  ${pad(line.every, everyRoom)}  下次 ${when(line.next)}`;
    const [where] = line.where ? wrap(`（在别处：${line.where}）`, room - width(head), 1) : [""];
    say(`  ${pad(line.name, ruleRoom)}  ${pad(line.every, everyRoom)}  ${dim("下次")} ${when(line.next)}${dim(where)}`);
  }

  const unrouted = state.unrouted.slice(0, 5);
  if (unrouted.length) section(heading("没有规则接的事件"));
  for (const event of unrouted) {
    const words = `${sourceName(event.source)} ${event.type} ${event.subject}`;
    say(`  ${yellow(words)}${event.summary ? dim(`：${event.summary}`) : ""}`);
  }
  return out.join("\n");
}
