import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkout, normalizeRemote, readScopes, register, resolveProject, writeScope } from "../src/project";
import { Store } from "../src/store";

let dir: string;
let store: Store;

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repo(name: string, remote?: string): string {
	const path = join(dir, name);
	mkdirSync(path);
	git(path, "init", "-q");
	git(path, "commit", "-q", "--allow-empty", "-m", "init");
	if (remote) git(path, "remote", "add", "origin", remote);
	return path;
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-memory-")));
	store = new Store(join(dir, "memory.sqlite3"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true });
});

test("the URL forms of one repository share an identity", () => {
	const expected = "github.com/acme/shop";
	expect(normalizeRemote("git@github.com:Acme/shop.git")).toBe(expected);
	expect(normalizeRemote("https://user@github.com/acme/shop.git/")).toBe(expected);
	expect(normalizeRemote("ssh://git@github.com:22/acme/shop")).toBe(expected);
});

test("worktrees and moved checkouts resolve to the registered project", () => {
	const path = repo("backend", "git@example.com:acme/backend.git");
	const { root, remote } = checkout(path) ?? {};
	store.registerProject({ id: "backend", name: "backend", group: "shop", remote: remote ?? null, path: root ?? "" });

	git(path, "worktree", "add", "-q", join(dir, "backend-wt"));
	mkdirSync(join(dir, "backend-wt", "src"));
	expect(resolveProject(store, join(dir, "backend-wt", "src"))?.id).toBe("backend");

	git(path, "worktree", "remove", join(dir, "backend-wt"));
	renameSync(path, join(dir, "moved"));
	expect(resolveProject(store, join(dir, "moved"))?.id).toBe("backend");
});

test("a repository without a remote resolves by path, and unregistered ones stay out", () => {
	const local = repo("local");
	store.registerProject({ id: "local", name: "local", group: null, remote: null, path: local });
	const nested = repo("local/vendored");

	expect(resolveProject(store, local)?.id).toBe("local");
	expect(resolveProject(store, nested)).toBeNull();
	expect(resolveProject(store, repo("stranger", "git@example.com:acme/stranger.git"))).toBeNull();
});

test("a repository registers itself on its first project-scoped write, without a group", () => {
	const path = repo("backend", "git@example.com:acme/backend.git");
	expect(writeScope(store, "global", path)).toBe("global");
	expect(resolveProject(store, path)).toBeNull();

	expect(writeScope(store, "project", path)).toBe("project:backend");
	expect(resolveProject(store, path)).toMatchObject({ id: "backend", group: null });
	expect(readScopes(resolveProject(store, path))).toEqual(["project:backend", "global"]);

	// A group scope exists only once a group was assigned, and directories outside git never register themselves.
	expect(() => writeScope(store, "group", path)).toThrow("assign_group");
	expect(() => writeScope(store, "project", dir)).toThrow("not in a git repository");
});

test("a folder outside git becomes a project once registered, and keeps its group when registered again", () => {
	const notes = join(dir, "notes");
	mkdirSync(join(notes, "drafts"), { recursive: true });
	expect(() => writeScope(store, "project", notes)).toThrow("register_project");

	expect(register(store, notes).id).toBe("notes");
	expect(writeScope(store, "project", join(notes, "drafts"))).toBe("project:notes");
	expect(resolveProject(store, dir)).toBeNull();

	register(store, notes, { group: "writing" });
	expect(register(store, notes)).toMatchObject({ id: "notes", group: "writing" });
	expect(() => register(store, homedir())).toThrow("too broad");
});

test("the user assigns a group, and same-named repositories keep separate identities", () => {
	const first = repo("api", "git@example.com:acme/api.git");
	mkdirSync(join(dir, "other"));
	const second = repo("other/api", "git@example.com:other/api.git");

	expect(register(store, first, { group: null }).id).toBe("api");
	expect(register(store, second, { group: null }).id).toBe("api-2");
	expect(() => register(store, second, { id: "api", group: null })).toThrow("permanent");

	expect(register(store, first, { group: "shop" })).toMatchObject({ id: "api", group: "shop" });
	expect(writeScope(store, "group", first)).toBe("group:shop");
	expect(readScopes(resolveProject(store, first))).toEqual(["project:api", "group:shop", "global"]);
	expect(readScopes(resolveProject(store, second))).toEqual(["project:api-2", "global"]);
});
