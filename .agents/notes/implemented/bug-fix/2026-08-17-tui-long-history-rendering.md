# Agent Note: Bounded TUI long-history rendering

Status: implemented

English | [中文](2026-08-17-tui-long-history-rendering.zh.md)

## Problem

Resuming a long TUI session replayed every persisted event through array-spread publication. Each appended transcript node or trajectory entry copied the full accumulated array, so replay cost grew quadratically with history length. After mount, opening or filtering the slash picker changed the transcript height and invalidated the settled-history projection because the empty-session welcome layout shared its memoization scope with non-empty history. That reparsed Markdown and rebuilt every visible history line on each keypress. The transcript then copied the complete projected line list again before selecting its bottom viewport. Startup also began reading and folding titles from up to 50 persisted session logs before the first frame, although those rows were only needed by `/sessions`.

## Decision

`foldFromLog` marks its private scratch as a batch replay and mutates only the node and trajectory arrays created for that replay. Once replay returns, the marker is removed; subsequent live `applyEvent` calls retain immutable array publication so `useSyncExternalStore` continues to observe changed snapshots.

The renderer projects at most the existing 3,000-node display tail through a per-application `WeakMap`. Each node caches a bounded set of line variants keyed by every display-affecting input: width, disclosure and selection state, retry animation state, feedback rating, and locale. Welcome, history, and trajectory projections have separate memoization scopes. The memoized transcript accepts the read-only line list directly, so composer typing and slash-picker height changes reuse settled lines instead of re-lexing Markdown or copying the full list. Resize and disclosure still calculate the required variants.

Persisted session titles load when `/sessions` first opens through the existing panel refresh path. Startup no longer scans unrelated logs before terminal input becomes interactive. Direct resume still reads the complete selected session log because the live agent and TUI state must be reconstructed from the same event prefix.

## Alternatives considered

**Reduce the 3,000-node display tail.** Rejected because it removes currently visible history and changes navigation behavior to mask projection cost.

**Debounce composer and slash-picker input.** Rejected because it adds input latency while leaving replay and every eventual render with the same redundant work.

**Add backward history pagination in this change.** Rejected because it changes transcript navigation and requires a persisted paging model shared with resume, selection, expansion, and scroll anchoring. The current optimization preserves those behaviors and leaves pagination as a separate feature.

**Cache rendered Markdown globally by text.** Rejected because equal text can have different node state, feedback, locale, width, or presentation, and a process-global cache would retain histories after their TUI exits.

## Consequences

Long-session fold cost is linear for ordinary append-heavy logs, while live updates keep their prior immutable publication semantics. Composer input and slash filtering no longer make settled-history work proportional to the displayed history size. Cache entries are owned by one mounted application, disappear with their node objects, and retain at most eight variants per node before resetting.

The complete selected log is still read and folded during resume, and the TUI still has no backward paging API. Opening `/sessions` performs the deferred title work and can therefore take longer on its first use. Functional coverage compares replay with incremental folding, exercises a 10,000-event replay followed by a live update, and spies on Markdown lexing while opening and filtering the slash picker over settled history. No model-visible or Agent Loop behavior changes.
