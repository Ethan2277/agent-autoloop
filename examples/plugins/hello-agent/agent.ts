// The smallest Agent plugin. `printf` stands in for a command-line Agent so this runs with no model and no account: put your
// CLI's print mode in its place, and read what that CLI really prints.
// In rules.json: "agents": { "hello": { "name": "Hello", "worker": "mac-mini", "use": "hello-agent" } }
type Turn = { prompt: string; session: string; resume: string | null; access: "read" | "edit" | "full" };
type Reading = { text?: string; session?: string; error?: string; started?: boolean };

export default {
  command(turn: Turn) {
    const session = turn.resume ?? turn.session;
    const text = `收到了 ${turn.prompt.length} 字的提示词，权限 ${turn.access}。这是 hello-agent，什么也没做。`;
    // One line when it takes the prompt and one when it's done: the two things `read` below goes by. A program whose only
    // line comes at the end can't say whether it got going, and one that broke is then run again in a new session.
    return ["printf", "%s\n%s\n", JSON.stringify({ session, started: true }), JSON.stringify({ session, text })];
  },
  // Called while it runs too, with code null. A throw here counts the turn as not having got through, so anything it can't read is an error it returns.
  // Once your CLI has taken the prompt, return started: true every time, even after it fails: a turn that broke then is
  // tried again in its session, while one that never got going carries on in a new session.
  read(stdout: string, code: number | null, stderr: string): Reading {
    let session: string | undefined;
    let started = false;
    let text: string | undefined;
    for (const line of stdout.split("\n")) {
      try {
        const said = JSON.parse(line);
        if (typeof said?.session === "string") session = said.session;
        if (said?.started === true) started = true;
        if (typeof said?.text === "string") text = said.text;
      } catch {
        // Not one of its lines. While it runs, the last one is often only half written.
      }
    }
    const known = { ...(session && { session }), ...(started && { started }) };
    if (code === null) return known;
    if (code !== 0) return { ...known, error: stderr.trim() || `退出码 ${code}` };
    return text ? { ...known, text } : { ...known, error: "没留下结果" };
  },
  // With a link the worker reports the session as soon as the run starts. A session it reads has to be one `resume` can go on
  // in: a retry and a bad receipt's rewrite both rely on it.
  link: (session: string) => `hello-agent://sessions/${session}`,
};
