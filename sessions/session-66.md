# Session 66 — `ved template` CLI

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved template` — Vault Template Manager (cli-template.ts — 701 lines)

Built a template management system for creating consistent vault entries. Templates are `.md` files in the vault's `templates/` folder with `{{variable}}` placeholders. Fully Obsidian-native — templates are just markdown files you can also use from Obsidian itself.

**7 subcommands:**

1. **`ved template list`** — List templates with type, variable count, size
2. **`ved template show <name>`** — Display template (vault or built-in)
3. **`ved template create <name> [--type <type>]`** — Create from built-in type, custom type, or blank
4. **`ved template edit <name>`** — Open in $EDITOR
5. **`ved template delete <name>`** — Remove a template
6. **`ved template use <tpl> <file> [--var k=v ...]`** — Instantiate template into vault with variable substitution
7. **`ved template vars <name>`** — Show template variables with occurrence counts

**Aliases:** `templates`, `tpl` for the command; `ls`/`cat`/`view`/`new`/`add`/`rm`/`remove`/`apply`/`instantiate`/`render`/`variables`/`placeholders` for subcommands.

### Built-in Templates (6)
- **person** — People entities (name, role, org, context, notes)
- **project** — Project tracking (overview, goals, status, decisions)
- **decision** — Decision records (context, options, rationale, consequences)
- **concept** — Ideas/technologies (definition, key points, examples)
- **daily** — Daily notes (summary, events, decisions, TODOs, reflections)
- **topic** — General topics (overview, resources, notes)

### Key Features
- **Variable system:** `{{variable_name}}` placeholders extracted and replaced
- **Auto-routing:** Output files placed in correct vault folder based on entity type (person → entities/people, project → projects/, etc.)
- **Auto-date:** `{{date}}` auto-set to today if not provided
- **Unreplaced detection:** Warns about variables not provided
- **Path traversal protection:** Template names validated (alphanumeric, dashes, underscores only)
- **Built-in fallback:** `ved template show person` works without creating anything first
- **--force flag:** Overwrite existing vault files on instantiation

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with template subcommands.

### Tests (37 new)
- extractVariables: simple, dedup, empty, frontmatter, underscore, invalid, large (7)
- applyVariables: replace, unknown, all-occurrences, empty, frontmatter, regex chars, multiline (8)
- Vault template files: create, list, read (3)
- Built-in variable extraction: person, decision (2)
- Template instantiation: apply+render, write output, unreplaced, auto-routing ×3 (6)
- Name validation: empty, path traversal, valid names (3)
- Delete: removal (1)
- Edge cases: no vars, frontmatter-only, nested braces, start/end, wikilinks, tags (6)

### Exported Utilities
- `extractVariables(content)` — Extract unique variable names from template
- `applyVariables(content, vars)` — Replace {{variables}} with values

## Stats
- **New files:** 2 (cli-template.ts, cli-template.test.ts)
- **Modified files:** 3 (app.ts, cli.ts, STATE.md)
- **Lines added:** ~1,079 (701 + 378)
- **Tests:** 37 new, 1549 total
- **Type errors:** 0
- **Docker parity:** ✅
- **CLI commands:** 22 (was 21)
