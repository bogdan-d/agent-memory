import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Write } from "../src/store";

let dir: string;
let store: Store;

const write = (fields: Partial<Write> = {}): Write => ({
	scope: "project:backend",
	key: "deploy-sync",
	kind: "fact",
	title: "Sync before running staging commands",
	content: "Rsync the php directory to the staging host first.",
	evidence: ["docs/staging.md"],
	pinned: false,
	author: "test",
	...fields,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
	store = new Store(join(dir, "memory.sqlite3"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true });
});

test("revising needs the current revision, and history keeps every version", () => {
	const created = store.remember(write());
	if (!created.ok) throw new Error("create failed");
	expect(created.entry.revision).toBe(1);

	// A second agent writing the same key without having read it must not overwrite.
	const blind = store.remember(write({ content: "Overwrite" }));
	expect(blind).toEqual({ ok: false, current: created.entry });

	const revised = store.remember(write({ content: "Use the sync task.", expectedRevision: 1 }));
	if (!revised.ok) throw new Error("revise failed");
	expect(revised.entry.revision).toBe(2);
	expect(revised.entry.id).toBe(created.entry.id);

	const stale = store.remember(write({ content: "Stale", expectedRevision: 1 }));
	expect(stale.ok).toBe(false);

	expect(store.remember(write({ key: "missing", expectedRevision: 3 }))).toEqual({ ok: false, current: null });
	expect(store.history(created.entry.id).map((entry) => entry.content)).toEqual([
		"Rsync the php directory to the staging host first.",
		"Use the sync task.",
	]);
});

test("search stays inside the requested scopes", () => {
	store.remember(write());
	store.remember(write({ scope: "group:shop", key: "portal", title: "Ticket portal id", content: "Staging tickets live in portal 42." }));
	store.remember(write({ scope: "project:other", key: "secret-plan", title: "Other project staging notes" }));

	const found = store.search(["project:backend", "group:shop", "global"], "staging");
	expect(found.map((entry) => entry.scope).sort()).toEqual(["group:shop", "project:backend"]);
	expect(store.search(["global"], "staging")).toEqual([]);
});

test("search takes arbitrary user text and matches word stems", () => {
	store.remember(write());
	expect(store.search(["project:backend"], `"rsyncing" OR (NEAR* -- php:`)).toHaveLength(1);
	expect(store.search(["project:backend"], "?!")).toEqual([]);
});

test("retired entries leave search and listings but stay readable", () => {
	const created = store.remember(write({ kind: "handoff" }));
	if (!created.ok) throw new Error("create failed");
	const retired = store.retire(created.entry.id, "other-agent");

	expect(retired?.retired).toBe(true);
	expect(retired?.revision).toBe(2);
	expect(store.search(["project:backend"], "staging")).toEqual([]);
	expect(store.list(["project:backend"])).toEqual([]);
	expect(store.get([created.entry.id])[0]?.author).toBe("other-agent");

	// Writing the key again with the retired revision brings it back.
	const revived = store.remember(write({ expectedRevision: 2 }));
	expect(revived.ok && !revived.entry.retired).toBe(true);
	expect(store.search(["project:backend"], "staging")).toHaveLength(1);
});

test("a backup taken while the database is open restores every entry", () => {
	store.remember(write());
	const snapshot = store.backup();
	const restored = new Store(snapshot);
	expect(restored.list().map((entry) => entry.key)).toEqual(["deploy-sync"]);
	expect(restored.search(["project:backend"], "rsync")).toHaveLength(1);
	restored.close();
});
