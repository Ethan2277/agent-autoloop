// What's going on, for the owner's own clients, read from what's there: rules, cards, runs and who has been seen. Nothing
// is decided by it, so it's no part of the kernel.
import type { SQLInputValue } from "node:sqlite";
import { describeCron, dayStart, nextRun, parseCron } from "../kernel/cron.ts";
import { SEEN_EVERY } from "../kernel/due.ts";
import { iso, type Row } from "../kernel/evolve.ts";
import type { cardView } from "../kernel/query.ts";
import { cronOf, eventRule, SCHEDULE, type Rules } from "../kernel/rules.ts";

/** The columns of the read-only SQL views over the projections, which the queries here read. */
const VIEWS = {
  events: "id source key type subject summary detail link routed paused received_at",
  runs:
    "id rule agent grp lane state attempts not_before claim last_result cancel_at resume session link created_at " +
    "claimed_at seen_at finished_at manual summary error usage",
  run_events: "run_id event_id",
  cards:
    "id key kind title text options recommend about state fyi quiet choice answer by result rule lane grp source " +
    "agent session run_id answer_event version created_at decided_at closed_at",
  deliveries: "card_id channel version ref tries first_try_at not_before error given_up",
  timers: "id rule lane key source agent session about at event_id created_at",
  schedules: "rule cron next_at skipped_at",
  seen: "kind name seen_at",
  keys: "kind name hash created_at",
  pauses: "name by reason since until",
};

/** Made anew at every start, so changing them takes no rebuild and no migration. */
export const viewStatements = Object.entries(VIEWS).map(([table, columns]) => {
  const selected = columns.split(" ").map((column) => `json_extract(data,'$.${column}') AS ${column}`);
  return `DROP VIEW IF EXISTS ${table}; CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`;
});

/** Seen this recently counts as online: two minutes of quiet, by a stamp that can be behind by SEEN_EVERY. */
const ONLINE = 120_000 + SEEN_EVERY;
const PAGE = 60;
const WEEK = 7 * 86400_000;

export type Spending = { rounds: number; tokens: number; cost: number; missingTokens: number; missingCost: number };
const SPENDING = `SELECT COUNT(*) AS rounds,
  COALESCE(SUM(COALESCE(json_extract(usage, '$.input'), 0) + COALESCE(json_extract(usage, '$.output'), 0)), 0) AS tokens,
  COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost,
  COUNT(*) - COUNT(COALESCE(json_extract(usage, '$.input'), json_extract(usage, '$.output'))) AS missingTokens,
  COUNT(*) - COUNT(json_extract(usage, '$.cost')) AS missingCost
  FROM runs WHERE finished_at >= ? AND (claimed_at IS NOT NULL OR usage IS NOT NULL)`;

const COUNTS = `
  SELECT rule, agent, state, COUNT(*) AS count,
    SUM(CASE WHEN state = 'queued' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
    SUM(CASE WHEN state = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS today,
    COALESCE(SUM(json_extract(usage, '$.input')), 0) AS input,
    COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output,
    COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost
  FROM runs GROUP BY rule, agent, state`;

// Start from this run's links; scanning events in ID order would revisit the whole history for each run.
const EVENTS_OF_RUN = `
  SELECT source, type, subject, summary, link FROM run_events CROSS JOIN events ON events.id = run_events.event_id
  WHERE run_events.run_id = ? ORDER BY events.id DESC LIMIT 20`;

type Reads = {
  all: <T>(sql: string, params?: SQLInputValue[]) => T[];
  view: (card: Row) => ReturnType<typeof cardView>;
  unrouted: () => Row[];
};

const sum = (counted: Row[], field: string): number => counted.reduce((total, row) => total + row[field], 0);

export function spendingOf(all: Reads["all"], now: number, timezone: string) {
  const since = (time: number) => all<Spending>(SPENDING, [iso(time)])[0];
  return { today: since(dayStart(now, timezone)), week: since(now - WEEK) };
}

function tally(counted: Row[]) {
  const inState = (state: string) => counted.reduce((total, row) => total + (row.state === state ? row.count : 0), 0);
  return {
    running: inState("claimed"),
    queued: inState("queued"),
    retrying: sum(counted, "retrying"),
    unknown: inState("unknown"),
    done: inState("done"),
    doneToday: sum(counted, "today"),
    nothing: inState("nothing"),
    usage: { input: sum(counted, "input"), output: sum(counted, "output"), cost: sum(counted, "cost") },
  };
}

// Events a pause kept from a rule: only those carry the field. A range on it, and +id, keep to that index instead of
// walking every event by id.
const SKIPPED = `SELECT id, source, type, subject, summary, paused, received_at FROM events
  WHERE paused > '' ORDER BY +id DESC LIMIT 20`;

export function stateOf(now: number, before: number | undefined, rules: Rules, { all, view, unrouted }: Reads) {
  const seen = new Map(
    all<Row>("SELECT kind, name, seen_at FROM seen").map((row) => [`${row.kind}:${row.name}`, row.seen_at as string]),
  );
  const presence = (who: string) => {
    const seenAt = seen.get(who) ?? null;
    return { seenAt, online: seenAt !== null && now - Date.parse(seenAt) <= ONLINE };
  };
  const counts = all<Row>(COUNTS, [iso(dayStart(now, rules.timezone))]);
  const openCards = all<Row>("SELECT * FROM cards WHERE state = 'open' ORDER BY id DESC");
  const recentCards = all<Row>("SELECT * FROM cards WHERE state <> 'open' ORDER BY id DESC LIMIT 20");
  const timers = before
    ? []
    : all<Row>("SELECT rule, lane, key, about, at FROM timers WHERE event_id IS NULL ORDER BY at");
  const older = before ? "WHERE id < ?" : "";
  const page = all<Row>(
    `SELECT * FROM runs ${older} ORDER BY id DESC LIMIT ?`,
    before ? [before, PAGE + 1] : [PAGE + 1],
  );
  const active = before ? [] : all<Row>("SELECT * FROM runs WHERE state IN ('queued', 'claimed', 'unknown')");
  const hasMore = page.length > PAGE;
  const byId = new Map([...page.slice(0, PAGE), ...active].map((run) => [run.id, run]));
  const visible = [...byId.values()].sort((a, b) => b.id - a.id);
  // A pause past its end is lifted at the next tick; until then it already doesn't hold.
  const pauses = all<Row>("SELECT name, by, reason, since, until FROM pauses ORDER BY name").filter(
    (pause) => pause.until === null || Date.parse(pause.until) > now,
  );
  const pauseOf = (rule: Rules["rules"][number]) => {
    const pause = pauses.find((p) => p.name === rule.name);
    return pause ? { by: pause.by, reason: pause.reason, since: pause.since, until: pause.until } : null;
  };
  const skippedAt = new Map(
    all<Row>("SELECT rule, skipped_at FROM schedules").map((row) => [row.rule, row.skipped_at]),
  );
  return {
    now: iso(now),
    timezone: rules.timezone,
    spending: spendingOf(all, now, rules.timezone),
    totals: { ...tally(counts), attention: openCards.length },
    // The owner's own: which matter a card is about, and what its asker left for whoever carries on. Channels don't get them.
    cards: openCards.map((card) => ({ ...view(card), lane: card.lane, about: card.about })),
    recentCards: recentCards.map((card) => ({ ...view(card), lane: card.lane, about: card.about })),
    timers: timers.map(({ rule, lane, key, about, at }) => ({ rule, lane, key, about, at })),
    sources: Object.entries(rules.sources).map(([id, { name }]) => {
      const events = all<Row>("SELECT COUNT(*) AS n FROM events WHERE source = ?", [id])[0].n as number;
      return { id, name, events };
    }),
    lines: rules.rules.map((rule) => ({
      id: rule.name,
      name: rule.name,
      group: rule.group,
      agent: rule.to,
      source: eventRule(rule) ? rule.when.source : SCHEDULE,
      types: eventRule(rule) ? rule.when.types : [],
      every: eventRule(rule) ? null : describeCron(cronOf(rule)),
      next: eventRule(rule) ? null : iso(nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!),
      totals: tally(counts.filter((row) => row.rule === rule.name)),
      paused: pauseOf(rule),
      skippedAt: eventRule(rule) ? null : (skippedAt.get(rule.name) ?? null),
    })),
    pauses,
    skipped: all<Row>(SKIPPED).map(({ paused, received_at: receivedAt, ...event }) => ({
      ...event,
      receivedAt,
      rules: JSON.parse(paused),
    })),
    elsewhere: rules.elsewhere.map(({ name, source, to, cron, where }) => {
      const next = iso(nextRun(parseCron(cron)!, now, rules.timezone) ?? now);
      return { id: name, name, source, agent: to, cron, every: describeCron(cron), next, where };
    }),
    agents: Object.entries(rules.agents).map(([id, { name, use, worker, program }]) => {
      const totals = tally(counts.filter((row) => row.agent === id));
      return { id, name, use, worker, ...(program && { program }), ...presence(`worker:${worker}`), totals };
    }),
    channels: Object.entries(rules.channels).map(([id, { name }]) => ({ id, name, ...presence(`channel:${id}`) })),
    runs: visible.map((run) => ({
      id: run.id as number,
      rule: run.rule,
      agent: run.agent,
      state: run.state,
      attempts: run.attempts,
      createdAt: run.created_at,
      claimedAt: run.claimed_at,
      finishedAt: run.finished_at,
      notBefore: run.not_before,
      summary: run.summary ?? "",
      error: run.error ?? "",
      link: run.link ?? "",
      session: run.session,
      usage: run.usage ? JSON.parse(run.usage) : null,
      stopping: run.cancel_at !== null,
      manual: Boolean(run.manual),
      events: all<Row>(EVENTS_OF_RUN, [run.id]),
    })),
    hasMore,
    nextBefore: hasMore ? page[PAGE - 1].id : null,
    unrouted: unrouted(),
  };
}
