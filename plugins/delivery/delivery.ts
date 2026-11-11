// One pull request from label to live: review, full check, merge, Ship, health. Every step reads GitHub's state back
// rather than trusting its own last response, and a failure is left for the hub's retry to pick up where it stands.
import { settings, type Live, type Settings } from "./project.ts";
import type { Finding, Reviewed } from "./review.ts";

export type DeliveryIO = {
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Reviewed>;
  verifyReview?(pr: any, config: Settings, main: string): Promise<Reviewed>;
  merge(pr: any, config: Settings): Promise<void>;
  enableAuto?(pr: any): Promise<void>;
  disableAuto(number: number): Promise<void>;
  verifyTools?(head: string): Promise<string | null>;
  contains(base: string, head: string): Promise<boolean>;
  prepareShip?(): void | Promise<void>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
  reviewStatus?: string;
  report?: DeliveryReport;
};
export type DeliveryPhase =
  | "accepted"
  | "reviewing"
  | "checking"
  | "merging"
  | "shipping"
  | "live"
  | "merged"
  | "reviewed"
  | "returned"
  | "withdrawn"
  | "retrying"
  | "docs_only";
export type DeliveryReport = (
  phase: DeliveryPhase,
  head: string,
  metadata?: { merge?: string; ship?: number; detail?: string },
) => void | Promise<void>;
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[]; head?: string };

export class DeliveryRefusal extends Error {
  readonly head?: string;

  constructor(message: string, head?: string) {
    super(message);
    this.head = head;
  }
}

export class DeliverySuperseded extends Error {}

const FINDINGS = "审查发现问题，修复后推新提交才会重审";
const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((label: any) => label.name));
const newestFirst = (a: any, b: any) => b.id - a.id;

export const status = (io: DeliveryIO, head: string, context: string, state: string, description: string) =>
  io.api(`statuses/${head}`, { state, context, description: [...description].slice(0, 140).join("") }, "POST");

export async function disableAuto(number: number, io: DeliveryIO) {
  let cause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch (error) {
      /* A lost mutation response must be read back, not assumed. */
      cause = error;
    }
    try {
      if (!(await io.api(`pulls/${number}`)).auto_merge) return;
    } catch (error) {
      /* Known failure: a failed read-back must still confirm cancellation within three attempts. */
      cause = error;
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("无法确认自动合并已关闭", { cause });
}

async function newestCheck(head: string, config: Settings, io: DeliveryIO) {
  const query = `head_sha=${head}&event=pull_request&per_page=100`;
  const { workflow_runs: runs } = await io.api(`actions/workflows/${config.check.workflow}/runs?${query}`);
  return runs.filter((run: any) => run.head_sha === head && run.event === "pull_request").sort(newestFirst)[0];
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
  after = 0,
): Promise<"passed" | "waiting" | "failed"> {
  const { job } = config.check;
  const run = await newestCheck(head, config, io);
  if (!run || run.id <= after) return "waiting";
  const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter(
    (candidate: any) => candidate.name === job || candidate.name.startsWith(`${job} (`),
  );
  if (!jobs.length) return "waiting";
  if (run.status === "completed" && run.conclusion !== "success") return "failed";
  const finished = (item: any) => item.status === "completed" && item.conclusion === "success";
  return finished(run) && jobs.every(finished) ? "passed" : "waiting";
}

export async function waitLive(merged: string, config: Settings, io: DeliveryIO, head?: string) {
  if (!config.health) return;
  if (head) await io.report?.("shipping", head, { merge: merged });
  await io.prepareShip?.();
  const query = "branch=main&event=push&per_page=100";
  let ship: number | undefined;
  for (;;) {
    const { workflow_runs } = await io.api(`actions/workflows/${config.ship.workflow}/runs?${query}`);
    const runs = workflow_runs.sort(newestFirst);
    const covering = [];
    for (const run of runs) if (run.event === "push" && (await io.contains(merged, run.head_sha))) covering.push(run);
    const newest = covering[0];
    if (head && newest && newest.id !== ship) {
      ship = newest.id;
      await io.report?.("shipping", head, { merge: merged, ship });
    }
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (run.status !== "completed" || run.conclusion !== "success") continue;
        const liveHasIt = await io.contains(run.head_sha, live.sha);
        if (liveHasIt) return { phase: "live" as const, ship: run.id as number, release: live.release };
        if (!(await io.releaseRequired(live.sha, run.head_sha, config.internal)))
          return { phase: "docs_only" as const, ship: run.id as number, release: live.release };
      }
    }
    if (newest?.status === "completed" && newest.conclusion !== "success") {
      throw new DeliveryRefusal(`已经合并，发布没有通过：${newest.html_url}。修复发布后重交原改动。`, head);
    }
    await io.wait();
  }
}

async function clearLabels(number: number, pr: any, io: DeliveryIO) {
  // A retry goes by what's left on. A merged PR only goes on to its release while it has `deliver`; an open one with `deliver`
  // alone is a full delivery, so a review-only one must lose `deliver-review` last or the retry merges it.
  const order = pr.merged_at ? ["deliver-review", "deliver"] : ["deliver", "deliver-review"];
  for (const label of ["deliver-attended", ...order]) {
    if (!labels(pr).has(label)) continue;
    try {
      await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    } catch (error) {
      // GitHub returned 404 after an observed labelled PR had already completed Ship; verify the desired state.
      if (labels(await io.api(`pulls/${number}`)).has(label)) throw error;
    }
  }
}

async function synced(number: number, head: string, base: string, io: DeliveryIO) {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const pr = await io.api(`pulls/${number}`);
    if (pr.merged_at) return pr;
    if (pr.head.sha !== head && (await io.contains(base, pr.head.sha))) return pr;
    if (Date.now() > until) throw new Error("已请求同步 main，15 分钟内没有看到同步后的提交，稍后重试");
    await io.wait();
  }
}

export async function deliver(
  repo: string,
  number: number,
  io: DeliveryIO,
  testLocalHealth = false,
): Promise<Delivered> {
  const reviewOnly = async (pr: any): Promise<Delivered> => {
    const summary = "审查通过，未合并或发布";
    await status(io, pr.head.sha, "delivery", "success", summary);
    await clearLabels(number, pr, io);
    await io.report?.("reviewed", pr.head.sha);
    return { summary, reviewOnly: true };
  };
  const withdrawn = async (head: string): Promise<Delivered> => {
    await status(io, head, "delivery", "success", "交付标记已撤回，未合并或发布");
    await io.report?.("withdrawn", head);
    return { summary: "交付标记已撤回" };
  };
  let pr = await io.api(`pulls/${number}`);
  if (!labels(pr).has("deliver") || (!pr.merged_at && pr.state !== "open")) return { summary: "没有待交付的标记" };
  if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main")
    throw new DeliveryRefusal("只处理本仓库分支到 main 的合并请求", pr.head.sha);
  if (pr.auto_merge) await disableAuto(number, io);
  let head = pr.head.sha;
  const accept = async () => {
    await status(io, head, "delivery", "pending", "正在审查、检查和核实发布");
    await io.report?.("accepted", head);
  };
  if (io.verifyReview) await accept();
  const settingsAt = async (commit: string) => {
    const file = await io.api(`contents/ops/delivery.json?ref=${commit}`);
    const read = settings(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")), testLocalHealth);
    if (read.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
    if (io.reviewStatus) read.review.status = io.reviewStatus;
    return read;
  };
  let config = await settingsAt((await io.api("git/ref/heads/main")).object.sha);
  if (!pr.merged_at && !io.verifyReview) {
    // The label stays on after findings, so another event lands here: a second review that misses them would merge the commit.
    // The review status keeps the record, since a failed round writes its error over `delivery`.
    const { statuses } = await io.api(`commits/${head}/status?per_page=100`);
    if (statuses.some((item: any) => item.context === config.review.status && item.state === "failure"))
      return { summary: "这个提交审查发现过问题，修复后推新提交才会重审" };
  }
  if (!io.verifyReview) await accept();
  // Sync inside the run: a thrown sync waits out the hub's growing retry backoff while main keeps moving.
  rounds: for (let round = 1; !pr.merged_at; round++) {
    if (pr.mergeable === false || pr.mergeable_state === "dirty")
      throw new DeliveryRefusal("改动与 main 有合并冲突，请先解决后重新交付。", head);
    let base = (await io.api("git/ref/heads/main")).object.sha;
    if (!(await io.contains(base, head))) {
      try {
        await io.api(`pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT");
      } catch (error) {
        const live = await io.api(`pulls/${number}`);
        if (!live.merged_at && live.head.sha === head) throw error;
      }
      pr = await synced(number, head, base, io);
      if (pr.merged_at) break;
      if (!(await io.contains(head, pr.head.sha)))
        throw new DeliverySuperseded("同步后的分支不包含原来的提交，等待重新交付");
      head = pr.head.sha;
      await status(io, head, "delivery", "pending", "已同步 main，正在审查、检查和核实发布");
      // GitHub syncs with main as it is by then, which may be newer than what was read above: against the older one, those
      // commits would be reviewed as the branch's own.
      base = (await io.api("git/ref/heads/main")).object.sha;
      if (!(await io.contains(base, head))) {
        if (round < 3) continue;
        throw new Error("main 已前进，稍后重新同步和检查");
      }
    }
    // The settings of the main this round is against: a newer one may add the health check its release has to pass.
    config = await settingsAt(base);
    const reviewed = await io.review(pr, config, base);
    const exempt = !Array.isArray(reviewed) && "exempt" in reviewed ? reviewed.exempt : null;
    const findings = Array.isArray(reviewed) ? reviewed : [];
    const current = await io.api(`pulls/${number}`);
    if (current.merged_at) {
      pr = current;
      break;
    }
    if (current.head.sha !== head) throw new DeliverySuperseded("审查期间提交变了，等待重新交付");
    if (!Array.isArray(reviewed) && "blocked" in reviewed) {
      await status(io, head, config.review.status, "failure", reviewed.blocked);
      throw new DeliveryRefusal(reviewed.blocked, head);
    }
    if (!Array.isArray(reviewed) && "changed" in reviewed) {
      pr = current;
      continue;
    }
    if (findings.length) {
      await status(io, head, "delivery", "failure", FINDINGS);
      // Last: once this stands nothing reviews the commit again, so a failed write must not keep the findings from going out.
      await status(io, head, config.review.status, "failure", FINDINGS);
      return { summary: "审查发现问题，尚未合并", findings, head };
    }
    if (labels(current).has("deliver-review")) {
      if (!exempt) return reviewOnly(current);
      // Asked for after this round let the change through without a review: the next round reviews it.
      pr = current;
      continue;
    }
    await io.report?.("checking", head);
    let after = 0;
    if (current.draft) {
      // Right after going ready the newest run is still a draft one: only a run started by the change can pass.
      after = (await newestCheck(head, config, io))?.id ?? 0;
      await io.api(`pulls/${number}/ready`, {}, "POST");
    }
    let merging = false;
    let autoRequested = false;
    const stopAuto = async () => {
      if (pr.auto_merge || autoRequested) {
        await disableAuto(number, io);
        pr.auto_merge = null;
        autoRequested = false;
      }
    };
    try {
      for (;;) {
        const state = await fullCheck(head, config, io, after);
        pr = await io.api(`pulls/${number}`);
        if (pr.merged_at) break rounds;
        if (pr.head.sha !== head) {
          throw new DeliverySuperseded("检查期间提交变了，等待重新交付");
        }
        if (pr.base.ref !== "main" || pr.state !== "open") {
          throw new DeliveryRefusal("改动已关闭或目标分支已变更，只合并到 main。", head);
        }
        if (pr.mergeable === false || pr.mergeable_state === "dirty") {
          throw new DeliveryRefusal("改动与 main 有合并冲突，请先解决后重新交付。", head);
        }
        if (!labels(pr).has("deliver")) {
          await stopAuto();
          return withdrawn(head);
        }
        if (labels(pr).has("deliver-review")) {
          await stopAuto();
          if (!exempt && !io.verifyReview) return reviewOnly(pr);
          continue rounds;
        }
        if (state === "failed") {
          throw new DeliveryRefusal(`完整检查没有通过。查看 https://github.com/${repo}/pull/${number}/checks`, head);
        }
        if (state === "passed" || pr.auto_merge) {
          if ((await io.api("git/ref/heads/main")).object.sha !== base) {
            await stopAuto();
            if (round < 3) continue rounds;
            throw new Error("main 已前进，稍后重新同步和检查");
          }
          const behind = await io.verifyTools?.(head);
          if (behind) throw new DeliveryRefusal(behind, head);
          const verified = await io.verifyReview?.(pr, config, base);
          if (verified) {
            if (!Array.isArray(verified) && "blocked" in verified) {
              await stopAuto();
              await status(io, head, config.review.status, "failure", verified.blocked);
              throw new DeliveryRefusal(verified.blocked, head);
            }
            const recheckedExempt = !Array.isArray(verified) && "exempt" in verified ? verified.exempt : null;
            if ((!Array.isArray(verified) && "changed" in verified) || recheckedExempt !== exempt) {
              await stopAuto();
              continue rounds;
            }
          }
          if (state === "passed" && !pr.auto_merge) {
            const checked = pr;
            pr = await io.api(`pulls/${number}`);
            if (pr.merged_at) break rounds;
            if (pr.head.sha !== head) throw new DeliverySuperseded("要合并的提交变了，等待重新交付");
            if (pr.base.ref !== "main" || pr.state !== "open")
              throw new DeliveryRefusal("改动已关闭或目标分支已变更，只合并到 main。", head);
            if (!labels(pr).has("deliver")) {
              await stopAuto();
              return withdrawn(head);
            }
            if (pr.body !== checked.body || labels(pr).has("deliver-review") || pr.auto_merge) {
              await stopAuto();
              continue rounds;
            }
            const passed = exempt
              ? `${exempt} 写的改动按策略免审`
              : !Array.isArray(reviewed) && "docsOnly" in reviewed
                ? "只改内部文档，按策略免审"
                : "此提交审查通过";
            await status(io, head, config.review.status, "success", `${passed}，完整检查通过`);
            if (!merging) await io.report?.("merging", head);
            merging = true;
            const auto = io.enableAuto && !config.admin_merge.includes(pr.user.login) ? io.enableAuto : undefined;
            try {
              if (auto) {
                autoRequested = true;
                await auto(pr);
              } else await io.merge(pr, config);
            } catch (error) {
              // The request can be accepted before its response is lost. Read back before any retry.
              pr = await io.api(`pulls/${number}`);
              if (!pr.merged_at && !(auto && pr.auto_merge)) throw error;
            }
            pr = await io.api(`pulls/${number}`);
            if (pr.merged_at) break rounds;
            if (!auto || !pr.auto_merge) throw new Error("尚未确认合并，稍后继续核实");
          }
        }
        await io.wait();
      }
    } catch (error) {
      await stopAuto();
      throw error;
    }
  }
  const merge = pr.merge_commit_sha;
  const shipped = await waitLive(merge, config, io, pr.head.sha);
  const summary = !shipped
    ? "已合并；项目没有线上服务"
    : shipped.phase === "docs_only"
      ? `仅内部文档变化，已合并，无需发布。已核实线上版本 ${shipped.release}`
      : `已发布并核实线上版本 ${shipped.release}`;
  await status(io, pr.head.sha, "delivery", "success", summary);
  await clearLabels(number, pr, io);
  await io.report?.(shipped?.phase ?? "merged", pr.head.sha, { merge, ship: shipped?.ship });
  return { summary, merged: merge };
}
