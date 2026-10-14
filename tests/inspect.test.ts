import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "../src/inspect";
import { Store, type Entry } from "../src/store";

test("the inspector lists, revises and retires entries, and refuses writes from other origins", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
	const store = new Store(join(dir, "memory.sqlite3"));
	const saved = store.remember({ scope: "global", key: "editor", kind: "decision", title: "Use tabs", content: "Tabs.", evidence: [], pinned: false, author: "cli" });
	if (!saved.ok) throw new Error("setup failed");
	const server = inspect(store);
	const url = (path: string) => new URL(path, server.url);
	const write = (path: string, method: string, body: unknown, origin = server.url.origin) =>
		fetch(url(path), { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	const revision = { kind: "decision", title: "Use spaces", content: "Spaces.", evidence: ["user decision"], pinned: true, expected_revision: 1 };

	try {
		expect(await (await fetch(server.url)).text()).toContain("<title>Agent memory</title>");
		expect(((await (await fetch(url("/api/entries"))).json()) as Entry[]).map((entry) => entry.title)).toEqual(["Use tabs"]);

		expect((await write("/api/entries/1", "PUT", revision, "http://evil.example")).status).toBe(403);
		expect((await write("/api/entries/1/retire", "POST", null, "http://evil.example")).status).toBe(403);

		const revised = (await (await write("/api/entries/1", "PUT", revision)).json()) as Entry;
		expect(revised).toMatchObject({ revision: 2, title: "Use spaces", pinned: true, author: "inspector" });
		expect((await write("/api/entries/1", "PUT", revision)).status).toBe(409);

		expect(((await (await write("/api/entries/1/retire", "POST", null)).json()) as Entry).retired).toBe(true);
		expect(((await (await fetch(url("/api/entries/1/history"))).json()) as Entry[]).map((entry) => entry.revision)).toEqual([1, 2, 3]);
	} finally {
		await server.stop(true);
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
