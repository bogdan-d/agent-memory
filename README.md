# Agent memory

Long-term memory shared by Claude Code and Codex on one machine. Agents read and write it through an MCP server, and a session-start hook loads the overview and the usage guidance into every session.

Entries live in one local SQLite database, by default `~/.local/share/agent-memory/memory.sqlite3` (override with `AGENT_MEMORY_DB`). The database is personal data and is never part of this repository or of the projects it describes.

## Scopes

Every entry belongs to one scope. An agent working in a project reads all three.

| Scope | Shared by | Example |
|---|---|---|
| `project` | Every clone and worktree of one repository | A staging quirk of the backend |
| `group` | Every project you put in the same group | A ticket-portal ID used across related repositories |
| `global` | Everything | A personal working preference |

**Git repositories** register themselves the first time an agent saves a project-scoped entry there. Until then they read the global scope alone. They are recognized by their `origin` remote, so clones, worktrees and moved checkouts keep their identity; a repository without a remote is recognized by its path.

**Folders outside git** have no obvious root, so they never register themselves. An agent that wants to save something project-specific there is told to ask you which folder is the project, then to call `register_project`. Everything beneath that folder belongs to the project. Your home folder and `/` are refused as too broad.

**Groups** exist only once you agree to one. When an agent is about to save something that applies to several related repositories, the guidance tells it to say so and offer a group. If you agree, it calls `assign_group` with the name and the repositories. Until then, a write to group scope is refused.

A project ID defaults to the directory name, with a numeric suffix if that is taken, and is permanent.

## Entries

An entry has a scope, a stable key, a kind, a title, content of at most 4,000 characters, evidence references, and an optional pin.

| Kind | Meaning |
|---|---|
| `fact` | Verified observation |
| `decision` | Stated by the user |
| `hypothesis` | Unverified |
| `handoff` | Unfinished work for another agent or session; retired when picked up |

- **Revisions:** writing the same scope and key revises the entry. A revision must name the revision it replaces, so two agents cannot overwrite each other, and every revision is kept in history.
- **Retiring:** a retired entry leaves search and the overview but keeps its history, and can be revived by writing its key again.
- **Search:** full text over key, title and content, ranked toward titles, with word stemming. It returns at most eight entries.
- **Overview:** the usage guidance, then open handoffs and pinned entries in full, then the other entries one line each, grouped by scope with the project's own first; only hypotheses are marked, as unverified. When everything fits, it says the list is complete, so agents fetch entries with `get` instead of searching; the guidance asks for at most one `recall` per task.

Saving is left to the agent, following the rules in the `remember` tool description, which load only when the agent saves: save only what is applicable and durable, revise instead of duplicating, and never store secrets or what the repository already records. Nothing prompts the agent at the end of a turn.

## Setup

Requires Bun 1.4.3 or newer.

```bash
git clone https://github.com/bogdan-d/agent-memory.git
cd agent-memory
bun install
bun check && bun test
```

The database is created empty on first use. Use absolute paths in the configuration below, because clients do not always start hooks with your shell's `PATH`.

### MCP server

```bash
claude mcp add --scope user agent-memory -- /path/to/bun /path/to/agent-memory/src/cli.ts mcp
codex mcp add agent-memory -- /path/to/bun /path/to/agent-memory/src/cli.ts mcp
```

Codex asks for approval the first time an agent calls each MCP tool; choosing to always allow it saves `approval_mode = "approve"` for that tool in `~/.codex/config.toml`. To skip the prompts, set a default for the server there:

```toml
[mcp_servers.agent-memory]
command = "/path/to/bun"
args = ["/path/to/agent-memory/src/cli.ts", "mcp"]
default_tools_approval_mode = "approve"
```

With `approve`, `register_project` and `assign_group` also run without a prompt; the guidance still tells agents to call them only after you agree. To keep a prompt for every write, use `writes` instead: `recall` and `get` are marked read-only and run without one. A per-tool `[mcp_servers.agent-memory.tools.<tool>]` table with its own `approval_mode` overrides the default.

### Session-start hook

Both clients take the same hook definition. Merge it into the `hooks` key of `~/.claude/settings.json`, and save it as `~/.codex/hooks.json` (wrapped in `{ "hooks": … }`). In Codex, run `/hooks` once to trust the hook; Codex skips it until then, and again after the command changes.

```json
{
	"SessionStart": [{ "hooks": [{ "type": "command", "command": "/path/to/bun /path/to/agent-memory/src/cli.ts session-start", "timeout": 10 }] }]
}
```

The hook reads the database directly, so it works before the MCP server is connected. It also runs after resume, clear and compaction.

### Built-in memory

Turn off Claude Code's auto memory so the two do not compete: set `"autoMemoryEnabled": false` in `~/.claude/settings.json`. Leave Codex's built-in memories off, which is its default.

### Check the install

Start a new session in either client. Its context should open with `# Agent memory` and the usage guidance, and `/mcp` should list `agent-memory` as connected. From a terminal, `bun /path/to/agent-memory/src/cli.ts list` should print nothing and exit without an error.

### Uninstall

Remove the hook entry, run `claude mcp remove --scope user agent-memory` and `codex mcp remove agent-memory`, and delete `~/.local/share/agent-memory/` if you no longer want the data.

## Inspecting memories

To browse, add, edit, move, retire and delete entries yourself, start the local inspector from the repository and open the address it prints:

```bash
bun inspect               # http://127.0.0.1:4870
bun inspect --port 9000
```

The page lists every entry grouped by scope, retired ones included, with text, scope and kind filters, each entry's revision history, and times in local time.

- **Add:** a new entry goes to global scope, a group or a registered project. If the scope already has the key, the page offers to edit that entry instead.
- **Edit:** saves a new revision as author `inspector`, and fails if the entry changed since it was loaded. Editing a retired entry revives it.
- **Move:** moves an entry to global scope, a group or a registered project as a new revision, keeping its ID and history. It fails if the target scope already has the key, or if the entry changed since it was loaded.
- **Delete:** only retired entries can be deleted. Deleting removes the entry and its whole history for good, and frees its key.
- **Keys:** `j`/`k` or the arrow keys move through the list, `/` searches, `n` adds, `e` edits, Ctrl+Enter saves and Esc leaves a field.

The server listens on `127.0.0.1` only, and its API accepts requests only from the page itself. Stop it with Ctrl+C.

## Memory tree

For an overview of everything at once, start the tree editor instead and open the address it prints:

```bash
bun tree                  # http://127.0.0.1:4871
bun tree --port 9000
```

The page draws all memory as one left-to-right tree: `global`, then each group with its entries and member projects, then the projects in no group, each with its entries. Collapsed nodes show how many entries lie beneath them and a bar split by kind. Entries are listed as agents see them in their session-start overview: `[id]` and the full title, open handoffs first, then pinned entries, then the rest, newest first. Their dots are coloured by kind and pinned ones are ringed; retired entries stay hidden until you show them, and then come last. Groups whose entries no project reads, because the group has no members left, are marked and listed in the summary.

- **Navigate:** scroll or drag the background to pan (Shift+scroll pans sideways), Ctrl+scroll or pinch to zoom, click a node to open it and its arrow to collapse it. Expand all, collapse all and fit act on the whole tree; fit never shrinks text below a readable size, so a tall tree shows its top and you scroll for the rest.
- **Panel:** drag the divider to resize the side panel; the page remembers the width. Double-click the divider to reset it.
- **Live:** the page checks for changes every few seconds and when the tab becomes visible again, so entries agents save appear without a reload. An open form or a focused panel control is left as it is.
- **Filter:** text matches entry IDs, keys, titles, content and evidence, and project and group names. Matches are highlighted, everything else is dimmed, and the path to every match is opened.
- **Summary:** totals per scope and kind, with pinned entries, open handoffs and retired entries. Click a row to show that scope in the tree.
- **Entries:** clicking one shows its content, evidence and revision history, with edit, retire, move and, for retired entries, permanent delete. These behave as in the inspector. The + on global, a group or a project adds an entry there.
- **Move:** drag an entry onto global, a group or a project, or choose the target in its panel. Esc cancels a drag.
- **What its agents see:** a project's panel shows the session-start overview its agents get, and global's panel the one for a folder that is not a registered project, with how much of the 6,000-character entry budget it uses and how many lines were cut. Cut entries reach agents only through `recall`.
- **Regroup:** drag a project onto a group or onto “no group”, or pick a group in its panel, where you can also name a new one. The page asks first, because a project's agents read its group's entries; it names the entries the project gains and loses access to.

Theme follows the system and can be switched to light or dark. The server, like the inspector's, listens on `127.0.0.1` only and accepts API requests only from the page itself.

## MCP tools

| Tool | Behavior |
|---|---|
| `recall` | With a query, searches the project, group and global scopes. Without one, returns the overview. Reads another project when given its ID; that project's overview leaves out the usage guidance, which the agent already has. |
| `get` | Complete entries by ID, including retired ones. |
| `remember` | Creates an entry, or revises the one with the same scope and key. Revising requires `expected_revision`; a mismatch is refused and returns the current entry. |
| `retire` | Retires an entry. Used for obsolete facts and picked-up handoffs. |
| `register_project` | Gives a folder outside git its own project memory. Agents call it only after you agree. |
| `assign_group` | Puts repositories in a group, creating it if needed, or removes them with a null group. Agents call it only after you agree. |

Outside a registered project, the overview names the projects that have memory, so an agent asked about one can read it by ID.

## CLI

Run as `bun /path/to/agent-memory/src/cli.ts <command>`, from the directory whose project you mean.

```text
list [--all] [--retired]                Entries for the current directory, or for every scope
show <id>                               One entry with its revision history
remember --scope s --key k --kind k --title t [--content c] [--evidence e]... [--pin] [--rev n]
retire <id>
projects                                Registered projects
register [--group g] [--id slug] <path>...
                                        Register projects or set their group; without --group the group is cleared
inspect [--port n]                      Browse, add, edit, move, retire and delete entries in a local web page (default port 4870)
tree [--port n]                         Edit entries and project groups in a collapsible tree in a local web page (default port 4871)
export                                  All active entries as Markdown
backup [directory]                      Consistent snapshot, by default under backups/ next to the database
```

`remember` reads the content from stdin when `--content` is omitted. To restore a backup, stop the clients and copy the snapshot over the database file.

## Limits

- One machine. The database uses SQLite's write-ahead log, which needs local storage and serializes writers on a single host.
- A project ID cannot be renamed, a project cannot be unregistered, and an entry cannot be renamed. Only the inspector and the tree move entries between scopes.
- No semantic search and no background extraction. Agents choose what to save.
