#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { z } from "zod";
import { readScopes, register, resolveProject, writeScope } from "./project";
import { renderEntries, renderEntry, renderExport, renderOverview } from "./render";
import { rememberInput } from "./schema";
import { serve } from "./server";
import { Store } from "./store";

const USAGE = `agent-memory <command>

  mcp                                  Run the MCP server on stdio
  session-start                        Session-start hook for Claude Code and Codex (hook JSON on stdin)
  register [--group g] [--id slug] <path>...
                                       Register projects or set their group; without --group the group is cleared
  projects                             List registered projects
  list [--all] [--retired]             Entries for the current directory, or for every scope
  show <id>                            One entry with its revision history
  remember --scope s --key k --kind k --title t [--content c] [--evidence e]... [--pin] [--rev n]
                                       Create or revise an entry; content comes from stdin when omitted
  retire <id>                          Retire an entry
  export                               Print all active entries as Markdown
  backup [directory]                   Write a consistent database snapshot

Database: $AGENT_MEMORY_DB, default ~/.local/share/agent-memory/memory.sqlite3`;

function entryId(value: string | undefined): number {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 1) throw new Error("expected an entry id");
	return id;
}

async function main(command: string | undefined, args: string[]): Promise<void> {
	if (!command || command === "help" || command === "--help") return console.log(USAGE);
	const store = new Store();
	const cwd = process.cwd();

	switch (command) {
		case "mcp":
			return serve(store);

		case "session-start": {
			// Claude Code and Codex both pass the session's working directory in the hook's JSON input.
			const input = z.object({ cwd: z.string() }).parse(await Bun.stdin.json());
			const project = resolveProject(store, input.cwd);
			return console.log(renderOverview(project, store.projects(), store.list(readScopes(project))));
		}

		case "register": {
			const { values, positionals } = parseArgs({
				args,
				options: { group: { type: "string" }, id: { type: "string" } },
				allowPositionals: true,
			});
			if (!positionals.length) throw new Error("register needs at least one path");
			if (values.id && positionals.length > 1) throw new Error("--id needs a single path");
			for (const path of positionals) {
				const project = register(store, path, { group: values.group ?? null, ...(values.id ? { id: values.id } : {}) });
				console.log(`${project.id}\t${project.group ?? "-"}\t${project.remote ?? project.path}`);
			}
			return;
		}

		case "projects":
			for (const project of store.projects()) {
				console.log(`${project.id}\t${project.group ?? "-"}\t${project.remote ?? "-"}\t${project.path}`);
			}
			return;

		case "list": {
			const { values } = parseArgs({ args, options: { all: { type: "boolean" }, retired: { type: "boolean" } } });
			const scopes = values.all ? undefined : readScopes(resolveProject(store, cwd));
			return console.log(renderEntries(store.list(scopes, values.retired)));
		}

		case "show": {
			const id = entryId(args[0]);
			const [entry] = store.get([id]);
			if (!entry) throw new Error(`no entry with id ${id}`);
			console.log(renderEntry(entry));
			const earlier = store.history(id).slice(0, -1);
			if (earlier.length) console.log(`\n## Earlier revisions\n\n${renderEntries(earlier)}`);
			return;
		}

		case "remember": {
			const { values } = parseArgs({
				args,
				options: {
					scope: { type: "string" },
					key: { type: "string" },
					kind: { type: "string" },
					title: { type: "string" },
					content: { type: "string" },
					evidence: { type: "string", multiple: true },
					pin: { type: "boolean" },
					rev: { type: "string" },
				},
			});
			const { scope, expected_revision, ...fields } = rememberInput.parse({
				scope: values.scope,
				key: values.key,
				kind: values.kind,
				title: values.title,
				content: values.content ?? (await Bun.stdin.text()),
				evidence: values.evidence,
				pinned: values.pin,
				expected_revision: values.rev === undefined ? undefined : Number(values.rev),
			});
			const result = store.remember({
				...fields,
				scope: writeScope(store, scope, cwd),
				author: "cli",
				...(expected_revision === undefined ? {} : { expectedRevision: expected_revision }),
			});
			if (!result.ok) {
				throw new Error(
					result.current
						? `entry exists at revision ${result.current.revision}; pass --rev ${result.current.revision} to revise it`
						: "no such entry; omit --rev to create it",
				);
			}
			return console.log(renderEntry(result.entry));
		}

		case "retire": {
			const entry = store.retire(entryId(args[0]), "cli");
			if (!entry) throw new Error("no such entry");
			return console.log(renderEntry(entry));
		}

		case "export":
			return console.log(renderExport(store.list()));

		case "backup":
			return console.log(store.backup(args[0]));

		default:
			throw new Error(`unknown command: ${command}\n\n${USAGE}`);
	}
}

const [command, ...args] = process.argv.slice(2);
main(command, args).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
