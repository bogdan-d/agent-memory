import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readScopes, register, resolveProject, writeScope } from "./project";
import { describeProject, renderEntries, renderEntry, renderOverview } from "./render";
import { rememberShape } from "./schema";
import type { Store } from "./store";

const INSTRUCTIONS =
	"Persistent memory shared by the coding agents on this machine. A session-start hook normally puts the agent-memory " +
	"overview and its usage guidance in your context. If it is missing, call recall with no query before using the other tools.";

const cwdShape = z
	.string()
	.optional()
	.describe("Absolute path of your working directory. Pass it when it differs from the directory the session started in.");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

export function createServer(store: Store): McpServer {
	const server = new McpServer({ name: "agent-memory", version: "0.1.0" }, { instructions: INSTRUCTIONS });
	const author = () => server.server.getClientVersion()?.name ?? "mcp";
	const projectAt = (cwd: string | undefined) => resolveProject(store, cwd ?? process.cwd());
	const projectNamed = (id: string) => {
		const known = store.projects();
		const project = known.find((candidate) => candidate.id === id);
		if (!project) throw new Error(`No project ${id}. Projects with memory: ${known.map((candidate) => candidate.id).join(", ") || "none"}.`);
		return project;
	};

	server.registerTool(
		"recall",
		{
			description:
				"Search memory for the current project, or one named by ID, plus its group and global scope. Without a query, returns the overview: open handoffs, pinned entries and an index of the rest.",
			inputSchema: {
				query: z.string().optional().describe("Free text. Any word may match; best matches come first."),
				project: z.string().optional().describe("ID of a project to read instead of the one you are working in."),
				cwd: cwdShape,
			},
		},
		({ query, project: id, cwd }) => {
			const project = id ? projectNamed(id) : projectAt(cwd);
			const scopes = readScopes(project);
			if (!query?.trim()) return text(renderOverview(project, store.projects(), store.list(scopes)));
			const found = store.search(scopes, query);
			return text(`${describeProject(project, store.projects())}\n\n${found.length ? renderEntries(found) : "No matching entries."}`);
		},
	);

	server.registerTool(
		"get",
		{
			description: "Fetch complete entries by id, including retired ones.",
			inputSchema: { ids: z.array(z.number().int().positive()).min(1).max(20) },
		},
		({ ids }) => {
			const entries = store.get(ids);
			return entries.length ? text(renderEntries(entries)) : failure(`No entries with ids ${ids.join(", ")}.`);
		},
	);

	server.registerTool(
		"remember",
		{
			description:
				"Create an entry, or revise the one with the same scope and key. Revising requires expected_revision and replaces every field.",
			inputSchema: { ...rememberShape, cwd: cwdShape },
		},
		({ cwd, scope, expected_revision, ...fields }) => {
			const result = store.remember({
				...fields,
				scope: writeScope(store, scope, cwd ?? process.cwd()),
				author: author(),
				...(expected_revision === undefined ? {} : { expectedRevision: expected_revision }),
			});
			if (result.ok) return text(`Saved.\n\n${renderEntry(result.entry)}`);
			if (!result.current) return failure("No entry with this scope and key exists. Omit expected_revision to create it.");
			return failure(
				`Not saved: this key already holds revision ${result.current.revision}. Reconcile with the current entry below, then retry with expected_revision=${result.current.revision}.\n\n${renderEntry(result.current)}`,
			);
		},
	);

	server.registerTool(
		"retire",
		{
			description:
				"Retire an entry that is wrong, obsolete, or a handoff that has been picked up. It leaves recall but keeps its history.",
			inputSchema: { id: z.number().int().positive() },
		},
		({ id }) => {
			const entry = store.retire(id, author());
			return entry ? text(`Retired.\n\n${renderEntry(entry)}`) : failure(`No entry with id ${id}.`);
		},
	);

	server.registerTool(
		"register_project",
		{
			description:
				"Give a folder outside git its own project memory. Everything beneath the folder belongs to the project. Call it only after the user has agreed to the folder. Git repositories need no registration.",
			inputSchema: { path: z.string().describe("Absolute path of the project's root folder.") },
		},
		({ path }) => {
			const project = register(store, path);
			return text(`Registered project ${project.id} at ${project.path}.`);
		},
	);

	server.registerTool(
		"assign_group",
		{
			description:
				"Put projects in a group so they share group-scoped entries, creating the group if needed. Call it only after the user has agreed to the group and its members.",
			inputSchema: {
				group: z
					.string()
					.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase kebab-case, at most 40 characters")
					.nullable()
					.describe("Group name. null removes the projects from their group."),
				paths: z.array(z.string()).min(1).max(50).describe("Absolute paths of the repositories or directories to assign."),
			},
		},
		({ group, paths }) => {
			const assigned = paths.map((path) => register(store, path, { group }));
			if (!group) return text(`No longer in a group: ${assigned.map((project) => project.id).join(", ")}.`);
			const members = store.projects().filter((project) => project.group === group);
			return text(`Group ${group} now holds: ${members.map((project) => project.id).join(", ")}.`);
		},
	);

	return server;
}

export async function serve(store: Store): Promise<void> {
	await createServer(store).connect(new StdioServerTransport());
}
