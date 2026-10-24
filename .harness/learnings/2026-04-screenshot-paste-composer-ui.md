---
type: learning
status: canonical
last_reviewed: 2026-04-29
related:
  - README.md
  - protocols/testing-protocol.md
tags: [learning, web, chat, clipboard, worktree, multimodal, bridge]
---

# Screenshot paste — full pipeline (Steps 0–4)

**When to read:** when extending image paste, attachment limits, debugging
composer drag/drop, or touching the bridge's multimodal content path.
**When to update:** when validation rules, prompt copy, or per-agent image
support changes.

## Summary

### Step 0 — Composer UI (`web/components/ChatWindow.tsx`)
- Clipboard image paste (`onPaste`), drag-and-drop onto the composer shell.
- Raster image limits: 5 files × 5MB, PNG/JPEG/GIF/WebP.
- Object-URL thumbnails with `useMemo`/`useEffect` cleanup.
- Clearer server-path instructions for raster uploads vs other attachments
  (`buildAttachmentPrompt` splits image paths from non-image paths).
- `PendingAttachment` type (id + file) replaces bare `File[]` so removal is
  stable even when two files have the same name.

### Steps 1–4 — Multimodal bridge pipeline
Full end-to-end image plumbing was added:

| Layer | Change |
|---|---|
| `web/lib/api.ts` | `UploadedImage` type; `images?` param on `startChatSession` + `sendChatMessage` |
| `web/components/ChatWindow.tsx` | Collects `uploadedImages: UploadedImage[]` from uploads and passes them to the API |
| `backend/src/chat.py` | Extracts `images` from request body; writes JSON manifest to EC2 as `PE_IMAGES_FILE`; only when `use_bridge=True` |
| `backend/src/lib/script_builder.py` | `images_b64` + `images_file` params on `build_launch_cmd`; decodes manifest before run script executes |
| `backend/src/lib/bridge/bridge.mjs` | Loads images at startup from `PE_IMAGES_FILE`; Claude: streaming-input mode with content array; Codex + Cursor: path-reference fallback appended to prompt; OpenCode: parts array with image parts |

## Per-agent image strategy

| Agent | Strategy | Native vision |
|---|---|---|
| Claude | SDK streaming input (`AsyncIterable<SDKUserMessage>`) with `{type:"image", source:{type:"base64",...}}` content blocks | Yes |
| Codex | Path-reference appended to prompt (SDK's `runStreamed` only accepts a string) | No — file path only |
| Cursor | Path-reference appended to prompt (already present from `buildAttachmentPrompt`) | No — file path only |
| OpenCode | Parts array with `{type:"image", source:{...}}` alongside the text part | Potentially (SDK parts format supports it; needs live verification) |

## Key constraints

- **Lambda payload limit** (6MB sync): images are uploaded to EC2 via SFTP
  *before* the chat call; the `images` body field carries only `{path, mediaType}`
  metadata, not base64 data.  Total API payload stays well under 10MB.
- **DynamoDB item limit** (400KB): image base64 is never stored in DDB.
  History re-loads show `[image attached]` placeholder text.
- **Codex SDK**: `thread.runStreamed(prompt)` is string-only.  The `--image`
  CLI flag is not accessible from the SDK path.  Path-reference fallback is
  the only option until the SDK exposes `InputImage` content items.

## What broke / surprises

- Git worktrees do not copy gitignored env files; copy
  `.env.local` / `samconfig.test.toml` from the main checkout.
- Backend pytest on a fresh machine needs `paramiko` and other transitive deps
  not listed in the minimal `requirements.txt`.  126 pre-existing failures are
  all infrastructure/env issues unrelated to this change.
- The `--strict` flag on `harness-gardening.sh` exits non-zero on warnings
  from *pre-existing* oversized learning files — not a regression.

## Linked tests / guards

- `backend/tests/agents/test_script_builder.py::TestBuildLaunchCmdImages` —
  7 new tests covering `images_b64`/`images_file` plumbing; all pass.
- TypeScript: `tsc --noEmit --skipLibCheck` clean on `api.ts` + `ChatWindow.tsx`.
- Full backend suite delta: baseline 417 passed → 424 passed after change
  (+7 new, 0 regressions, 126 pre-existing failures unchanged).
- **Real browser (Playwright):** `web/tools/paste-composer-e2e.mjs` — writes a
  PNG to `navigator.clipboard`, focuses the composer `<textarea>`, sends
  Ctrl+V / Cmd+V, asserts `[data-testid="paste-thumbnail"]` appears. The target
  page is dev-only `/paste-smoke` (`app/paste-smoke/*`), which imports the
  **same** `imageFilesFromClipboardData` + `mergePendingAttachments` helpers as
  `ChatWindow.tsx` (`web/lib/composerImagePaste.ts`). Run: `npm run dev:webpack`
  then `PE_BASE_URL=http://localhost:3847 npm run test:paste-e2e`. Evidence
  PNGs committed under `.github/pr-screenshots/paste-e2e-*.png`.

## See also

- `protocols/testing-protocol.md` — real-browser validation required before
  claiming "done" for user-visible work.
- `references/architecture-overview.md` — pipeline diagram.

## Referenced by

- `features/` — add a multimodal feature file once this is merged and
  confirmed working end-to-end with Claude.
