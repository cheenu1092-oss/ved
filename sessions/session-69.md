# Session 69 — `ved pipe` — Multi-Step Pipeline Execution

**Date:** 2026-03-07
**Phase:** CYCLE (feature development)

## What Happened

### `ved pipe` — Multi-Step Pipeline Execution (cli-pipe.ts — 580 lines)

Built a multi-step pipeline system that chains queries and shell commands together, where each step receives the previous step's output as context.

**Usage patterns:**
```bash
ved pipe "summarize" "extract key points" "translate to Spanish"   # inline
ved pipe "summarize" "!wc -w" "format the count"                  # mix LLM + shell
ved pipe -f pipeline.yaml                                          # from YAML file
ved pipe -f pipeline.yaml --dry-run                                # preview without executing
ved pipe run my-saved-pipeline                                     # run saved pipeline
ved pipe list                                                      # list saved pipelines
ved pipe show my-pipeline                                          # show definition
ved pipe save my-pipe -f pipeline.yaml -d "description"            # save pipeline
ved pipe delete my-pipe                                            # delete saved
```

**Aliases:** `ved pipeline`, `ved chain`

**Pipeline YAML format:**
```yaml
name: translate-and-summarize
description: Summarize then translate
model: gpt-4o              # default model for all steps
timeout: 60                # default timeout per step
steps:
  - query: "Summarize this document"
    file: input.txt         # attach file as context
  - query: "Extract the 5 key points"
    no-rag: true            # skip RAG for this step
  - shell: "sort"           # pipe through shell command
  - query: "Format as markdown"
    model: claude-3         # per-step model override
```

**Output formats:**
- `text` (default) — Step-by-step summary with final output
- `json` — Structured with all step results, timing, errors
- `raw` — Final output only (perfect for piping)

**Flags:**
- `-f, --file` — Load pipeline from YAML
- `--json` — JSON output
- `--raw` — Raw output (final step only)
- `-v, --verbose` — Step-by-step progress on stderr
- `-n, --dry-run` — Show what would run
- `-h, --help` — Full help

**Subcommands:**
- `list`/`ls` — List saved pipelines
- `show`/`cat`/`view` — Display pipeline definition
- `save` — Save pipeline from YAML file
- `delete`/`rm`/`remove` — Delete saved pipeline
- `run` — Run a saved pipeline by name

**Shell steps:**
- In inline mode, prefix with `!` to run shell: `ved pipe "summarize" "!wc -w"`
- In YAML, use `shell:` key
- Shell commands receive previous output on stdin, stdout becomes next input
- Shell timeout defaults to 30s

**Key features:**
- Pipeline stops on first failure (fail-fast)
- Saved pipelines stored in `~/.ved/pipelines/` as YAML
- Name sanitization (lowercase, special chars → dashes)
- Pipeline validation (no empty steps, no both query+shell, file only with query)
- Duration tracking per step and total
- Dry run mode (works without app init)
- Only initializes VedApp if pipeline has query steps (shell-only pipelines skip LLM)

### Shell Completions
Updated all 3 shells (bash/zsh/fish) with `pipe` command, aliases (`pipeline`, `chain`), subcommands, and flags.

### Tests (58 new)
- parsePipelineYaml: basic queries, mixed steps, step options, comments, quotes, empty steps, system prompt (7)
- buildInlinePipeline: queries, ! prefix shell, single, empty (4)
- validatePipeline: valid, empty, missing query/shell, both query+shell, file with shell, invalid timeout, NaN timeout, multiple errors (8)
- parsePipeArgs: default list, list/ls, show, delete, rm alias, save with flags, inline queries, file flag, format flags, verbose, dry-run, run subcommand (12)
- executeShellStep: cat pipe, echo capture, wc -l, tr transform, failed command, nonexistent command, empty input, sort (8)
- formatPipelineResult: raw, JSON, text with steps, failure info, JSON error field, long duration (6)
- saved pipelines: save+load, list, delete, nonexistent delete, nonexistent load, sanitize names, step options roundtrip, empty dir (8)
- edge cases: colons in values, dash-only step, !command with spaces, multiline output, large input (5)

## Stats
- **New files:** cli-pipe.ts (580 lines), cli-pipe.test.ts (510 lines)
- **Modified files:** cli.ts, app.ts (completions)
- **New tests:** 58
- **Total tests:** 1690/1690 pass (host + Docker parity)
- **Type errors:** 0
- **CLI commands:** 25 (was 24)
