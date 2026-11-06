import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "../src/inspect";
import { Store, type Entry } from "../src/store";

test("the inspector lists, creates, revises, moves, retires and deletes entries, and refuses writes from other origins", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
	const store = new Store(join(dir, "memory.sqlite3"));
	const saved = store.remember({ scope: "global", key: "editor", kind: "decision", title: "Use tabs", content: "Tabs.", evidence: [], pinned: false, author: "cli" });
	if (!saved.ok) throw new Error("setup failed");
	store.registerProject({ id: "web", name: "web", group: "shop", remote: null, path: join(dir, "web") });
	const server = inspect(store);
	const url = (path: string) => new URL(path, server.url);
	const write = (path: string, method: string, body: unknown, origin = server.url.origin) =>
		fetch(url(path), { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	const created = { scope: "group:shop", key: "deploy", kind: "fact", title: "Deploy with make", content: "make deploy" };
	const revision = { kind: "decision", title: "Use spaces", content: "Spaces.", evidence: ["user decision"], pinned: true, expected_revision: 1 };

	try {
		expect(await (await fetch(server.url)).text()).toContain("<title>Agent memory</title>");
		expect(((await (await fetch(url("/api/entries"))).json()) as Entry[]).map((entry) => entry.title)).toEqual(["Use tabs"]);

		expect((await write("/api/entries/1", "PUT", revision, "http://evil.example")).status).toBe(403);
		expect((await write("/api/entries/1/retire", "POST", null, "http://evil.example")).status).toBe(403);
		expect((await write("/api/entries", "POST", created, "http://evil.example")).status).toBe(403);
		expect((await write("/api/entries/1", "DELETE", null, "http://evil.example")).status).toBe(403);

		expect(await (await fetch(url("/api/scopes"))).json()).toEqual(["global", "group:shop", "project:web"]);
		expect((await write("/api/entries", "POST", { ...created, scope: "project:other" })).status).toBe(400);
		const response = await write("/api/entries", "POST", created);
		expect(response.status).toBe(201);
		const deploy = (await response.json()) as Entry;
		expect(deploy).toMatchObject({ scope: "group:shop", revision: 1, author: "inspector", evidence: [], pinned: false });
		const duplicate = await write("/api/entries", "POST", created);
		expect(duplicate.status).toBe(409);
		expect(((await duplicate.json()) as { entry: Entry }).entry.id).toBe(deploy.id);

		const revised = (await (await write("/api/entries/1", "PUT", revision)).json()) as Entry;
		expect(revised).toMatchObject({ revision: 2, title: "Use spaces", pinned: true, author: "inspector" });
		expect((await write("/api/entries/1", "PUT", revision)).status).toBe(409);

		expect(((await (await write("/api/entries/1/retire", "POST", null)).json()) as Entry).retired).toBe(true);
		expect(((await (await fetch(url("/api/entries/1/history"))).json()) as Entry[]).map((entry) => entry.revision)).toEqual([1, 2, 3]);

		const move = (scope: string, expected_revision: number) => write(`/api/entries/${deploy.id}/move`, "POST", { scope, expected_revision });
		expect((await move("project:other", 1)).status).toBe(400);
		expect((await move("project:web", 2)).status).toBe(409);
		expect((await (await move("project:web", 1)).json()) as Entry).toMatchObject({ id: deploy.id, scope: "project:web", revision: 2 });

		expect((await write(`/api/entries/${deploy.id}`, "DELETE", null)).status).toBe(409);
		expect((await write("/api/entries/1", "DELETE", null)).status).toBe(204);
		expect((await write("/api/entries/1", "DELETE", null)).status).toBe(404);
		expect(store.history(1)).toEqual([]);
		// The key is free again once the entry is gone.
		expect((await write("/api/entries", "POST", { ...created, scope: "global", key: "editor" })).status).toBe(201);
	} finally {
		await server.stop(true);
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
