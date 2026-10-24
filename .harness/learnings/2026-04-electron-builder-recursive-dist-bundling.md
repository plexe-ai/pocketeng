---
type: learning
status: canonical
last_reviewed: 2026-04-25
related: []
tags: [learning, desktop, electron-builder, packaging, release]
---

# electron-builder Recursively Bundles Its Own Output (2026-04)

**When to read:** before changing `files:` in `desktop/electron-builder.yml`,
or when DMG sizes look unusually large.

**When to update:** never edit the story. Add cross-links if a new
related scar appears.

## One-line

`files: dist/**/*` told electron-builder to bundle EVERYTHING under
`dist/`, including `dist/release/` — which is also where it WRITES the
DMG. Each new build packed the previous build's DMG into the next
.app's Resources. Sizes grew cumulatively until a release looked
obviously wrong.

---

## Symptom

- v0.1.2 DMGs: 197 MB (arm64), 406 MB (x64). Normal Electron app size.
- v0.1.3 first build: 1.2 GB (arm64), 2.0 GB (x64). 6-10× bigger.
- Notarization succeeded (Apple doesn't care how big it is).
- The `--publish always` would have happily uploaded gigabyte DMGs to
  GitHub Releases if the first build had used the flag.
- Anyone updating from v0.1.2 → v0.1.3 would have had electron-updater
  download 1.2 GB on next launch.

The first signal you'll see: the DMG file in `dist/release/` is
much larger than the previous version's DMG. Run `du -sh
"dist/release/mac-arm64/Pocket Eng.app"` — if Resources contains
`*.dmg` files, you have this bug.

---

## Root cause

In `electron-builder.yml`:

```yaml
files:
  - dist/**/*
  - package.json
  - '!**/*.map'
```

`files:` says "what goes inside the .app's Resources". It's NOT a
build-output filter. The default for an Electron project is
`dist/**/*`, which is fine UNTIL `electron-builder` itself writes its
output to `dist/release/` — at which point you're recursively
bundling your own outputs. Once `dist/release/Pocket Eng-0.1.2.dmg`
exists, the next `dist/**/*` pass reads it as input and packs it
into `Pocket Eng.app/Contents/Resources/`.

`dist/release/` is the default `directories.output`. It's a sibling
of `dist/main/`, `dist/preload/`, `dist/shared/` (the actual TS
compile outputs). Both live under `dist/`. The glob doesn't
distinguish.

This shows up only on the SECOND build, not the first — fresh repos
have an empty `dist/release/` so nothing extra gets bundled. v0.1.2
shipped fine. v0.1.3 caught it.

---

## Fix

Add a negation to keep `dist/main`, `dist/preload`, `dist/shared`
in but skip `dist/release/**`:

```yaml
files:
  - dist/**/*
  - '!dist/release/**'
  - package.json
  - '!**/*.map'
```

After the fix, v0.1.3 rebuilt at 93 MB (arm64) / 100 MB (x64) — close
to v0.1.2 minus the bloat that was already creeping in there too.

Alternative: be explicit about which subdirs to include
(`dist/main/**/*`, `dist/preload/**/*`, `dist/shared/**/*`). Slightly
safer (defaults to excluding new sibling dirs) but more brittle —
you'd have to remember to update the list when adding a new src
subdir.

---

## How to catch a regression fast

1. After `bun run build`, check the DMG sizes:

   ```bash
   ls -lh dist/release/*.dmg
   ```

   For an Electron 33 + thin web shell, expect ~80-100 MB. Anything
   ≥200 MB means the bundle includes something it shouldn't.

2. Inspect the .app's Resources before uploading:

   ```bash
   du -sh "dist/release/mac-arm64/Pocket Eng.app/Contents/Resources/"
   find "dist/release/mac-arm64/Pocket Eng.app/Contents/Resources/" -size +50M
   ```

   If anything bigger than `app.asar` (~30 MB) shows up — especially
   `*.dmg` or `*.blockmap` files — you have this bug.

3. CI gate idea: assert `du -sb dist/release/*.dmg | awk '{print $1}'`
   is under, say, 200 MB before allowing publish. Not implemented yet
   — flag for a future hardening pass.

---

## Subtle traps to avoid

- **Don't reach for `dist/**/*` reflexively.** It's the electron-
  builder default in many tutorials, but the default works only when
  `directories.output` lives outside `dist/`. We can't change
  `directories.output` without breaking other things, so the negation
  is the right answer for this layout.
- **Don't fix this by `rm -rf dist/release/` between builds.** That
  works once but reintroduces the bug the moment someone forgets.
  The exclusion in `files:` is the durable fix.
- **`files:` is NOT a filter for `electron-builder`'s output dir.**
  It's the input list for what gets packed into Resources. Read
  carefully when documentation talks about "files patterns" — that
  phrase covers both directions in different products.

---

## See also

- [`../../desktop/electron-builder.yml`](../../desktop/electron-builder.yml) — the file with the negation
- [`../../desktop/CLAUDE.md`](../../desktop/CLAUDE.md) — packaging overview

## Referenced by

- `desktop/electron-builder.yml` (inline comment on the negation)
