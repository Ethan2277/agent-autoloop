// The hub's inputs by name, for tests and measuring scripts. What runs for real takes them at the doors in kernel/http.ts,
// through `execute`. Import it after the environment is set, as host/runtime.ts has to be.
import { db, execute, getView, rules, type KeyKind } from "../host/runtime.ts";
import { evolve, keyOf, rows, type Row, type Table } from "../kernel/evolve.ts";
import * as query from "../kernel/query.ts";
import type { Job } from "../protocol/job.ts";
import type { Rejected } from "../protocol/validate.ts";

export * from "../host/runtime.ts";
export { RulesError } from "../protocol/rules.ts";

export const ruleNamed = (name: string) => rules.rules.find((rule) => rule.name === name);

type EventAck = { event: number; duplicate: boolean; routed: string[] };
export const ingest = (source: string, input: unknown, now = Date.now()): EventAck =>
  execute("ingest", [source, input], now);
export const claimNext = (worker: string, claim: string, now = Date.now()): Job | null =>
  execute("claimNext", [worker, claim], now);
export const heartbeat = (worker: string, running: number[], now = Date.now()) =>
  execute("heartbeat", [worker, running], now);
export const started = (run: number, token: string, input: unknown, now = Date.now()) =>
  execute("started", [run, token, input], now);
type ReceiptAck = { rejected: Rejected[]; duplicate?: boolean };
export const finish = (run: number, token: string, input: unknown, now = Date.now()): ReceiptAck =>
  execute("finish", [run, token, input], now);
export const cancel = (run: number, now = Date.now()) => execute("cancel", [run], now);
export const cancels = (worker: string) => query.cancels(getView(), worker);
export const sweep = (now = Date.now()) => execute("sweep", [], now);

export const createCard = (spec: Row, now = Date.now()) => execute("createCard", [spec], now);
type CardAck = { card: number; duplicate: boolean };
export const tell = (key: string, title: string, text: string, now = Date.now()): CardAck =>
  execute("tell", [key, title, text], now);
export const ask = (task: string, question: object, now = Date.now()): CardAck => execute("ask", [task, question], now);
type Answer = { choice?: number; text?: string; by?: string; channel?: string; ref?: string };
type Answered = { changed: boolean; state: string; card?: ReturnType<typeof query.cardView> };
export const answer = (id: number, given: Answer, now = Date.now()): Answered => execute("answer", [id, given], now);
export const resolve = (id: number, reason: string, by: string, now = Date.now()): boolean =>
  execute("resolve", [id, reason, by], now);
export const nextCard = (channel: string, now = Date.now()): ReturnType<typeof query.cardView> | null =>
  execute("nextCard", [channel], now);
export const delivered = (channel: string, id: number, version: number, ref: string | null, now = Date.now()) =>
  execute("delivered", [channel, id, version, ref], now);
export const failed = (channel: string, id: number, version: number, error: string, now = Date.now()) =>
  execute("failed", [channel, id, version, error], now);
export const removeKey = (kind: KeyKind, name: string) => execute("removeKey", [kind, name]) as boolean;

/** Empties a table to reset a fixture: no fact says so, which nothing that runs for real may do. */
export function fixtureClear(table: Table) {
  const latest = getView();
  const changes = rows(latest, table).map((row) => ({ table, key: keyOf(table, row), row: null }));
  evolve(latest, [{ version: 1, seq: latest.seq, at: 0, type: "fixture", changes }], db);
}
