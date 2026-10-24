> **Engineers and coding agents:** start at [`.harness/README.md`](.harness/README.md). It is the single entry point for how we work here — protocols, playbooks, references, and bug scars. Follow the task-start routine in [`.harness/meta/read-protocol.md`](.harness/meta/read-protocol.md) before you touch code.
>
> For the theory behind the design, see [`docs/harness-research.md`](docs/harness-research.md).

---

## Cursor Cloud specific instructions

### Services overview

| Service | Path | Dev command | Notes |
|---|---|---|---|
| Web dashboard | `web/` | `npm run dev` (port 3000) | Main UI — Next.js 16 + React 19. See `web/CLAUDE.md` for details. |
| Backend API | `backend/` | `sam build` / `sam local invoke` | AWS SAM Python 3.12 Lambdas. See `backend/CLAUDE.md`. Requires AWS SAM CLI (not pre-installed). |
| MCP server | `mcp-server/` | `node index.js` | Single-file stdio MCP server. |
| Agent bridge | `backend/src/lib/bridge/` | `node --test` (from that dir) | Pure ES modules with no npm deps. SDKs (`@openai/codex-sdk`, `@opencode-ai/sdk`) are resolved at runtime via a symlink to the EC2 global `node_modules`. |
| Desktop app | `desktop/` | `bun run dev` | Electron shell for macOS/Windows. Loads `web/` dev server when `PE_DESKTOP_DEV=1`; see `desktop/CLAUDE.md`. |
| CLI | `pocketeng` | Bash script, no build | Single-file bash CLI. |

### Running the web dashboard

1. Ensure `web/.env.local` exists (copy from `web/.env.example` if missing).
2. `cd web && npm run dev` — starts on http://localhost:3000.
3. Auth requires valid Supabase credentials in `.env.local`. Without them the app renders but login redirects to a placeholder Supabase URL.

### Running backend tests

```bash
cd backend && python3 -m pytest tests -q
```

- Requires `boto3` in addition to `requirements.txt` deps (boto3 is provided by Lambda runtime in production but must be installed locally for tests).
- Integration tests are marked `pytest.mark.integration` and require the real `claude`/`codex`/`cursor` CLIs + API keys. They do NOT run in CI — exclude with `--ignore=tests/agents/test_integration.py`.

### Lint / type checking

- No ESLint or standalone lint config exists. TypeScript checking is done via `npm run build` in `web/`.
- Desktop TypeScript checking is done via `cd desktop && bun run build:ts`; desktop unit/smoke tests are `bun run test:unit` and `bun run test:smoke`.
- Backend has no Python linter configured (no ruff/flake8/mypy config).

### Gotchas

- `backend/src/lib/bridge/` has no `npm install` step — SDK deps are only resolved at runtime on EC2 workspaces. Run `node --test` directly from that dir to execute the uploader tests.
- Backend Python deps install to `~/.local` (user-level). Ensure `~/.local/bin` is on PATH for `pytest`.
- The web app uses Capacitor for iOS/Android but those require Xcode/Android Studio respectively — not available in Cloud VMs.
- AWS SAM CLI is not pre-installed. Backend deployment (`sam deploy`) requires it, but unit tests run fine without it.
