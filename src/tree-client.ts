/// <reference lib="dom" />
import { KINDS, type Kind } from "./schema";
import type { Overview } from "./render";
import type { Entry, Project, Scope } from "./store";

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
const canvas = $<SVGSVGElement>("canvas");
const viewport = $<SVGGElement>("viewport");
const linkLayer = $<SVGGElement>("links");
const nodeLayer = $<SVGGElement>("nodes");
const panel = $<HTMLElement>("panel");
const filter = $<HTMLInputElement>("filter");
const showRetired = $<HTMLInputElement>("retired");
const matchCount = $<HTMLElement>("matches");
const status = $<HTMLElement>("status");
const themeButton = $<HTMLButtonElement>("theme");

// Data

let entries: Entry[] = [];
let projects: Project[] = [];
// Scopes an entry may be created in or moved to.
let scopes: Scope[] = [];

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

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

function notify(text: string, error = false) {
	status.textContent = text;
	status.className = error ? "error" : "";
}

// Tree model. Scope nodes use their scope as ID, entries use entry:<id>.

type NodeType = "root" | "global" | "group" | "ungrouped" | "project" | "entry";

interface TreeNode {
	id: string;
	type: NodeType;
	label: string;
	children: TreeNode[];
	entry?: Entry;
	project?: Project;
	// A group without member projects, or entries under a project that is not registered: no agent reads these.
	orphan: boolean;
	// Visible entries in this subtree, by kind.
	counts: Record<Kind, number>;
	total: number;
	match: boolean;
	matchBelow: boolean;
}

const expanded = new Set<string>(["root", "global", "ungrouped"]);
let selected = "root";
let tree: TreeNode | null = null;
const nodes = new Map<string, TreeNode>();
const parents = new Map<string, string>();

const entryText = (entry: Entry) => [`#${entry.id}`, entry.key, entry.title, entry.content, ...entry.evidence].join("\n").toLowerCase();
// The order of the session-start overview: open handoffs, then pinned entries, then the rest, each newest first.
// Retired entries, which agents do not see, come last.
const rank = (entry: Entry) => (entry.retired ? 3 : entry.kind === "handoff" ? 0 : entry.pinned ? 1 : 2);
const entryOrder = (a: Entry, b: Entry) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id;
const groupNames = () =>
	[...new Set([...projects.flatMap((project) => (project.group ? [project.group] : [])), ...entries.flatMap((entry) => (entry.scope.startsWith("group:") ? [entry.scope.slice(6)] : []))])].sort();

function build(): TreeNode {
	const text = filter.value.trim().toLowerCase();
	const visible = entries.filter((entry) => showRetired.checked || !entry.retired);
	const byScope = Map.groupBy(visible, (entry): string => entry.scope);
	const make = (id: string, type: NodeType, label: string, children: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode => ({
		id,
		type,
		label,
		children,
		orphan: false,
		counts: { fact: 0, decision: 0, hypothesis: 0, handoff: 0 },
		total: 0,
		match: false,
		matchBelow: false,
		...extra,
	});
	const leaves = (scope: string) =>
		(byScope.get(scope) ?? [])
			.toSorted(entryOrder)
			.map((entry) => make(`entry:${entry.id}`, "entry", entry.title, [], { entry, match: Boolean(text) && entryText(entry).includes(text) }));
	const projectNode = (project: Project) => make(`project:${project.id}`, "project", project.id, leaves(`project:${project.id}`), { project });
	const registered = new Set(projects.map((project) => `project:${project.id}`));
	const stray = [...byScope.keys()]
		.filter((scope) => scope.startsWith("project:") && !registered.has(scope))
		.sort()
		.map((scope) => make(scope, "project", scope.slice(8), leaves(scope), { orphan: true }));
	const ungrouped = projects.filter((project) => !project.group);

	const root = make("root", "root", "memory", [
		make("global", "global", "global", leaves("global")),
		...groupNames()
			.filter((group) => projects.some((project) => project.group === group) || byScope.has(`group:${group}`))
			.map((group) => {
				const members = projects.filter((project) => project.group === group);
				return make(`group:${group}`, "group", group, [...members.map(projectNode), ...leaves(`group:${group}`)], { orphan: !members.length });
			}),
		...(ungrouped.length || stray.length || projects.length ? [make("ungrouped", "ungrouped", "no group", [...ungrouped.map(projectNode), ...stray])] : []),
	]);

	nodes.clear();
	parents.clear();
	const tally = (node: TreeNode) => {
		nodes.set(node.id, node);
		if (text && node.type !== "entry" && node.type !== "root") node.match = node.label.toLowerCase().includes(text);
		if (node.entry) {
			node.counts[node.entry.kind]++;
			node.total++;
		}
		for (const child of node.children) {
			parents.set(child.id, node.id);
			tally(child);
			for (const kind of KINDS) node.counts[kind] += child.counts[kind];
			node.total += child.total;
			node.matchBelow ||= child.matchBelow;
		}
		node.matchBelow ||= node.match;
	};
	tally(root);
	return root;
}

function ancestors(id: string): string[] {
	const path: string[] = [];
	for (let parent = parents.get(id); parent; parent = parents.get(parent)) path.push(parent);
	return path;
}

// Layout: one row per visible leaf, a column per depth that is as wide as its widest node, parents centred on their children.

interface Placed {
	node: TreeNode;
	parent: string | null;
	x: number;
	y: number;
	w: number;
}

const ROW = 24;
const GAP = 56;
const BAR = 36;
const SCOPE_FONT = "600 13px system-ui, sans-serif";
// Entry titles turn bold on hover and selection, so rows are sized for the bold title.
const ENTRY_FONT = "600 12.5px system-ui, sans-serif";
const SMALL_FONT = "11px system-ui, sans-serif";
const measurer = document.createElement("canvas").getContext("2d");
const textWidth = (text: string, font: string) => {
	if (!measurer) return text.length * 7;
	measurer.font = font;
	return measurer.measureText(text).width;
};

const entryId = (entry: Entry) => `[${entry.id}] `;
const addable = (node: TreeNode) => scopes.includes(node.id as Scope);

// Pieces of a scope pill, left to right: chevron, label, count, kind bar, add button.
function pill(node: TreeNode) {
	const label = 22;
	const count = label + textWidth(node.label, SCOPE_FONT) + 8;
	const bar = count + textWidth(String(node.total), SMALL_FONT) + 6;
	const add = bar + (node.total ? BAR + 8 : 0);
	return { label, count, bar, add, width: add + (addable(node) ? 22 : 4) };
}

const nodeWidth = (node: TreeNode) =>
	node.entry ? 16 + textWidth(entryId(node.entry), SMALL_FONT) + textWidth(node.entry.title, ENTRY_FONT) : pill(node).width;

function layout(root: TreeNode): Map<string, Placed> {
	const open = (node: TreeNode) => node.children.length > 0 && expanded.has(node.id);
	const columns: number[] = [];
	const measure = (node: TreeNode, depth: number) => {
		if (!node.entry) columns[depth] = Math.max(columns[depth] ?? 0, nodeWidth(node));
		if (open(node)) for (const child of node.children) measure(child, depth + 1);
	};
	measure(root, 0);
	const xs = [0];
	for (let depth = 1; depth <= columns.length; depth++) xs[depth] = (xs[depth - 1] ?? 0) + (columns[depth - 1] ?? 0) + GAP;

	const placed = new Map<string, Placed>();
	let row = 0;
	const place = (node: TreeNode, depth: number, parent: string | null): number => {
		let y = row * ROW;
		if (open(node)) {
			const ys = node.children.map((child) => place(child, depth + 1, node.id));
			y = ((ys[0] ?? 0) + (ys.at(-1) ?? 0)) / 2;
		} else row++;
		placed.set(node.id, { node, parent, x: xs[depth] ?? 0, y, w: nodeWidth(node) });
		return y;
	};
	place(root, 0, null);
	return placed;
}

// Drawing

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string | number> = {},
	...children: (Node | string)[]
): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG, tag);
	for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
	element.append(...children);
	return element;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const element = Object.assign(document.createElement(tag), props);
	element.append(...children);
	return element;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const countText = (node: TreeNode) =>
	`${plural(node.total, "entry", "entries")}${node.total ? `: ${KINDS.filter((kind) => node.counts[kind]).map((kind) => `${node.counts[kind]} ${kind}`).join(", ")}` : ""}`;

function drawNode(node: TreeNode, width: number): SVGGElement {
	const text = filter.value.trim();
	const classes = ["node", `type-${node.type}`, node.entry ? `entry kind-${node.entry.kind}` : "scope"];
	if (node.id === selected) classes.push("selected");
	if (node.orphan) classes.push("orphan");
	if (node.match) classes.push("match");
	if (text && !node.matchBelow) classes.push("dim");
	const g = svg("g", { class: classes.join(" "), "data-id": node.id });

	if (node.entry) {
		const entry = node.entry;
		if (entry.pinned) classes.push("pinned");
		if (entry.retired) classes.push("retired");
		g.setAttribute("class", classes.join(" "));
		g.append(
			svg("title", {}, `#${entry.id} ${entry.title}\n${entry.kind}${entry.pinned ? " · pinned" : ""}${entry.retired ? " · retired" : ""} · ${entry.scope} · key ${entry.key}`),
			svg("rect", { class: "hit", x: -4, y: -ROW / 2 + 1, width: width + 8, height: ROW - 2, rx: 4 }),
			...(entry.pinned ? [svg("circle", { class: "ring", cx: 5, r: 8 })] : []),
			svg("circle", { class: "dot", cx: 5, r: 5 }),
			svg("text", { x: 16 }, svg("tspan", { class: "id" }, entryId(entry)), entry.title),
		);
		return g;
	}

	const parts = pill(node);
	const segments: SVGRectElement[] = [];
	let offset = parts.bar;
	for (const kind of KINDS) {
		if (!node.counts[kind]) continue;
		const size = (BAR * node.counts[kind]) / node.total;
		segments.push(svg("rect", { class: `kind-${kind}`, x: offset, y: -3, width: size, height: 6 }));
		offset += size;
	}
	const open = expanded.has(node.id);
	g.append(
		svg("title", {}, `${node.type === "group" ? "group " : node.type === "project" ? "project " : ""}${node.label}${node.orphan ? (node.type === "group" ? " (no member projects)" : " (not registered)") : ""}\n${countText(node)}`),
		svg("rect", { class: "pill", x: 0, y: -10, width, height: 20, rx: 10 }),
		...(node.children.length
			? [svg("g", { class: "chevron" }, svg("rect", { class: "hit", x: 0, y: -10, width: 20, height: 20, rx: 10 }), svg("text", { x: 7 }, open ? "▾" : "▸"))]
			: []),
		svg("text", { class: "label", x: parts.label }, node.label),
		svg("text", { class: "count", x: parts.count }, String(node.total)),
		...segments,
		...(addable(node)
			? [svg("g", { class: "add" }, svg("title", {}, "Add entry here"), svg("circle", { cx: parts.add + 9, r: 8 }), svg("text", { x: parts.add + 9 }, "+"))]
			: []),
	);
	return g;
}

// Rendering with animated transitions. Positions are in layout units; the viewport transform pans and zooms.

interface Point {
	x: number;
	y: number;
}

let current = new Map<string, Placed>();
let shown = new Map<string, Point>();
let frame = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const linkPath = (from: Point, width: number, to: Point) => {
	const x1 = from.x + width;
	const middle = (x1 + to.x) / 2;
	return `M${x1},${from.y}C${middle},${from.y} ${middle},${to.y} ${to.x},${to.y}`;
};

// Redraws the tree. The anchor node keeps its place on screen, so the part being worked on does not jump.
function render(anchor: string = selected) {
	tree = build();
	const next = layout(tree);
	const before = shown.get(anchor);
	const after = next.get(anchor);
	if (before && after) {
		const dx = before.x - after.x;
		const dy = before.y - after.y;
		for (const placed of next.values()) {
			placed.x += dx;
			placed.y += dy;
		}
	}
	const previous = current;
	current = next;

	// Entering nodes grow out of their nearest visible ancestor; leaving nodes shrink into theirs.
	const enterFrom = (id: string): Point | undefined => {
		for (let parent = next.get(id)?.parent; parent; parent = next.get(parent)?.parent) {
			const point = shown.get(parent);
			if (point) return point;
		}
		return undefined;
	};
	const exitTo = (id: string): Point | undefined => {
		for (let parent = previous.get(id)?.parent; parent; parent = previous.get(parent)?.parent) {
			const placed = next.get(parent);
			if (placed) return placed;
		}
		return undefined;
	};

	interface Item {
		placed: Placed;
		from: Point;
		to: Point;
		fade: 0 | 1 | -1;
		g: SVGGElement;
		link: SVGPathElement | null;
	}
	const items: Item[] = [];
	const add = (placed: Placed, from: Point, to: Point, fade: Item["fade"]) =>
		items.push({ placed, from, to, fade, g: drawNode(placed.node, placed.w), link: placed.parent ? svg("path", { class: "link" }) : null });
	for (const placed of next.values()) {
		const seen = shown.get(placed.node.id);
		add(placed, seen ?? enterFrom(placed.node.id) ?? placed, placed, seen ? 0 : 1);
	}
	for (const placed of previous.values()) {
		if (next.has(placed.node.id)) continue;
		const seen = shown.get(placed.node.id) ?? placed;
		add(placed, seen, exitTo(placed.node.id) ?? seen, -1);
	}
	linkLayer.replaceChildren(...items.flatMap((item) => (item.link ? [item.link] : [])));
	nodeLayer.replaceChildren(...items.map((item) => item.g));

	const widths = new Map([...previous, ...next].map(([id, placed]) => [id, placed.w]));
	const duration = reducedMotion.matches || !previous.size ? 0 : 280;
	const start = performance.now();
	cancelAnimationFrame(frame);
	const step = (now: number) => {
		const t = duration ? Math.min(1, (now - start) / duration) : 1;
		const eased = 1 - (1 - t) ** 3;
		const at = new Map<string, Point>();
		for (const item of items) {
			const point = { x: item.from.x + (item.to.x - item.from.x) * eased, y: item.from.y + (item.to.y - item.from.y) * eased };
			at.set(item.placed.node.id, point);
			item.g.setAttribute("transform", `translate(${point.x},${point.y})`);
			const opacity = item.fade === 1 ? eased : item.fade === -1 ? 1 - eased : 1;
			item.g.style.opacity = String(opacity);
			if (item.link) item.link.style.opacity = String(opacity);
		}
		for (const item of items) {
			const parent = item.placed.parent;
			const from = parent ? at.get(parent) : undefined;
			const to = at.get(item.placed.node.id);
			if (item.link && from && to) item.link.setAttribute("d", linkPath(from, widths.get(parent ?? "") ?? 0, to));
		}
		shown = new Map([...at].filter(([id]) => next.has(id)));
		if (t < 1) frame = requestAnimationFrame(step);
		else for (const item of items) if (item.fade === -1) (item.g.remove(), item.link?.remove());
	};
	step(start);

	const text = filter.value.trim();
	matchCount.textContent = text ? plural([...nodes.values()].filter((node) => node.match).length, "match", "matches") : "";
}

// Pan and zoom

const view = { k: 1, x: 24, y: 24 };
const applyView = () => viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);

function zoomAt(x: number, y: number, factor: number) {
	const k = Math.min(3, Math.max(0.15, view.k * factor));
	view.x = x - ((x - view.x) * k) / view.k;
	view.y = y - ((y - view.y) * k) / view.k;
	view.k = k;
	applyView();
}

// Scale below which labels get hard to read.
const READABLE = 0.8;

// Fits the whole tree if it fits at a readable scale; otherwise shows its top-left corner, and scrolling pans the rest.
function fit() {
	const box = canvas.getBoundingClientRect();
	const placed = [...current.values()];
	if (!placed.length) return;
	const left = Math.min(...placed.map((item) => item.x));
	const right = Math.max(...placed.map((item) => item.x + item.w));
	const top = Math.min(...placed.map((item) => item.y)) - ROW;
	const bottom = Math.max(...placed.map((item) => item.y)) + ROW;
	view.k = Math.min(1, Math.max(READABLE, Math.min((box.width - 48) / (right - left), (box.height - 24) / (bottom - top))));
	view.x = 24 - left * view.k;
	view.y = Math.max(12, (box.height - (bottom - top) * view.k) / 2) - top * view.k;
	applyView();
}

// Pans just enough to bring a node into view.
function reveal(id: string) {
	const placed = current.get(id);
	if (!placed) return;
	const box = canvas.getBoundingClientRect();
	const x = view.x + placed.x * view.k;
	const y = view.y + placed.y * view.k;
	const right = x + Math.min(placed.w * view.k, box.width / 2);
	if (x < 16) view.x += 16 - x;
	else if (right > box.width - 16) view.x -= right - box.width + 16;
	if (y < 24 || y > box.height - 24) view.y += box.height / 2 - y;
	applyView();
}

canvas.addEventListener(
	"wheel",
	(event) => {
		event.preventDefault();
		// Line and page deltas become pixels.
		const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
		// Ctrl+wheel zooms; trackpad pinches arrive as Ctrl+wheel too.
		if (event.ctrlKey || event.metaKey) {
			const box = canvas.getBoundingClientRect();
			const step = Math.min(0.25, Math.max(-0.25, -event.deltaY * unit * 0.002));
			return zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(step));
		}
		// Plain wheel pans; Shift turns a mouse wheel's vertical scroll sideways.
		const [dx, dy] = event.shiftKey && !event.deltaX ? [event.deltaY, 0] : [event.deltaX, event.deltaY];
		view.x -= dx * unit;
		view.y -= dy * unit;
		applyView();
	},
	{ passive: false },
);

// Pointer gestures: a press that does not move is a click; dragging an entry or project moves it; anything else pans.

interface Gesture {
	pointer: number;
	x: number;
	y: number;
	target: Element;
	id: string | null;
	view: { x: number; y: number };
	mode: "press" | "pan" | "drag";
	targets: Set<string>;
	hover: string | null;
	ghost: HTMLElement | null;
}
let gesture: Gesture | null = null;
const nodeElement = (id: string) => nodeLayer.querySelector<SVGGElement>(`[data-id="${CSS.escape(id)}"]`);

// Where an entry or project could be dropped.
function dropTargets(node: TreeNode): Set<string> {
	if (node.entry) {
		const from = node.entry.scope;
		return new Set(scopes.filter((scope) => scope !== from));
	}
	if (node.project && !node.orphan) {
		const group = node.project.group;
		return new Set([...nodes.values()].filter((other) => (other.type === "group" && other.label !== group) || (other.type === "ungrouped" && group)).map((other) => other.id));
	}
	return new Set();
}

canvas.addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	const target = event.target as Element;
	canvas.setPointerCapture(event.pointerId);
	gesture = {
		pointer: event.pointerId,
		x: event.clientX,
		y: event.clientY,
		target,
		id: target.closest("g.node")?.getAttribute("data-id") ?? null,
		view: { x: view.x, y: view.y },
		mode: "press",
		targets: new Set(),
		hover: null,
		ghost: null,
	};
});

canvas.addEventListener("pointermove", (event) => {
	if (!gesture || event.pointerId !== gesture.pointer) return;
	const dx = event.clientX - gesture.x;
	const dy = event.clientY - gesture.y;
	if (gesture.mode === "press") {
		if (Math.hypot(dx, dy) < 5) return;
		const node = gesture.id ? nodes.get(gesture.id) : undefined;
		const targets = node ? dropTargets(node) : new Set<string>();
		if (node && targets.size) {
			gesture.mode = "drag";
			gesture.targets = targets;
			gesture.ghost = el("div", { id: "ghost", textContent: node.entry ? `#${node.entry.id} ${node.entry.title}` : `project ${node.label}` });
			document.body.append(gesture.ghost);
			nodeElement(node.id)?.classList.add("dragging-source");
			for (const id of targets) nodeElement(id)?.classList.add("drop-target");
		} else {
			gesture.mode = "pan";
			canvas.classList.add("panning");
		}
	}
	if (gesture.mode === "pan") {
		view.x = gesture.view.x + dx;
		view.y = gesture.view.y + dy;
		applyView();
		return;
	}
	if (gesture.ghost) gesture.ghost.style.left = `${event.clientX}px`;
	if (gesture.ghost) gesture.ghost.style.top = `${event.clientY}px`;
	const over = document.elementFromPoint(event.clientX, event.clientY)?.closest("g.node")?.getAttribute("data-id") ?? null;
	const hover = over && gesture.targets.has(over) ? over : null;
	if (hover !== gesture.hover) {
		if (gesture.hover) nodeElement(gesture.hover)?.classList.remove("drop-hover");
		if (hover) nodeElement(hover)?.classList.add("drop-hover");
		gesture.hover = hover;
	}
});

// Ends the current gesture. A cancelled one clicks and drops nothing.
function endGesture(cancelled: boolean) {
	const done = gesture;
	if (!done) return;
	gesture = null;
	if (canvas.hasPointerCapture(done.pointer)) canvas.releasePointerCapture(done.pointer);
	canvas.classList.remove("panning");
	done.ghost?.remove();
	for (const element of nodeLayer.querySelectorAll(".drop-target, .drop-hover, .dragging-source")) {
		element.classList.remove("drop-target", "drop-hover", "dragging-source");
	}
	if (cancelled) return;
	if (done.mode === "press") click(done.id, done.target);
	if (done.mode === "drag" && done.id && done.hover) void drop(done.id, done.hover);
}
canvas.addEventListener("pointerup", (event) => event.pointerId === gesture?.pointer && endGesture(false));
canvas.addEventListener("pointercancel", (event) => event.pointerId === gesture?.pointer && endGesture(true));

function click(id: string | null, target: Element) {
	const node = id ? nodes.get(id) : undefined;
	if (!node) return;
	if (target.closest(".add")) return entryForm(null, node.id as Scope);
	if (target.closest(".chevron")) return toggle(node.id);
	if (node.children.length && !expanded.has(node.id)) expanded.add(node.id);
	select(node.id);
}

function toggle(id: string) {
	if (expanded.has(id)) expanded.delete(id);
	else expanded.add(id);
	render(id);
}

async function drop(id: string, target: string) {
	const node = nodes.get(id);
	if (node?.entry) await moveEntry(node.entry, target as Scope);
	else if (node?.project) await regroup(node.project, target === "ungrouped" ? null : target.slice(6));
}

// Operations

const fetchAll = () => Promise.all([api<Entry[]>("/api/entries"), api<Project[]>("/api/projects"), api<Scope[]>("/api/scopes")]);
type Data = Awaited<ReturnType<typeof fetchAll>>;

// The data last shown, to tell whether a refresh found changes.
let snapshot = "";
function apply(data: Data) {
	[entries, projects, scopes] = data;
	snapshot = JSON.stringify(data);
}

async function reload(anchor?: string) {
	apply(await fetchAll());
	const first = !tree;
	if (first) for (const group of groupNames()) expanded.add(`group:${group}`);
	render(anchor);
	if (!nodes.has(selected) && !selectedEntry()) selected = "root";
	if (first) fit();
	showPanel();
}

// Picks up changes made outside this page, such as agents saving memories. Leaves an open form or a focused panel control alone.
let offline = false;
async function refresh() {
	if (document.hidden || gesture) return;
	try {
		const data = await fetchAll();
		if (offline) notify("");
		offline = false;
		if (gesture || JSON.stringify(data) === snapshot) return;
		apply(data);
		render();
		if (!nodes.has(selected) && !selectedEntry()) selected = "root";
		if (!panel.querySelector("form") && !panel.contains(document.activeElement)) showPanel();
	} catch {
		offline = true;
		notify("Cannot reach the server; changes made elsewhere will show once it is back.", true);
	}
}

const selectedEntry = () => (selected.startsWith("entry:") ? entries.find((entry) => `entry:${entry.id}` === selected) : undefined);

function select(id: string) {
	selected = id;
	overviewOpen = false;
	for (const parent of ancestors(id)) expanded.add(parent);
	render(id);
	reveal(id);
	showPanel();
}

async function moveEntry(entry: Entry, scope: Scope) {
	try {
		await api<Entry>(`/api/entries/${entry.id}/move`, { method: "POST", body: JSON.stringify({ scope, expected_revision: entry.revision }) });
		expanded.add(scope);
		for (const parent of ancestors(scope)) expanded.add(parent);
		selected = `entry:${entry.id}`;
		await reload(scope);
		reveal(selected);
		notify(`Moved #${entry.id} to ${scope}.`);
	} catch (failure) {
		const occupant = failure instanceof ApiError ? failure.entry : undefined;
		notify(`${message(failure)}${occupant && occupant.id !== entry.id ? ` (#${occupant.id})` : ""}`, true);
		await reload();
	}
}

const activeIn = (scope: string) => entries.filter((entry) => entry.scope === scope && !entry.retired).length;

// Changes a project's group after confirmation, because the project's agents read the group's entries.
async function regroup(project: Project, group: string | null) {
	if (group === project.group) return;
	const lines = [`Move project ${project.id} ${project.group ? `from group ${project.group} ` : ""}${group ? `to group ${group}` : "out of its group"}?`, ""];
	if (project.group) lines.push(`Its agents stop reading the ${activeIn(`group:${project.group}`)} active entries of group:${project.group}.`);
	if (group) {
		const known = groupNames().includes(group);
		lines.push(known ? `Its agents start reading the ${activeIn(`group:${group}`)} active entries of group:${group}.` : `This creates the new group ${group}.`);
	}
	const others = projects.filter((other) => other.group === project.group && other.id !== project.id);
	if (project.group && !others.length && activeIn(`group:${project.group}`)) {
		lines.push(`group:${project.group} has no other members, so no project will read its entries until one joins it.`);
	}
	if (!confirm(lines.join("\n"))) return;
	try {
		await api<Project>(`/api/projects/${encodeURIComponent(project.id)}/group`, { method: "PUT", body: JSON.stringify({ group }) });
		const parent = group ? `group:${group}` : "ungrouped";
		expanded.add(parent);
		selected = `project:${project.id}`;
		await reload(parent);
		reveal(selected);
		notify(`Project ${project.id} is now ${group ? `in group ${group}` : "in no group"}.`);
	} catch (failure) {
		notify(message(failure), true);
	}
}

async function retire(entry: Entry) {
	if (!confirm(`Retire #${entry.id} ${entry.title}?`)) return;
	try {
		await api<Entry>(`/api/entries/${entry.id}/retire`, { method: "POST" });
		await reload();
		notify(`Retired #${entry.id}.`);
	} catch (failure) {
		notify(message(failure), true);
	}
}

async function remove(entry: Entry, revisions: number) {
	if (!confirm(`Permanently delete #${entry.id} ${entry.title} and its ${revisions} revisions? This cannot be undone.`)) return;
	try {
		await api<null>(`/api/entries/${entry.id}`, { method: "DELETE" });
		selected = parents.get(selected) ?? entry.scope;
		await reload();
		notify(`Deleted #${entry.id}.`);
	} catch (failure) {
		notify(message(failure), true);
	}
}

// Panel

const when = (iso: string) => new Date(iso).toLocaleString();

// Whether the selected project's panel shows the overview its agents get at session start.
let overviewOpen = false;

function showPanel() {
	const entry = selectedEntry();
	if (entry) return void showEntry(entry);
	const node = nodes.get(selected);
	if (!node || node.type === "root") return showSummary();
	if (overviewOpen && (node.project || node.type === "global")) return void showOverview(node.project ?? null);
	showScope(node);
}

function kindTags(entry: Entry) {
	return [
		el("span", { className: "tag", textContent: entry.scope }),
		el("span", { className: `tag kind-${entry.kind}`, textContent: entry.kind }),
		...(entry.pinned ? [el("span", { className: "tag pinned", textContent: "pinned" })] : []),
		...(entry.retired ? [el("span", { className: "tag retired", textContent: "retired" })] : []),
	];
}

function revisionBody(entry: Entry) {
	return [
		el("p", { className: "meta", textContent: `key ${entry.key} · rev ${entry.revision} · ${when(entry.updatedAt)} by ${entry.author}` }),
		el("div", { className: "content", textContent: entry.content }),
		...(entry.evidence.length ? [el("h2", { textContent: "Evidence" }), el("ul", {}, ...entry.evidence.map((item) => el("li", { textContent: item })))] : []),
	];
}

function scopeSelect(values: readonly string[], value: string) {
	const select = el("select", {}, ...values.map((scope) => el("option", { value: scope, textContent: scope })));
	select.value = value;
	return select;
}

async function showEntry(entry: Entry) {
	const id = selected;
	const history = await api<Entry[]>(`/api/entries/${entry.id}/history`).catch(() => [] as Entry[]);
	// A later selection may have finished first.
	if (selected !== id) return;
	const targets = scopes.filter((scope) => scope !== entry.scope);
	const destination = scopeSelect(targets, targets[0] ?? "");
	const earlier = history.slice(0, -1).reverse();
	panel.replaceChildren(
		el("h1", { textContent: `#${entry.id} ${entry.title}` }),
		el("div", {}, ...kindTags(entry)),
		...revisionBody(entry),
		el(
			"div",
			{ className: "actions" },
			el("button", { textContent: entry.retired ? "Edit and revive" : "Edit", onclick: () => entryForm(entry, entry.scope) }),
			entry.retired
				? el("button", { className: "danger", textContent: "Delete permanently", onclick: () => void remove(entry, history.length) })
				: el("button", { textContent: "Retire", onclick: () => void retire(entry) }),
		),
		...(targets.length
			? [el("div", { className: "actions" }, "Move to ", destination, el("button", { textContent: "Move", onclick: () => void moveEntry(entry, destination.value as Scope) }))]
			: []),
		...(earlier.length ? [el("h2", { textContent: "Earlier revisions" })] : []),
		...earlier.map((revision) =>
			el("details", {}, el("summary", { textContent: `rev ${revision.revision}: ${revision.title}` }), el("div", {}, ...kindTags(revision)), ...revisionBody(revision)),
		),
	);
}

function countsLine(node: TreeNode) {
	return el("p", { className: "meta", textContent: countText(node) });
}

function showScope(node: TreeNode) {
	const add = addable(node) ? [el("button", { className: "primary", textContent: "Add entry here", onclick: () => entryForm(null, node.id as Scope) })] : [];
	const children = (type: NodeType) => node.children.filter((child) => child.type === type);
	const projectList = (list: TreeNode[]) =>
		el("ul", {}, ...list.map((child) => el("li", {}, el("a", { href: "#", textContent: child.label, onclick: (event) => (event.preventDefault(), select(child.id)) }), el("small", { textContent: ` ${child.total}` }))));

	if (node.type === "global") {
		return panel.replaceChildren(
			el("h1", { textContent: "global" }),
			el("p", { textContent: "Read by every agent, in every project." }),
			countsLine(node),
			el(
				"div",
				{ className: "actions" },
				...add,
				el("button", { textContent: "What agents outside a project see", onclick: () => ((overviewOpen = true), showPanel()) }),
			),
		);
	}
	if (node.type === "ungrouped") {
		return panel.replaceChildren(
			el("h1", { textContent: "No group" }),
			el("p", { textContent: "Projects here read only their own entries and the global ones. Drag a project onto a group to put it there." }),
			projectList(children("project")),
		);
	}
	if (node.type === "group") {
		const members = children("project");
		return panel.replaceChildren(
			el("h1", { textContent: `group ${node.label}` }),
			members.length
				? el("p", { textContent: `Read by the agents of its ${members.length} member ${members.length === 1 ? "project" : "projects"}.` })
				: el("p", { className: "warning", textContent: "No member projects, so no agent reads these entries. Put a project in this group, or move the entries elsewhere." }),
			countsLine(node),
			el("div", { className: "actions" }, ...add),
			...(members.length ? [el("h2", { textContent: "Members" }), projectList(members)] : []),
		);
	}
	const project = node.project;
	if (!project) {
		return panel.replaceChildren(
			el("h1", { textContent: `project ${node.label}` }),
			el("p", { className: "warning", textContent: "Not a registered project, so no agent reads these entries. Move them elsewhere." }),
			countsLine(node),
		);
	}
	const NEW = "\u0000new";
	const groups = groupNames();
	const choice = el(
		"select",
		{},
		el("option", { value: "", textContent: "no group" }),
		...groups.map((group) => el("option", { value: group, textContent: group })),
		el("option", { value: NEW, textContent: "New group…" }),
	);
	choice.value = project.group ?? "";
	const name = el("input", { placeholder: "new-group-name", pattern: "[a-z0-9][a-z0-9\\-]{0,39}", title: "lowercase kebab-case, at most 40 characters", hidden: true });
	choice.onchange = () => {
		name.hidden = choice.value !== NEW;
		if (!name.hidden) name.focus();
	};
	const change = () => {
		if (choice.value === NEW && !name.reportValidity()) return;
		const group = choice.value === NEW ? name.value.trim() : choice.value || null;
		if (group !== null && !group) return;
		void regroup(project, group);
	};
	panel.replaceChildren(
		el("h1", { textContent: `project ${project.id}` }),
		el("p", { className: "meta", textContent: [project.path, project.remote].filter(Boolean).join(" · ") }),
		el("p", { textContent: `Its agents read its own entries, ${project.group ? `group:${project.group} and ` : ""}global.` }),
		countsLine(node),
		el(
			"div",
			{ className: "actions" },
			...add,
			el("button", { textContent: "What its agents see", onclick: () => ((overviewOpen = true), showPanel()) }),
		),
		el("h2", { textContent: "Group" }),
		el("div", { className: "actions" }, choice, name, el("button", { textContent: "Change group", onclick: change })),
		el("p", { className: "meta", textContent: "Or drag the project onto a group, or onto “no group”." }),
	);
}

// The session-start overview of a project, or with null, of a folder that is not a registered project.
async function showOverview(project: Project | null) {
	const id = selected;
	const path = project ? `/api/projects/${encodeURIComponent(project.id)}/overview` : "/api/overview";
	const result = await api<Overview>(path).catch((failure: unknown) => message(failure));
	// A later selection may have finished first.
	if (selected !== id || !overviewOpen) return;
	const back = el("button", { textContent: "Back", onclick: () => ((overviewOpen = false), showPanel()) });
	if (typeof result === "string") return panel.replaceChildren(el("p", { className: "error", textContent: result }), back);
	const { text, used, budget, omitted } = result;
	const percent = Math.round((used / budget) * 100);
	panel.replaceChildren(
		el("h1", { textContent: project ? `Session start in ${project.id}` : "Session start outside a project" }),
		el("p", {
			className: "meta",
			textContent: `What an agent ${project ? "in this project" : "in a folder that is not a registered project"} gets in its context when a session starts. Index lines are fetched in full with get.`,
		}),
		el("meter", { min: 0, max: budget, value: used, low: budget * 0.75, high: budget * 0.9, optimum: 0 }),
		el("p", { className: "meta", textContent: `Entries use ${used.toLocaleString()} of ${budget.toLocaleString()} characters (${percent}%).` }),
		omitted
			? el("p", { className: "warning", textContent: `${plural(omitted, "line was", "lines were")} cut. Agents here see those entries only if recall finds them.` })
			: el("p", { className: "meta", textContent: `Nothing is cut; ${(budget - used).toLocaleString()} characters left.` }),
		el("div", { className: "actions" }, back, el("button", { textContent: "Copy", onclick: () => void navigator.clipboard.writeText(text) })),
		el("div", { className: "content", textContent: text }),
	);
}

function showSummary() {
	const root = tree;
	if (!root) return;
	const rows: { node: TreeNode; depth: number }[] = [];
	const walk = (node: TreeNode, depth: number) => {
		if (node.type !== "root" && node.type !== "entry") rows.push({ node, depth });
		for (const child of node.children) walk(child, depth + (node.type === "root" ? 0 : 1));
	};
	walk(root, 0);
	const own = (node: TreeNode) => {
		const counts: Record<Kind, number> = { fact: 0, decision: 0, hypothesis: 0, handoff: 0 };
		for (const child of node.children) if (child.entry) counts[child.entry.kind]++;
		return counts;
	};
	const cell = (value: number) => el("td", { className: value ? "" : "zero", textContent: value ? String(value) : "·" });
	const active = entries.filter((entry) => !entry.retired);
	const handoffs = active.filter((entry) => entry.kind === "handoff").length;
	const orphans = rows.filter((row) => row.node.orphan && row.node.total);

	panel.replaceChildren(
		el("h1", { textContent: "Summary" }),
		el("p", {
			className: "meta",
			textContent: `${active.length} active entries, ${active.filter((entry) => entry.pinned).length} pinned, ${handoffs} open ${handoffs === 1 ? "handoff" : "handoffs"}${entries.length > active.length ? `, ${entries.length - active.length} retired` : ""} · ${plural(projects.length, "project", "projects")}, ${plural(groupNames().length, "group", "groups")}`,
		}),
		...orphans.map((row) => el("p", { className: "warning", textContent: `${row.node.id} has ${plural(row.node.total, "entry", "entries")} but ${row.node.type === "group" ? "no member projects" : "is not registered"}, so no agent reads them.` })),
		el(
			"table",
			{},
			el("thead", {}, el("tr", {}, el("th", { textContent: "Scope" }), ...KINDS.map((kind) => el("th", { title: kind }, el("span", { className: `swatch kind-${kind}` }), ` ${kind.slice(0, 4)}`)), el("th", { textContent: "all" }))),
			el(
				"tbody",
				{},
				...rows.map(({ node, depth }) => {
					const counts = node.type === "ungrouped" ? null : own(node);
					const label = el("td", { textContent: node.type === "ungrouped" ? "no group" : node.label });
					label.style.paddingLeft = `${6 + depth * 14}px`;
					if (node.type === "group" || node.type === "global") label.style.fontWeight = "600";
					if (node.orphan) label.className = "warning";
					return el(
						"tr",
						{ onclick: () => select(node.id) },
						label,
						...KINDS.map((kind) => (counts ? cell(counts[kind]) : el("td"))),
						counts ? cell(KINDS.reduce((sum, kind) => sum + counts[kind], 0)) : el("td"),
					);
				}),
			),
			el("tfoot", {}, el("tr", {}, el("td", { textContent: "Total" }), ...KINDS.map((kind) => cell(root.counts[kind])), cell(root.total))),
		),
		el("p", { className: "meta", textContent: "Counts are each scope's own entries. Click a row to show it in the tree." }),
		el("h2", { textContent: "How to" }),
		el(
			"ul",
			{ className: "meta" },
			el("li", { textContent: "Click a node to open it, its arrow to collapse it, and + to add an entry there." }),
			el("li", { textContent: "Drag an entry onto global, a group or a project to move it; drag a project onto a group or “no group” to regroup it. Esc cancels a drag." }),
			el("li", { textContent: "Scroll or drag the background to pan (Shift+scroll pans sideways); Ctrl+scroll or pinch to zoom." }),
			el("li", { textContent: "Changes made by agents show up within a few seconds." }),
			el("li", {}, el("kbd", { textContent: "/" }), " filter · ", el("kbd", { textContent: "Esc" }), " back to the summary"),
		),
	);
}

// Form for a new entry in a scope, or for revising an existing one.
function entryForm(entry: Entry | null, preset: Scope) {
	const scope = scopeSelect(scopes, scopes.includes(preset) ? preset : "global");
	const key = el("input", { required: true, pattern: "[a-z0-9][a-z0-9\\-]{0,79}", placeholder: "kebab-case-topic", title: "lowercase kebab-case" });
	const kind = el("select", {}, ...KINDS.map((value) => el("option", { value, textContent: value })));
	kind.value = entry?.kind ?? "fact";
	const title = el("input", { required: true, value: entry?.title ?? "", maxLength: 120 });
	const content = el("textarea", { required: true, value: entry?.content ?? "", maxLength: 4000 });
	const evidence = el("textarea", { value: entry?.evidence.join("\n") ?? "", className: "evidence" });
	const pinned = el("input", { type: "checkbox", checked: entry?.pinned ?? false });
	const error = el("p", { className: "error" });

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
			selected = `entry:${saved.id}`;
			expanded.add(saved.scope);
			for (const parent of ancestors(saved.scope)) expanded.add(parent);
			await reload(saved.scope);
			reveal(selected);
			notify(entry ? `Saved #${saved.id} rev ${saved.revision}.` : `Created #${saved.id}.`);
		} catch (failure) {
			error.replaceChildren(message(failure));
			const existing = failure instanceof ApiError ? failure.entry : undefined;
			if (existing) {
				error.append(" ", el("button", { type: "button", textContent: `Edit #${existing.id} instead`, onclick: () => entryForm(existing, existing.scope) }));
			}
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
			el("button", { type: "submit", className: "primary", textContent: entry ? "Save revision" : "Create entry" }),
			el("button", { type: "button", textContent: "Cancel", onclick: () => void reload() }),
		),
		error,
	);
	panel.replaceChildren(
		el("h1", { textContent: entry ? `Edit #${entry.id}` : "New entry" }),
		...(entry ? [el("p", { className: "meta", textContent: `${entry.scope} · key ${entry.key} · replacing rev ${entry.revision}` })] : []),
		form,
	);
	(entry ? title : key).focus();
}

// Toolbar

filter.addEventListener("input", () => {
	build();
	// Open the path to every match.
	for (const node of nodes.values()) if (node.match) for (const parent of ancestors(node.id)) expanded.add(parent);
	render();
});
showRetired.addEventListener("input", () => {
	if (!showRetired.checked && selectedEntry()?.retired) selected = parents.get(selected) ?? "root";
	render();
	showPanel();
});
$<HTMLButtonElement>("expand").addEventListener("click", () => {
	for (const node of nodes.values()) if (node.children.length) expanded.add(node.id);
	render("root");
});
$<HTMLButtonElement>("collapse").addEventListener("click", () => {
	expanded.clear();
	expanded.add("root");
	if (!nodes.has(selected) || parents.get(selected) !== "root") selected = "root";
	render("root");
	fit();
	showPanel();
});
$<HTMLButtonElement>("fit").addEventListener("click", () => fit());
$<HTMLButtonElement>("summary").addEventListener("click", () => select("root"));

// Panel width: drag the divider to resize, double-click it to reset. The chosen width persists.
const resizer = $<HTMLElement>("resizer");
const PANEL_WIDTH = "agent-memory-panel-width";
let panelWidth = Number(localStorage.getItem(PANEL_WIDTH)) || 0;
// Keeps at least 320 pixels for the tree, and a 280-pixel panel.
function applyPanelWidth() {
	if (!panelWidth) return document.body.style.removeProperty("--panel-width");
	const width = Math.max(280, Math.min(panelWidth, window.innerWidth - 320));
	document.body.style.setProperty("--panel-width", `${Math.round(width)}px`);
}
applyPanelWidth();
window.addEventListener("resize", applyPanelWidth);
resizer.addEventListener("pointerdown", (event) => {
	event.preventDefault();
	resizer.setPointerCapture(event.pointerId);
	resizer.classList.add("active");
	const move = (moved: PointerEvent) => {
		panelWidth = window.innerWidth - moved.clientX - resizer.offsetWidth / 2;
		applyPanelWidth();
	};
	const up = () => {
		resizer.classList.remove("active");
		resizer.removeEventListener("pointermove", move);
		resizer.removeEventListener("pointerup", up);
		resizer.removeEventListener("pointercancel", up);
		localStorage.setItem(PANEL_WIDTH, String(Math.round(panelWidth)));
	};
	resizer.addEventListener("pointermove", move);
	resizer.addEventListener("pointerup", up);
	resizer.addEventListener("pointercancel", up);
});
resizer.addEventListener("dblclick", () => {
	panelWidth = 0;
	localStorage.removeItem(PANEL_WIDTH);
	applyPanelWidth();
});

const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
function setTheme(theme: Theme) {
	if (theme === "auto") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
	themeButton.textContent = `Theme: ${theme}`;
	localStorage.setItem("agent-memory-theme", theme);
}
const savedTheme = localStorage.getItem("agent-memory-theme");
setTheme(THEMES.find((theme) => theme === savedTheme) ?? "auto");
themeButton.addEventListener("click", () => setTheme(THEMES[(THEMES.indexOf(themeButton.textContent.slice(7) as Theme) + 1) % THEMES.length] ?? "auto"));

document.addEventListener("keydown", (event) => {
	// Escape cancels a drag, or a pan, which returns to where it started.
	if (event.key === "Escape" && gesture) {
		if (gesture.mode === "pan") {
			view.x = gesture.view.x;
			view.y = gesture.view.y;
			applyView();
		}
		endGesture(true);
		event.preventDefault();
		return;
	}
	const target = event.target;
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
		if (event.key === "Escape") target.blur();
		return;
	}
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	if (event.key === "/") filter.focus();
	else if (event.key === "Escape") select("root");
	else return;
	event.preventDefault();
});

void reload().catch((failure: unknown) => notify(message(failure), true));
setInterval(() => void refresh(), 4000);
document.addEventListener("visibilitychange", () => void refresh());
