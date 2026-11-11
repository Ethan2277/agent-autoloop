// What's waiting for delivery, as events: each labelled item, with an id that stays the same until something changes.
import { github, pages } from "./github.ts";
import { hasLabel, unattendedFailure } from "./handoff.ts";
import { pendingEvents } from "./input.ts";

export async function poll(repo: string, dispatch = false) {
  const api = github(repo);
  const rows = [];
  const order = dispatch ? "&sort=created&direction=asc" : "";
  for (const label of ["deliver", "ask-owner"]) {
    for (const issue of pages(repo, `issues?state=all&labels=${label}&per_page=100${order}`)) {
      if (!issue.pull_request && issue.state !== "open") continue;
      const events = pages(repo, `issues/${issue.number}/events?per_page=100`);
      const marked = events.filter((event) => event.event === "labeled" && event.label?.name === label).at(-1);
      const pr = issue.pull_request ? await api(`pulls/${issue.number}`) : null;
      if (!dispatch && pr?.state === "closed" && !pr.merged_at) continue;
      rows.push({
        number: issue.number,
        head: pr?.head.sha ?? "",
        // One item without a readable record must not hold up the others.
        labelEvent: marked?.id ?? 0,
        kind: pr ? "pull_request" : "issues",
      });
    }
  }
  const events = pendingEvents(repo, rows);
  if (!dispatch) return events;
  const prefix = `delivery.${repo.toLowerCase().replace("/", ".")}`;
  const pending = events.map((event) => ({
    ...event,
    type: `${prefix}.${event.type === "pull_request.labeled" ? "pr" : "issue"}`,
  }));
  for (const issue of pages(repo, "issues?state=all&labels=deliver-attended&per_page=100")) {
    if (!issue.pull_request || hasLabel(issue, "deliver")) continue;
    const pr = await api(`pulls/${issue.number}`);
    if (!hasLabel(pr, "deliver-attended") || hasLabel(pr, "deliver")) continue;
    const { statuses } = await api(`commits/${pr.head.sha}/status?per_page=100`);
    const failure = statuses.find((item: any) => item.context === "delivery");
    if (!unattendedFailure(pr.labels, failure)) continue;
    pending.push({
      id: `${repo}#${issue.number}:unacknowledged:${failure.id}:${pr.head.sha}`,
      type: `${prefix}.unacknowledged`,
      subject: `${repo}#${issue.number}`,
      link: pr.html_url,
    });
  }
  return pending;
}

if (import.meta.main) {
  const [, , first, ...rest] = process.argv;
  const dispatch = first === "--dispatch";
  const repos = dispatch ? rest : [first];
  if (!repos.length) throw new Error("请指定至少一个 owner/name 仓库");
  const results = await Promise.allSettled(repos.map((repo) => poll(repo, dispatch)));
  const events = results
    .flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      if (!dispatch) throw result.reason;
      console.error(`${repos[index]} 的交付标签暂时读不到，下轮再查`);
      return [];
    })
    .slice(0, 100);
  console.log(`看过了，${events.length} 件待处理\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``);
}
