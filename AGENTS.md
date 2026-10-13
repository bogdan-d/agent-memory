# Agent instructions

`README.md` describes what the tool does. Keep it aligned with implemented behavior, and do not add design drafts or plans to the repository.

Use strict TypeScript and Bun's built-in facilities where they cover the requirement. Storage behavior lives in `src/store.ts` and is shared by the MCP server, CLI and session-start hook.

Run `bun check` and `bun test` before finishing. Tests use temporary databases; never point them at `~/.local/share/agent-memory/`.
