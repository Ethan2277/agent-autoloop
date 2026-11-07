// `backup` and `restore`: the database, the key that signs card links, and the files that say what this machine is.
// A backup is taken while the hub runs; a restore needs it stopped, because it replaces the file that is open.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { backup as copyPages, DatabaseSync } from "node:sqlite";
import { privateDirectory } from "../host/files.ts";

const DB = "hub.db";
const KEY = "master.key";
const FILES = [KEY, "config.json", "rules.json", "secrets.env"];
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A copy as of one point, WAL and all, of a database that may be in use. It copies pages because VACUUM INTO rebuilds the
 * indexes, and the hub's call functions only the hub has.
 */
async function copyDatabase(from: string, to: string) {
  const source = new DatabaseSync(from);
  try {
    await copyPages(source, to);
  } finally {
    source.close();
  }
  chmodSync(to, 0o600);
}

/** Writes a backup folder nothing exists in yet: the database first, then whichever of the files are there. */
export async function backup(home: string, target: string) {
  const database = path.join(home, DB);
  if (!existsSync(database)) throw new Error("还没装好：先运行 agent-autoloop init");
  if (existsSync(target) && readdirSync(target).length) throw new Error(`备份目录不是空的：${target}`);
  privateDirectory(target);
  await copyDatabase(database, path.join(target, DB));
  const files = [DB];
  for (const name of FILES) {
    const from = path.join(home, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, path.join(target, name));
    chmodSync(path.join(target, name), 0o600);
    files.push(name);
  }
  return { target, files };
}

function readableBackup(source: string) {
  const database = path.join(source, DB);
  const key = path.join(source, KEY);
  if (!existsSync(database) || !existsSync(key)) throw new Error(`这个目录不像备份：缺 ${DB} 或 ${KEY}`);
  if (!KEY_SHAPE.test(readFileSync(key, "utf8").trim())) throw new Error("备份里的 master.key 坏了");
  let result: unknown;
  try {
    const check = new DatabaseSync(database);
    try {
      // Not integrity_check: that one evaluates the indexes too, and so needs the hub's functions.
      result = Object.values(check.prepare("PRAGMA quick_check").get() ?? {})[0];
    } finally {
      check.close();
    }
  } catch {}
  if (result !== "ok") throw new Error("备份里的 hub.db 读不出来");
}

/** Whether anything has the database open, a hub between requests included: only then is this lock out of reach. */
function inUse(database: string) {
  if (!existsSync(database)) return false;
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    return false;
  } catch (error) {
    // One that can't be read at all isn't in use: that may be why it's being restored.
    return /locked/.test(String(error));
  } finally {
    db.close();
  }
}

/** Puts a backup back in place, keeping what it replaced. */
export async function restore(home: string, source: string) {
  if (inUse(path.join(home, DB))) {
    throw new Error("中台还在跑：先停掉它（例如 agent-autoloop service remove，或手动停服务），再恢复");
  }
  readableBackup(source);
  privateDirectory(home);
  const safety = path.join(home, `restore-before-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(safety, { mode: 0o700 });
  // The WAL belongs to the file that's leaving: a stale one next to the restored database would be applied to it. A file
  // the backup doesn't have stays as it is.
  const replaced = [DB, `${DB}-wal`, `${DB}-shm`, ...FILES.filter((name) => existsSync(path.join(source, name)))];
  for (const name of replaced) {
    const from = path.join(home, name);
    if (existsSync(from)) renameSync(from, path.join(safety, name));
  }
  try {
    await copyDatabase(path.join(source, DB), path.join(home, DB));
    for (const name of replaced.filter((name) => FILES.includes(name))) {
      copyFileSync(path.join(source, name), path.join(home, name));
      chmodSync(path.join(home, name), 0o600);
    }
  } catch (error) {
    // Half a restore is worse than none: everything goes back as it was, the WAL with its database.
    for (const name of replaced) {
      rmSync(path.join(home, name), { force: true });
      if (existsSync(path.join(safety, name))) renameSync(path.join(safety, name), path.join(home, name));
    }
    rmSync(safety, { recursive: true });
    throw error;
  }
  return { safety };
}
