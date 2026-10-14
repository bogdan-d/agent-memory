/// <reference lib="dom" />
import { KINDS } from "./schema";
import type { Entry } from "./store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = $<HTMLInputElement>("search");
const scopeFilter = $<HTMLSelectElement>("scope");
const kindFilter = $<HTMLSelectElement>("kind");
const showRetired = $<HTMLInputElement>("retired");
const list = $<HTMLUListElement>("list");
const detail = $<HTMLElement>("detail");

let entries: Entry[] = [];
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
	const body = await response.json();
	if (!response.ok) throw new Error((body as { error: string }).error);
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
		el("span", { className: "tag", textContent: entry.kind }),
		...(entry.pinned ? [el("span", { className: "tag", textContent: "pinned" })] : []),
		...(entry.retired ? [el("span", { className: "tag retired-tag", textContent: "retired" })] : []),
	];
}

function renderList() {
	const text = search.value.trim().toLowerCase();
	const visible = entries.filter(
		(entry) =>
			(showRetired.checked || !entry.retired) &&
			(!scopeFilter.value || entry.scope === scopeFilter.value) &&
			(!kindFilter.value || entry.kind === kindFilter.value) &&
			(!text || [entry.key, entry.title, entry.content, ...entry.evidence].join("\n").toLowerCase().includes(text)),
	);
	list.replaceChildren(
		...visible.map((entry) =>
			el(
				"li",
				{
					className: [entry.id === selected ? "selected" : "", entry.retired ? "retired" : ""].join(" "),
					onclick: () => void select(entry.id),
				},
				el("div", {}, el("strong", { textContent: `[${entry.id}] ` }), entry.title),
				el("div", {}, ...tags(entry), el("small", { textContent: `rev ${entry.revision} · ${when(entry.updatedAt)}` })),
			),
		),
	);
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
	const earlier = history.slice(0, -1).reverse();
	detail.replaceChildren(
		el("h1", { textContent: `[${entry.id}] ${entry.title}` }),
		el("div", {}, ...tags(entry)),
		...renderRevision(entry),
		el(
			"div",
			{ className: "actions" },
			el("button", { textContent: entry.retired ? "Edit and revive" : "Edit", onclick: () => edit(entry) }),
			...(entry.retired ? [] : [el("button", { textContent: "Retire", onclick: () => void retire(entry) })]),
		),
		...(earlier.length ? [el("h2", { textContent: "Earlier revisions" })] : []),
		...earlier.map((revision) =>
			el("details", {}, el("summary", { textContent: `rev ${revision.revision}: ${revision.title}` }), ...tags(revision), ...renderRevision(revision)),
		),
	);
}

function edit(entry: Entry) {
	const kind = el("select", {}, ...KINDS.map((value) => el("option", { value, textContent: value })));
	kind.value = entry.kind;
	const title = el("input", { value: entry.title, maxLength: 120 });
	const content = el("textarea", { value: entry.content, maxLength: 4000 });
	const evidence = el("textarea", { value: entry.evidence.join("\n"), className: "evidence" });
	const pinned = el("input", { type: "checkbox", checked: entry.pinned });
	const status = el("p", { className: "error" });

	const save = async (event: SubmitEvent) => {
		event.preventDefault();
		try {
			await api<Entry>(`/api/entries/${entry.id}`, {
				method: "PUT",
				body: JSON.stringify({
					kind: kind.value,
					title: title.value,
					content: content.value,
					evidence: evidence.value.split("\n").map((line) => line.trim()).filter(Boolean),
					pinned: pinned.checked,
					expected_revision: entry.revision,
				}),
			});
			await reload();
		} catch (failure) {
			status.textContent = failure instanceof Error ? failure.message : String(failure);
		}
	};

	detail.replaceChildren(
		el("h1", { textContent: `Edit [${entry.id}]` }),
		el("p", { className: "meta", textContent: `${entry.scope} · key ${entry.key} · replacing rev ${entry.revision}` }),
		el(
			"form",
			{ onsubmit: (event) => void save(event as SubmitEvent) },
			el("label", {}, "Kind ", kind),
			el("label", {}, "Title", el("br"), title),
			el("label", {}, "Content", el("br"), content),
			el("label", {}, "Evidence, one per line", el("br"), evidence),
			el("label", {}, pinned, " Pinned"),
			el("div", { className: "actions" }, el("button", { type: "submit", textContent: "Save revision" }), el("button", { type: "button", textContent: "Cancel", onclick: () => void select(entry.id) })),
			status,
		),
	);
}

async function retire(entry: Entry) {
	if (!confirm(`Retire [${entry.id}] ${entry.title}?`)) return;
	await api<Entry>(`/api/entries/${entry.id}/retire`, { method: "POST" });
	await reload();
}

async function reload() {
	entries = await api<Entry[]>("/api/entries");
	options(scopeFilter, "All scopes", [...new Set(entries.map((entry) => entry.scope))].sort());
	options(kindFilter, "All kinds", KINDS);
	renderList();
	if (selected !== null) await select(selected);
}

for (const input of [search, scopeFilter, kindFilter, showRetired]) input.addEventListener("input", renderList);
void reload();
