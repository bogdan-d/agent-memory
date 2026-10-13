import { z } from "zod";

export const KINDS = ["fact", "decision", "hypothesis", "handoff"] as const;
export type Kind = (typeof KINDS)[number];

export const LEVELS = ["project", "group", "global"] as const;
export type Level = (typeof LEVELS)[number];

// Input shape for writing an entry, shared by the MCP tool and the CLI.
export const rememberShape = {
	scope: z
		.enum(LEVELS)
		.describe("project: this repository. global: all projects. group: every repository in this project's group, if the user agreed to one."),
	key: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "lowercase kebab-case, at most 80 characters")
		.describe("Stable topic key. Writing the same scope and key again revises the entry."),
	kind: z
		.enum(KINDS)
		.describe(
			"fact: verified observation. decision: explicit user decision. hypothesis: unverified. handoff: unfinished work for another agent or session.",
		),
	title: z.string().trim().min(1).max(120),
	content: z.string().trim().min(1).max(4000).describe("Concise and self-contained. Name the environment if the fact depends on one."),
	evidence: z
		.array(z.string().trim().min(1).max(300))
		.max(10)
		.default([])
		.describe("Where this comes from: repository-relative paths, commits, URLs, ticket IDs, or 'user decision'."),
	pinned: z.boolean().default(false).describe("Show the full entry at every session start. Reserve for essentials."),
	expected_revision: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Revision you are replacing. Required to revise an existing entry; omit to create one."),
};

export const rememberInput = z.object(rememberShape);
export type RememberInput = z.infer<typeof rememberInput>;
