// The cost lines in `agent-autoloop status`, from /v1/state's completion-time totals. Agents report usage for themselves, or
// don't: a plain command says nothing, and some give tokens but no price. So every figure says how many rounds it leaves out.
import type { Spending } from "../host/state.ts";
const count = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
/** To two places, a day on a cheap model would read as nothing at all. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

function tally(label: string, { rounds, tokens, cost, missingTokens, missingCost }: Spending) {
  if (!rounds) return `${label} 0 轮`;
  const missing = (silent: number) => (silent ? `（${silent} 轮没上报）` : "");
  const shownTokens =
    missingTokens === rounds
      ? "Token 没上报"
      : `${count.format(tokens).replace(/(万|亿)/, " $1")} Token${missing(missingTokens)}`;
  const shownCost = missingCost === rounds ? "费用没上报" : `${dollars(cost)}${missing(missingCost)}`;
  return `${label} ${rounds} 轮 · ${shownTokens} · ${shownCost}`;
}

/** Two lines, labels padded to the same terminal width so the figures line up. */
export function spendLines(spending: { today: Spending; week: Spending }) {
  return [tally("今天     ", spending.today), tally("最近 7 天", spending.week)];
}
