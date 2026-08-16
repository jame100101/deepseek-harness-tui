# @deepseek-ai/dsh-tui-cli

`dsh-tui` — a thin, Claude Code-style command line over the DeepSeek Harness
terminal surface. It boots the existing TUI profile (`dsh --profile tui`) with
a small user-facing flag grammar; all sessions, agents, and rendering stay in
the TUI app.

## Usage

```text
dsh-tui                          interactive TUI, new session
dsh-tui "fix the failing test"   interactive TUI, submits the task on boot
dsh-tui -c                       resume the newest session from this directory
dsh-tui -r                       interactive session picker
dsh-tui -r <session>             resume by id, id prefix, or title
dsh-tui -c --fork-session        fork the resumed session, then switch to it
dsh-tui -p "run the tests"       one-shot: print the assistant result and exit
dsh-tui -c -p "keep going"       resume, then run one task non-interactively
```

Exit codes: `0` success, `1` execution failure, `2` usage error, `130`
SIGINT. `--print` output goes to stdout (assistant result only); diagnostics
go to stderr.

The wrapper resolves the built `dsh` bin through its `@deepseek-ai/dsh`
dependency and spawns it with inherited stdio — it never captures output,
queries sessions, or renders anything itself.
