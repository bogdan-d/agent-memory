import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Kind } from "./schema";

export type Scope = "global" | `group:${string}` | `project:${string}`;

export interface Project {
	id: string;
	name: string;
	group: string | null;
	remote: string | null;
	path: string;
}

export interface Entry {
	id: number;
	scope: Scope;
	key: string;
	kind: Kind;
	title: string;
	content: string;
	evidence: string[];
	pinned: boolean;
	retired: boolean;
	revision: number;
	author: string;
	createdAt: string;
	updatedAt: string;
}

export type EntryFields = Pick<Entry, "scope" | "key" | "kind" | "title" | "content" | "evidence" | "pinned" | "author">;

// expectedRevision is the revision being replaced; leave it out to create a new entry.
export type Write = EntryFields & { expectedRevision?: number };

export type WriteResult = { ok: true; entry: Entry } | { ok: false; current: Entry | null };

interface EntryRow {
	id: number;
	scope: string;
	key: string;
	kind: string;
	title: string;
	content: string;
	evidence: string;
	pinned: number;
	retired: number;
	revision: number;
	author: string;
	created_at: string;
	updated_at: string;
}

interface ProjectRow {
	id: string;
	name: string;
	grp: string | null;
	remote: string | null;
	path: string;
}

const ENTRY_STATE = `
	kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'hypothesis', 'handoff')),
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	evidence TEXT NOT NULL,
	pinned INTEGER NOT NULL,
	retired INTEGER NOT NULL,
	author TEXT NOT NULL`;

// Append only. Index + 1 is the schema version stored in PRAGMA user_version.
const MIGRATIONS = [
	`
	CREATE TABLE projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		grp TEXT,
		remote TEXT UNIQUE,
		path TEXT NOT NULL UNIQUE
	) STRICT;

	CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		scope TEXT NOT NULL,
		key TEXT NOT NULL,
		revision INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		${ENTRY_STATE},
		UNIQUE (scope, key)
	) STRICT;

	CREATE TABLE history (
		entry_id INTEGER NOT NULL REFERENCES entries (id),
		revision INTEGER NOT NULL,
		at TEXT NOT NULL,
		${ENTRY_STATE},
		PRIMARY KEY (entry_id, revision)
	) STRICT;

	CREATE VIRTUAL TABLE entries_fts USING fts5 (key, title, content, tokenize = 'porter unicode61');
	`,
];

export function defaultDbPath(): string {
	const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return process.env.AGENT_MEMORY_DB ?? join(dataHome, "agent-memory", "memory.sqlite3");
}

function toEntry(row: EntryRow): Entry {
	return {
		id: row.id,
		scope: row.scope as Scope,
		key: row.key,
		kind: row.kind as Kind,
		title: row.title,
		content: row.content,
		evidence: JSON.parse(row.evidence) as string[],
		pinned: row.pinned === 1,
		retired: row.retired === 1,
		revision: row.revision,
		author: row.author,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toProject(row: ProjectRow): Project {
	return { id: row.id, name: row.name, group: row.grp, remote: row.remote, path: row.path };
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

export class Store {
	private readonly db: Database;

	constructor(readonly path: string = defaultDbPath()) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA synchronous = FULL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db
			.transaction(() => {
				const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
				for (const migration of MIGRATIONS.slice(version)) this.db.run(migration);
				this.db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
			})
			.immediate();
	}

	// Projects

	registerProject(project: Project): void {
		this.db.run(
			`INSERT INTO projects (id, name, grp, remote, path) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET name = excluded.name, grp = excluded.grp, remote = excluded.remote, path = excluded.path`,
			[project.id, project.name, project.group, project.remote, project.path],
		);
	}

	projects(): Project[] {
		return this.db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY grp, id").all().map(toProject);
	}

	// Entries

	find(scope: Scope, key: string): Entry | null {
		const row = this.db.query<EntryRow, [string, string]>("SELECT * FROM entries WHERE scope = ? AND key = ?").get(scope, key);
		return row ? toEntry(row) : null;
	}

	get(ids: number[]): Entry[] {
		return this.db
			.query<EntryRow, number[]>(`SELECT * FROM entries WHERE id IN (${placeholders(ids)}) ORDER BY id`)
			.all(...ids)
			.map(toEntry);
	}

	// Entries in the given scopes, or everywhere when scopes is omitted. Newest first.
	list(scopes?: Scope[], includeRetired = false): Entry[] {
		const where = [
			...(scopes ? [`scope IN (${placeholders(scopes)})`] : []),
			...(includeRetired ? [] : ["retired = 0"]),
		];
		return this.db
			.query<EntryRow, Scope[]>(
				`SELECT * FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC`,
			)
			.all(...(scopes ?? []))
			.map(toEntry);
	}

	// Full-text search over active entries. The query is free text: any word may match, best matches first.
	search(scopes: Scope[], query: string, limit = 8): Entry[] {
		const words = query.match(/[\p{L}\p{N}_]+/gu);
		if (!words) return [];
		const match = words.map((word) => `"${word}"`).join(" OR ");
		return this.db
			.query<EntryRow, (string | number)[]>(
				`SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
				 WHERE entries_fts MATCH ? AND e.scope IN (${placeholders(scopes)})
				 ORDER BY bm25(entries_fts, 2.0, 4.0, 1.0) LIMIT ?`,
			)
			.all(match, ...scopes, limit)
			.map(toEntry);
	}

	history(id: number): Entry[] {
		return this.db
			.query<EntryRow, [number]>(
				`SELECT e.id, e.scope, e.key, e.created_at, h.at AS updated_at, h.revision,
				        h.kind, h.title, h.content, h.evidence, h.pinned, h.retired, h.author
				 FROM history h JOIN entries e ON e.id = h.entry_id WHERE h.entry_id = ? ORDER BY h.revision`,
			)
			.all(id)
			.map(toEntry);
	}

	// Creates or revises the entry at (scope, key). A revision mismatch changes nothing and returns the current entry.
	remember(write: Write): WriteResult {
		return this.db
			.transaction((): WriteResult => {
				const current = this.find(write.scope, write.key);
				if (current?.revision !== write.expectedRevision) return { ok: false, current };
				return { ok: true, entry: this.save({ ...write, retired: false }, current) };
			})
			.immediate();
	}

	retire(id: number, author: string): Entry | null {
		return this.db
			.transaction((): Entry | null => {
				const current = this.get([id])[0];
				if (!current || current.retired) return current ?? null;
				return this.save({ ...current, author, retired: true }, current);
			})
			.immediate();
	}

	private save(next: EntryFields & { retired: boolean }, current: Entry | null): Entry {
		const at = new Date().toISOString();
		const revision = (current?.revision ?? 0) + 1;
		const state = [next.kind, next.title, next.content, JSON.stringify(next.evidence), next.pinned ? 1 : 0, next.retired ? 1 : 0, next.author];
		const row = this.db
			.query<{ id: number }, (string | number)[]>(
				`INSERT INTO entries (scope, key, revision, created_at, updated_at, kind, title, content, evidence, pinned, retired, author)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (scope, key) DO UPDATE SET
					revision = excluded.revision, updated_at = excluded.updated_at, kind = excluded.kind, title = excluded.title,
					content = excluded.content, evidence = excluded.evidence, pinned = excluded.pinned, retired = excluded.retired,
					author = excluded.author
				 RETURNING id`,
			)
			.get(next.scope, next.key, revision, at, at, ...state);
		if (!row) throw new Error("entry write returned no row");
		this.db.run(
			`INSERT INTO history (entry_id, revision, at, kind, title, content, evidence, pinned, retired, author)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[row.id, revision, at, ...state],
		);
		this.db.run("DELETE FROM entries_fts WHERE rowid = ?", [row.id]);
		if (!next.retired) {
			this.db.run("INSERT INTO entries_fts (rowid, key, title, content) VALUES (?, ?, ?, ?)", [row.id, next.key, next.title, next.content]);
		}
		const saved = this.get([row.id])[0];
		if (!saved) throw new Error("saved entry not found");
		return saved;
	}

	// Writes a consistent snapshot, safe while other processes use the database. Restore by copying it over the database.
	backup(directory: string = join(dirname(this.path), "backups")): string {
		mkdirSync(directory, { recursive: true });
		const target = join(directory, `memory-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite3`);
		this.db.run("VACUUM INTO ?", [target]);
		return target;
	}
}
