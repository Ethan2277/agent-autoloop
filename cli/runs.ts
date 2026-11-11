// `agent-autoloop runs`: the finished runs before the few `status` shows, so `why` can be given a number. It pages through
// /v1/state the way any owner's client can; picking one rule is done here, so the protocol stays as it is.
import { finished, runRows } from "./status.ts";

type Page = (before?: number) => Promise<any>;

/**
 * Up to `want` finished runs, newest first, older than `before` and of `rule` when given. `more` is where the next list
 * starts, or null when there's nothing older.
 */
export async function findRuns(
  page: Page,
  { rule, before, want = 20 }: { rule?: string; before?: number; want?: number },
) {
  const runs: any[] = [];
  let cursor = before;
  let first: any;
  for (;;) {
    const state = await page(cursor);
    first ??= state;
    // The newest page also carries every run still unsettled, however old; each is read on its own page instead.
    const own = state.runs.filter((run: any) => state.nextBefore === null || run.id >= state.nextBefore);
    const matching = own.filter((run: any) => finished(run) && (rule === undefined || run.rule === rule));
    for (const run of matching) {
      if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
      runs.push(run);
    }
    if (!state.hasMore) return { state: first, runs, more: null };
    if (runs.length === want) return { state: first, runs, more: runs.at(-1).id as number };
    cursor = state.nextBefore;
  }
}

export function runsText(
  found: Awaited<ReturnType<typeof findRuns>>,
  { rule, color, columns }: { rule?: string; color: boolean; columns?: number },
) {
  if (!found.runs.length) return rule === undefined ? "还没有做完的轮次。" : `规则「${rule}」没有做完的轮次。`;
  const lines = runRows(found.state, found.runs, { color, columns });
  lines.push("", "细节：agent-autoloop why <第几轮>");
  if (found.more !== null) {
    const named = rule === undefined ? "" : ` ${/^[^\s"'\\$`]+$/.test(rule) ? rule : JSON.stringify(rule)}`;
    lines.push(`更早的：agent-autoloop runs${named} --before ${found.more}`);
  }
  return lines.join("\n");
}
