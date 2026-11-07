// The channel a new install starts with: a notification on this computer that there's something to look at. It can't take
// an answer; `agent-autoloop status` shows the card and `agent-autoloop answer` answers it.
//   "channels": { "desktop": { "key": "…" } } in config.json
//   "channels": { "desktop": { "name": "桌面通知" } } in rules.json
import { execFile, spawnSync } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { POWERSHELL, powershell } from "../../host/command.ts";

const WORDS = "运行 agent-autoloop status 查看";
const TITLE = "Agent 问你一个问题";
const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

/**
 * A card's title is whatever an Agent wrote, so it's only ever an argument, never part of a script. The `--` is what keeps
 * it one when it starts with a dash: without it osascript takes a title of `-e` as more script to run.
 */
export function notifyCommand(title: string, platform: string = process.platform): [string, string[]] {
  const body = `${title}\n${WORDS}`;
  if (platform === "win32") {
    const data = Buffer.from(JSON.stringify({ title: TITLE, body })).toString("base64");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
      $words = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $icon = [Windows.Forms.NotifyIcon]::new()
      try {
        $icon.Icon = [Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $words.title
        $icon.BalloonTipText = $words.body
        $icon.Visible = $true
        $icon.ShowBalloonTip(5000)
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Seconds 5
      } finally { $icon.Dispose() }`;
    return [
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    ];
  }
  if (platform === "darwin") return ["osascript", [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", TITLE, body]];
  return ["notify-send", ["--", TITLE, body]];
}

function hasDesktop() {
  if (process.platform === "win32") {
    return (
      powershell(
        "$session=(Get-Process -Id $PID).SessionId; [string][bool](@(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count)",
      ) === "True"
    );
  }
  if (process.platform === "darwin") {
    return spawnSync("launchctl", ["print", `gui/${process.getuid!()}`], { stdio: "ignore" }).status === 0;
  }
  return process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Not the sync call the other channels get away with: this runs in the hub's own process, and may wait on a dialog. */
function show(title: string) {
  const [program, args] = notifyCommand(title);
  return new Promise<void>((resolve, reject) => {
    execFile(program, args, { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export default async function desktop({ hub, log, signal }: ChannelContext) {
  const available = hasDesktop();
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`连不上中台：${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // A notification is gone once shown: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    if (!available) {
      await hub.delivered(card.id, card.version, `skipped-${card.id}`);
      continue;
    }
    try {
      await show(card.title);
      await hub.delivered(card.id, card.version, `shown-${card.id}`);
    } catch (error) {
      log(`卡片 ${card.id} 的桌面通知没发出：${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
