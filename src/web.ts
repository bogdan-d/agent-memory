import { z } from "zod";
import { groupName, rememberShape } from "./schema";
import type { Scope, Store } from "./store";

const AUTHOR = "inspector";

const fields = {
	kind: rememberShape.kind,
	title: rememberShape.title,
	content: rememberShape.content,
	evidence: rememberShape.evidence,
	pinned: rememberShape.pinned,
};

// Revising from the inspector keeps the scope and key; every other field is replaced.
const reviseInput = z.object({ ...fields, expected_revision: z.number().int().positive() });
const createInput = z.object({ ...fields, scope: z.string(), key: rememberShape.key });
const moveInput = z.object({ scope: z.string(), expected_revision: z.number().int().positive() });
const groupInput = z.object({ group: groupName.nullable() });

const error = (status: number, message: string) => Response.json({ error: message }, { status });

// Serves a local page and the JSON API it edits memory through. Binds to loopback only.
export function serveWeb(store: Store, page: Bun.HTMLBundle, port: number): Bun.Server<undefined> {
	// Only this page may call the API: the Host check stops DNS rebinding, the Origin check stops other sites posting.
	const allowed = (request: Request, write: boolean): boolean => {
		const host = request.headers.get("host");
		if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return false;
		return !write || request.headers.get("origin") === `http://${host}`;
	};
	const entryAt = (id: string) => store.get([Number(id)])[0];

	// Scopes a new entry may use: global, every group, every registered project.
	const scopes = (): Scope[] => {
		const projects = store.projects();
		const groups = [...new Set(projects.flatMap((project) => (project.group ? [project.group] : [])))].sort();
		return [
			"global",
			...groups.map((group) => `group:${group}` as const),
			...projects.map((project) => `project:${project.id}` as const).sort(),
		];
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		development: false,
		routes: {
			"/": page,
			"/api/scopes": {
				GET: (request) => (allowed(request, false) ? Response.json(scopes()) : error(403, "forbidden")),
			},
			"/api/projects": {
				GET: (request) => (allowed(request, false) ? Response.json(store.projects()) : error(403, "forbidden")),
			},
			"/api/projects/:id/group": {
				PUT: async (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const parsed = groupInput.safeParse(await request.json().catch(() => null));
					if (!parsed.success) return error(400, z.prettifyError(parsed.error));
					const project = store.setGroup(request.params.id, parsed.data.group);
					return project ? Response.json(project) : error(404, "no such project");
				},
			},
			"/api/entries": {
				GET: (request) => (allowed(request, false) ? Response.json(store.list(undefined, true)) : error(403, "forbidden")),
				POST: async (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const parsed = createInput.safeParse(await request.json().catch(() => null));
					if (!parsed.success) return error(400, z.prettifyError(parsed.error));
					const { scope: requested, ...rest } = parsed.data;
					const scope = scopes().find((candidate) => candidate === requested);
					if (!scope) return error(400, `unknown scope ${requested}`);
					const result = store.remember({ ...rest, scope, author: AUTHOR });
					if (!result.ok) {
						return Response.json({ error: `${scope} already has an entry with key ${rest.key}`, entry: result.current }, { status: 409 });
					}
					return Response.json(result.entry, { status: 201 });
				},
			},
			"/api/entries/:id/history": {
				GET: (request) =>
					allowed(request, false) ? Response.json(store.history(Number(request.params.id))) : error(403, "forbidden"),
			},
			"/api/entries/:id": {
				PUT: async (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const current = entryAt(request.params.id);
					if (!current) return error(404, "no such entry");
					const parsed = reviseInput.safeParse(await request.json().catch(() => null));
					if (!parsed.success) return error(400, z.prettifyError(parsed.error));
					const { expected_revision, ...rest } = parsed.data;
					const result = store.remember({
						...rest,
						scope: current.scope,
						key: current.key,
						author: AUTHOR,
						expectedRevision: expected_revision,
					});
					if (!result.ok) return error(409, `entry is now at revision ${result.current?.revision}; reload and retry`);
					return Response.json(result.entry);
				},
				DELETE: (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const current = entryAt(request.params.id);
					if (!current) return error(404, "no such entry");
					if (!store.delete(current.id)) return error(409, "only retired entries can be deleted");
					return new Response(null, { status: 204 });
				},
			},
			"/api/entries/:id/move": {
				POST: async (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const current = entryAt(request.params.id);
					if (!current) return error(404, "no such entry");
					const parsed = moveInput.safeParse(await request.json().catch(() => null));
					if (!parsed.success) return error(400, z.prettifyError(parsed.error));
					const scope = scopes().find((candidate) => candidate === parsed.data.scope);
					if (!scope) return error(400, `unknown scope ${parsed.data.scope}`);
					const result = store.move(current.id, scope, parsed.data.expected_revision, AUTHOR);
					if (result.ok) return Response.json(result.entry);
					if (result.current?.id === current.id) return error(409, `entry is now at revision ${result.current.revision}; reload and retry`);
					return Response.json({ error: `${scope} already has an entry with key ${current.key}`, entry: result.current }, { status: 409 });
				},
			},
			"/api/entries/:id/retire": {
				POST: (request) => {
					if (!allowed(request, true)) return error(403, "forbidden");
					const entry = store.retire(Number(request.params.id), AUTHOR);
					return entry ? Response.json(entry) : error(404, "no such entry");
				},
			},
		},
		fetch: () => error(404, "not found"),
	});
	return server;
}
