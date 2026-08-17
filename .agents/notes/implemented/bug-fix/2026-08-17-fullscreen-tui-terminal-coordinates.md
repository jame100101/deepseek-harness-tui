# Agent Note: Fullscreen TUI terminal coordinates

Status: implemented

English | [中文](2026-08-17-fullscreen-tui-terminal-coordinates.zh.md)

## Problem

The TUI fills the alternate screen without a trailing newline. Ink 7.1.1's cursor suffix calculated its vertical move from a notional row after the rendered output. `NativeCursor` compensated by reporting `measureElement()`'s row plus one, which stored an invented row as `previousCursorPosition`. Ink also retained the notional visible-line origin in `buildCursorOnlySequence`; whitespace-only composer input and navigation can leave frame bytes unchanged, so each cursor-only update returned from an actual row that no longer matched the saved row and accumulated upward drift.

The TUI also calculated composer display columns with `string-width` 7.2.0 while Ink 7.1.1 calculated layout with `string-width` 8.2.2. The versions disagree for symbols such as `⚙`, so the composer could wrap text at a different column from the renderer. The scrollbar used `│` for its rail, `█` for its thumb, and bold only for the thumb; the unified glyph removed font-bearing variation, but painting it in the terminal's final physical column still armed DECAWM pending-wrap state. VTE and Windows Terminal differ in how subsequent LF and cursor-control sequences resolve that state, so a correct one-cell Yoga gutter could still appear on adjacent rows or columns.

## Decision

Cursor coordinates remain zero-based Ink layout coordinates. `NativeCursor` passes the exact `measureElement()` position to `useCursor`. A pinned Ink 7.1.1 patch makes `buildCursorSuffix` and `buildCursorOnlySequence` receive the physical row occupied after writing the output (`splitLines.length - 1`) instead of a visible-line count that assumes a trailing newline. Standard, incremental, initial, repaint, sync, and cursor-only paths therefore preserve one coordinate model. No platform branch participates in coordinate calculation.

The npm launcher embeds the patched Ink payload under its bundled runtime while retaining Ink as a registry dependency for its dependency graph. This runtime-local copy ensures npm installations use the same cursor implementation as the pnpm workspace; the assembly step rejects an unpatched or version-mismatched Ink installation.

The TUI pins `string-width` 8.2.2 to match Ink's layout dependency. The frame width is one cell less than the physical terminal width, leaving the final cell blank and placing the scrollbar gutter immediately beside it. The scrollbar renders both rail and thumb with `█` in the same weight; dim rail and cyan thumb color carry state. The TUI gives scrollbar cells a private marker that Ink's output serializer converts to `█` after emitting CHA, so the gutter returns to its Yoga column even when the terminal measures an earlier emoji differently. Other full-block glyphs remain ordinary transcript or chrome content. Mouse hit-testing covers the rail and the blank safety cell, preserving the two-cell target without painting into the autowrap column.

`runInk` declares `interactive: true` explicitly. Normal command, Ctrl+D, and double-Ctrl+C exits reset the application-owned mouse modes before asking Ink to unmount because alternate-screen cleanup output is disposable. The terminal owner repeats the reset after unmount as a best-effort process-shutdown fallback.

## Alternatives considered

- A Linux-only row decrement was rejected because terminal output framing, not the operating system, determines the cursor origin.
- Keeping the `y + 1` adjustment was rejected because it corrupts Ink's saved cursor position and only masks the first paint.
- Adding a trailing newline was rejected because it changes the output cursor row and fixed-height rendering model without removing right-margin pending-wrap state.
- Disabling DECAWM was rejected because it mutates shared terminal state and adds a restore obligation that a crash can bypass.
- Clearing and redrawing the full screen for every input was rejected because it hides the state error, causes flicker, and bypasses Ink's incremental cursor lifecycle.
- Retaining mixed scrollbar glyphs and tuning color or padding was rejected because padding changes the gutter width and color does not correct differing glyph bearings.

## Consequences

The Ink patch must be reevaluated when upgrading Ink and can be removed after upstream exposes the written-output cursor row correctly. Composer wrapping and cursor placement now share one Unicode width table. Scrollbar drag, wheel scrolling, selection, composer editing, and the transcript row budget keep their existing semantics.

Regression coverage has three layers: pure viewport tests for width boundaries, Unicode columns, and the reserved terminal column; direct Ink log-update tests for repeated cursor-only movement; alternate-screen Ink render and real PTY tests for typing, editing, resize, CHA-anchored scrollbar columns, scroll, drag, back-to-bottom, normal exit, and Ctrl+C teardown. Windows ConPTY consumes and reserializes positioning controls before the parent emulator observes them, while Unix PTYs preserve the original bytes; a GUI terminal remains a manual smoke check because CI PTYs do not execute VTE itself.
