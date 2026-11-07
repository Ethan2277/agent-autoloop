// The hub on this machine: its database, the view kept from the log, the rules file, and one way to apply an input.
// Importing this opens them all, which is why the checks that must survive a bad rules file import it late.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HOME, RULES_FILE } from "./home.ts";
import { privateDirectory } from "./files.ts";
import { stateOf as state, viewStatements } from "./state.ts";
import { cardHash, digest, whose as keyHolder } from "../kernel/credentials.ts";
import { decide } from "../kernel/decide.ts";
import { NotFound } from "../kernel/errors.ts";
import { initialize, rows, statement, type Fact, type Row, type Table } from "../kernel/evolve.ts";
import * as query from "../kernel/query.ts";
import { commitLatest, openView } from "../kernel/store.ts";
import { parseRules as checkRules, RulesError } from "../protocol/rules.ts";

privateDirectory(HOME);
const masterKeyFile = join(HOME, "master.key");
if (!existsSync(masterKeyFile)) {
  writeFileSync(masterKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
}
const masterKey = readFileSync(masterKeyFile, "utf8").trim();
// An empty or cut-short key would still sign links, and card links derive from what channels see. Replacing it would
// void every link and token, so that is left to the owner.
if (!/^[A-Za-z0-9_-]{43}$/.test(masterKey)) {
  throw new Error(
    `${masterKeyFile} 坏了（应该是 43 个字符），中台不启动。从备份恢复这个文件；没有备份就删掉它，` +
      "重启会生成新的，但已经发出的卡片链接和正在跑的轮次会失效。",
  );
}
export const environment = {
  secret: masterKey,
  publicUrl: process.env.AGENT_AUTOLOOP_PUBLIC_URL ?? "",
};

export const db = new DatabaseSync(join(HOME, "hub.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
db.function("card_hash", { deterministic: true }, (id, at) => cardHash(environment, id, at));
initialize(db);

// Other processes must see either the old views or the new ones, never the gap between DROP and CREATE.
db.exec(`BEGIN IMMEDIATE; ${viewStatements.join(";")}; COMMIT`);

const CARD_HASH_INDEX =
  "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'";

// The persisted projection is expendable; the log alone rebuilds it, which an upgrade has to wait for. So only the files that
// decide what's stored count here, whole, since what they do is spread across helpers and constants. The views above are
// made anew at every start and need no rebuild.
const format = digest(
  ["../kernel/evolve.ts", "../kernel/credentials.ts"]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n") +
    CARD_HASH_INDEX +
    digest(environment.secret),
);
let current = openView(db, format);
db.exec(CARD_HASH_INDEX);

export const all = <T>(sql: string, params: SQLInputValue[] = []) =>
  db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }) as T);

export const one = <T>(sql: string, params: SQLInputValue[] = []) => {
  const row = db.prepare(sql).get(...params);
  return row ? ({ ...row } as T) : undefined;
};

export function getView() {
  current = openView(db, format);
  return current;
}

type Listener = (type: string, facts: Fact[]) => void;
const listeners = new Set<Listener>();

export const onChange = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function execute(type: string, args: any[], now = Date.now()) {
  let facts: Fact[] = [];
  let value: any;
  current = commitLatest(db, format, (latest) => {
    ({ facts, value } = decide(latest, { type, args }, now, environment));
    return facts;
  });
  if (facts.length) for (const listener of listeners) listener(type, facts);
  return value;
}

export const parseRules = (json: string, now = Date.now()) =>
  checkRules(json, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
export let rules = query.configuration(current);

export function reloadRules(file = RULES_FILE): { problem?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { problem: unreadable(file, error as NodeJS.ErrnoException) };
  }
  try {
    const next = parseRules(text);
    const differs = JSON.stringify(next) !== JSON.stringify(query.configuration(getView()));
    const reportedBroken = (card: Row) => card.key.startsWith("rules:") && card.state === "open";
    if (differs || rows(current, "cards", { state: "open" }).some(reportedBroken)) execute("rules", [next]);
    rules = next;
    return {};
  } catch (error) {
    if (error instanceof RulesError) return { problem: error.message };
    throw error;
  }
}

function unreadable(file: string, error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return `找不到 ${file}，被删掉或移走了？放回去就会接着用`;
  if (error.code === "EACCES" || error.code === "EPERM") return `没有权限读 ${file}，改回能读的权限就会接着用`;
  return `读不到 ${file}：${error.code ?? error.message}`;
}

const initial = reloadRules();
if (!rules) throw new Error(initial.problem ?? "缺少规则");

let toldOf: string | undefined;

export function tick(now = Date.now()) {
  const { problem } = reloadRules();
  // A file still gone or still wrong is a problem at every tick, and an owner who closed the card has heard.
  if (problem && problem !== toldOf) execute("rulesError", [problem], now);
  toldOf = problem;
  execute("tick", [], now);
}

export function cardByToken(token: string) {
  const row = statement(
    db,
    "SELECT data FROM projections WHERE collection='cards' AND card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))=?",
  ).get(digest(token));
  return row ? (JSON.parse(String(row.data)) as Row) : undefined;
}

export const view = (card: Row, ref: string | null = null, links = false) =>
  query.cardView(card, environment, ref, links);
export const unrouted = (limit = 20) => query.unrouted(getView(), limit);
/** Read in one snapshot: its seq is where the log stood for all of it, for a client to go on in /v1/stream from. */
export function stateOf(now = Date.now(), before?: number) {
  db.exec("BEGIN");
  try {
    const latest = getView();
    return { seq: latest.seq, ...state(now, before, query.configuration(latest), { all, view, unrouted }) };
  } finally {
    db.exec("COMMIT");
  }
}

export type KeyKind = "source" | "worker" | "channel" | "owner";
export const keepKeyHash = (kind: KeyKind, name: string, hash: string, now = Date.now()) =>
  execute("key", [kind, name, hash], now);

export function addKey(kind: KeyKind, name: string, now = Date.now()) {
  const key = randomBytes(32).toString("base64url");
  keepKeyHash(kind, name, digest(key), now);
  return key;
}

export const listKeys = () =>
  all<{ kind: string; name: string; created_at: string }>("SELECT kind,name,created_at FROM keys ORDER BY kind,name");
export const whose = (kind: string, key: string) => keyHolder(getView(), kind, key);
export const logAfter = (after = 0, limit = -1) =>
  db
    .prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(after, limit)
    .map((row) => query.safeFact(JSON.parse(String(row.fact))));

/** The part of the log that explains one run: its events, cards and receipts, and the rules it ran under. */
export function why(id: number) {
  const latest = getView();
  if (!latest.get("runs", id)) throw new NotFound("没有这一轮");
  const events = query.eventsOf(latest, id).map((event) => event.id);
  const cards = [...rows(latest, "cards", { run_id: id }), ...rows(latest, "cards", { answer_event: events })];
  const sequences = new Set<number>();
  const include = (table: Table, key: string | number) => {
    for (const row of statement(db, "SELECT seq FROM projection_refs WHERE collection=? AND key=?").all(
      table,
      String(key),
    ))
      sequences.add(Number(row.seq));
  };
  include("runs", id);
  const read = (seq: number): Fact =>
    JSON.parse(String(statement(db, "SELECT fact FROM facts WHERE seq=?").get(seq)!.fact));
  for (const seq of [...sequences])
    for (const change of read(seq).changes)
      if (change.table === "runs" && change.key === String(id) && change.row?.rules_version)
        sequences.add(change.row.rules_version);
  for (const event of events) include("events", event);
  for (const card of cards) include("cards", card.id);
  return [...sequences].sort((a, b) => a - b).map((seq) => query.safeFact(read(seq)));
}
