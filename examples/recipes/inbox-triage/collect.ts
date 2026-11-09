// The mailbox stays behind its CLI: only a complete, body-capped snapshot can wake the triage Agent.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

type Sources = {
  folderId: string;
  onlyUnread: boolean;
  lookbackHours: number;
  maxMessages: number;
  bodyChars: number;
  skipSenders: string[];
};
type Summary = {
  message_id: string;
  thread_id?: string;
  subject?: string;
  date_formatted?: string;
  head_from?: { name?: string; mail_address?: string };
  security_level?: { is_risk?: boolean; risk_banner_reason?: string };
};
class AuthorizationError extends Error {}

function lark(args: string[]) {
  // Reading the mailbox is a human decision: the CLI is always asked as the owner, never as the bot.
  const run = spawnSync("lark-cli", [...args, "--as", "user"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const response = JSON.parse(run.status === 0 ? run.stdout : run.stderr);
  if (response.error?.type === "authorization" || response.error?.type === "authentication")
    throw new AuthorizationError();
  if (run.status !== 0 || response.ok !== true)
    throw new Error(`邮箱读取失败：${response.error?.type ?? "未知错误"}，请在本机检查 CLI`);
  if (response.identity !== "user") throw new Error("邮箱读取没有使用本人身份");
  return response.data ?? {};
}

const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
const blockedTitle = "请恢复邮箱读取";
if (
  context.answers.length &&
  !context.answers.some(
    (answer: { title: string; choice: number | null }) => answer.title === blockedTitle && answer.choice === 0,
  )
) {
  console.log("没事可做：本轮未确认恢复，留待下次计划读取");
} else if (context.open.some((card: { title: string }) => card.title === blockedTitle) && !context.answers.length) {
  console.log("没事可做：等待本人恢复邮箱读取");
} else {
  const sources: Sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (
    !sources.folderId ||
    !Number.isInteger(sources.maxMessages) ||
    sources.maxMessages < 1 ||
    sources.maxMessages > 400 ||
    !Number.isInteger(sources.bodyChars) ||
    sources.bodyChars < 1 ||
    !Number.isInteger(sources.lookbackHours) ||
    sources.lookbackHours < 1 ||
    !Array.isArray(sources.skipSenders)
  ) {
    throw new Error("检查 sources.json：目录、回看小时、最多几封、正文保留多少字都要写清楚");
  }
  try {
    const until = new Date();
    const from = new Date(until.getTime() - sources.lookbackHours * 3_600_000);
    const filter = {
      folder_id: sources.folderId,
      ...(sources.onlyUnread ? { is_unread: true } : {}),
      time_range: { start_time: from.toISOString(), end_time: until.toISOString() },
    };
    // A skipped sender still takes a slot in the page it arrives in, so the listing is read page by page: reading only
    // the first would let notifications fill the cap and make a mailbox with mail look empty.
    const skip = new Set(sources.skipSenders.map((address: string) => address.trim().toLowerCase()));
    const picked: Summary[] = [];
    // One request returns at most this many summaries however it is paged inside, so paging past it buys nothing.
    const ceiling = 400;
    let scanned = 0;
    let pageToken = "";
    let more = true;
    // Mail the owner wants that the cap left out of the snapshot.
    let left = false;
    while (picked.length < sources.maxMessages && more && scanned < ceiling) {
      const listed = lark([
        "mail",
        "+triage",
        "--format",
        "json",
        "--max",
        String(Math.min(sources.maxMessages, ceiling - scanned)),
        "--filter",
        JSON.stringify(filter),
        ...(pageToken ? ["--page-token", pageToken] : []),
      ]);
      if (!Array.isArray(listed.messages)) throw new Error("邮箱没有返回邮件列表，不能当作没有新邮件");
      const page = listed.messages as Summary[];
      scanned += page.length;
      for (const message of page) {
        if (skip.has((message.head_from?.mail_address ?? "").toLowerCase())) continue;
        if (picked.length < sources.maxMessages) picked.push(message);
        else left = true;
      }
      // An empty page ends the read whatever the listing says about more: there is nowhere left to page from.
      const next = typeof listed.page_token === "string" ? listed.page_token : "";
      more = listed.has_more === true && next !== "" && page.length > 0;
      pageToken = next;
    }
    // Only a window read to its end with nothing left out is all of it; reaching the cap says nothing about what is after.
    const complete = !more && !left;
    if (!picked.length && complete) {
      console.log(`没事可做：${sources.lookbackHours} 小时内没有需要看的邮件`);
    } else {
      // A sender the owner asked to skip is not read at all, so its body never reaches this machine. A read cut short
      // with nothing kept has no bodies to ask for, and an empty id list is not a request the mailbox takes.
      const contents = picked.length
        ? lark(["mail", "+messages", "--message-ids", picked.map((m) => m.message_id).join(","), "--html=false"])
        : { messages: [] };
      if (!Array.isArray(contents.messages)) throw new Error("邮箱没有返回邮件正文，资料不完整");
      if (Array.isArray(contents.unavailable_message_ids) && contents.unavailable_message_ids.length)
        throw new Error(`邮箱没有返回部分邮件的正文（${contents.unavailable_message_ids.length} 封），本次不生成清单`);
      const bodies = new Map<string, { body_plain_text?: string }>(
        (contents.messages as { message_id: string; body_plain_text?: string }[]).map((message) => [
          message.message_id,
          message,
        ]),
      );
      const messages = picked.map((summary) => {
        const body = bodies.get(summary.message_id);
        if (!body) throw new Error(`邮箱没有返回邮件 ${summary.message_id} 的正文，本次不生成清单`);
        const chars = [...(body.body_plain_text ?? "")];
        return {
          message_id: summary.message_id,
          thread_id: summary.thread_id ?? "",
          subject: summary.subject ?? "",
          from: { name: summary.head_from?.name ?? "", address: summary.head_from?.mail_address ?? "" },
          date: summary.date_formatted ?? "",
          risk: {
            is_risk: summary.security_level?.is_risk === true,
            reason: summary.security_level?.risk_banner_reason ?? "",
          },
          body: chars.slice(0, sources.bodyChars).join(""),
          truncated: chars.length > sources.bodyChars,
        };
      });
      const content = {
        from: from.toISOString(),
        until: until.toISOString(),
        folder: sources.folderId,
        limit: sources.maxMessages,
        // What the listing got through, so the brief can say whether mail was left unscanned.
        scanned: { summaries: scanned, complete },
        messages,
      };
      const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      writeFileSync("inbox-input.json.tmp", JSON.stringify({ id, ...content }, null, 2), { mode: 0o600 });
      renameSync("inbox-input.json.tmp", "inbox-input.json");
      const receipt = {
        events: [
          {
            id,
            type: "inbox.ready",
            subject: "inbox",
            summary: `本期收件箱读取了 ${messages.length} 封${complete ? "" : "，还有邮件没读完"}`,
          },
        ],
      };
      console.log(
        `收件箱读取完成：${messages.length} 封${complete ? "" : "（还有邮件没读，本期没读全）"}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``,
      );
    }
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    console.log(
      `待你处理：请恢复邮箱读取\n\n\`\`\`agent-autoloop\n${JSON.stringify({
        ask: [
          {
            key: "mail-access",
            title: blockedTitle,
            text: "请在接单电脑用本人身份登录邮箱，或补上读信的授权，完成后选择继续。恢复前不会用旧邮件当成本次结果。",
            options: ["已恢复，继续读取", "本期先跳过"],
            recommend: 0,
            about: "重新按 sources.json 的范围读一次；完整读到底才交给分诊 Agent。",
          },
        ],
      })}\n\`\`\``,
    );
  }
}
