import { createHash } from "node:crypto";
import type { Finding } from "./review.ts";

const SECTION = "## Codex 审查";
const ROUND = /^第 (\d+) 轮（([^）\n]+)，([a-z]+(?: \+ [a-z]+)*)，审到 ([0-9a-f]{7,40})）：/gm;
const ITEM = /^(\d+)\. /;
export const REVIEW_ROUNDS = 3;

function section(body: string) {
  return /^## Codex 审查\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body);
}

export function ledger(description: string | null | undefined) {
  const body = (description ?? "").replaceAll("\r\n", "\n");
  const match = section(body);
  const record = match?.[1] ?? "";
  const matches = [...record.matchAll(ROUND)];
  const rounds = matches.map(([, number, signature, effort, head], index) => ({
    number: Number(number),
    signature,
    effort,
    head,
    // Bind all earlier rounds too. Removing an old finding must invalidate the latest proof.
    digest: createHash("sha256")
      .update(
        record
          .slice(0, matches[index + 1]?.index)
          .replace(/^   处理：[^\n]*$/gm, "   处理：")
          .trim(),
      )
      .digest("hex"),
  }));
  const waiting = new Map<number, boolean>();
  let current: number | undefined;
  for (const line of record.split("\n")) {
    const item = ITEM.exec(line);
    if (item) {
      current = Number(item[1]);
      waiting.set(current, true);
    } else if (line.startsWith("第 ") && line.includes(" 轮（")) {
      current = undefined;
    } else if (current !== undefined) {
      const handled = /^ +处理：(.*)$/.exec(line);
      if (handled) waiting.set(current, !handled[1].trim());
    }
  }
  return {
    body,
    record: record.trim(),
    rounds,
    author: match ? (body.slice(0, match.index) + body.slice(match.index + match[0].length)).trim() : body.trim(),
    unhandled: [...waiting].filter(([, pending]) => pending).map(([item]) => item),
    numbered: Math.max(0, ...waiting.keys()),
    append(text: string) {
      if (!match) return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${SECTION}\n\n${text}\n`;
      const end = match.index + match[0].length;
      const rest = body.slice(end);
      return `${body.slice(0, end).trimEnd()}\n\n${text}\n${rest ? `\n${rest}` : ""}`;
    },
  };
}

export function renderRound(
  current: ReturnType<typeof ledger>,
  signature: string,
  effort: string[],
  head: string,
  findings: Finding[],
) {
  const header = `第 ${current.rounds.length + 1} 轮（${signature}，${effort.join(" + ")}，审到 ${head}）：`;
  if (!findings.length) return `${header}没有发现问题。`;
  return [
    `${header}发现 ${findings.length} 条。`,
    ...findings.map(({ title, text }, index) => {
      const body = text
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => (line ? `   ${line}` : ""))
        .join("\n");
      return `\n${current.numbered + index + 1}. **${title.replace(/\s+/g, " ").trim()}**\n\n${body}\n\n   处理：`;
    }),
  ].join("\n");
}
