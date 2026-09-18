# LCA Code Agent

An autonomous coding agent for VS Code, built around three deliberate constraints:

1. **OpenAI-compatible or Anthropic APIs only.** No other AI provider is supported.
2. **No internet access anywhere else.** The extension makes exactly one kind of network
   call — `POST {baseUrl}/chat/completions` to the endpoint you configure (plus, if you
   choose to set them up, local MCP server processes you control). There is no telemetry,
   no update-checking, no web browsing/search tool, nothing else.
3. **Filesystem sandboxed to the current project folder.** Every read/write/delete the
   agent does is resolved against the first open workspace folder and rejected if it
   would land outside that folder — including via `..` traversal or absolute paths.

Within those constraints, it's a real autonomous agent: it plans, edits files, runs
commands to validate its own work, iterates when validation fails, remembers
project-specific instructions between sessions, and can be extended with your own MCP
tools.

## Install

1. In VS Code: Extensions view → `...` menu → **Install from VSIX...** → select
   `lca-code-agent-0.2.0.vsix`.
   (Or from a terminal: `code --install-extension lca-code-agent-0.2.0.vsix`.)
2. Open the project folder you want the agent to work on (**File > Open Folder...**).
   Only the *first* workspace folder is used as the sandbox root.
3. Click the terminal icon in the Activity Bar to open the "LCA Code Agent" panel.

## First-time setup

On first activation the extension creates:

```
~/.lca/setup.json
```

(`~` is your OS user profile folder — `%USERPROFILE%` on Windows, `$HOME` on macOS/Linux.)

```json
{
  "provider": "openai",
  "baseUrl": "",
  "apiKey": "",
  "model": "gpt-4o-mini",
  "temperature": 0.2,
  "maxTokens": 4096,
  "autoApprove": false,
  "toolsEnabled": true,
  "toolCallStyle": "native",
  "executeCommandEnabled": true,
  "maxAgentSteps": 40,
  "mcpServers": {},
  "anthropicBaseUrl": "",
  "anthropicApiKey": "",
  "anthropicAuthToken": "",
  "anthropicModel": ""
}
```

Edit it (via the gear icon in the chat panel's title bar, or open the file directly)
and configure the provider you're using. Note that `"maxTokens"` is the **maximum output
tokens per response**, not a context-window size — most models cap this well below
100,000, and a request that exceeds a model's real limit gets rejected outright (a 400,
often with an unhelpful generic message from whatever's in front of the model, like a
router/proxy). If a request fails right away, this is one of the first things to check —
try 4096 or 8192.

### OpenAI-compatible (default, `"provider": "openai"`)

Set at least `baseUrl`:

- Local server: `"baseUrl": "http://localhost:1234/v1"` (LM Studio, Ollama's OpenAI-
  compatible endpoint, llama.cpp server, vLLM, etc.) — leave `apiKey` empty if the
  server doesn't require one.
- Self-hosted/proxied OpenAI-compatible endpoint: set `baseUrl` and `apiKey` accordingly.

### Anthropic (`"provider": "anthropic"`)

Talks directly to Anthropic's native Messages API (`POST {baseUrl}/v1/messages`) instead
of the OpenAI-compatible endpoint — a separate wire format, translated automatically so
the rest of the extension (tools, diffs, sessions, etc.) works the same either way. Set:

- `anthropicModel` — required, e.g. `"claude-sonnet-4-5"`.
- `anthropicApiKey` **or** `anthropicAuthToken` — one of the two is required.
  `anthropicApiKey` is sent as `x-api-key`; `anthropicAuthToken` (for OAuth-style
  bearer tokens, e.g. from a proxy) is sent as `Authorization: Bearer <token>` and takes
  priority if both are set.
- `anthropicBaseUrl` — optional, defaults to `https://api.anthropic.com`. Set this to
  point at a compatible proxy.

Each of these four also falls back to the matching environment variable if the
`setup.json` field is left empty — `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` — the same names used by Claude Code and
Anthropic's own SDKs, so an existing shell environment already set up for those tools
works here too without duplicating credentials into `setup.json`.

The file is re-read on every request, so edits take effect immediately — no reload needed.

`autoApprove: false` (the default) means the agent will ask you to Approve/Deny before
any file write, file delete, or shell command. Reading files and listing directories
never needs approval. Set `autoApprove: true` only if you're comfortable with the agent
acting without confirmation.

## Tool-calling compatibility (`toolCallStyle`)

Most servers implement OpenAI/Anthropic-style native function-calling reliably, and the
default (`"toolCallStyle": "native"`) uses that. But plenty of free, routed, or smaller
self-hosted models handle it inconsistently — sometimes it works, sometimes a request
(especially a long one, like a skill invocation) comes back with an empty response for
no obvious reason, even though the exact same model works fine elsewhere. Tools like
Cline avoid this for such models by not using the API's native tool mechanism at all —
instead describing the available tools in the prompt and asking the model to "call" them
by writing a specific text format, which is far more universally supported since it
doesn't depend on the server implementing function-calling correctly.

Set `"toolCallStyle": "prompt"` in `~/.lca/setup.json` to do the same here. With this on,
the extension stops sending the API's native `tools`/`tool_choice` parameters entirely;
instead the system prompt describes each tool and instructs the model to emit blocks like:

```
<tool_call name="read_file">
{"path": "index.html"}
</tool_call>
```

which get parsed back into the same internal tool-call representation native
function-calling produces — so approval prompts, diffs, the plan tracker, and MCP tools
all work exactly the same either way. This is purely a request-format change scoped to
this extension's own outgoing API calls; it doesn't persist into saved sessions, so you
can switch it back to `"native"` at any time without affecting existing conversations.

## Plan Mode / Act Mode

A toggle in the toolbar next to the other buttons, the same idea as similar tools' Plan/Act
switch: **Plan** restricts the agent to read-only exploration (`list_files`, `read_file`,
and updating its plan with `update_plan`) — `write_file`, `replace_in_file`, `delete_file`,
`execute_command`, and any MCP tools are not even offered to the model, so it physically
cannot use them no matter how a request is phrased; it can only investigate and propose a
plan, then stop and ask you to switch to **Act** to carry it out. Act is the normal full
mode everything else in this README describes. The mode change shows up in the chat log as
a small notice so it's clear which one is active.

This is a coarser, session-level gate on top of the per-call approval prompts — useful when
you want to review a plan before any tool has a chance to touch anything, rather than
approving edits one at a time as they come up.

## The autonomous loop: Plan → Edit → Run → Validate → Iterate

For non-trivial tasks, the agent is instructed to work through an explicit loop rather
than just editing blind:

1. **Plan** — lay out its steps up front using the `update_plan` tool.
2. **Edit** — inspect the relevant files, then make focused changes.
3. **Run** — actually execute the project's build/test/lint commands via
   `execute_command`.
4. **Validate** — check whether that run actually passed.
5. **Iterate** — if it didn't, go back and fix it rather than declaring success anyway.

The plan is visible and tracked live: a **Plan** checklist card appears in the chat and
updates as steps move from `☐ pending` → `◐ in progress` → `☑ done`, so you can see where
the agent is in the loop instead of just watching a stream of tool calls.

## Project memory (AGENTS.md)

Project-wide context and instructions live in `AGENTS.md` in your project's root folder
(not `~/.lca` — this one is meant to be committed and shared with your team, the same
convention used by several other coding agents). It's read fresh at the start of every
new chat, so edits take effect on the next conversation.

Use the book icon in the chat panel's title bar (or **LCA Code Agent: Open Project Memory**
from the Command Palette) to create a starter template if one doesn't exist yet, and open
it either way. Typical contents: project overview, coding conventions, build/test
commands, and anything else you want the agent to always know about this specific repo.

## Custom MCP servers

You can extend the agent with your own [MCP](https://modelcontextprotocol.io) tools by
adding servers to `~/.lca/setup.json`, using the same `mcpServers` shape as Claude
Desktop / Claude Code configs:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"]
    },
    "my-internal-tool": {
      "command": "node",
      "args": ["/path/to/my-mcp-server/index.js"],
      "env": { "SOME_TOKEN": "..." }
    }
  }
}
```

Servers are connected (via stdio) once when VS Code starts and disconnected on shutdown.
Their tools show up automatically in the chat as `servername: toolname` and go through
the same Approve/Deny flow as built-in tools (unless `autoApprove` is on) — the sandbox
guarantees only apply to this extension's own file tools, so only add MCP servers you
trust, since an MCP tool can do whatever its own implementation allows. Check the Log
(see Troubleshooting) if a server fails to connect — the rest of the extension keeps
working even if one server's connection fails.

## Reviewing changes before they happen

For `write_file` and `replace_in_file`, approving opens a real VS Code diff editor tab in
the main editor area — **Original ↔ Proposed Changes** — using VS Code's native diff
viewer. The sidebar chat shows a short prompt pointing at the tab, plus
**Approve**/**Deny**. The diff tab closes automatically once you decide. Nothing is
written to disk until you click **Approve**.

## Task completed summary

When a turn involved actual file/tool work, the agent's closing message renders as a
distinct "✓ Task Completed" card (with real markdown — headings, bold, lists, inline
code) instead of a plain chat bubble. Plain questions that don't touch any files still
show as a normal reply.

## Progress indicator

While the agent is working, a "Working ●●●" indicator appears in the chat log and the
input box is disabled, so it's always clear whether it's still processing or waiting for
you.

## Long turns

If a single turn needs more than `maxAgentSteps` (40 by default) tool calls, the agent
pauses rather than erroring out — the conversation isn't lost, just send another message
(e.g. "continue") to keep going. Raise `"maxAgentSteps"` in `~/.lca/setup.json` if you
regularly hit it.

## OS-aware commands

On Windows, `execute_command` looks for a real POSIX shell in this order: (1) whatever
shell your own VS Code integrated terminal is configured to default to, if it's Git Bash
or WSL (`terminal.integrated.defaultProfile.windows`) — this is very likely why other
tools that drive the integrated terminal directly don't hit this at all on the same
machine; (2) common Git-for-Windows install locations
(`Program Files\Git\bin\bash.exe` and a few alternates); (3) whatever `bash` resolves to
on PATH at all, which also catches portable/scoop/chocolatey installs and WSL's own
`bash.exe` shim. If any of those find a real bash, standard Unix tools (`head`, `tail`,
`wc`, `find`, `grep`, `cat`, `ls`, `sed`, `awk`, etc.) just work, the same as on
macOS/Linux, instead of failing with "is not recognized." Only if none of that turns up a
shell does it fall back to `cmd.exe`, with the tool description/system prompt switching to
concrete `cmd`/PowerShell guidance instead (e.g. a one-liner for counting lines, listing
files by extension, or searching text) — either way the model gets accurate guidance
about what's actually available this session, rather than a generic guess.

## Sessions

- **New Chat** auto-saves the current conversation (if it has any messages) before
  clearing.
- **Save** lets you name/rename the current session explicitly and saves it immediately.
- **Sessions** opens a panel listing all saved sessions (newest first), each with **Open**
  and **Delete** (Delete asks you to confirm by clicking twice).
- If the sidebar view is ever hidden and re-shown (e.g. switching to another view and
  back), the current conversation reappears automatically rather than looking cleared.

Sessions are stored as individual JSON files under `~/.lca/sessions/`.

## Skills

Reusable prompt snippets live in `~/.lca/skills/`, in either layout:

- **Flat file:** `~/.lca/skills/<name>.md` (or `.txt`) — the filename (without extension)
  is the skill's name.
- **Folder-style:** `~/.lca/skills/<name>/SKILL.md` — the folder name is the skill's name;
  `SKILL.md` (case-insensitive) inside it is read as the content.

Both layouts can be mixed freely. Type `/` in the chat box to see a filterable list of
available skills; pick one (or type `/skillname your extra instructions`) and it sends
the skill's content as instructions, followed by anything else you typed.

## What the agent can do

Built-in tools, all confined to the project root:

- `list_files` — list a directory (optionally recursive)
- `read_file` — read a file's contents
- `write_file` — create or overwrite a file
- `replace_in_file` — find-and-replace an exact text block in a file (line-ending
  differences between CRLF/LF, and common smart-quote/dash/non-breaking-space variants,
  are normalized automatically before falling back to a match failure)
- `delete_file` — delete a file or folder
- `execute_command` — run a shell command with cwd pinned to the project root
- `update_plan` — track the Plan → Edit → Run → Validate → Iterate checklist

Plus whatever tools your configured MCP servers provide.

Note on `execute_command`: pinning the working directory keeps *file* access sandboxed,
but a shell command can still do anything a normal terminal command can on this machine
(e.g. `curl`, `npm install`, `git push`) — sandboxing paths doesn't sandbox what a
subprocess itself is capable of. That's exactly why approval is required for it by
default; leave `autoApprove` off if you want to review each command before it runs.

## Security model recap

What's actually guaranteed (enforced in code, doesn't depend on the model behaving,
can't be talked out of it by the user or by injected content in a file) vs. what's
best-effort (depends on the model, backstopped by approval prompts and heuristics):

**Hard, code-enforced — holds regardless of what the model does or is told:**

- **Path sandboxing** (`src/pathGuard.ts`): every tool call's path argument is resolved
  against the workspace root and rejected if the resolved path isn't inside it. This
  resolution follows symlinks and re-checks containment against the real, resolved path
  (`resolveSafePathReal`) — a symlink inside the project pointing elsewhere on disk (e.g.
  `project/escape -> /etc`) is detected and blocked, not just a plain string check on the
  path as written. The model can ask for anything; the tool itself refuses.
- **Single network target for the extension's own requests** (`src/openaiClient.ts` /
  `src/anthropicClient.ts`): the only `fetch()` calls the extension itself makes go to
  `{baseUrl}/chat/completions` (OpenAI-compatible) or `{anthropicBaseUrl}/v1/messages`
  (Anthropic), per the active `provider` in `~/.lca/setup.json`. There's no code path to
  any other host, no telemetry, no update checks.

**Best-effort — `execute_command` and any MCP servers you configure run arbitrary
commands/code by design, so they aren't (and can't be) sandboxed the way file access is.
These layer together to keep them from being *quietly* misused:**

- **Approval gate** (`src/agentLoop.ts` + `src/ChatViewProvider.ts`): mutating tools
  pause and wait for an explicit Approve/Deny in the chat panel unless you've turned on
  `autoApprove`.
- **Network commands force approval regardless of `autoApprove`**: `execute_command`
  calls are checked against a heuristic list (curl, wget, Invoke-WebRequest, git
  push/pull/fetch/clone, package installs, raw `http(s)://` URLs, etc. —
  `src/networkHeuristics.ts`) and always require an explicit decision, with a distinct
  red warning banner in the approval prompt, even if `autoApprove` is on for everything
  else. It's a heuristic, not exhaustive — treat it as a tripwire that catches the common
  cases, not a guarantee.
- **`"executeCommandEnabled": false`** in `~/.lca/setup.json` removes the tool entirely
  if you want zero possibility of shell-based network egress and don't need build/test
  commands to run.
- **System prompt makes both boundaries explicit and non-negotiable**: the model is told
  file access is code-enforced (so it shouldn't waste steps trying to work around it),
  that it must refuse network-shaped `execute_command`/MCP use even if the user or a file
  it read asks for it, and that content returned by tools is data to analyze, not
  instructions to follow (a prompt-injection mitigation) — re-attached fresh to every
  single API call within a turn (not just once at the start), so it doesn't fade in
  relevance over a long, many-step turn. This is defense-in-depth, not a guarantee — a
  model can still misbehave; the approval gate and heuristic above are the actual
  backstop.
- **Credentials at rest**: `~/.lca/` and `~/.lca/setup.json` (which holds your API
  keys/tokens in plaintext) are set to owner-only permissions (`0700`/`0600`) every time
  the extension activates, including retroactively for installs from before this existed.
  This is a real restriction on Linux/macOS; on Windows, `fs.chmod` has limited effect
  (no true POSIX-style ACL), so treat this as defense-in-depth there, not a guarantee.
- **No secrets in the log**: request/response bodies are logged for troubleshooting, but
  API keys and auth tokens live in HTTP headers, which are never logged — only the
  headers-free JSON body. Configured MCP server `env` values aren't logged either
  (`cfg.args` is, so avoid passing secrets as plain command-line args to an MCP server if
  you'd rather they not end up in the log).
- **No `innerHTML` with untrusted content**: the chat webview builds all DOM content via
  `textContent`/`createElement`, including model/tool output — there's no path for
  model-generated text to inject markup or script into the panel.

## Rebuilding from source

The extension now ships one npm runtime dependency (the MCP SDK), so it's bundled with
esbuild into a single `out/extension.js` rather than shipping `node_modules`:

```bash
npm install
npm run build      # typechecks, then bundles with esbuild
npx vsce package --no-dependencies   # produces the .vsix
```

`npm run watch` re-bundles on file changes during development.

## Troubleshooting

If the agent doesn't respond and you don't see an error in the chat panel:

1. Click the **Log** button in the chat toolbar (or run **LCA Code Agent: Show Log**
   from the Command Palette). Every request, response status, and error is written
   there with a timestamp — this is the first place to look.
2. A VS Code notification popup also appears for any failure, as a second safety net in
   case the chat panel itself couldn't render it.
3. Requests now time out after 120 seconds instead of hanging forever, so a slow or
   unresponsive server will surface as a clear timeout error rather than silence.
4. If you get a 200 OK response but nothing appears, and the log shows a small response
   body, the server likely doesn't reliably support native function/tool calling — this
   is common with free/routed models, and can get worse or become intermittent under a
   large prompt (e.g. a skill), even if the same model works fine elsewhere (like Cline)
   which falls back to a text-based tool format for exactly this reason. Try
   `"toolCallStyle": "prompt"` in `~/.lca/setup.json` first (see below) — it keeps full
   file-editing/agent capability. If that still doesn't help, `"toolsEnabled": false`
   disables tool calling entirely as a last resort (plain chat only — no file access,
   commands, or MCP tools; you'd copy code out of the chat yourself).
5. If a tool call shows up with a garbled name (e.g. containing stray `<`/`>` tags), the
   server's own tool-calling implementation produced malformed output — this extension
   strips the garbage and tries to recover the real tool name, but if the arguments are
   also corrupted the tool run will fail with a clear error rather than doing something
   unpredictable. This points to a server/model compatibility issue, not something to fix
   here.
6. If `replace_in_file` reports the search text wasn't found even though it looks right,
   line-ending differences (CRLF vs LF, common on Windows) or smart quotes/dashes are the
   most likely cause — both are handled automatically by normalizing before comparing, but
   if it
   still fails, re-read the file with `read_file` first and copy the exact current text.
7. With `"provider": "anthropic"`, a 400 error from the provider (especially via a
   router/proxy) after otherwise-successful requests usually means two same-role messages
   ended up adjacent in the conversation — Anthropic's API requires strict user/assistant
   alternation, unlike OpenAI-compatible APIs. This is handled automatically (adjacent
   same-role turns are merged before sending), but the exact request body is also now
   logged before every call, so if something still looks wrong you can see precisely what
   was sent.
8. Also check `"maxTokens"` in the logged request body if you get an immediate 400 with a
   generic message like "bad request" — it's max **output** tokens, not a context-window
   size, and a value beyond what the model/provider actually supports (routers in
   particular tend to reject this outright rather than clamping it) is a common cause. The
   Log now warns when `maxTokens` looks unusually high (over 100,000) as a hint.

## Known limitations

- Only the first workspace folder is treated as the sandbox root; multi-root workspaces
  aren't specially supported.
- Non-streaming responses only (simpler and more robust across different
  OpenAI-compatible server implementations); large responses arrive all at once rather
  than token-by-token.
- `execute_command` and any MCP server tools cannot themselves be sandboxed to
  "no internet" — see the notes above for both.
