import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { Level } from "./schema";
import type { Project, Scope, Store } from "./store";

export interface Checkout {
	// Root of the main working tree, shared by all linked worktrees.
	root: string;
	remote: string | null;
}

function git(cwd: string, ...args: string[]): string | null {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
	const output = result.stdout.toString().trim();
	return result.exitCode === 0 && output ? output : null;
}

// Reduces the URL forms of one repository (ssh, scp-like, https) to a single host/path identity.
export function normalizeRemote(url: string): string {
	const scpLike = !url.includes("://");
	let id = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
	id = scpLike ? id.replace(":", "/") : id.replace(/^([^/]+):\d+/, "$1");
	return id.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

export function checkout(cwd: string): Checkout | null {
	const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
	if (!commonDir) return null;
	const root = basename(commonDir) === ".git" ? dirname(commonDir) : (git(cwd, "rev-parse", "--show-toplevel") ?? cwd);
	const remote = git(cwd, "config", "--get", "remote.origin.url");
	return { root, remote: remote ? normalizeRemote(remote) : null };
}

// A repository matches by remote, then by its root path, so clones, worktrees and moved checkouts share one identity.
// Outside git, a directory belongs to the registered path that contains it.
export function resolveProject(store: Store, cwd: string): Project | null {
	const projects = store.projects();
	const repo = checkout(cwd);
	if (repo) {
		return (
			projects.find((project) => repo.remote !== null && project.remote === repo.remote) ??
			projects.find((project) => project.path === repo.root) ??
			null
		);
	}
	const dir = resolve(cwd);
	return (
		projects
			.filter((project) => dir === project.path || dir.startsWith(`${project.path}/`))
			.sort((a, b) => b.path.length - a.path.length)[0] ?? null
	);
}

// The scopes an agent working in this project reads from, narrowest first.
export function readScopes(project: Project | null): Scope[] {
	if (!project) return ["global"];
	return [`project:${project.id}`, ...(project.group ? [`group:${project.group}` as const] : []), "global"];
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Registers the repository or directory at path, or updates the project it already belongs to.
// Leaving group out keeps the project's current group. A project ID is permanent, because entries are stored under it.
export function register(store: Store, path: string, options: { id?: string; group?: string | null } = {}): Project {
	if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${path}`);
	const repo = checkout(path);
	const root = repo?.root ?? resolve(path);
	// A directory outside git owns everything beneath it, so these would swallow every unrelated folder.
	if (!repo && (root === "/" || root === homedir())) throw new Error(`${root} is too broad to be a project`);
	const projects = store.projects();
	const existing = repo ? resolveProject(store, path) : (projects.find((project) => project.path === root) ?? null);
	const taken = new Set(projects.map((project) => project.id));

	let id = existing?.id ?? options.id;
	if (existing && options.id && options.id !== existing.id) {
		throw new Error(`${root} is already registered as ${existing.id}, and a project ID is permanent`);
	}
	if (!existing && options.id && taken.has(options.id)) throw new Error(`project ID ${options.id} is taken`);
	if (!id) {
		const base = slug(basename(root)) || "project";
		id = base;
		for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
	}

	const group = options.group === undefined ? (existing?.group ?? null) : options.group;
	const project = { id, name: basename(root), group, remote: repo?.remote ?? null, path: root };
	store.registerProject(project);
	return project;
}

// The scope a write at this level lands in. A git repository registers itself on its first project-level write,
// so a project joins the memory when there is something to remember. Groups exist only once the user agreed to one.
export function writeScope(store: Store, level: Level, cwd: string): Scope {
	if (level === "global") return "global";
	const project = resolveProject(store, cwd);
	if (level === "project") {
		if (project) return `project:${project.id}`;
		if (!checkout(cwd)) {
			throw new Error(
				"This directory is not in a git repository, so it has no project memory yet. If the entry belongs to a project here, ask the user whether to register its folder, and which folder is the project root, then call register_project. Otherwise use scope=global.",
			);
		}
		return `project:${register(store, cwd).id}`;
	}
	if (!project?.group) {
		throw new Error(
			"This project has no group. If the entry applies to several related repositories, propose a group to the user and create it with assign_group once they agree. Otherwise use scope=project or scope=global.",
		);
	}
	return `group:${project.group}`;
}
