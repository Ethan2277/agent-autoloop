// The delivery's way to GitHub: the signed-in `gh`, and bare Git objects fetched into a scratch folder.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { DeliveryIO } from "./delivery.ts";
import { git, liveRelease, releaseRequired, REPO } from "./project.ts";
import { declaredAgent, reviewSnapshot } from "./review.ts";

const LONGEST_WAIT = 1800000;

export function gh(args: string[], input?: object) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  return execFileSync("gh", args, {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function github(repo: string) {
  if (!REPO.test(repo)) throw new Error("仓库要写成 owner/name");
  return async (path: string, body?: any, method = body === undefined ? "GET" : "POST") => {
    const ready = /^pulls\/(\d+)\/ready$/.exec(path);
    if (ready) {
      gh(["pr", "ready", ready[1], "--repo", repo]);
      return {};
    }
    const text = gh(
      ["api", `repos/${repo}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])],
      body,
    );
    return text ? JSON.parse(text) : {};
  };
}

export function pages(repo: string, path: string): any[] {
  if (!REPO.test(repo)) throw new Error("仓库要写成 owner/name");
  return JSON.parse(gh(["api", `repos/${repo}/${path}`, "--paginate", "--slurp"])).flat();
}

export function createIO(repo: string, folder: string): DeliveryIO {
  const api = github(repo);
  const bare = join(folder, "objects.git");
  const started = Date.now();
  let initialized = false;
  const fetchObjects = (...refs: string[]) => {
    if (!initialized) {
      mkdirSync(bare, { recursive: true });
      git(bare, "init", "--bare", "--template=");
      git(bare, "remote", "add", "origin", `https://github.com/${repo}.git`);
      initialized = true;
    }
    git(bare, "fetch", "--no-tags", "origin", ...refs);
  };
  const ancestors = new Map<string, boolean>();
  return {
    api,
    async review(pr, config, main) {
      fetchObjects(main, pr.head.sha);
      const { agents, trusted } = config.review;
      const statuses = (sha: string) => pages(repo, `commits/${sha}/statuses?per_page=100`);
      const source = {
        agent: Object.keys(agents).length ? declaredAgent(bare, main, pr.head.sha, pr.number, trusted, statuses) : null,
        required: pr.labels.some((label: any) => label.name === "deliver-review"),
      };
      return reviewSnapshot(bare, join(folder, `review-${pr.head.sha}`), main, pr.head.sha, config, source);
    },
    async merge(pr, config) {
      if (config.admin_merge.includes(pr.user.login)) {
        const number = String(pr.number);
        gh(["pr", "merge", number, "--repo", repo, "--squash", "--admin", "--match-head-commit", pr.head.sha]);
        return;
      }
      const result = await api(`pulls/${pr.number}/merge`, { sha: pr.head.sha, merge_method: "squash" }, "PUT");
      if (!result.merged) throw new Error("GitHub 没有接受合并");
    },
    async disableAuto(number) {
      gh(["pr", "merge", String(number), "--repo", repo, "--disable-auto"]);
    },
    async contains(base, head) {
      if (base === head) return true;
      const key = `${base}:${head}`;
      if (!ancestors.has(key)) {
        const { status } = await api(`compare/${base}...${head}`);
        ancestors.set(key, ["ahead", "identical"].includes(status));
      }
      return ancestors.get(key)!;
    },
    async releaseRequired(base, head, patterns) {
      let full = base;
      try {
        // A health check may report a short commit, and a fetch only takes a full one.
        if (base.length < 40) full = (await api(`commits/${base}`)).sha;
        fetchObjects(full, head);
      } catch {
        return true;
      }
      return releaseRequired(bare, full, head, patterns);
    },
    live: liveRelease,
    async wait() {
      if (Date.now() - started > LONGEST_WAIT) throw new Error("等待超过半小时，保留远端状态，稍后继续核实");
      await setTimeout(5000);
    },
  };
}
