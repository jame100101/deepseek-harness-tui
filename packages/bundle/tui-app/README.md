# `@deepseek-ai/dsh-tui-app`

The dsh terminal-surface bundle. Its patch layer rides over [`dsh-base`](../base/README.md) and mounts exactly one row: the in-process [`@deepseek-ai/dsh-tui`](../tui/tui/README.md) surface. Run with `dsh --profile tui` (the shipped template stacks `dsh-base` + this bundle).

Unlike `dsh-web-app`, this bundle disables none of the base's agent-plane rows: the TUI is single-session and composes its agent process-wide.

## Model Experience

### What the model sees

The same coding persona paragraph the `headless` and `web` bundles set on the shared `system-prompt` row. This bundle adds no prompt section, no tool, and no dynamic context.

### Token effect

None beyond the persona line, which is byte-identical to the other shipped surfaces.

### KV Cache effect

None. The persona is a process-level constant near the system-prompt head, so it does not invalidate the prompt cache across turns (same posture as `dsh-web-app`).

## Known Limitations and Deferred Work

- **v0.0.1 surface scope**: see the `@deepseek-ai/dsh-tui` README — the P0 skeleton covers the transcript fold, streaming, composer, and `/quit`; approvals, command passthrough, and virtualization land in P1–P3.
- **No startup provider yet**: `dsh --profile tui --help` mounts the surface instead of printing help (deferred to the P1 `tui-startup` row).
