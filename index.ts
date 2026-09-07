import { type Plugin, tool } from "@opencode-ai/plugin";

const PROMPT = `You are a Zellij terminal session name generator. You output ONLY a name. Nothing else. You should always be invoked in response to the user's first message.

<task>
Generate a brief title that would help the user re-attach to the Zellij session later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- Lowercase words separated by hyphens
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as greeting, quick-check-in, light-chat, intro-message, etc.)
</rules>

<examples>
"debug 500 errors in production" → prod-debugging
"refactor user service" → service-refactor
"why is app.js failing" → app-investigation
"implement rate limiting" → rate-limiting
"how do I connect postgres to my API" → postgres-api
"best practices for React hooks" → react-hooks-best-practices
"@src/auth.ts can you add refresh token support" → auth-refresh-token
"@utils/parser.ts this is broken" → parser-fix
"look at @config.json" → config-review
"@App.tsx add dark mode toggle" → dark-mode-toggle
</examples>`;

const handled = new Set<string>();
const own = new Set<string>();
let active = false;

export const ZellijRenamerPlugin: Plugin = async ({ client, $ }) => {
  let currentSession = process.env.ZELLIJ_SESSION_NAME ?? "";

  const log = (level: "debug" | "info" | "warn", message: string) =>
    client.app.log({ body: { service: "zellij-renamer", level, message } }).catch(() => {});

  const renameZellij = async (name: string) => {
    const result =
      await $`ZELLIJ_SESSION_NAME=${currentSession} zellij action rename-session ${name}`
        .nothrow()
        .quiet();
    if (result.exitCode === 0) currentSession = name;
    return result;
  };

  const liveSessions = async () => {
    const out = await $`zellij list-sessions --no-formatting`.nothrow().quiet();
    return out.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim() && !l.includes("EXITED"))
      .map((l) => l.split(" [")[0]?.trim() ?? "");
  };

  if (currentSession) {
    const live = await liveSessions();
    if (!live.includes(currentSession)) {
      await log(
        "warn",
        `ZELLIJ_SESSION_NAME=${currentSession} is not a live session (live: ${live.join(", ")}). Renames will be skipped until opencode is started from a fresh shell inside the session.`,
      );
    }
  }

  const sanitize = (raw: string) =>
    raw
      .replace(/['"`]/g, "")
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "");

  const extractName = (raw: string) => {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines.at(-1) ?? "";
    const arrow = Math.max(last.lastIndexOf("→"), last.lastIndexOf("->"));
    return sanitize(arrow >= 0 ? last.slice(arrow + 1) : last);
  };

  const generate = async (
    sessionID: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ) => {
    const history = await client.session.messages({ path: { id: sessionID } });
    const userCount = history.data?.filter((m) => m.info.role === "user").length ?? 0;
    if (userCount > 1) return;

    const created = await client.session.create({ body: { title: "zellij-renamer" } });
    const titleSessionID = created.data?.id;
    if (!titleSessionID) return;
    own.add(titleSessionID);

    try {
      await log(
        "info",
        `generating title for ${sessionID} from: ${JSON.stringify(text.slice(0, 120))}`,
      );
      const res = await client.session.prompt({
        path: { id: titleSessionID },
        body: {
          ...(model ? { model } : {}),
          agent: "title",
          tools: { "*": false },
          parts: [
            {
              type: "text",
              text: `${PROMPT}\n\n<message>\n${text}\n</message>\n\nRespond with the title only.`,
            },
          ],
        },
      });
      const raw =
        res.data?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ") ?? "";
      await log("info", `raw model output: ${JSON.stringify(raw)}`);
      const name = extractName(raw);
      await log("info", `sanitized name: ${JSON.stringify(name)}`);
      if (!name) return;
      const result = await renameZellij(name);
      const ok = result.exitCode === 0;
      await log(
        ok ? "info" : "warn",
        `rename command ${ok ? "succeeded" : `failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`} for ${JSON.stringify(name)}`,
      );
      if (ok) {
        await new Promise((r) => setTimeout(r, 1000));
        const listed = await $`zellij list-sessions`.nothrow().quiet();
        const visible = listed.stdout.toString().includes(name);
        await log(
          visible ? "info" : "warn",
          visible ? "rename verified in list-sessions" : "rename NOT visible in list-sessions",
        );
      }
    } finally {
      await client.session.delete({ path: { id: titleSessionID } }).catch(() => {});
    }
  };

  return {
    "chat.params": async (input, output) => {
      if (!own.has(input.sessionID)) return;
      output.temperature = 0.1;
      output.topP = 1;
    },
    "chat.message": async (input, output) => {
      if (own.has(input.sessionID)) return;
      if (handled.has(input.sessionID)) return;
      if (active) return;
      const text = output.parts
        .flatMap((p) => (p.type === "text" && !("synthetic" in p && p.synthetic) ? [p.text] : []))
        .join(" ")
        .trim();
      if (!text) return;
      if (!currentSession) return;
      handled.add(input.sessionID);
      active = true;
      void generate(input.sessionID, text, input.model)
        .catch(async (e) => {
          await client.app
            .log({ body: { service: "zellij-renamer", level: "error", message: String(e) } })
            .catch(() => {});
        })
        .finally(() => {
          active = false;
        });
    },
    tool: {
      "rename-zellij-session": tool({
        description: "Rename the current Zellij terminal session",
        args: {
          name: tool.schema.string().describe("Name to set for the Zellij session"),
        },
        async execute(args) {
          if (!currentSession) {
            return "Not running inside a Zellij session";
          }
          const ok = await renameZellij(args.name);
          if (!ok) {
            return `Failed to rename session to ${args.name}`;
          }
          return `Renamed Zellij session to ${args.name}`;
        },
      }),
    },
  };
};
