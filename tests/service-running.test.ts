// Which service runs this on a machine. Failure cases: doctor says a service running from a system-level unit isn't
// running; an update takes that unit for its own, writes a user-level one beside it, and fails where there's no user
// manager or starts a second hub where there is; a user-level service isn't restarted by an update; a Mac is asked about
// systemd; a service just started counts as done before its hub answers, so the command run next finds nothing there.
// The fake systemctl stands in for both managers, and no test installs anything real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("service-running");
const person = join(home, "person");
const fakes = join(home, "fakes");
const calls = join(home, "calls");
mkdirSync(person);
mkdirSync(fakes);
process.env.HOME = person;
process.env.PATH = `${fakes}:${process.env.PATH}`;
const actual = process.platform;
const onLinux = () => Object.defineProperty(process, "platform", { value: "linux" });
onLinux();
const { restartService, serviceRunning, systemUnit, untilAnswering } = await import("../host/service.ts");

/** `system` and `user` are the units running; without a user manager every --user call fails, as it does for root. */
function systemctl({ system = false, user = false, manager = true }) {
  rmSync(calls, { force: true });
  writeFileSync(
    join(fakes, "systemctl"),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "is-active "*) exit ${system ? 0 : 3} ;;
  "--user is-active") ${user ? "echo active; exit 0" : "echo inactive; exit 3"} ;;
  --user*) exit ${manager ? 0 : 1} ;;
esac
`,
  );
  chmodSync(join(fakes, "systemctl"), 0o755);
}
const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const userUnits = join(person, ".config", "systemd", "user");

test("a system-level unit running counts for what's running, and isn't taken for a service of ours", () => {
  systemctl({ system: true, manager: false });
  assert.equal(serviceRunning(), false);
  assert.match(systemUnit()!, /^agent-autoloop/);
});

test("an update leaves a system-level unit to its owner, and says how to restart it", () => {
  systemctl({ system: true, manager: false });
  const said = restartService()!;
  assert.match(said, /systemctl restart agent-autoloop/);
  assert.ok(!called().some((call) => call.includes("daemon-reload") || call.includes("enable")));
  assert.equal(existsSync(userUnits), false, "no second unit beside it");
});

test("an update restarts a user-level service as before", () => {
  systemctl({ user: true });
  assert.equal(restartService(), undefined);
  assert.ok(called().includes("--user daemon-reload"));
  assert.ok(called().some((call) => call.startsWith("--user restart ")));
  rmSync(userUnits, { recursive: true, force: true });
});

test("a service just started is waited for until its hub answers; one its manager doesn't have isn't", async () => {
  systemctl({ user: true });
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const url = `http://127.0.0.1:${port}`;
  const hub = createServer((_, response) => response.end("{}"));
  const starting = setTimeout(() => hub.listen(port, "127.0.0.1"), 300);
  try {
    assert.equal(await untilAnswering(url), true);
  } finally {
    clearTimeout(starting);
    hub.close();
  }
  assert.equal(await untilAnswering(url, 300), false, "one that never answers is given up on, and said so");
  systemctl({});
  const asked = Date.now();
  assert.equal(await untilAnswering(url), null, "nothing to wait for");
  assert.ok(Date.now() - asked < 2_000);
});

test("with no service at all an update starts none and says nothing", () => {
  systemctl({});
  assert.equal(restartService(), undefined);
  assert.equal(existsSync(userUnits), false);
});

test("a Mac isn't asked about systemd", { skip: actual !== "darwin" }, () => {
  systemctl({ system: true });
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    assert.equal(systemUnit(), null);
    assert.deepEqual(called(), []);
  } finally {
    onLinux();
  }
});

test("doctor says a system-level unit is running", () => {
  systemctl({ system: true, manager: false });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:9", worker: { name: "w", key: "k" } }),
  );
  const onLinuxFirst = `data:text/javascript,Object.defineProperty(process,"platform",{value:"linux"})`;
  const doctor = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      onLinuxFirst,
      join(import.meta.dirname, "..", "bin", "agent-autoloop.ts"),
      "doctor",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.match(doctor.stdout, /● 系统级服务在跑/);
  assert.doesNotMatch(doctor.stdout, /系统服务没在跑/);
});
