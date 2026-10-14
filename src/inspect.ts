import { z } from "zod";
import page from "./inspect.html";
import { rememberShape } from "./schema";
import type { Store } from "./store";

const AUTHOR = "inspector";

// Revising from the inspector keeps the scope and key; every other field is replaced.
const reviseInput = z.object({
	kind: rememberShape.kind,
	title: rememberShape.title,
	content: rememberShape.content,
	evidence: rememberShape.evidence,
	pinned: rememberShape.pinned,
	expected_revision: z.number().int().positive(),
});

const error = (status: number, message: string) => Response.json({ error: message }, { status });

// Local web viewer for browsing, editing and retiring entries. Binds to loopback only.
export function inspect(store: Store, port = 0): Bun.Server<undefined> {
	// Only this page may call the API: the Host check stops DNS rebinding, the Origin check stops other sites posting.
	const allowed = (request: Request, write: boolean): boolean => {
		const host = request.headers.get("host");
		if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return false;
		return !write || request.headers.get("origin") === `http://${host}`;
	};
	const entryAt = (id: string) => store.get([Number(id)])[0];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		development: false,
		routes: {
			"/": page,
			"/api/entries": {
				GET: (request) => (allowed(request, false) ? Response.json(store.list(undefined, true)) : error(403, "forbidden")),
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
					const { expected_revision, ...fields } = parsed.data;
					const result = store.remember({
						...fields,
						scope: current.scope,
						key: current.key,
						author: AUTHOR,
						expectedRevision: expected_revision,
					});
					if (!result.ok) return error(409, `entry is now at revision ${result.current?.revision}; reload and retry`);
					return Response.json(result.entry);
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
