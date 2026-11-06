import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../src/store";
import { Store } from "../src/store";
import { tree } from "../src/tree";

test("the tree page lists projects and regroups them, validating group names and refusing other origins", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
	const store = new Store(join(dir, "memory.sqlite3"));
	store.registerProject({ id: "web", name: "web", group: "shop", remote: "github.com/acme/web", path: join(dir, "web") });
	store.registerProject({ id: "api", name: "api", group: null, remote: null, path: join(dir, "api") });
	const server = tree(store);
	const url = (path: string) => new URL(path, server.url);
	const regroup = (id: string, body: unknown, origin = server.url.origin) =>
		fetch(url(`/api/projects/${id}/group`), { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

	try {
		expect(await (await fetch(server.url)).text()).toContain("<title>Agent memory tree</title>");
		expect(((await (await fetch(url("/api/projects"))).json()) as Project[]).map((project) => [project.id, project.group])).toEqual([
			["api", null],
			["web", "shop"],
		]);

		expect((await regroup("api", { group: "shop" }, "http://evil.example")).status).toBe(403);
		for (const group of ["Shop", "-shop", "a".repeat(41), "shop group", ""]) expect((await regroup("api", { group })).status).toBe(400);
		expect((await regroup("api", {})).status).toBe(400);
		expect((await regroup("nope", { group: "shop" })).status).toBe(404);

		// Only the group changes; the rest of the project is kept.
		expect(await (await regroup("api", { group: "shop" })).json()).toEqual({ id: "api", name: "api", group: "shop", remote: null, path: join(dir, "api") });
		expect(await (await regroup("web", { group: null })).json()).toMatchObject({ id: "web", group: null, remote: "github.com/acme/web" });
		expect(store.projects().map((project) => [project.id, project.group])).toEqual([
			["web", null],
			["api", "shop"],
		]);
		// The overview is the one the project's agents get at session start.
		store.remember({ scope: "group:shop", key: "deploy", kind: "fact", title: "Deploy with make", content: "make deploy", evidence: [], pinned: false, author: "test" });
		const overview = (await (await fetch(url("/api/projects/api/overview"))).json()) as { text: string; omitted: number };
		expect(overview.text).toContain("Project: api · group: shop");
		expect(overview.text).toContain("Deploy with make (group:shop, fact)");
		expect(overview.omitted).toBe(0);
		expect((await fetch(url("/api/projects/nope/overview"))).status).toBe(404);

		// A new group exists as soon as a project is put in it, and becomes a scope entries can use.
		await regroup("web", { group: "new-group" });
		expect(await (await fetch(url("/api/scopes"))).json()).toEqual(["global", "group:new-group", "group:shop", "project:api", "project:web"]);
	} finally {
		await server.stop(true);
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
