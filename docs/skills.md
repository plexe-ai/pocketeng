# Skills

A **skill** is a bundle of knowledge, instructions, and tools that teaches a coding agent how to do a specific job.

## What's in a Skill

At minimum, a skill is a markdown file with instructions (like CLAUDE.md or AGENTS.md). At maximum, it's a full workflow with tools, validation, and memory.

### Levels of complexity

**Level 1 — Instructions only**
A markdown file. Coding conventions, architecture decisions, what to avoid. Gets injected as context when the agent starts.

```
skills/
  nextjs.md        # "Use App Router, server components by default, Tailwind..."
  python-api.md    # "Use FastAPI, Pydantic models, alembic migrations..."
```

**Level 2 — Instructions + tools**
Instructions plus specific CLI tools or MCP servers the agent should have access to.

```yaml
name: deploy-preview
instructions: |
  After making changes, run `vercel deploy --prebuilt` to create a preview.
  Share the preview URL in your response.
tools:
  - vercel
  - gh
```

**Level 3 — Full workflow**
Multi-step orchestrated workflow with state, validation, and specialized agents. Like the ML model builder.

```yaml
name: ml-model-builder
instructions: skills/ml-model-builder/instructions.md
workflow:
  phases:
    - data-understanding
    - preparation
    - baselines
    - model-search
    - evaluation
    - packaging
tools:
  - python3
  - spark
  - aws-cli
```

## How Skills Get Used

1. **At workspace creation** — user selects skills to install
2. **Per session** — user can activate/deactivate skills for a specific chat
3. **Always-on** — some skills (like coding conventions) are always active for the project

## Built-in Skills (shipped with PocketEng)

| Skill | Description |
|---|---|
| `nextjs` | Next.js App Router conventions, server components, Tailwind |
| `python-api` | FastAPI/Flask, Pydantic, SQLAlchemy, migrations |
| `ios-swift` | SwiftUI, Swift concurrency, Xcode build conventions |
| `deploy-vercel` | Vercel CLI, preview deployments, environment variables |
| `database-supabase` | Supabase client, migrations, RLS policies |
| `testing` | Write tests, run tests, TDD workflow |
| `pr-workflow` | PR creation, review, and merge workflow |

## Custom Skills

Users can create their own skills — either from scratch or by forking a built-in.

A skill lives as a file (or directory) in the workspace. The simplest skill is just a `.md` file in a `skills/` directory.

## Sharing Skills

Skills can be shared as:
- A GitHub repo (clone into workspace)
- A gist (single-file skill)
- A published npm/pip package (for skills with tools)
- On a skill marketplace (future)
