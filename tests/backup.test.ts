// Failure modes: a backup or its check fails on a real hub's database, whose indexes call functions only the hub has; a backup
// taken while the hub runs misses what's in the WAL; a restore leaves the old WAL beside the new database, or drops what's only
// in the WAL of the folder it reads; a broken master.key or database is restored; a failed restore loses what it replaced, its
// WAL included; restoring runs while anything has the database open, a hub started some other way or between requests
// included; a database too broken to read stops the restore that would replace it; a restore runs without being confirmed.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { powershell, psQuote } from "../host/command.ts";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { at, setup } from "./helpers.ts";

const home = setup("backup");
const hub = await import("./hub.ts");
const { backup, restore } = await import("../cli/backup.ts");

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-backup-"));
after(() => {
  if (hub.db.isOpen) hub.db.close();
  rmSync(scratch, { recursive: true, force: true });
});
let folders = 0;
const folder = () => {
  const made = join(scratch, `folder-${++folders}`);
  mkdirSync(made);
  return made;
};
const privateMode = (file: string, expected: number) => {
  if (process.platform !== "win32") return assert.equal(statSync(file).mode & 0o777, expected);
  const allowed = powershell(
    `$acl = [IO.${statSync(file).isDirectory() ? "Directory" : "File"}]::GetAccessControl(${psQuote(file)}); ($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) -join ','`,
  ).split(",");
  const owner = powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  assert.ok(allowed.length && allowed.every((sid) => sid === owner || sid === "S-1-5-18"), allowed.join(","));
};
const rows = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n;
  } finally {
    db.close();
  }
};
const key = "k".repeat(43);

/** A database with one row in its file and another only in its WAL, as a hub that was killed leaves it. */
function withWal(into: string) {
  const live = new DatabaseSync(join(scratch, `live-${++folders}.db`));
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(seq INTEGER PRIMARY KEY); INSERT INTO facts VALUES (1);");
  live.exec("PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO facts VALUES (2);");
  const name = live.location()!;
  copyFileSync(name, join(into, "hub.db"));
  copyFileSync(`${name}-wal`, join(into, "hub.db-wal"));
  live.close();
  writeFileSync(join(into, "master.key"), `${key}\n`, { mode: 0o600 });
}

test("a real hub's data, backed up while it runs, comes back whole under its own key", async () => {
  hub.ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const target = join(folder(), "snapshot");
  const { files } = await backup(home, target);
  assert.ok(files.includes("hub.db") && files.includes("master.key"), files.join());
  privateMode(join(target, "hub.db"), 0o600);
  privateMode(join(target, "master.key"), 0o600);
  const { n } = hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!;
  assert.ok(n > 0);
  assert.equal(rows(join(target, "hub.db")), n);
  await assert.rejects(backup(home, target), /不是空的/);

  const other = folder();
  await restore(other, target);
  assert.equal(readFileSync(join(other, "master.key"), "utf8"), readFileSync(join(home, "master.key"), "utf8"));
  // Started on the restored files, as the hub would be: it opens, and it knows what the first one knew.
  const started = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const hub = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)});
       console.log(JSON.stringify(hub.stateOf().runs.map((run) => run.id)));`,
    ],
    { env: { ...process.env, AGENT_AUTOLOOP_HOME: other }, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(
    JSON.parse(started.stdout),
    hub.stateOf().runs.map((run: { id: number }) => run.id),
  );
});

test("a backup into an empty folder that's already there makes it private: it holds the keys", async () => {
  const target = join(folder(), "made-beforehand");
  mkdirSync(target);
  chmodSync(target, 0o755);
  await backup(home, target);
  privateMode(target, 0o700);
});

test("a restore keeps what it replaced, and the old WAL doesn't stay beside the new database", async () => {
  const source = folder();
  withWal(source);
  const target = folder();
  withWal(target);
  writeFileSync(join(target, "config.json"), "{}");
  const backedUp = join(folder(), "snapshot");
  await backup(source, backedUp);
  rmSync(join(target, "master.key"));
  writeFileSync(join(target, "master.key"), `${"z".repeat(43)}\n`);
  const { safety } = await restore(target, backedUp);
  assert.ok(!existsSync(join(target, "hub.db-wal")));
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(readFileSync(join(target, "master.key"), "utf8").trim(), key);
  privateMode(join(target, "hub.db"), 0o600);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), "{}", "what the backup doesn't have stays");
  assert.equal(rows(join(safety, "hub.db")), 2, "what it replaced is kept, WAL and all");
});

test("a folder with a WAL beside its database restores what's only in the WAL", async () => {
  const source = folder();
  withWal(source);
  const target = folder();
  await restore(target, source);
  assert.equal(rows(join(target, "hub.db")), 2);
});

test("a restore that fails halfway puts everything back, the WAL with its database", async () => {
  const target = folder();
  withWal(target);
  writeFileSync(join(target, "config.json"), "mine");
  const source = folder();
  withWal(source);
  mkdirSync(join(source, "config.json"));
  await assert.rejects(restore(target, source));
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), "mine");
  assert.deepEqual(
    readdirSync(target).filter((name) => name.startsWith("restore-before-")),
    [],
  );
});

test("a restore refuses a backup whose key or database is broken", async () => {
  const brokenKey = folder();
  withWal(brokenKey);
  writeFileSync(join(brokenKey, "master.key"), "short");
  const target = folder();
  await assert.rejects(restore(target, brokenKey), /master\.key 坏了/);

  const brokenDatabase = folder();
  writeFileSync(join(brokenDatabase, "hub.db"), "this isn't a database, not even close to one".repeat(100));
  writeFileSync(join(brokenDatabase, "master.key"), key);
  await assert.rejects(restore(target, brokenDatabase), /读不出来/);
  assert.deepEqual(readdirSync(target), [], "nothing was touched");
});

test("a restore refuses while anything has the database open, and only then", async () => {
  const good = folder();
  withWal(good);
  await assert.rejects(restore(home, good), /中台还在跑/, "a hub in this process");

  const target = folder();
  withWal(target);
  const holder = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(join(target, "hub.db"))});
       db.exec("PRAGMA journal_mode=WAL; INSERT INTO facts VALUES (3);");
       console.log("open");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(holder.stdout, "data");
  try {
    // Another process, idle between requests, that left no number anywhere: how a hub embedded in something else looks.
    await assert.rejects(restore(target, good), /中台还在跑/);
    assert.equal(rows(join(target, "hub.db")), 3, "nothing was touched");
  } finally {
    holder.kill("SIGKILL");
    await once(holder, "exit");
  }
  // Killed, it holds nothing any more, and what it wrote is still there for the copy that's kept.
  const { safety } = await restore(target, good);
  assert.equal(rows(join(target, "hub.db")), 2);
  assert.equal(rows(join(safety, "hub.db")), 3);
});

test("a database too broken to read doesn't stop the restore that would replace it", async () => {
  const good = folder();
  withWal(good);
  const target = folder();
  writeFileSync(join(target, "hub.db"), "this isn't a database, not even close to one".repeat(100));
  await restore(target, good);
  assert.equal(rows(join(target, "hub.db")), 2);
});

test("the commands write where they're told and ask before replacing anything", async () => {
  const machine = folder();
  await restore(machine, await backupOfHub());
  const cli = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: machine } },
    );
  const target = join(folder(), "snapshot");
  assert.match((await cli("backup", target)).stdout, /备份好了/);
  assert.ok(existsSync(join(target, "hub.db")));
  await assert.rejects(cli("backup", target), /不是空的/);
  await assert.rejects(cli("backup", "--wat"), /不认识的参数/);

  await assert.rejects(cli("restore", target), /--yes/);
  await assert.rejects(cli("restore"), /用法/);
  assert.match((await cli("restore", target, "--yes")).stdout, /恢复好了/);
});

async function backupOfHub() {
  const target = join(folder(), "snapshot");
  await backup(home, target);
  return target;
}
