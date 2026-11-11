#!/bin/sh
# Someone's first hour, start to finish, in a throwaway home: install what's committed here with install.sh, start it, run
# `try` with nobody at a terminal, answer, see it finish, uninstall, and check nothing's left. Only the Agent and the commands
# that show a notification are stand-ins. It takes no service: a CI machine doesn't always have a session to run one in.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd -P)
# In two steps: with mktemp failing inside the `cd`, `work` would be this folder, and cleaning up would delete it.
work=$(mktemp -d)
work=$(cd "$work" && pwd -P)
up_pid=""

cleanup() {
  code=$?
  if [ -n "$up_pid" ]; then
    kill "$up_pid" 2>/dev/null || true
    wait "$up_pid" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ -f "$work/up.log" ]; then
    echo "--- up.log"
    cat "$work/up.log"
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "install-smoke: $1" >&2
  exit 1
}

# Waits up to 30 seconds for a command to succeed.
wait_for() {
  what=$1
  shift
  tries=0
  until "$@" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 150 ] || fail "$what"
    sleep 0.2
  done
}

export HOME="$work/home"
export DISPLAY=:99
export AGENT_AUTOLOOP_HOME="$work/hub"
export AGENT_AUTOLOOP_REPO="file://$repo"
unset AGENT_AUTOLOOP_RULES AGENT_AUTOLOOP_PUBLIC_URL AGENT_AUTOLOOP_COMMIT
mkdir -p "$HOME" "$work/bin"
export PATH="$work/bin:$HOME/.local/bin:$PATH"

printf '#!/bin/sh\nexit 0\n' > "$work/bin/launchctl"
chmod +x "$work/bin/launchctl"
for notifier in osascript notify-send; do
  cat >"$work/bin/$notifier" <<END
#!/bin/sh
while [ "\$1" != "--" ]; do shift; done
printf '%s\n' "\$3" >>"$work/notified"
END
  chmod +x "$work/bin/$notifier"
done

cat >"$work/agent.sh" <<'END'
#!/bin/sh
if grep -q 'card.answered' "$AGENT_AUTOLOOP_CONTEXT"; then
  echo "你选了绿色，试跑通过"
else
  cat <<'ASK'
问了一个问题

```agent-autoloop
{"ask":[{"title":"试跑：选一个颜色","text":"这是一次试跑，选哪个都行。","options":["蓝色","绿色"],"key":"try-color"}]}
```
ASK
fi
END
chmod +x "$work/agent.sh"

port=$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
healthy() { curl --noproxy '*' -fsS "http://127.0.0.1:$port/healthz"; }

sh "$repo/install.sh" --no-service --command "$work/agent.sh" --port "$port" >"$work/install.out" 2>&1 || {
  cat "$work/install.out"
  fail "install.sh failed"
}
cat "$work/install.out"
[ -L "$HOME/.local/bin/agent-autoloop" ] || fail "install.sh didn't put the command in ~/.local/bin"
[ "$(command -v agent-autoloop)" = "$HOME/.local/bin/agent-autoloop" ] || fail "agent-autoloop isn't what PATH finds"
grep -q "先运行 agent-autoloop up" "$work/install.out" || fail "the next step printed isn't to start it"

commit=$(git -C "$repo" rev-parse HEAD | cut -c 1-12)
agent-autoloop --version | grep -q "$commit" || fail "--version doesn't say $commit"

agent-autoloop up >"$work/up.log" 2>&1 &
up_pid=$!
wait_for "up didn't start" healthy

agent-autoloop try </dev/null >"$work/try.out" 2>&1 || {
  cat "$work/try.out"
  fail "try failed"
}
cat "$work/try.out"
card=$(sed -n 's/.*agent-autoloop answer \([0-9][0-9]*\) .*/\1/p' "$work/try.out" | head -n 1)
[ -n "$card" ] || fail "try didn't say how to answer"

notified() { grep -q '试跑：选一个颜色' "$work/notified"; }
wait_for "the question didn't reach the desktop channel" notified

agent-autoloop answer "$card" 2
finished() { agent-autoloop status | grep -q '试跑通过'; }
wait_for "status never showed it finished" finished
agent-autoloop status | tee "$work/status.out"
grep -q '最近 7 天 2 轮' "$work/status.out" || fail "status doesn't count the two rounds"
grep -q '● 桌面通知' "$work/status.out" || fail "status doesn't show the desktop channel online"

agent-autoloop uninstall --yes </dev/null
[ -f "$AGENT_AUTOLOOP_HOME/config.json" ] || fail "uninstall deleted the data"
[ ! -e "$AGENT_AUTOLOOP_HOME/app" ] || fail "uninstall left the program"
if [ -e "$HOME/.local/bin/agent-autoloop" ] || [ -L "$HOME/.local/bin/agent-autoloop" ]; then fail "the command is still there"; fi
if healthy >/dev/null 2>&1; then fail "the hub is still running"; fi
wait "$up_pid" 2>/dev/null || true
up_pid=""
left=$(find "$HOME" \( -type f -o -type l \))
[ -z "$left" ] || fail "left behind: $left"

echo "install-smoke: from install to uninstall, all good."
