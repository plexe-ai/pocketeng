---
type: learning
status: active
last_reviewed: 2026-04-30
related:
  - protocols/testing-protocol.md
  - playbooks/browser-testing.md
tags: [learning, sidebar, ui, playwright]
---

# Sidebar context menu: group-hover and headless Playwright

**When to read:** when adding hover-triggered menus or testing them with Playwright.

## The scar

The `group-hover:flex` pattern (menu button hidden until parent `.group` is hovered) doesn't reliably trigger via Playwright's `.hover()` in headless Chromium. The `:hover` pseudo-class fires on the element but Tailwind's `group-hover:` variant sometimes doesn't resolve in the same paint frame.

## The fix

For Playwright E2E tests targeting hover-revealed elements:
- Use `page.evaluate()` + `dispatchEvent(new MouseEvent('click', { bubbles: true }))` to directly click the button that exists in DOM but is visually hidden.
- OR use `.click({ force: true })` to bypass Playwright's actionability check.
- Do NOT rely on `waitFor({ state: 'visible' })` after `.hover()` for `group-hover` elements.

## Nested buttons

A `<button>` containing another `<button>` is invalid HTML and causes React hydration warnings. Restructure as: outer `<div role="button">` with an inner `<button>` for navigation + a sibling `<div>` wrapping the menu trigger.

## Sidebar refresh kills local state

The 6-second sidebar refresh (`setInterval(refresh, 6000)`) re-creates session objects. If the React key (`key={t.id}`) stays stable, component state (like `isRenaming`) survives. But if the list re-sorts and the item moves position, reference-based locators in tests break — use text-content-based selectors after mutations.

## Referenced by

- `README.md` (via routing table → grep learnings)
