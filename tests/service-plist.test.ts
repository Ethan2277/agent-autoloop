// The plist an install writes must never stay world-writable: launchd refuses to load a plist others can write, and
// says only "Bootstrap failed: 5: Input/output error". Failure modes: an install from a umask-0 shell (a GUI app's)
// writes the plist born world-writable and the service never starts; a later reinstall rewrites the bytes but keeps
// the mode, so the machine stays broken however many times it reinstalls.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("service-plist");
const person = join(home, "person");
const fakes = join(home, "fakes");
mkdirSync(person);
mkdirSync(fakes);
process.env.HOME = person;
process.env.PATH = `${fakes}:${process.env.PATH}`;
// `print` says no service is loaded, so the wait for the old one to be gone ends at once; the rest just succeed.
writeFileSync(
  join(fakes, "launchctl"),
  `#!/bin/sh
[ "$1" = "print" ] && exit 1
exit 0
`,
);
chmodSync(join(fakes, "launchctl"), 0o755);
Object.defineProperty(process, "platform", { value: "darwin" });
const { installService } = await import("../host/service.ts");

const agents = join(person, "Library", "LaunchAgents");

test("a plist born world-writable is repaired by the next install, not just rewritten", () => {
  const umask = process.umask(0o000);
  try {
    installService(); // the incident: an install whose files are born world-writable
  } finally {
    process.umask(umask);
  }
  const [name] = readdirSync(agents);
  assert.match(name!, /^agent-autoloop.*\.plist$/);
  chmodSync(join(agents, name!), 0o666); // what the broken install left on the machine
  installService(); // a reinstall must fix the file, not only its contents
  assert.equal(statSync(join(agents, name!)).mode & 0o777, 0o644);
});
