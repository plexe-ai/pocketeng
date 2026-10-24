# Skills

Markdown files that get injected as `AGENTS.md` on EC2 instances during provisioning. They teach the coding agent conventions and patterns for a specific technology.

## How They Work

1. User selects skills in the web dashboard's provision form
2. Skill IDs are passed to `POST /servers` as `skills: ["nextjs", "testing"]`
3. `backend/src/lib/userdata.py` → `_skills_block()` combines selected skills into one file
4. Written to `~/projects/AGENTS.md` on the EC2 during setup
5. Claude Code reads `AGENTS.md` automatically when working in that directory

## Adding a New Skill

1. Create `skills/my-skill.md` with the content
2. Add the skill ID and a summary to `BUILT_IN_SKILLS` dict in `backend/src/lib/userdata.py`
3. Add it to the skills list in `web/components/ProvisionForm.tsx` (the chips array)
4. Add it to `web/app/dashboard/skills/page.tsx` (the BUILT_IN_SKILLS array)

All four places must match. The skill ID (filename without `.md`) is the key.

## Writing Good Skills

- Keep it under 50 lines. The agent reads this every session — don't waste its context window.
- Lead with conventions, not tutorials. The agent already knows the technology.
- Include the specific patterns THIS project uses, not generic best practices.
- List what NOT to do — agents learn more from anti-patterns than patterns.
- Include the test command and deploy command if relevant.

## Current Skills

| ID | File | What it covers |
|---|---|---|
| `nextjs` | nextjs.md | App Router, server components, Tailwind, TypeScript |
| `python-api` | python-api.md | FastAPI, Pydantic, SQLAlchemy, Alembic |
| `ios-swift` | ios-swift.md | SwiftUI, MVVM, Swift concurrency, SwiftData |
| `testing` | testing.md | TDD, test structure, what to test |
| `deploy-vercel` | deploy-vercel.md | Vercel CLI, preview/prod deploys |
| `database-supabase` | database-supabase.md | Supabase CLI, migrations, RLS |
