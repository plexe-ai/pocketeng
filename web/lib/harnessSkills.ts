export type HarnessSkillCategory = 'framework' | 'workflow' | 'tool' | 'custom'

export interface HarnessCustomSkill {
  id: string
  name: string
  description: string
  content: string
}

export interface HarnessSkillDef {
  id: string
  name: string
  description: string
  category: HarnessSkillCategory
  builtin: boolean
}

export interface HarnessSkillCatalogItem extends HarnessSkillDef {
  content: string
  hasOverride?: boolean
}

// Built-in skill default content (matches backend BUILT_IN_SKILLS)
export const BUILT_IN_HARNESS_SKILL_CONTENT: Record<string, string> = {
  'nextjs': '# Next.js Development\nUse App Router, server components by default, Tailwind CSS, TypeScript strict.\nFile structure: app/ for routes, components/ for shared, lib/ for utilities.\nFetch data in server components. Use Server Actions for mutations.\nTest with vitest. Deploy with vercel deploy.',
  'python-api': '# Python API Development\nUse FastAPI with Pydantic models, SQLAlchemy ORM, Alembic migrations.\nType hints everywhere. Async endpoints by default. Thin route handlers, logic in services.\nTest with pytest. Use dependency injection.',
  'ios-swift': '# iOS / Swift Development\nSwiftUI for views, MVVM pattern, @Observable over Combine.\nSwift concurrency (async/await), SwiftData for persistence.\nStructured concurrency with TaskGroup. @MainActor for UI state.',
  'testing': '# Testing\nWrite tests alongside code. Test behavior not implementation.\nHappy path + edge cases + error cases. Run tests before committing.\nArrange-Act-Assert pattern. Keep tests independent.',
  'deploy-vercel': '# Vercel Deployment\nUse `vercel deploy` for previews, `vercel --prod` for production.\nAlways build first to catch errors. Share preview URLs in responses.',
  'database-supabase': '# Supabase Database\nUse Supabase CLI for migrations. Enable RLS on user-data tables.\nWrite policies restricting access to row owner. Use service role key server-side only.',
  'pr-workflow': '# PR Workflow\nAlways follow this end-to-end workflow:\n1. Create a branch (feat/ or fix/)\n2. Implement the changes\n3. Run tests and capture output. Run build if applicable. For web projects, take a screenshot with headless Chrome.\n4. Push and create a PR with gh pr create — include summary, test results, and screenshot\n5. Report back with the PR URL and a one-line summary',
}

export const BUILT_IN_HARNESS_SKILLS: HarnessSkillDef[] = [
  { id: 'nextjs',            name: 'Next.js',       description: 'App Router, server components, Tailwind, TypeScript',               category: 'framework', builtin: true },
  { id: 'python-api',        name: 'Python API',    description: 'FastAPI, Pydantic, SQLAlchemy, Alembic migrations',                 category: 'framework', builtin: true },
  { id: 'ios-swift',         name: 'iOS / Swift',   description: 'SwiftUI, MVVM, Swift concurrency, SwiftData',                       category: 'framework', builtin: true },
  { id: 'testing',           name: 'Testing',       description: 'TDD patterns, test structure, what to test and skip',               category: 'workflow',  builtin: true },
  { id: 'deploy-vercel',     name: 'Vercel Deploy', description: 'Preview deployments, production deploys, and deployment conventions', category: 'tool',      builtin: true },
  { id: 'database-supabase', name: 'Supabase DB',   description: 'Migrations, RLS policies, auth, storage, and database conventions', category: 'tool',      builtin: true },
  { id: 'pr-workflow',       name: 'PR Workflow',   description: 'Branching, testing, screenshots, and PR creation end-to-end',       category: 'workflow',  builtin: true },
]

export const HARNESS_CATEGORY_SECTION_LABELS: Record<HarnessSkillCategory, string> = {
  framework: 'Frameworks',
  workflow: 'Workflows',
  tool: 'Tools',
  custom: 'Custom',
}

export const HARNESS_CATEGORY_BADGE_LABELS: Record<HarnessSkillCategory, string> = {
  framework: 'Framework',
  workflow: 'Workflow',
  tool: 'Platform guide',
  custom: 'Custom',
}

export function createHarnessSkillCatalog(
  customSkills: HarnessCustomSkill[],
  skillOverrides: Record<string, string> = {},
): HarnessSkillCatalogItem[] {
  return [
    ...BUILT_IN_HARNESS_SKILLS.map(skill => {
      const hasOverride = Object.prototype.hasOwnProperty.call(skillOverrides, skill.id)

      return {
        ...skill,
        content: hasOverride
          ? skillOverrides[skill.id]
          : BUILT_IN_HARNESS_SKILL_CONTENT[skill.id] ?? '',
        hasOverride,
      }
    }),
    ...customSkills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || 'Custom skill',
      category: 'custom' as const,
      builtin: false,
      content: skill.content,
    })),
  ]
}
