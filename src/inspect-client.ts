/// <reference lib="dom" />
import { KINDS } from "./schema";
import type { Entry, Scope } from "./store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = $<HTMLInputElement>("search");
const scopeFilter = $<HTMLSelectElement>("scope");
const kindFilter = $<HTMLSelectElement>("kind");
const showRetired = $<HTMLInputElement>("retired");
const list = $<HTMLUListElement>("list");
const detail = $<HTMLElement>("detail");

let entries: Entry[] = [];
let scopes: Scope[] = [];
// Entries in display order, for keyboard navigation.
let visible: Entry[] = [];
let selected: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

const when = (iso: string) => new Date(iso).toLocaleString();

// A failed API call. A create that collides with an existing key carries that entry.
class ApiError extends Error {
	constructor(
		message: string,
		readonly entry?: Entry,
	) {
		super(message);
	}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
	const body: unknown = response.status === 204 ? null : await response.json();
	if (!response.ok) {
		const { error, entry } = body as { error: string; entry?: Entry };
		throw new ApiError(error, entry);
	}
	return body as T;
}

function options(select: HTMLSelectElement, all: string, values: readonly string[]) {
	const current = select.value;
	select.replaceChildren(el("option", { value: "", textContent: all }), ...values.map((value) => el("option", { value, textContent: value })));
	select.value = values.includes(current) ? current : "";
}

function tags(entry: Entry): HTMLElement[] {
	return [
		el("span", { className: "tag", textContent: entry.scope }),
		el("span", { className: `tag kind-${entry.kind}`, textContent: entry.kind }),
		...(entry.pinned ? [el("span", { className: "tag pinned-tag", textContent: "pinned" })] : []),
		...(entry.retired ? [el("span", { className: "tag retired-tag", textContent: "retired" })] : []),
	];
}

// Global first, then groups, then projects.
const scopeOrder = (scope: string) => `${scope === "global" ? 0 : scope.startsWith("group:") ? 1 : 2}${scope}`;

function renderList() {
	const text = search.value.trim().toLowerCase();
	const matching = entries.filter(
		(entry) =>
			(showRetired.checked || !entry.retired) &&
			(!scopeFilter.value || entry.scope === scopeFilter.value) &&
			(!kindFilter.value || entry.kind === kindFilter.value) &&
			(!text || [entry.key, entry.title, entry.content, ...entry.evidence].join("\n").toLowerCase().includes(text)),
	);
	const groups = Map.groupBy(matching, (entry) => entry.scope);
	const order = [...groups.keys()].sort((a, b) => scopeOrder(a).localeCompare(scopeOrder(b)));
	visible = order.flatMap((scope) => groups.get(scope) ?? []);

	list.replaceChildren(
		...order.flatMap((scope) => {
			const group = groups.get(scope) ?? [];
			return [
				el("li", { className: "group-header" }, scope, el("small", { textContent: ` ${group.length}` })),
				...group.map((entry) =>
					el(
						"li",
						{
							className: ["entry", entry.id === selected ? "selected" : "", entry.retired ? "retired" : ""].join(" "),
							onclick: () => void select(entry.id),
						},
						el("div", {}, el("strong", { textContent: `[${entry.id}] ` }), entry.title),
						el("div", {}, ...tags(entry).slice(1), el("small", { textContent: `rev ${entry.revision} · ${when(entry.updatedAt)}` })),
					),
				),
			];
		}),
	);
	list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function placeholder() {
	detail.replaceChildren(el("p", { className: "meta", textContent: "Select an entry, or press n to add one." }));
}

function renderRevision(entry: Entry): HTMLElement[] {
	return [
		el("p", { className: "meta", textContent: `key ${entry.key} · rev ${entry.revision} · ${when(entry.updatedAt)} by ${entry.author}` }),
		...(entry.evidence.length ? [el("ul", {}, ...entry.evidence.map((item) => el("li", { textContent: item })))] : []),
		el("div", { className: "content", textContent: entry.content }),
	];
}

async function select(id: number) {
	selected = id;
	renderList();
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) return;
	const history = await api<Entry[]>(`/api/entries/${id}/history`);
	// A later selection may have finished first.
	if (selected !== id) return;
	const earlier = history.slice(0, -1).reverse();
	const targets = scopes.filter((scope) => scope !== entry.scope);
	const destination = el("select", {}, ...targets.map((value) => el("option", { value, textContent: value })));
	const status = el("p", { className: "error" });
	const move = async () => {
		try {
			await api<Entry>(`/api/entries/${entry.id}/move`, {
				method: "POST",
				body: JSON.stringify({ scope: destination.value, expected_revision: entry.revision }),
			});
			await reload();
		} catch (failure) {
			status.replaceChildren(failure instanceof Error ? failure.message : String(failure));
			const occupant = failure instanceof ApiError ? failure.entry : undefined;
			if (occupant) status.append(" ", el("button", { textContent: `Open [${occupant.id}]`, onclick: () => void select(occupant.id) }));
		}
	};
	detail.replaceChildren(
		el("h1", { textContent: `[${entry.id}] ${entry.title}` }),
		el("div", {}, ...tags(entry)),
		...renderRevision(entry),
		el(
			"div",
			{ className: "actions" },
			el("button", { textContent: entry.retired ? "Edit and revive" : "Edit", onclick: () => entryForm(entry) }),
			entry.retired
				? el("button", { className: "danger", textContent: "Delete permanently", onclick: () => void remove(entry, history.length) })
				: el("button", { textContent: "Retire", onclick: () => void retire(entry) }),
			...(targets.length ? [el("span", { className: "move" }, "Move to ", destination, el("button", { textContent: "Move", onclick: () => void move() }))] : []),
		),
		status,
		...(earlier.length ? [el("h2", { textContent: "Earlier revisions" })] : []),
		...earlier.map((revision) =>
			el("details", {}, el("summary", { textContent: `rev ${revision.revision}: ${revision.title}` }), ...tags(revision), ...renderRevision(revision)),
		),
	);
}

// Form for a new entry, or for revising an existing one.
function entryForm(entry: Entry | null) {
	const scope = el("select", { required: true }, ...scopes.map((value) => el("option", { value, textContent: value })));
	scope.value = scopes.find((value) => value === scopeFilter.value) ?? "global";
	const key = el("input", { required: true, pattern: "[a-z0-9][a-z0-9\\-]{0,79}", placeholder: "kebab-case-topic", title: "lowercase kebab-case" });
	const kind = el("select", {}, ...KINDS.map((value) => el("option", { value, textContent: value })));
	kind.value = entry?.kind ?? "fact";
	const title = el("input", { required: true, value: entry?.title ?? "", maxLength: 120 });
	const content = el("textarea", { required: true, value: entry?.content ?? "", maxLength: 4000 });
	const evidence = el("textarea", { value: entry?.evidence.join("\n") ?? "", className: "evidence" });
	const pinned = el("input", { type: "checkbox", checked: entry?.pinned ?? false });
	const status = el("p", { className: "error" });

	const save = async (event: SubmitEvent) => {
		event.preventDefault();
		const body = {
			kind: kind.value,
			title: title.value,
			content: content.value,
			evidence: evidence.value.split("\n").map((line) => line.trim()).filter(Boolean),
			pinned: pinned.checked,
		};
		try {
			const saved = entry
				? await api<Entry>(`/api/entries/${entry.id}`, { method: "PUT", body: JSON.stringify({ ...body, expected_revision: entry.revision }) })
				: await api<Entry>("/api/entries", { method: "POST", body: JSON.stringify({ ...body, scope: scope.value, key: key.value }) });
			selected = saved.id;
			await reload();
		} catch (failure) {
			status.replaceChildren(failure instanceof Error ? failure.message : String(failure));
			const existing = failure instanceof ApiError ? failure.entry : undefined;
			if (existing) status.append(" ", el("button", { type: "button", textContent: `Edit [${existing.id}] instead`, onclick: () => void editExisting(existing) }));
		}
	};

	const form = el(
		"form",
		{
			onsubmit: (event) => void save(event as SubmitEvent),
			onkeydown: (event) => {
				if ((event.ctrlKey || event.metaKey) && event.key === "Enter") form.requestSubmit();
			},
		},
		...(entry ? [] : [el("label", {}, "Scope ", scope), el("label", {}, "Key", el("br"), key)]),
		el("label", {}, "Kind ", kind),
		el("label", {}, "Title", el("br"), title),
		el("label", {}, "Content", el("br"), content),
		el("label", {}, "Evidence, one per line", el("br"), evidence),
		el("label", {}, pinned, " Pinned"),
		el(
			"div",
			{ className: "actions" },
			el("button", { type: "submit", textContent: entry ? "Save revision" : "Create entry" }),
			el("button", { type: "button", textContent: "Cancel", onclick: () => (entry ? void select(entry.id) : placeholder()) }),
		),
		status,
	);

	detail.replaceChildren(
		el("h1", { textContent: entry ? `Edit [${entry.id}]` : "New entry" }),
		...(entry ? [el("p", { className: "meta", textContent: `${entry.scope} · key ${entry.key} · replacing rev ${entry.revision}` })] : []),
		form,
	);
	(entry ? title : key).focus();
}

async function editExisting(entry: Entry) {
	selected = entry.id;
	await reload();
	entryForm(entries.find((candidate) => candidate.id === entry.id) ?? entry);
}

async function retire(entry: Entry) {
	if (!confirm(`Retire [${entry.id}] ${entry.title}?`)) return;
	await api<Entry>(`/api/entries/${entry.id}/retire`, { method: "POST" });
	await reload();
}

async function remove(entry: Entry, revisions: number) {
	if (!confirm(`Permanently delete [${entry.id}] ${entry.title} and its ${revisions} revisions? This cannot be undone.`)) return;
	await api<null>(`/api/entries/${entry.id}`, { method: "DELETE" });
	selected = null;
	await reload();
}

async function reload() {
	[entries, scopes] = await Promise.all([api<Entry[]>("/api/entries"), api<Scope[]>("/api/scopes")]);
	options(scopeFilter, "All scopes", [...new Set([...scopes, ...entries.map((entry) => entry.scope)])].sort((a, b) => scopeOrder(a).localeCompare(scopeOrder(b))));
	options(kindFilter, "All kinds", KINDS);
	if (selected !== null && !entries.some((entry) => entry.id === selected)) selected = null;
	renderList();
	if (selected === null) placeholder();
	else await select(selected);
}

function move(step: number) {
	if (!visible.length) return;
	const index = visible.findIndex((entry) => entry.id === selected);
	const next = visible[index < 0 ? 0 : Math.min(Math.max(index + step, 0), visible.length - 1)];
	if (next) void select(next.id);
}

document.addEventListener("keydown", (event) => {
	const target = event.target;
	const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
	if (typing) {
		if (event.key === "Escape") target.blur();
		return;
	}
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	const current = entries.find((entry) => entry.id === selected);
	switch (event.key) {
		case "j":
		case "ArrowDown":
			move(1);
			break;
		case "k":
		case "ArrowUp":
			move(-1);
			break;
		case "/":
			search.focus();
			break;
		case "n":
			entryForm(null);
			break;
		case "e":
			if (current) entryForm(current);
			break;
		default:
			return;
	}
	event.preventDefault();
});

for (const input of [search, scopeFilter, kindFilter, showRetired]) input.addEventListener("input", renderList);
$<HTMLButtonElement>("new").addEventListener("click", () => entryForm(null));
void reload();
