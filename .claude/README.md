# Claude Code Project Setup

This directory holds the project-scoped Claude Code configuration for this repository. The instruction baseline is the root [`CLAUDE.md`](../CLAUDE.md); everything here refines it for specific areas and workflows. The Codex equivalent lives in [`.codex/`](../.codex/README.md).

## Layout

```text
.claude/
├── settings.json   # shared permissions (allow / ask / deny) and sandbox defaults
├── rules/          # path-scoped instructions loaded when matching files are touched
├── agents/         # focused review subagents
└── skills/         # repeatable workflows, with references and helper scripts
```

## Settings

`settings.json` allows routine read-only and test commands (`npm run *`, `node --test *`, read-only `git`), asks before state-changing commands (`git add/commit/push`, installs, `npm run clear-data`, network tools, `gh`), and denies destructive commands (`git reset --hard`, `git clean -f`, `rm -rf`) plus reads/edits of `.env*` files, `secrets/`, and cloud credentials. Keep personal overrides in an untracked `settings.local.json`.

## Rules

Each rule's frontmatter `paths:` decides when it loads.

| Rule                | Applies to |
| ------------------- | ---------- |
| `backend-node.md`   | `server/**/*.js`, `scripts/**/*.js` |
| `frontend-react.md` | `client/src/**` |
| `mcp-typescript.md` | `mcp/src/**`, MCP package config and README |
| `docs-markdown.md`  | `**/*.md` |
| `i18n-parity.md`    | i18n locales, READMEs, and other localized surfaces |
| `wiki-i18n.md`      | `wiki/` page, scripts, and styles |
| `file-headers.md`   | every applicable source file (always on) |

## Subagents

| Agent               | Use for |
| ------------------- | ------- |
| `backend-reviewer`  | Route and hook logic: regressions, data integrity, missing tests |
| `frontend-reviewer` | React UI: behavior regressions, state consistency, UX breakage |
| `mcp-reviewer`      | MCP server: tool safety, schema quality, host integration |

## Skills

| Skill                 | When it applies |
| --------------------- | --------------- |
| `file-headers`        | **Mandatory** on every change — authorship header format and audit scripts |
| `update-project-docs` | **Mandatory** after any behavior, config, interface, schema, CLI, or feature change |
| `i18n-parity`         | **Mandatory** for localized content — dashboard keys, wiki, READMEs, switchers, formatting |
| `version-release`     | Every release bump and its metadata synchronization |
| `push-to-forked-pr`   | Updating a PR whose head branch lives on a fork |
| `ship-feature`        | End-to-end feature work across backend, frontend, or MCP |
| `debug-live-issue`    | Evidence-driven debugging of regressions and flaky behavior |
| `mcp-operations`      | MCP host config, connectivity, and tool-domain changes |
| `repo-onboarding`     | Understanding architecture and finding the right module |

Some skills are mirrored for other agents under `.agents/skills/` and `.codex/skills/`. Always edit the canonical `.claude/` copy; for `i18n-parity`, re-sync with:

```bash
bash .claude/skills/i18n-parity/scripts/sync-agent-mirrors.sh
```

## Useful audit scripts

```bash
bash .claude/skills/file-headers/scripts/check-headers.sh      # repo-wide header audit
bash .claude/skills/i18n-parity/scripts/i18n-audit.sh          # localization parity
bash .claude/skills/update-project-docs/scripts/doc-coverage.sh  # doc coverage check
```
