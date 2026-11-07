// Failure modes: the worker cannot run ps at all (the sandbox forbids it, or it is missing or not executable), and it
// reports a run that is still going as finished because the failed lookup was read as "the process is gone"; or, unable
// to look, it holds a stuck or stopped run forever because its timeout and its stop wait on a sighting that never comes;
// or it holds back the result of a run that has ended, stopping a process group it can't see anything left in; or, unable
// to see a group it stopped itself because the turn was over, it throws away the answer the turn gave and the hub runs
// the work again. Or, waiting on a slow lookup (PowerShell takes over a second to start on Windows), it holds up the
// hub that shares its process, so the state, the stream and answers to cards stall while any run is going.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-look-"));
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

/** Put a ps in front of the real one that answers the question the way a gone process does. */
function psSaysGone() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * Put a ps in front of the real one that fails the way one that cannot run does. A file without the execute bit would
 * not do: the lookup skips it and finds the real ps further along PATH, so outside a sandbox the test would check nothing.
 */
function psCannotRun() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 126\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function workerThatReports(results: any[], job: any, now: () => number = Date.now) {
  let claimed = false;
  return createWorker({
    name: "test",
    wait: 0,
    now,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

/** Each run gets its own number so one run's exit file is never read as another's. */
function jobFor(run: number, seconds: number, timeout?: number) {
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "lookup", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      timeout,
      command: ["/bin/sh", "-c", `sleep ${seconds}`],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("looking at a run's process holds up nothing else in the process", async () => {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nsleep 0.5\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(18, 2));
  await worker.tick();
  let beats = 0;
  const beat = setInterval(() => beats++, 20);
  try {
    await worker.tick();
  } finally {
    clearInterval(beat);
  }
  assert.ok(beats >= 10, `the process was held up while it looked: ${beats} beats in half a second`);
});

test("a run whose process is gone is reported as finished", async () => {
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(12, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});

test("a run that is gone with no exit, and a group that can't be looked at, is reported without waiting", async () => {
  // Still really going, so there's no exit file whatever the machine's speed: only the lookup says it's gone.
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(16, 1));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "it was held back");
});

test("a run that failed, and a group that can't be looked at, is reported without waiting", async () => {
  psCannotRun();
  const results: any[] = [];
  const job = jobFor(17, 0);
  job.agent.command = ["/bin/sh", "-c", "echo boom >&2; exit 3"];
  const worker = workerThatReports(results, job);
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "it was held back");
  assert.match(results[0].error, /退出码 3：boom/);
});

test("a run that cannot be looked up is not reported as finished", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(11, 30));
  for (let i = 0; i < 60 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 0, "the run was reported before it finished");
  process.kill(-JSON.parse(readFileSync(join(home, "worker", "runs", "11-1", "entry.json"), "utf8")).pid, "SIGKILL");
});

test("a stuck run that cannot be looked up still times out and is reported", async () => {
  psCannotRun();
  const results: any[] = [];
  let moment = Date.now();
  const worker = workerThatReports(results, jobFor(15, 30, 1), () => moment);
  await worker.tick();
  await worker.tick();
  assert.equal(results.length, 0, "the run was reported before its timeout");
  moment += 61_000;
  await worker.tick();
  moment += 11_000;
  for (let i = 0; i < 20 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the timed-out run was never reported");
});

test("a run that cannot be looked up is reported once its exit file shows up", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(14, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});

const runs = join(home, "worker", "runs");

/** A child in a process group of its own, the way a run's shell is started. */
function ownGroup() {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.unref();
  const pid = child.pid!;
  return {
    pid,
    gone,
    kill: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    },
  };
}

/** A run that was already stopped, so that only confirming its group gone is left to do. */
function stoppedRun(run: number, pid: number, how: object = { why: "cancel" }) {
  const dir = join(runs, `${run}-1`);
  mkdirSync(dir, { recursive: true });
  const entry = {
    run,
    token: "test-token",
    attempt: 1,
    job: jobFor(run, 30),
    dir,
    prompt: "p",
    turn: 1,
    session: "s",
    resume: null,
    repairs: 0,
    triedFresh: false,
    pid,
    launchedAt: Date.now() - 60_000,
    stopping: Date.now() - 20_000,
    ...how,
  };
  writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Claims nothing: these tests are about runs that are already in hand. */
function idleWorker(results: any[]) {
  return createWorker({
    name: "test",
    wait: 0,
    hub: {
      work: async () => ({ job: null, cancel: [] }),
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

test("a stopped run whose group can't be seen is reported as failed, never as cancelled", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(18, group.pid);
  const results: any[] = [];
  const originalKill = process.kill;
  try {
    process.kill = ((target: number, signal?: string | number) => {
      if (target === -group.pid) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    await idleWorker(results).tick();
  } finally {
    process.kill = originalKill;
    group.kill();
    clean();
  }
  assert.equal(results.length, 1, "the run was never handed in");
  assert.equal(
    results[0].outcome,
    "failed",
    "cancelled would release the item while a process may still be running in it",
  );
  assert.match(String(results[0].error), /没能确认/, "the reason has to say what wasn't seen");
});

test("a stopped run whose group is gone is cancelled even when ps can't run", async () => {
  psCannotRun();
  const group = ownGroup();
  group.kill();
  await group.gone;
  const clean = stoppedRun(19, group.pid);
  const results: any[] = [];
  try {
    await idleWorker(results).tick();
  } finally {
    clean();
  }
  assert.equal(results[0]?.outcome, "cancelled", "a group that is gone is a stop that can be confirmed");
});

test("a stopped run whose group is still there is not handed in until it has gone", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(20, group.pid);
  const results: any[] = [];
  const worker = idleWorker(results);
  try {
    await worker.tick();
    assert.equal(results.length, 0, "reported before the group was seen gone");
    await group.gone;
    await worker.tick();
  } finally {
    clean();
    group.kill();
  }
  assert.equal(results[0]?.outcome, "cancelled", "the stop was confirmed once the group had gone");
});

test("a run stopped because its turn was over keeps its answer when its group can't be seen", async () => {
  psCannotRun();
  const group = ownGroup();
  const clean = stoppedRun(21, group.pid, { why: "finished", finishedAt: Date.now() - 30_000 });
  writeFileSync(join(runs, "21-1", "stdout-1.log"), "做完了");
  const results: any[] = [];
  const originalKill = process.kill;
  try {
    process.kill = ((target: number, signal?: string | number) => {
      if (target === -group.pid) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    await idleWorker(results).tick();
  } finally {
    process.kill = originalKill;
    group.kill();
    clean();
  }
  assert.equal(results.length, 1, "the run was never handed in");
  assert.notEqual(results[0].outcome, "failed", "a failed run is tried again, and the work it did is done twice");
  assert.match(String(results[0].summary), /做完了/);
});
