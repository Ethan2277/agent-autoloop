// One delivery run: `node run.ts owner/name`, reading its event from AGENT_AUTOLOOP_CONTEXT and printing a receipt.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createIO, gh, isGitHubHiccup, type DeliveryOptions } from "./github.ts";
import { deliver, DeliveryRefusal, DeliverySuperseded, disableAuto, status, type DeliveryIO } from "./delivery.ts";
import { deliveryReceipt, question, receiptBlock, subjectNumber } from "./input.ts";
import { hasLabel, retryHandoff, retryHead, runHook, tellQuestion, tellReturn, unattendedFailure } from "./handoff.ts";

type Options = DeliveryOptions & { progressCommand?: string; notifyCommand?: string; direct?: boolean };
type Context = Parameters<typeof subjectNumber>[1] & {
  answers?: unknown[];
  timers?: Parameters<typeof retryHandoff>[0];
};
type HandoffResult = { text: string; exit?: 1 | 2; retry?: NonNullable<ReturnType<typeof retryHandoff>> };

async function handoff(
  repo: string,
  number: number,
  context: Context,
  io: DeliveryIO,
  options: Options,
  testLocalHealth: boolean,
): Promise<HandoffResult> {
  const timers = context.timers ?? [];
  let head = retryHead(timers);
  let pr: any;
  const notify = options.notifyCommand;
  const sendBack = async (reason: string, detail: string): Promise<HandoffResult> => {
    const current = await io.api(`pulls/${number}`);
    if (head && current.head.sha !== head) return { text: "提交已更新，下一轮处理新提交", exit: 2 };
    if (!hasLabel(current, "deliver")) return { text: "没事可做：交付标记已撤掉", exit: 2 };
    head = current.head.sha;
    if (current.auto_merge) await disableAuto(number, io);
    if (!hasLabel(current, "deliver-attended") && notify) tellReturn(notify, repo, number, head, reason);
    await status(io, head, "delivery", "failure", reason);
    gh(["pr", "edit", String(number), "--repo", repo, "--remove-label", "deliver,deliver-review"]);
    await io.report?.("returned", head, { detail });
    return { text: `交付退回：${reason}`, exit: 1 };
  };
  try {
    const issue = await io.api(`issues/${number}`);
    if (!issue.pull_request) {
      if (!notify || issue.state !== "open" || !hasLabel(issue, "ask-owner"))
        return { text: "没事可做：没有待转告的问题", exit: 2 };
      tellQuestion(notify, repo, issue);
      await io.api(`issues/${number}/labels/ask-owner`, undefined, "DELETE");
      return { text: "已转告需要处理的问题" };
    }
    pr = await io.api(`pulls/${number}`);
    head = pr.head.sha;
    if (!hasLabel(pr, "deliver")) {
      if (notify && hasLabel(pr, "deliver-attended")) {
        const { statuses } = await io.api(`commits/${head}/status?per_page=100`);
        const latest = statuses.find((item: any) => item.context === "delivery");
        if (unattendedFailure(pr.labels, latest)) {
          tellReturn(notify, repo, number, head, latest.description);
          gh(["pr", "edit", String(number), "--repo", repo, "--remove-label", "deliver-attended"]);
          return { text: "已转告无人领取的交付结果" };
        }
      }
      return { text: "没事可做：没有待交付的标记", exit: 2 };
    }
    if (pr.state === "closed" && !pr.merged_at) {
      await status(io, head, "delivery", "failure", "合并请求已关闭，未合并或发布");
      gh(["pr", "edit", String(number), "--repo", repo, "--remove-label", "deliver,deliver-review,deliver-attended"]);
      await io.report?.("returned", head, { detail: "closed" });
      return { text: "没事可做：合并请求已关闭", exit: 2 };
    }
    const result = await deliver(repo, number, io, testLocalHealth);
    if (result.findings?.length) {
      head = result.head ?? head;
      return await sendBack(result.summary, "review");
    }
    return { text: result.summary, exit: result.merged || result.reviewOnly ? undefined : 2 };
  } catch (error) {
    if (error instanceof DeliverySuperseded) return { text: error.message, exit: 2 };
    if (error instanceof DeliveryRefusal) {
      head = error.head ?? head;
      try {
        return await sendBack(error.message, "delivery");
      } catch (writeError) {
        error = writeError;
      }
    }
    const hiccup = isGitHubHiccup(error);
    const canReturn = !!pr && hasLabel(pr, "deliver");
    const retry = retryHandoff(timers, head, hiccup, Date.now(), canReturn || options.direct === true);
    if (retry) {
      if (head) await io.report?.("retrying", head, { detail: hiccup ? "github" : "execution" });
      return { text: hiccup ? "GitHub 暂时出错，一分钟后接着查" : "交付步骤暂时出错，一分钟后接着查", retry };
    }
    if (!canReturn) return { text: "暂时读不到交付请求，请稍后重交", exit: 2 };
    try {
      return await sendBack(
        hiccup ? "GitHub 连续约一小时出错，请稍后重交" : "交付连续五次尝试都卡住了，请稍后重交",
        hiccup ? "github" : "execution",
      );
    } catch {
      if (options.direct) return { text: "暂时写不回交付结果，请稍后重交", exit: 2 };
      const retry = retryHandoff(timers, head, hiccup, Date.now(), false)!;
      return { text: "暂时写不回交付结果，一分钟后接着查", retry };
    }
  }
}

export async function run(repo: string, context: Context, testLocalHealth = false, options: Options = {}) {
  const number = subjectNumber(repo, context);
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-"));
  const { progressCommand } = options;
  const report: DeliveryOptions["report"] = progressCommand
    ? (phase, head, metadata) => {
        try {
          runHook(progressCommand, { repo, number, head, phase, at: new Date().toISOString(), ...metadata }, 3000);
        } catch {
          // Progress is separate from the GitHub receipt and may be unavailable during a release.
          console.error("暂时没能上报交付进度");
        }
      }
    : options.report;
  const makeIO = () => createIO(repo, folder, { ...options, report });
  const io = makeIO();
  try {
    if (options.notifyCommand || options.direct) {
      let result = await handoff(repo, number, context, io, options, testLocalHealth);
      while (options.direct && result.retry) {
        console.log(result.text);
        await setTimeout(Math.max(0, Date.parse(result.retry.at) - Date.now()));
        result = await handoff(
          repo,
          number,
          { ...context, timers: [result.retry] },
          makeIO(),
          options,
          testLocalHealth,
        );
      }
      if (options.direct && result.exit) process.exitCode = result.exit;
      return result.retry ? `${result.text}\n${receiptBlock({ later: [result.retry] })}` : result.text;
    }
    const issue = await io.api(`issues/${number}`);
    if (!issue.pull_request) {
      if (issue.state !== "open" || !hasLabel(issue, "ask-owner")) return "没事可做：没有待处理的问题";
      if (context.answers?.length) {
        await io.api(`issues/${number}/labels/ask-owner`, undefined, "DELETE");
        return "已记录处理结果";
      }
      return `有一件事需要你处理\n${receiptBlock({ ask: [question(issue)] })}`;
    }
    try {
      const result = await deliver(repo, number, io, testLocalHealth);
      return deliveryReceipt(number, result, hasLabel(issue, "deliver-attended"));
    } catch (error) {
      if (error instanceof DeliverySuperseded) return error.message;
      const pr = await io.api(`pulls/${number}`);
      if (pr.auto_merge) await disableAuto(number, io);
      await status(io, pr.head.sha, "delivery", "failure", (error as Error).message);
      throw error;
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [repo, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      "test-local-health": { type: "boolean" },
      "auto-merge": { type: "boolean" },
      "review-policy": { type: "string" },
      "review-status": { type: "string" },
      toolkit: { type: "string" },
      "progress-command": { type: "string" },
      "notify-command": { type: "string" },
      pr: { type: "string" },
    },
  });
  const context =
    values.pr !== undefined
      ? { events: [{ subject: `${repo}#${values.pr}` }] }
      : JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  run(repo, context, values["test-local-health"], {
    autoMerge: values["auto-merge"],
    reviewPolicy: values["review-policy"],
    reviewStatus: values["review-status"],
    toolkit: values.toolkit,
    progressCommand: values["progress-command"],
    notifyCommand: values["notify-command"],
    direct: values.pr !== undefined,
  })
    .then((text) => console.log(text))
    .catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
