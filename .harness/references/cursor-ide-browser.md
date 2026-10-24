---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - playbooks/browser-testing.md
tags: [reference, cursor, mcp, browser]
---

# Cursor IDE browser MCP

**When to read:** when you're in Cursor and want to use its built-in browser MCP instead of Playwright, or when a reader asks what the Cursor browser subagent is.
**When to update:** when Cursor changes the MCP surface or its availability.

## Summary

`cursor-ide-browser` is a Model Context Protocol server that ships with Cursor IDE. It lets an agent in Cursor's agent / Composer mode drive a real browser tab via ~28 tools (navigate, click, fill, screenshot, snapshot, CPU profiling, network/console capture).

**This is a convenience for Cursor users only.** The harness default is Playwright because anyone with any agent can use it. If you're not in Cursor — or you want an engineer on a different tool to be able to rerun your evidence — stick to Playwright.

---

## What it is, concretely

- Cursor-provided MCP server, bundled with the IDE (no separate install).
- Chromium-backed. CPU profile data lands in `~/.cursor/browser-logs/`.
- Tools include: `browser_navigate`, `browser_click`, `browser_fill`, `browser_type`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_snapshot` (ARIA tree, gives element refs), `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_profile_start` / `_stop`, `browser_tabs`, `browser_lock`, `browser_mouse_click_xy`, plus a few more.
- Operates on tabs the user has open in the Cursor browser surface.

---

## Who has access

| User | Access? |
|---|---|
| Cursor user, Agent / Composer mode | Yes — shipped with the IDE |
| Cursor user, Ask / readonly mode | No — MCP is gated behind agent mode |
| Cursor user testing manually | N/A — just open a browser yourself |
| Any other IDE (VSCode, JetBrains, Neovim, etc.) | No — use Playwright |
| Agent outside Cursor (Claude Code CLI, Codex CLI, Aider…) | No — use Playwright |
| CI / headless | No — use Playwright |

---

## How it maps onto our Playwright patterns

The conventions in [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) still apply when you drive the MCP: numbered screenshots, real backend, read the evidence before declaring done, no `curl` substitutions. Only the driver changes.

| Playwright step | Cursor MCP equivalent |
|---|---|
| `chromium.launch(...)` | tab is already open — `browser_tabs({action:'list'})` |
| `page.goto(url)` | `browser_navigate(url)` |
| `page.screenshot({ path })` | `browser_take_screenshot` — save the result with a numbered name yourself |
| `page.click(selector)` | `browser_snapshot` → pick `ref` → `browser_click(ref)` |
| `page.fill(selector, text)` | `browser_fill(ref, text)` |
| `page.type(selector, text)` | `browser_type(ref, text)` |
| `page.on('console')` | `browser_console_messages` (poll between actions) |
| `page.on('response')` | `browser_network_requests` (poll between actions) |
| `recordVideo: { dir, size }` | **not available** — take frequent screenshots; for the trust-evidence pass, do one final Playwright run with video |

---

## Hybrid workflow (recommended when you're in Cursor)

The MCP is fast to iterate with because you're already in the editor. Playwright gives you the video evidence a reviewer can watch. You can have both:

1. **Iterate** with the Cursor MCP — quick feedback, no separate terminal loop.
2. **Final evidence pass** with the Playwright script — produces the numbered screenshots + video for the PR.

This is honest about what each tool is good for, and keeps the PR artifacts portable for engineers who aren't in Cursor.

---

## Gotchas

- The MCP is sensitive to stale refs: after any action that could change the page, take a fresh `browser_snapshot` before the next interaction.
- Lock/unlock: `browser_lock({action:'lock'})` must come *after* a tab exists, never before `browser_navigate`. Unlock only when the turn is fully done.
- Native browser dialogs (`confirm`, `prompt`) don't block automation — if you need to test a specific response, call `browser_handle_dialog` *before* triggering the dialog.
- Iframe content is not reachable through the MCP.

---

## See also

- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) — the generic Playwright path
- [`../protocols/no-bypass.md`](../protocols/no-bypass.md) — why "MCP didn't work today" is not a reason to `curl`

## Referenced by

- `playbooks/browser-testing.md`
