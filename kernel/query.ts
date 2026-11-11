// Reading the view: what the decisions and the doors ask of it, and the shapes they hand out.
import { credential, type Environment } from "./credentials.ts";
import { rows, type Fact, type Row, type View } from "./evolve.ts";
import { ruleOf, type Rule, type Rules } from "./rules.ts";
import type { Job } from "../protocol/job.ts";

export function configuration(view: View, version?: number): Rules {
  const current = view.get("config", "rules");
  return (version === undefined || version === current?.version ? current : view.get("config", version))?.value;
}
/** The owner's pause that keeps a rule from taking work at this moment, if there is one. */
export function pauseOf(view: View, rule: Rule, now: number): Row | null {
  const row = view.get("pauses", rule.name);
  return row && (row.until === null || Date.parse(row.until) > now) ? row : null;
}

export const workerOf = (view: View, run: Row) => configuration(view, run.rules_version).agents[run.agent]?.worker;
export function agentsOf(view: View, worker: string) {
  const agents = Object.entries(configuration(view).agents);
  return agents.filter(([, agent]) => agent.worker === worker).map(([id]) => id);
}
export const workers = (view: View) =>
  new Set([
    ...Object.values(configuration(view)?.agents ?? {}).map((agent) => agent.worker),
    ...rows(view, "runs", { state: "claimed" }).map((run) => workerOf(view, run)!),
  ]);

/** What a worker's agents have on: runs in hand and runs ready to be claimed. */
export function waitingOn(view: View, worker: string, now: number) {
  return rows(view, "runs", { state: ["queued", "claimed"] }).filter(
    (run) => workerOf(view, run) === worker && (run.state === "claimed" || Date.parse(run.not_before) <= now),
  );
}

export function eventsOf(view: View, runId: number) {
  const links = rows(view, "run_events", { run_id: runId });
  return links.map((link) => view.get("events", link.event_id)!).sort((a, b) => a.id - b.id);
}

export function sourceOf(view: View, runId: number) {
  const sources = [...new Set(eventsOf(view, runId).map((event) => event.source))];
  return sources.length === 1 ? sources[0] : null;
}

/** The rules an event went to, and the ones that would have taken it but were paused. */
export function routingOf(event: Row) {
  const paused: string[] = JSON.parse(event.paused ?? "[]");
  return { routed: JSON.parse(event.routed).filter((name: string) => !paused.includes(name)), paused };
}

/**
 * What became of an event, for the source that sent it: every run it is in now, as retries can merge runs. A run's summary
 * and the events its receipt sent are what the Agent made of all its events, so only a run of this source's alone has them.
 */
export function eventOutcome(view: View, source: string, id: number) {
  const event = view.get("events", id);
  if (event?.source !== source || !event.sent) return null;
  const runs = rows(view, "run_events", { event_id: id })
    .map((link) => view.get("runs", link.run_id)!)
    .sort((a, b) => a.id - b.id);
  return {
    event: event.id,
    ...routingOf(event),
    runs: runs.map((run) => {
      const own = sourceOf(view, run.id) === source;
      const sent = (JSON.parse(run.emitted ?? "[]") as number[]).map((id) => view.get("events", id)!);
      return {
        run: run.id,
        rule: run.rule,
        state: run.state,
        attempts: run.attempts,
        error: run.error,
        finishedAt: run.finished_at,
        summary: own ? run.summary : null,
        events: own
          ? sent.map(({ key: id, type, subject, summary, detail, link }) => ({
              id,
              type,
              subject,
              summary,
              detail,
              link,
            }))
          : null,
      };
    }),
  };
}

/** The cards a run may close: open before it was claimed, from the same source and group. */
export function openInScope(view: View, run: Row) {
  const source = sourceOf(view, run.id);
  if (!source || !run.claimed_at) return [];
  return rows(view, "cards", { state: "open", grp: run.grp, source }).filter(
    (card) => card.created_at <= run.claimed_at,
  );
}

export function cardView(card: Row, env: Environment, ref: string | null = null, links = false) {
  const { id, version, kind, state, title, text, recommend, choice, answer, by, result } = card;
  const options: string[] = kind === "ask" ? JSON.parse(card.options) : state === "open" ? ["已处理"] : [];
  const link = links ? `${env.publicUrl.replace(/\/$/, "")}/c/${credential(env, "card", id, card.created_at)}` : null;
  const when = { createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at };
  return {
    id,
    version,
    ref,
    kind,
    state,
    title,
    text,
    options,
    recommend,
    choice,
    answer,
    by,
    result,
    link,
    rule: card.rule,
    ...when,
  };
}

export function jobOf(view: View, run: Row, env: Environment): Job {
  const rules = configuration(view, run.rules_version);
  const { name, cwd, skill, prompt, emits } = ruleOf(rules, run.rule)!;
  const { maxActive: _maxActive, ...agent } = rules.agents[run.agent];
  const events = eventsOf(view, run.id);
  const eventIds = events.map((event) => event.id);
  const thread = { rule: run.rule, lane: run.lane };
  const answers = rows(view, "cards", { ...thread, answer_event: eventIds });
  const timers = rows(view, "timers", { ...thread, event_id: eventIds });
  const waiting = rows(view, "timers", { ...thread, event_id: null });
  const decided = ["decided", "done"]
    .flatMap((state) => rows(view, "cards", { ...thread, state }, 20, true))
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  const timerView = (timer: Row) => ({ key: timer.key, about: timer.about, at: timer.at });
  return {
    run: run.id,
    token: credential(env, "run", run.id, run.issued),
    attempt: run.attempts + 1,
    rule: { name, cwd, skill, prompt, emits },
    agent: { ...agent, id: run.agent },
    session: run.session ?? run.resume,
    askFirst: rules.askFirst,
    context: {
      events: events.map(({ key: id, source, type, subject, summary, detail, link, received_at: receivedAt, hops }) => {
        const sourceName = rules.sources[source]?.name ?? source;
        return { id, source, sourceName, type, subject, summary, detail, link, receivedAt, hops: hops ?? 0 };
      }),
      answers: answers.map(({ id: card, title, options, choice, answer: text, about, by, decided_at: at }) => {
        const picked: string[] = JSON.parse(options);
        return {
          card,
          title,
          options: picked,
          choice,
          chosen: choice === null ? text : picked[choice],
          text,
          about,
          by,
          at,
        };
      }),
      timers: timers.map(timerView),
      waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)).map(timerView),
      open: openInScope(view, run).map(({ id, title, text, created_at }) => ({
        card: id,
        title,
        text,
        at: created_at,
      })),
      decided: decided
        .filter((card) => !answers.some((answer) => answer.id === card.id))
        .map(({ id, title, choice, answer, options, decided_at }) => {
          return { card: id, title, choice: choice === null ? answer : JSON.parse(options)[choice], at: decided_at };
        }),
    },
  };
}

export function cancels(view: View, worker: string): number[] {
  return rows(view, "runs", { state: "claimed" })
    .filter((run) => run.cancel_at !== null && workerOf(view, run) === worker)
    .map((run) => run.id);
}

export function unrouted(view: View, limit = 20) {
  return rows(view, "events", { routed: "[]" }, limit, true);
}

export const safeFact = (fact: Fact) => ({ ...fact, changes: fact.changes.filter(({ table }) => table !== "keys") });
