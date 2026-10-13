import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Drives the real CLI entry point over stdio, the way Claude Code and Codex launch it.
test("an MCP client can save, recall, hit a revision conflict, retire, and share entries through a group", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-memory-")));
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
			cwd: dir,
			env: { ...process.env, AGENT_MEMORY_DB: join(dir, "memory.sqlite3") },
		}),
	);

	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args });
		const [first] = result.content as { type: string; text: string }[];
		return { text: first?.text ?? "", isError: result.isError === true };
	};
	const entry = { scope: "global", key: "editor", kind: "decision", title: "Use tabs", content: "The user prefers tabs." };

	try {
		expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["assign_group", "get", "recall", "register_project", "remember", "retire"]);

		const saved = await call("remember", entry);
		expect(saved.isError).toBe(false);
		expect(saved.text).toContain("by test-client");

		const conflict = await call("remember", { ...entry, content: "Spaces." });
		expect(conflict.isError).toBe(true);
		expect(conflict.text).toContain("expected_revision=1");

		expect((await call("remember", { ...entry, content: "Spaces.", expected_revision: 1 })).text).toContain("rev 2");
		expect((await call("recall", { query: "which indentation: spaces?" })).text).toContain("Spaces.");

		// Outside a git repository there is no project to save to.
		const outside = await call("remember", { ...entry, scope: "project" });
		expect(outside.isError).toBe(true);
		expect(outside.text).toContain("register_project");

		const id = Number(/\[(\d+)\]/.exec(saved.text)?.[1]);
		expect((await call("retire", { id })).text).toContain("RETIRED");
		expect((await call("recall", { query: "spaces" })).text).toContain("No matching entries.");

		// Two sibling repositories share nothing until a group is assigned.
		const [backend, frontend] = ["backend", "frontend"].map((name) => {
			const path = join(dir, name);
			mkdirSync(path);
			Bun.spawnSync(["git", "-C", path, "init", "-q"]);
			return path;
		});
		const shared = { ...entry, scope: "group", key: "portal", title: "Ticket portal", content: "Portal id is 42." };
		const refused = await call("remember", { ...shared, cwd: backend });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("assign_group");

		expect((await call("assign_group", { group: "shop", paths: [backend, frontend] })).text).toContain("backend, frontend");
		expect((await call("remember", { ...shared, cwd: backend })).text).toContain("group:shop");
		expect((await call("recall", { query: "portal", cwd: frontend })).text).toContain("Portal id is 42.");
		expect((await call("recall", { query: "portal" })).text).toContain("No matching entries.");

		// From outside any project, the overview names the projects, and one can be read by ID.
		expect((await call("recall", {})).text).toContain("Projects with memory: backend, frontend.");
		expect((await call("recall", { project: "frontend" })).text).toContain("Ticket portal");
		expect((await call("recall", { project: "nope" })).text).toContain("Projects with memory: backend, frontend");

		// A plain folder gets project memory once registered.
		const notes = join(dir, "notes");
		mkdirSync(notes);
		expect((await call("register_project", { path: notes })).text).toContain("Registered project notes");
		expect((await call("remember", { ...entry, scope: "project", key: "style", cwd: notes })).text).toContain("project:notes");
		expect((await call("assign_group", { group: "shop", paths: [join(dir, "missing")] })).isError).toBe(true);
	} finally {
		await client.close();
		rmSync(dir, { recursive: true });
	}
});
