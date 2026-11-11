import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { question } from "./input.ts";

const retryKey = "delivery-retry";
const retryInterval = 60_000;
const acknowledgeWithin = 180_000;
type Label = { name: string };
type Status = { state: string; description: string; created_at: string };
type Timer = { key: string; about?: string; at?: string };
type RetryState = { head: string; github: number; execution: number };

export const hasLabel = (issue: { labels: Label[] }, name: string) => issue.labels.some((label) => label.name === name);

export function unattendedFailure(labels: Label[], last: Status | undefined, now = Date.now()) {
  return (
    hasLabel({ labels }, "deliver-attended") &&
    !hasLabel({ labels }, "deliver") &&
    last?.state === "failure" &&
    now - Date.parse(last.created_at) >= acknowledgeWithin
  );
}

function retryState(timers: Timer[]): RetryState | undefined {
  const saved = timers.find((timer) => timer.key === retryKey)?.about;
  return saved ? JSON.parse(saved) : undefined;
}

export const retryHead = (timers: Timer[]) => retryState(timers)?.head ?? "";

export function retryHandoff(timers: Timer[], head: string, hiccup: boolean, now = Date.now(), canReturn = true) {
  const previous = retryState(timers);
  const count = previous?.head === head ? previous : { head, github: 0, execution: 0 };
  const kind = hiccup ? "github" : "execution";
  const limit = hiccup ? 60 : 5;
  count[kind] = Math.min(count[kind] + 1, limit);
  if (count[kind] === limit && canReturn) return null;
  return { key: retryKey, at: new Date(now + retryInterval).toISOString(), about: JSON.stringify(count) };
}

export function runHook(program: string, data: object, timeout: number) {
  const executable = program.startsWith("~/") ? join(homedir(), program.slice(2)) : program;
  execFileSync(executable, [], { input: JSON.stringify(data), stdio: ["pipe", "ignore", "pipe"], timeout });
}

const matter = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 64);

export function tellReturn(program: string, repo: string, number: number, head: string, reason: string) {
  const key = matter(`${repo.split("/")[1]}.${number}.${head.slice(0, 12)}`);
  const url = `https://github.com/${repo}/pull/${number}`;
  const text = question({ number, title: "", body: reason, html_url: url }).text.slice(0, 300);
  runHook(program, { key, text: `上线流程停在 ${repo} 的第 ${number} 项改动。\n${text}\n${url}` }, 60_000);
}

export function tellQuestion(program: string, repo: string, issue: Parameters<typeof question>[0]) {
  const { text, title } = question(issue);
  const key = matter(`ask.${repo.split("/")[1]}.${issue.number}`);
  const body = text === issue.html_url ? "" : `${text.slice(0, 600)}\n`;
  runHook(program, { key, text: `云端有件事需要你决定。\n${title}\n${body}${issue.html_url}` }, 60_000);
}
