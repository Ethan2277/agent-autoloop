#!/bin/sh
# 定时看一眼 GitHub 有没有新 issue，没有新东西不花 Token。中台在家里、连不上公网也能用。
#
#   "agents": { "watcher": { "name": "轮询", "worker": "my-mac", "use": "command", "command": ["/绝对路径/watch-github-issues.sh", "owner/repo", "created:>=2026-11-04T00:00:00+08:00"] } }
#   "rules": [
#     { "name": "看新 issue", "when": { "cron": "*/5 * * * *" }, "to": "watcher", "cwd": "~/", "tell": "never", "emits": { "source": "github", "types": ["issues.opened"] } },
#     { "name": "处理 issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 1 }
#   ]
#
# 第二个参数可选，是 GitHub 的搜索条件：created:>=日期 只看这天以后开的（GitHub 按 UTC 算日期，带上 T00:00:00+08:00 才是北京时间的那天），label:agent 只看打了这个标签的。不写就是所有开着的。
# 不留游标：每次都读最近的，事件的 id 是稳定的，重复的中台只记一次。
# 整理好的例子见 examples/recipes/github-issues。
set -e
REPO="$1"
SEARCH="${2:-}"
EVENTS=$(gh issue list --repo "$REPO" --state open --limit 30 ${SEARCH:+--search "$SEARCH"} --json number,title,url,body \
  --jq 'map({id: ("issue-" + (.number|tostring)), type: "issues.opened", subject: ("#" + (.number|tostring)), summary: .title[0:200], detail: .body[0:4000], link: .url})')
echo "看了 $REPO 最近的 issue"
echo
echo '```agent-autoloop'
# Not echo: /bin/sh's echo turns the \n and \\ inside the JSON into real ones.
printf '{"events":%s}\n' "$EVENTS"
echo '```'
