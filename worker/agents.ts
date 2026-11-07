// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { findOnPath } from "../host/command.ts";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  /** The program a built-in plugin starts instead of the one it finds: a wrapper that sets things up and runs it. */
  program?: string;
  contextFile: string;
  folder: string;
};
export type Reading = {
  text?: string;
  session?: string;
  /** What this launch used. */
  usage?: Usage;
  /** What the session has used so far, for amounts the program only gives that way. */
  sessionUsage?: Usage;
  error?: string;
  /** Its turn is over, though it may not have exited. */
  finished?: boolean;
  /** It has this turn's prompt, in a conversation that's there. From here on the work may be half done. */
  started?: boolean;
};
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in, as `program` if its rules name one: what's wrong, in words a person can act on, or nothing. */
  check?(program?: string): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

const found = new Map<string, string | null>();

/** Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  if (!found.has(name)) {
    let onPath: string | null = null;
    if (process.platform === "win32") onPath = findOnPath(name, [".exe", ".com", ".cmd", ".ps1"]);
    else {
      try {
        const printed = execFileSync(process.env.SHELL ?? "/bin/sh", ["-lc", `command -v ${name}`], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        onPath = printed.trim().split("\n").at(-1) || null;
      } catch {}
    }
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
