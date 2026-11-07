// The hub is long-running. Upgrade node under Homebrew and the `Cellar` directory this process started from is
// deleted while it keeps working; ACP and delivery start every turn's child process with `process.execPath`, so from
// then on each turn fails with ENOENT until someone restarts the service. What is checked here: children are given
// the `opt` link beside the version, a version directory that no longer exists still resolves through that link, and
// a node outside Homebrew is left as it is.
// Failure modes: the Cellar path is handed to children; a deleted version path is kept even though `opt` resolves;
// the `opt` link is used when it resolves nowhere.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stablePath } from "../host/node-path.ts";
import acp from "../plugins/acp/agent.ts";
import delivery from "../plugins/delivery/agent.ts";

const scratch = mkdtempSync(join(tmpdir(), "node-path-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A Homebrew-shaped tree: `opt/<formula>` points into one of the versions under `Cellar`. */
function brew(formula: string, versions: string[], linked: string) {
  const root = mkdtempSync(join(scratch, `${formula}-`));
  for (const version of versions) {
    const bin = join(root, "Cellar", formula, version, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), "#!/bin/sh\n");
  }
  mkdirSync(join(root, "opt"), { recursive: true });
  symlinkSync(join(root, "Cellar", formula, linked), join(root, "opt", formula));
  return {
    roots: [root],
    bin: (version: string) => join(root, "Cellar", formula, version, "bin", "node"),
    opt: join(root, "opt", formula, "bin", "node"),
  };
}

test("the node this process runs is named by its opt link", () => {
  const tree = brew("node", ["26.13.0"], "26.13.0");
  assert.equal(stablePath(tree.bin("26.13.0"), tree.roots), tree.opt);
});

test("a version directory deleted by an upgrade still resolves through the link", () => {
  const tree = brew("node", ["24.1.0", "26.13.0"], "26.13.0");
  const old = tree.bin("24.1.0");
  rmSync(join(tree.roots[0], "Cellar", "node", "24.1.0"), { recursive: true, force: true });
  assert.equal(stablePath(old, tree.roots), tree.opt, "the deleted path would fail every turn");
});

test("a version that is still installed is left alone when the link has moved on", () => {
  const tree = brew("node", ["24.1.0", "26.13.0"], "26.13.0");
  assert.equal(stablePath(tree.bin("24.1.0"), tree.roots), tree.bin("24.1.0"));
});

test("a link that resolves nowhere doesn't take the place of the node that is running", () => {
  const tree = brew("node", ["26.13.0"], "26.13.0");
  rmSync(join(tree.roots[0], "Cellar", "node", "26.13.0"), { recursive: true, force: true });
  assert.equal(stablePath(tree.bin("26.13.0"), tree.roots), tree.bin("26.13.0"));
});

test("a node outside Homebrew is named as it is", () => {
  assert.equal(stablePath("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(stablePath("/opt/node/bin/node"), "/opt/node/bin/node");
});

test("ACP and delivery start their child with that path", () => {
  const turn = {
    prompt: "做这件事",
    session: "s",
    resume: null,
    cwd: "/x",
    access: "edit",
    contextFile: "/c",
    folder: "/f",
  };
  assert.equal(acp.command(turn as never)[0], stablePath(process.execPath));
  assert.equal(delivery.command(turn as never)[0], stablePath(process.execPath));
});
