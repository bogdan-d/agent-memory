import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderOverview } from "../src/render";
import { Store } from "../src/store";

test("the overview shows handoffs and pinned entries in full, indexes the rest, and respects its budget", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
	const store = new Store(join(dir, "memory.sqlite3"));
	const base = { scope: "global" as const, evidence: [], author: "test" };
	store.remember({ ...base, key: "a", kind: "handoff", title: "Finish the import", content: "Step 3 remains.", pinned: false });
	store.remember({ ...base, key: "b", kind: "fact", title: "Essential", content: "Pinned body.", pinned: true });
	store.remember({ ...base, key: "c", kind: "fact", title: "Minor detail", content: "Indexed body.", pinned: false });
	const entries = store.list(["global"]);
	store.close();
	rmSync(dir, { recursive: true });

	const overview = renderOverview(null, [], entries);
	expect(overview).toContain("save it with remember");
	expect(overview).toContain("Step 3 remains.");
	expect(overview).toContain("Pinned body.");
	expect(overview).toContain("Minor detail");
	expect(overview).not.toContain("Indexed body.");
	expect(overview).toContain("This list is complete.");

	const cut = renderOverview(null, [], entries, 150);
	expect(cut).toContain("Step 3 remains.");
	expect(cut).not.toContain("Pinned body.");
	expect(cut).toContain("more lines omitted");
	expect(cut).not.toContain("This list is complete.");
});
