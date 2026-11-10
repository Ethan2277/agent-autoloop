// What the kernel reads in rules: their shape and which events a rule takes. The rules file is checked before it gets
// here, in protocol/rules.ts.
export type Access = "read" | "edit" | "full";
export type Source = { name: string; adapter?: string };
type AgentOptions = { model?: string; effort?: string; command?: string[]; program?: string; timeout?: number };
export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access };
export type Channel = { name: string; answerers?: string[]; links?: boolean };
export type Tell = "always" | "needed" | "never";
type EventFilter = { source: string; types: string[] };
type When = EventFilter | { cron: string };
type RuleWords = { skill?: string; prompt?: string };
type RuleOptions = RuleWords & { parallel?: number; resume?: boolean; emits?: EventFilter };
/** Without channels a rule's cards reach the default ones, or every channel if there are none; with them, only those. */
type Reach = { channels?: string[] };
/** Without parallel a rule's group runs one at a time; with it, each subject is its own thread, that many at once. */
export type Rule = RuleOptions &
  Reach & { name: string; when: When; to: string; cwd: string; group: string; tell: Tell };
/** A scheduled task that runs elsewhere (say, in the Claude app): the hub neither starts nor records it. With a cwd it can
 * also ask, and your answer goes on there like a round of a rule. */
export type Elsewhere = RuleWords & {
  name: string;
  source: string;
  to: string;
  cron: string;
  where: string;
  cwd?: string;
};
type Registered = { sources: Record<string, Source>; agents: Record<string, Agent>; channels: Record<string, Channel> };
export type Rules = Registered & {
  timezone: string;
  askFirst: string[];
  /** Where a card that names no channels of its own goes: a tell, the hub's own alerts, a rule without a list. */
  defaultChannels?: string[];
  rules: Rule[];
  elsewhere: Elsewhere[];
};

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule";

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
}
export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type));
export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;

/** The rule a run, card or timer names: a rule's own, or a task elsewhere's, which only your answers to it start. */
export function ruleOf(rules: Rules, name: string): Rule | undefined {
  const rule = rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  const task = rules.elsewhere.find((task) => task.name === name);
  if (!task?.cwd) return undefined;
  const { source, to, cwd, skill, prompt } = task;
  // No event type matches none: nothing that comes in starts it.
  return { name, when: { source, types: [] }, to, cwd, skill, prompt, group: name, tell: "needed" };
}
