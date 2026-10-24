'use client'

/**
 * /dashboard/harness — operations console for the user's harness.
 *
 * Per-user, not per-workspace. Same harness applies wherever the agent
 * runs.
 *
 * Categories ground in the real .harness/ folder layout (see
 * .harness/meta/file-taxonomy.md):
 *
 *   Protocols   — must-follow rules (.harness/protocols/)
 *   Playbooks   — runnable procedures (.harness/playbooks/, often with
 *                 a .sh / .mjs sibling)
 *   Sensors     — checks that catch problems (pytest, harness-lint,
 *                 the pre-push hook, Greptile, the Playwright harness;
 *                 the canonical inventory is .harness/references/feedback-controls.md)
 *   Learnings   — bug stories, append-only (.harness/learnings/)
 *   References  — durable facts about the system (.harness/references/)
 *
 * The HarnessItem.kind enum on the backend maps onto these as:
 *   review_rule        → Protocols
 *   integration_recipe → Playbooks
 *   env_bootstrap      → Playbooks
 *   validation_rule    → Sensors
 *   test_rule          → Sensors
 *   secondary_agent_check → Sensors
 *   skill              → References (or Learnings if its source field
 *                                    starts with "scar:" / "learning:")
 *
 * Sample snapshot:
 *   When /harness is empty (fresh signup or transient 5xx), this page
 *   renders SAMPLE_SNAPSHOT below — pre-populated with REAL paths from
 *   this repo's .harness/ tree and pending items that are realistic
 *   proposals from this week's actual work (the EarlyValidation hook
 *   scar, the long-session truncation regression, the desktop polling
 *   bug). A "preview" pill in the header makes it visible. Approve /
 *   Reject still works locally so the flow is demoable end-to-end.
 *
 * Approval-gated:
 *   Every pending item requires the user to click Approve before it
 *   becomes live. Reject is reversible (move-back from dismissed via
 *   the API). Nothing is added to the live harness silently.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  getHarness,
  updateHarnessItem,
  type HarnessSnapshot,
  type HarnessItem,
  type HarnessItemKind,
} from '@/lib/api'

// ── Categories ────────────────────────────────────────────────────────

type CategoryId = 'protocols' | 'playbooks' | 'sensors' | 'learnings' | 'references'

interface CategoryDef {
  id: CategoryId
  label: string
  /** What lives here, in plain language. Shown in unfiltered Live view. */
  blurb: string
  accent: string
  icon: (cls: string) => ReactElement
  /** Backend kinds that fall into this category. Skill + learning is a
   *  heuristic: `kind === 'skill'` lands in References by default but
   *  the per-item `_category` override (sample data only) can pin a
   *  scar-derived skill into Learnings. */
  kinds: HarnessItemKind[]
}

const Icon = {
  clipboard: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h6a2 2 0 012 2v0H7v0a2 2 0 012-2zM5 7a2 2 0 012-2v12a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 012 2v12a4 4 0 01-4 4H9a4 4 0 01-4-4V7z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 11h6M9 15h4" />
    </svg>
  ),
  terminal: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth={1.6} />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10l3 2-3 2M13 14h4" />
    </svg>
  ),
  radar: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <circle cx="12" cy="12" r="3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12a4 4 0 018 0M5 12a7 7 0 0114 0M2 12a10 10 0 0120 0" />
    </svg>
  ),
  bookmark: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5v15.5a.5.5 0 00.8.4l5.7-4.2a.8.8 0 01.95 0l5.75 4.2A.5.5 0 0019 20.5V5a2 2 0 00-2-2H7a2 2 0 00-2 2z" />
    </svg>
  ),
  book: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.5C9 4.5 5 4.5 3.5 5v13c1.5-.5 5.5-.5 8.5 1.5m0-13c3-2 7-2 8.5-1.5v13c-1.5-.5-5.5-.5-8.5 1.5m0-13v13" />
    </svg>
  ),
  inbox: (cls: string) => (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338A2.25 2.25 0 0017.085 3.75H6.915a2.25 2.25 0 00-2.155 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />
    </svg>
  ),
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'protocols',
    label: 'Protocols',
    blurb: 'Must-follow rules',
    accent: 'amber',
    icon: Icon.clipboard,
    kinds: ['review_rule'],
  },
  {
    id: 'playbooks',
    label: 'Playbooks',
    blurb: 'Runnable procedures',
    accent: 'accent',
    icon: Icon.terminal,
    kinds: ['integration_recipe', 'env_bootstrap'],
  },
  {
    id: 'sensors',
    label: 'Sensors',
    blurb: 'Checks that catch problems',
    accent: 'green',
    icon: Icon.radar,
    kinds: ['validation_rule', 'test_rule', 'secondary_agent_check'],
  },
  {
    id: 'learnings',
    label: 'Learnings',
    blurb: 'Bug stories, append-only',
    accent: 'purple',
    icon: Icon.bookmark,
    kinds: [], // routed via _category override on samples; see categoryFor()
  },
  {
    id: 'references',
    label: 'References',
    blurb: 'Durable facts about the system',
    accent: 'bright',
    icon: Icon.book,
    kinds: ['skill'],
  },
]

/** A sample-only override the API doesn't carry. Lets us pin a skill-kind
 *  item into Learnings (e.g. when the source IS a scar) without
 *  mutating the backend enum. */
type ItemWithOverride = HarnessItem & { _category?: CategoryId }

function categoryFor(item: ItemWithOverride): CategoryDef {
  if (item._category) {
    const found = CATEGORIES.find(c => c.id === item._category)
    if (found) return found
  }
  return CATEGORIES.find(c => c.kinds.includes(item.kind)) ?? CATEGORIES[CATEGORIES.length - 1]
}

const ACCENT_CLASSES: Record<string, { text: string; tint: string; ring: string; bar: string; dot: string }> = {
  amber:  { text: 'text-amber',  tint: 'bg-amber/10',  ring: 'ring-amber/30',  bar: 'bg-amber',  dot: 'bg-amber' },
  green:  { text: 'text-green',  tint: 'bg-green/10',  ring: 'ring-green/30',  bar: 'bg-green',  dot: 'bg-green' },
  accent: { text: 'text-accent', tint: 'bg-accent/10', ring: 'ring-accent/30', bar: 'bg-accent', dot: 'bg-accent' },
  purple: { text: 'text-purple', tint: 'bg-purple/10', ring: 'ring-purple/30', bar: 'bg-purple', dot: 'bg-purple' },
  bright: { text: 'text-bright', tint: 'bg-l2',        ring: 'ring-line',      bar: 'bg-bright', dot: 'bg-bright' },
}

// ── Sample snapshot ───────────────────────────────────────────────────
// Real paths from this repo's .harness/ tree. Pending items are
// realistic proposals from this week's actual scars (the
// EarlyValidation deploy block, the long-session truncation regression,
// the API-key paste incident).

const SAMPLE_SNAPSHOT: HarnessSnapshot & { items: ItemWithOverride[] } = {
  currentVersion: { label: 'v0.4', versionSeq: 4, createdAt: new Date(Date.now() - 86400_000 * 1).toISOString() },
  lastPromotedAt: new Date(Date.now() - 86400_000 * 1).toISOString(),
  items: [
    // ── PENDING ── this-week's real proposals ─────────────────────
    {
      itemId: 'pend-lint-template-desc',
      kind: 'validation_rule',
      mode: 'required',
      status: 'pending',
      title: 'Lint template.yaml descriptions before sam build',
      summary: 'Block sam build if any AWS::Serverless::Function.Description exceeds 256 chars. The CloudFormation EarlyValidation hook rejects with no diagnostic detail when this happens.',
      when: 'Before sam deploy (preflight, scripts/lint-template.py)',
      source: 'Today: 2-hour deploy block on a 274-char Description on ScheduledEmailNudgeFunction.',
      sourceRunIds: ['session_2026-04-27_deploy_block'],
      confidence: 0.95,
      impact: 'Prevents an entire class of opaque CFN deploy failures that took ~2 hours to bisect today.',
      evidence: [
        'Five sam deploy attempts failed with AWS::EarlyValidation::PropertyValidation, no diagnostic',
        'describe-change-set --include-property-values surfaced the 274-char description as the only meaningful diff',
        'Trimmed to 173 chars, deploy succeeded immediately',
      ],
      surfaces: ['validation'],
      action: { commands: ['python3 scripts/lint-template.py backend/template.yaml'] },
      generated: ['scripts/lint-template.py', '.harness/playbooks/lint-template.md'],
      createdAt: new Date(Date.now() - 86400_000 * 0.05).toISOString(),
    },
    {
      itemId: 'pend-scar-early-validation',
      kind: 'skill',
      _category: 'learnings',
      mode: 'informational',
      status: 'pending',
      title: 'Scar: EarlyValidation hook rejects on Description > 256 chars',
      summary: "Document today's deploy block as an append-only learning so the next person who hits the opaque AWS::EarlyValidation::PropertyValidation failure finds the answer in one grep.",
      when: 'Filed under .harness/learnings/, linked from feedback-controls.md',
      source: 'Today\'s deploy session — see the diagnostic path in the harness commit history.',
      confidence: 0.99,
      impact: 'Cuts the next occurrence from 2 hours to 2 minutes. Same pattern that retired the polling-stuck bug.',
      evidence: [
        'CloudFormation hook returned no diagnostic; bisection via describe-change-set was the only path',
        'No existing learning covers Description-property limits',
      ],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/learnings/2026-04-early-validation-description-length.md'],
      createdAt: new Date(Date.now() - 86400_000 * 0.04).toISOString(),
    },
    {
      itemId: 'pend-secrets-precommit',
      kind: 'validation_rule',
      mode: 'required',
      status: 'pending',
      title: 'Pre-commit hook: block staged files containing API keys',
      summary: 'Add git-secrets / trufflehog patterns for Anthropic, Resend, Retell, AWS access-key formats. Commit fails if any staged hunk matches.',
      when: 'On every git commit',
      source: 'Two sessions this week pasted live API keys into chat. One we noticed only after rotation.',
      sourceRunIds: ['sess_3a91…', 'sess_77c2…'],
      confidence: 0.91,
      impact: 'Stops credentials reaching git history. Cheap to add; expensive to recover from.',
      evidence: [
        'sess_3a91 — key_79d6… pasted in chat at 10:05',
        'sess_77c2 — RETELL_API_KEY in voice-agent-demo/.env',
      ],
      surfaces: ['validation', 'review loop'],
      action: { commands: ['git secrets --pre_commit_hook'] },
      generated: ['scripts/check-secrets.sh', '.git/hooks/pre-commit'],
      createdAt: new Date(Date.now() - 86400_000 * 0.5).toISOString(),
    },
    {
      itemId: 'pend-deploy-playbook-update',
      kind: 'integration_recipe',
      mode: 'suggested',
      status: 'pending',
      title: 'Add description-length preflight to deploy playbook',
      summary: 'Update playbooks/deploy-to-test-stack.md so the preflight section runs scripts/lint-template.py before sam build, with a one-line failure mode pointing at the new learning.',
      when: 'Before every deploy',
      source: 'Companion to the lint-template.py sensor proposed above.',
      confidence: 0.88,
      impact: 'The playbook is the canonical deploy procedure — sensors that aren\'t in it get skipped.',
      evidence: [
        'playbooks/deploy-to-test-stack.md currently has 4 preflight steps; this would be a 5th',
      ],
      surfaces: ['validation'],
      action: {},
      generated: ['.harness/playbooks/deploy-to-test-stack.md'],
      createdAt: new Date(Date.now() - 86400_000 * 0.03).toISOString(),
    },

    // ── LIVE — Protocols ────────────────────────────────────────────
    {
      itemId: 'live-proto-safety',
      kind: 'review_rule',
      mode: 'required',
      status: 'live',
      title: 'Safety protocol — secrets and destructive ops',
      summary: 'Never commit or print secrets. Pre-flight any destructive AWS / SAM op against a non-prod stack. Listed in detail in the protocol file.',
      when: 'Always',
      source: 'Founding protocol set.',
      confidence: 1,
      impact: 'Removes whole classes of footguns structurally.',
      evidence: [],
      surfaces: ['review loop'],
      action: {},
      generated: ['.harness/protocols/safety-protocol.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-proto-testing',
      kind: 'review_rule',
      mode: 'required',
      status: 'live',
      title: 'Testing protocol — real data, real browser, real deploy',
      summary: 'Never mock the integration surface. Every fix gets real-browser validation before "done." Test against the deployed test stack, not localhost mocks.',
      when: 'Phase 4 of the dev cycle, on every change',
      source: 'Founding protocol — captured in protocols/testing-protocol.md.',
      confidence: 1,
      impact: 'Catches the bugs that only appear under real network / WKWebView / Lambda conditions.',
      evidence: [],
      surfaces: ['validation'],
      action: {},
      generated: ['.harness/protocols/testing-protocol.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-proto-commit',
      kind: 'review_rule',
      mode: 'required',
      status: 'live',
      title: 'Commit + PR protocol — evidence required',
      summary: 'Every commit message states the why. Every PR attaches the evidence (test output, browser-harness video, deploy URL). No "trust me" commits.',
      when: 'Phase 5 of the dev cycle',
      source: 'Founding protocol set.',
      confidence: 1,
      impact: 'PRs become reviewable in minutes instead of "what does this even do".',
      evidence: [],
      surfaces: ['review loop'],
      action: {},
      generated: ['.harness/protocols/commit-and-pr-protocol.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-proto-tdd',
      kind: 'review_rule',
      mode: 'required',
      status: 'live',
      title: 'TDD + scope discipline',
      summary: 'New non-trivial logic ships with a failing test first. Scope creep gets sliced into a follow-up; the active PR stays single-concern.',
      when: 'On every feature or non-trivial fix',
      source: 'Captured after early "kitchen-sink PR" pattern was painful to review.',
      confidence: 1,
      impact: 'PRs reviewable. Tests actually run. Scope drift caught at commit time.',
      evidence: [],
      surfaces: ['review loop'],
      action: {},
      generated: ['.harness/protocols/tdd-and-scope.md'],
      createdAt: new Date(Date.now() - 86400_000 * 25).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 25).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-proto-no-bypass',
      kind: 'review_rule',
      mode: 'required',
      status: 'live',
      title: 'No-bypass protocol — what to do when blocked',
      summary: 'When a hook, lint, or test blocks: fix the underlying issue. Never `--no-verify`, never silence a sensor. Escalate to a human if the rule itself is wrong.',
      when: 'When any sensor blocks the agent',
      source: 'Captured after a hook-bypass scar.',
      confidence: 1,
      impact: 'Sensors that can be bypassed are sensors that lie. This protocol keeps them honest.',
      evidence: [],
      surfaces: ['review loop', 'validation'],
      action: {},
      generated: ['.harness/protocols/no-bypass.md'],
      createdAt: new Date(Date.now() - 86400_000 * 22).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 22).toISOString(),
      versionIntroduced: 1,
    },

    // ── LIVE — Playbooks ─────────────────────────────────────────────
    {
      itemId: 'live-playbook-browser-testing',
      kind: 'integration_recipe',
      mode: 'required',
      status: 'live',
      title: 'Real-browser test harness (Playwright)',
      summary: 'browser-testing.sh installs a Playwright harness in ~/.pocketeng/browser-harness. .mjs scenarios drive real Chromium, capture numbered screenshots + video + console + network, and get reviewed by a human.',
      when: 'Phase 4 of the dev cycle, on UI-affecting changes',
      source: 'Standardised after multiple "shipped on localhost, broke in prod" incidents.',
      confidence: 1,
      impact: 'Visual + network regressions caught before merge.',
      evidence: ['playbooks/browser-testing.md', 'playbooks/browser-testing.sh', 'playbooks/test-polling-resume.mjs (regression for the polling-stuck scar)'],
      surfaces: ['validation'],
      action: { commands: ['bash .harness/playbooks/browser-testing.sh'] },
      generated: ['.harness/playbooks/browser-testing.md', '.harness/playbooks/browser-testing.sh'],
      createdAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-playbook-deploy',
      kind: 'integration_recipe',
      mode: 'required',
      status: 'live',
      title: 'Deploy to test stack',
      summary: 'Standard preflight + sam build + sam deploy against the test-stack params. Includes the "never deploy to prod from a feature branch" guard.',
      when: 'Before any merge that touches backend/',
      source: 'Founding playbook.',
      confidence: 1,
      impact: 'Catches CFN, IAM, and template regressions before prod.',
      evidence: [],
      surfaces: ['validation'],
      action: { commands: ['bash .harness/playbooks/deploy-to-test-stack.sh'] },
      generated: ['.harness/playbooks/deploy-to-test-stack.md', '.harness/playbooks/deploy-to-test-stack.sh'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-playbook-test-polling-resume',
      kind: 'integration_recipe',
      mode: 'automatic',
      status: 'live',
      title: 'test-polling-resume.mjs — Playwright regression for the four wake-up signals',
      summary: 'Holds the next /sessions/:id/events open indefinitely, dispatches visibilitychange/pageshow/focus, asserts a fresh fetch fires post-resume. Pre-fix builds fail; post-fix pass.',
      when: 'CI on every PR touching ChatWindow.tsx',
      source: 'Born from the iOS WKWebView scar; expanded today to cover the Electron app-switch scar.',
      confidence: 0.95,
      impact: 'No more "messages don\'t show until reload" regressions.',
      evidence: ['.harness/learnings/2026-04-session-polling-single-flight-stuck.md'],
      surfaces: ['validation'],
      action: { commands: ['node .harness/playbooks/test-polling-resume.mjs'] },
      generated: ['.harness/playbooks/test-polling-resume.mjs'],
      createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
      versionIntroduced: 3,
    },
    {
      itemId: 'live-playbook-harness-gardening',
      kind: 'integration_recipe',
      mode: 'suggested',
      status: 'live',
      title: 'Weekly harness-gardening pass',
      summary: 'Run harness-lint.py, sweep stale last_reviewed dates, audit broken links, deprecate dead-weight files. Keeps the knowledge base honest.',
      when: 'Weekly — manual cadence',
      source: 'Harnesses rot if not maintained. Codified after 2 weeks of drift.',
      confidence: 0.9,
      impact: 'The harness itself stays load-bearing instead of becoming a graveyard.',
      evidence: [],
      surfaces: ['agent context'],
      action: { commands: ['bash .harness/playbooks/harness-gardening.sh'] },
      generated: ['.harness/playbooks/harness-gardening.md', '.harness/playbooks/harness-gardening.sh'],
      createdAt: new Date(Date.now() - 86400_000 * 21).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 21).toISOString(),
      versionIntroduced: 1,
    },

    // ── LIVE — Sensors ───────────────────────────────────────────────
    {
      itemId: 'live-sensor-pytest',
      kind: 'test_rule',
      mode: 'required',
      status: 'live',
      title: 'pytest — backend unit + integration suite',
      summary: 'python3 -m pytest tests/ runs ~620 tests covering session-sync invariants, harness handler state transitions, and BYOS guards. Pre-push hook runs the relevant subset.',
      when: 'Phase 4 of the dev cycle, pre-push hook, on demand',
      source: 'Computational sensor — feedback-controls.md.',
      confidence: 1,
      impact: 'Backend regressions caught before they reach origin.',
      evidence: ['references/feedback-controls.md'],
      surfaces: ['validation'],
      action: { commands: ['python3 -m pytest tests -q'] },
      generated: [],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-sensor-tsc',
      kind: 'test_rule',
      mode: 'required',
      status: 'live',
      title: 'pnpm build — TypeScript + Next.js compile',
      summary: 'cd web && pnpm build catches type errors, broken imports, SSR breaks. Vercel runs the same step on every preview deploy.',
      when: 'Phase 4 of the dev cycle, Vercel CI',
      source: 'Computational sensor — feedback-controls.md.',
      confidence: 1,
      impact: 'Type errors never reach prod.',
      evidence: ['references/feedback-controls.md'],
      surfaces: ['validation'],
      action: { commands: ['pnpm --dir web build'] },
      generated: [],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-sensor-harness-lint',
      kind: 'validation_rule',
      mode: 'automatic',
      status: 'live',
      title: 'harness-lint.py — link + frontmatter integrity',
      summary: 'Validates every relative link in .harness/, every frontmatter block, every last_reviewed date. Reports oversized files without justification.',
      when: 'Weekly gardening pass',
      source: 'Built after a broken-link grep took 45 minutes to manually fix.',
      confidence: 1,
      impact: 'The harness folder stays a working knowledge graph instead of a pile of stale notes.',
      evidence: [],
      surfaces: ['validation'],
      action: { commands: ['python3 .harness/tools/harness-lint.py'] },
      generated: ['.harness/tools/harness-lint.py'],
      createdAt: new Date(Date.now() - 86400_000 * 21).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 21).toISOString(),
      versionIntroduced: 2,
    },
    {
      itemId: 'live-sensor-pre-push',
      kind: 'validation_rule',
      mode: 'required',
      status: 'live',
      title: 'Pre-push hook — verify-before-pr.sh',
      summary: 'Final back-pressure before a push reaches origin. Runs the test subset relevant to the diff, refuses to push on failure.',
      when: 'On git push',
      source: 'Computational sensor — Ralph-loop pattern from harness-model.md.',
      confidence: 1,
      impact: 'Catches "I forgot to run the tests" at the cheapest possible moment.',
      evidence: [],
      surfaces: ['validation'],
      action: {},
      generated: ['.claude/hooks/verify-before-pr.sh'],
      createdAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      versionIntroduced: 2,
    },
    {
      itemId: 'live-sensor-greptile',
      kind: 'secondary_agent_check',
      mode: 'automatic',
      status: 'live',
      title: 'Greptile — AI code review on every PR',
      summary: 'Inferential sensor. Reads each diff and flags scope creep, security concerns, missing tests. Flagged the over-permissioned IAM on PR #102 and #97.',
      when: 'On every PR open and re-push',
      source: 'Adopted after Greptile caught the second over-permissioned IAM diff.',
      confidence: 0.85,
      impact: 'Independent second pass — catches things the original author missed.',
      evidence: ['Greptile review on PR #102 (over-permissioned TrialUsageFunction)', 'Greptile review on PR #97 (over-permissioned ScheduledEmailNudgeFunction)'],
      surfaces: ['review loop'],
      action: { agent: 'greptile-bot' },
      generated: [],
      createdAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 14).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-sensor-sam-validate',
      kind: 'validation_rule',
      mode: 'required',
      status: 'live',
      title: 'sam build / sam validate — template integrity',
      summary: 'Catches malformed CloudFormation, missing handler files, schema violations before any deploy attempt.',
      when: 'On every deploy preflight',
      source: 'Computational sensor — feedback-controls.md.',
      confidence: 1,
      impact: 'Template breaks fail at preflight instead of mid-deploy.',
      evidence: [],
      surfaces: ['validation'],
      action: { commands: ['cd backend && sam build'] },
      generated: [],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },

    // ── LIVE — Learnings ─────────────────────────────────────────────
    {
      itemId: 'live-scar-polling-stuck',
      kind: 'skill',
      _category: 'learnings',
      mode: 'informational',
      status: 'live',
      title: 'Session polling freezes after app backgrounding',
      summary: "Single-flight `pollInFlightRef` flag stuck at `true` because suspended fetches on iOS WKWebView / throttled Chromium / Electron-blur never resolve. Fix: AbortController + reset on visibilitychange/pageshow/focus/online.",
      when: 'Read before touching ChatWindow.doOnePoll or any new polling loop',
      source: 'iOS WKWebView scar (April) + Electron desktop scar (April).',
      confidence: 1,
      impact: 'Saved ~2 hours of root-causing the same symptom on a different platform.',
      evidence: ['playbook: test-polling-resume.mjs (paired regression)'],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/learnings/2026-04-session-polling-single-flight-stuck.md'],
      createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
      versionIntroduced: 3,
    },
    {
      itemId: 'live-scar-long-session',
      kind: 'skill',
      _category: 'learnings',
      mode: 'informational',
      status: 'live',
      title: 'Long sessions drop assistant replies on initial load',
      summary: "Initial /sessions/:id/messages truncated to 'all user rows + last 500 raw rows', leaving older user bubbles orphaned. Fix: contiguous suffix that rewinds to the nearest preceding user row.",
      when: 'Read before touching backend/src/sessions.py initial-load path',
      source: 'Today\'s "previous claude messages don\'t show on desktop" incident.',
      confidence: 1,
      impact: 'Retired a class of bug that already cost one production hotfix and an angry user session.',
      evidence: ['commit cfa60e3 fix(chat): long-session truncation', 'tests/test_sessions.py::test_long_initial_load_keeps_recent_transcript_contiguous'],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/learnings/2026-04-long-session-initial-load-drops-assistant-replies.md'],
      createdAt: new Date(Date.now() - 86400_000 * 0.3).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 0.3).toISOString(),
      versionIntroduced: 4,
    },
    {
      itemId: 'live-scar-codex-duplicate',
      kind: 'skill',
      _category: 'learnings',
      mode: 'informational',
      status: 'live',
      title: 'Codex duplicate-sessions from rsid mis-routing',
      summary: 'Treating the bridge\'s emit_init `session_id` as the agent\'s remote session id overwrote a correct rsid with our internal id. Sync daemon then couldn\'t match pulled .jsonl files to the live session record.',
      when: 'Read before touching the agent-bridge session_id routing',
      source: 'April scar — Codex sessions duplicating in the sidebar.',
      confidence: 1,
      impact: 'Prefer thread.started over system/init for remote-session-id assignment.',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/learnings/2026-04-codex-duplicate-sessions.md'],
      createdAt: new Date(Date.now() - 86400_000 * 12).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 12).toISOString(),
      versionIntroduced: 2,
    },
    {
      itemId: 'live-scar-electron-builder',
      kind: 'skill',
      _category: 'learnings',
      mode: 'informational',
      status: 'live',
      title: 'electron-builder recursive dist bundling',
      summary: "electron-builder bundled its own previous dist/ output into the new build, causing exponential .dmg growth.",
      when: 'Read before touching desktop/electron-builder.json',
      source: 'April scar.',
      confidence: 1,
      impact: 'Saved ~30 min of "why is the dmg 600MB now".',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/learnings/2026-04-electron-builder-recursive-dist-bundling.md'],
      createdAt: new Date(Date.now() - 86400_000 * 16).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 16).toISOString(),
      versionIntroduced: 1,
    },

    // ── LIVE — References ───────────────────────────────────────────
    {
      itemId: 'live-ref-architecture',
      kind: 'skill',
      mode: 'informational',
      status: 'live',
      title: 'architecture-overview.md',
      summary: 'Big-picture flow of the system — web ↔ backend ↔ EC2 bridge ↔ DDB. Read before any cross-cutting change.',
      when: 'Pre-task, when the change spans more than one component',
      source: 'Founding reference.',
      confidence: 1,
      impact: 'Avoids surprise "I didn\'t know X talked to Y".',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/references/architecture-overview.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-ref-aws-debug',
      kind: 'skill',
      mode: 'informational',
      status: 'live',
      title: 'aws-debugging.md',
      summary: 'Recipes for AWS CLI probes — DDB scans, CloudFormation events, Lambda logs. The change-set-events recipe is what unblocked today\'s deploy.',
      when: 'During incident debugging',
      source: 'Founding reference.',
      confidence: 1,
      impact: 'Today\'s EarlyValidation diagnosis used describe-change-set --include-property-values from this file.',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/references/aws-debugging.md'],
      createdAt: new Date(Date.now() - 86400_000 * 25).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 25).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-ref-feedback-controls',
      kind: 'skill',
      mode: 'informational',
      status: 'live',
      title: 'feedback-controls.md — sensor inventory',
      summary: 'Canonical map of every sensor we run today. Computational vs inferential. If a sensor exists but isn\'t listed, it\'s a gap.',
      when: 'Before adding a new check or debugging "why didn\'t X catch this"',
      source: 'Founding reference.',
      confidence: 1,
      impact: 'Single source of truth for the Sensors category above.',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/references/feedback-controls.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-ref-repo-map',
      kind: 'skill',
      mode: 'informational',
      status: 'live',
      title: 'repo-map.md',
      summary: 'Which folder owns which concern. Routes the agent at task-start before it reads any code.',
      when: 'Pre-task',
      source: 'Founding reference.',
      confidence: 1,
      impact: 'Prevents "agent edits the wrong file because it grepped the wrong thing".',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/references/repo-map.md'],
      createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 30).toISOString(),
      versionIntroduced: 1,
    },
    {
      itemId: 'live-ref-env-vars',
      kind: 'skill',
      mode: 'informational',
      status: 'live',
      title: 'env-variables.md',
      summary: 'Every env var, every secret, where it lives, who reads it. Updated whenever a new param is added to template.yaml.',
      when: 'When adding or debugging an env-driven feature',
      source: 'Founding reference.',
      confidence: 1,
      impact: 'No more "is this in samconfig.toml or Vercel project settings?".',
      evidence: [],
      surfaces: ['agent context'],
      action: {},
      generated: ['.harness/references/env-variables.md'],
      createdAt: new Date(Date.now() - 86400_000 * 28).toISOString(),
      promotedAt: new Date(Date.now() - 86400_000 * 28).toISOString(),
      versionIntroduced: 1,
    },
  ],
  history: [
    { versionSeq: 4, version: 'v0.4', createdAt: new Date(Date.now() - 86400_000 * 1).toISOString(), title: 'Long-session truncation + polling resilience', items: ['live-scar-long-session', 'live-playbook-test-polling-resume'], note: '2 promoted, 0 dismissed' },
    { versionSeq: 3, version: 'v0.3', createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(), title: 'Polling regression test', items: ['live-scar-polling-stuck'], note: '1 promoted' },
    { versionSeq: 2, version: 'v0.2', createdAt: new Date(Date.now() - 86400_000 * 14).toISOString(), title: 'Pre-push hook + harness-lint', items: ['live-sensor-pre-push', 'live-sensor-harness-lint'], note: '2 promoted, 1 dismissed' },
    { versionSeq: 1, version: 'v0.1', createdAt: new Date(Date.now() - 86400_000 * 30).toISOString(), title: 'Founding harness — protocols + base sensors', items: ['live-proto-safety', 'live-proto-testing', 'live-sensor-pytest', 'live-sensor-tsc'], note: 'Initial set' },
  ],
  runSummaries: [],
}

// ── Page ──────────────────────────────────────────────────────────────

export default function HarnessPage() {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot | null>(null)
  const [usingSample, setUsingSample] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyItemId, setBusyItemId] = useState<string | null>(null)
  const [recentlyResolved, setRecentlyResolved] = useState<Record<string, 'approved' | 'rejected'>>({})
  const [activeCat, setActiveCat] = useState<CategoryId | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'pending'>('all')

  const load = useCallback(async () => {
    setError(null)
    try {
      const data = await getHarness()
      if (!data.items || data.items.length === 0) {
        setSnapshot(SAMPLE_SNAPSHOT)
        setUsingSample(true)
      } else {
        setSnapshot(data)
        setUsingSample(false)
      }
    } catch {
      setSnapshot(SAMPLE_SNAPSHOT)
      setUsingSample(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleAction = useCallback(async (itemId: string, action: 'promote' | 'dismiss') => {
    setBusyItemId(itemId)
    setRecentlyResolved(prev => ({ ...prev, [itemId]: action === 'promote' ? 'approved' : 'rejected' }))
    try {
      if (usingSample) {
        await new Promise(r => setTimeout(r, 220))
        setSnapshot(prev => {
          if (!prev) return prev
          return {
            ...prev,
            items: prev.items.map(it =>
              it.itemId === itemId
                ? { ...it, status: action === 'promote' ? 'live' : 'dismissed', promotedAt: action === 'promote' ? new Date().toISOString() : it.promotedAt }
                : it,
            ),
          }
        })
      } else {
        const next = await updateHarnessItem(itemId, action)
        setSnapshot(next)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyItemId(null)
      setTimeout(() => setRecentlyResolved(prev => {
        const next = { ...prev }
        delete next[itemId]
        return next
      }), 1800)
    }
  }, [usingSample])

  const items = (snapshot?.items ?? []) as ItemWithOverride[]
  const pending = useMemo(() => items.filter(i => i.status === 'pending'), [items])
  const live = useMemo(() => items.filter(i => i.status === 'live'), [items])

  const countsByCategory = useMemo(() => {
    const m: Record<CategoryId, { pending: number; live: number }> = {
      protocols: { pending: 0, live: 0 },
      playbooks: { pending: 0, live: 0 },
      sensors: { pending: 0, live: 0 },
      learnings: { pending: 0, live: 0 },
      references: { pending: 0, live: 0 },
    }
    for (const it of items) {
      const cat = categoryFor(it).id
      if (it.status === 'pending') m[cat].pending += 1
      else if (it.status === 'live') m[cat].live += 1
    }
    return m
  }, [items])

  const filteredPending = useMemo(() => {
    if (statusFilter === 'live') return []
    if (activeCat === 'all') return pending
    return pending.filter(it => categoryFor(it).id === activeCat)
  }, [pending, activeCat, statusFilter])

  const filteredLive = useMemo(() => {
    if (statusFilter === 'pending') return []
    if (activeCat === 'all') return live
    return live.filter(it => categoryFor(it).id === activeCat)
  }, [live, activeCat, statusFilter])

  return (
    <div className="mx-auto max-w-5xl px-5 sm:px-8 py-6 sm:py-8 space-y-6">
      <PageHeader
        version={snapshot?.currentVersion?.label ?? null}
        liveCount={live.length}
        pendingCount={pending.length}
        usingSample={usingSample}
        loading={loading}
      />

      <CategoryStrip
        activeCat={activeCat}
        onSelect={setActiveCat}
        counts={countsByCategory}
        totals={{ pending: pending.length, live: live.length }}
      />

      <StatusFilter value={statusFilter} onChange={setStatusFilter} pendingCount={pending.length} liveCount={live.length} />

      {error && (
        <div className="text-[12.5px] text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {statusFilter !== 'live' && (
        <PendingList
          items={filteredPending}
          loading={loading}
          busyItemId={busyItemId}
          recentlyResolved={recentlyResolved}
          onAction={handleAction}
        />
      )}

      {statusFilter !== 'pending' && (
        <LiveList items={filteredLive} loading={loading} activeCat={activeCat} />
      )}

      {snapshot?.history && snapshot.history.length > 0 && (
        <Timeline history={snapshot.history} />
      )}
    </div>
  )
}

// ── Page header ───────────────────────────────────────────────────────

function PageHeader({
  version,
  liveCount,
  pendingCount,
  usingSample,
  loading,
}: {
  version: string | null
  liveCount: number
  pendingCount: number
  usingSample: boolean
  loading: boolean
}) {
  return (
    <div className="flex items-end justify-between gap-4 pb-4 border-b border-line">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[20px] font-semibold text-bright tracking-tight">Harness</h1>
          {version && (
            <span className="font-mono text-[11px] text-tertiary tabular-nums">{version}</span>
          )}
          {usingSample && (
            <span
              className="text-[9.5px] uppercase tracking-wider text-tertiary border border-line rounded px-1.5 py-[1px]"
              title="No data on file yet — showing this repo's actual .harness/ items as illustration. Approvals are local-only until your first session lands."
            >
              preview
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-5 text-[12px] flex-shrink-0">
        <HeaderStat label="Live" value={loading ? null : liveCount} tone="bright" />
        <span className="h-3 w-px bg-line" />
        <HeaderStat label="Pending" value={loading ? null : pendingCount} tone={pendingCount > 0 ? 'accent' : 'tertiary'} />
      </div>
    </div>
  )
}

function HeaderStat({ label, value, tone }: { label: string; value: number | null; tone: 'bright' | 'accent' | 'tertiary' }) {
  const toneClass = tone === 'accent' ? 'text-accent' : tone === 'tertiary' ? 'text-tertiary' : 'text-bright'
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`text-[15px] font-semibold tabular-nums ${toneClass}`}>{value === null ? '—' : value}</span>
      <span className="text-tertiary text-[11.5px]">{label}</span>
    </span>
  )
}

// ── Category strip ────────────────────────────────────────────────────

function CategoryStrip({
  activeCat,
  onSelect,
  counts,
  totals,
}: {
  activeCat: CategoryId | 'all'
  onSelect: (id: CategoryId | 'all') => void
  counts: Record<CategoryId, { pending: number; live: number }>
  totals: { pending: number; live: number }
}) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      <CategoryTile
        id="all"
        label="All"
        blurb="Everything"
        accent="bright"
        active={activeCat === 'all'}
        pending={totals.pending}
        live={totals.live}
        onSelect={onSelect}
        icon={Icon.inbox}
      />
      {CATEGORIES.map(cat => (
        <CategoryTile
          key={cat.id}
          id={cat.id}
          label={cat.label}
          blurb={cat.blurb}
          accent={cat.accent}
          active={activeCat === cat.id}
          pending={counts[cat.id].pending}
          live={counts[cat.id].live}
          onSelect={onSelect}
          icon={cat.icon}
        />
      ))}
    </div>
  )
}

function CategoryTile({
  id,
  label,
  blurb,
  accent,
  active,
  pending,
  live,
  onSelect,
  icon,
}: {
  id: CategoryId | 'all'
  label: string
  blurb: string
  accent: string
  active: boolean
  pending: number
  live: number
  onSelect: (id: CategoryId | 'all') => void
  icon: (cls: string) => ReactElement
}) {
  const acc = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.bright
  return (
    <button
      onClick={() => onSelect(id)}
      className={`group relative text-left rounded-lg border px-3 py-2.5 transition-all duration-150 cursor-pointer ${
        active ? 'border-line2 bg-l1' : 'border-line bg-l1/30 hover:bg-l1/60 hover:border-line2'
      }`}
    >
      {active && <span className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-r ${acc.bar}`} />}
      <div className="flex items-center gap-2 min-w-0">
        <span className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded ${acc.tint} ${acc.text}`}>
          {icon('w-3 h-3')}
        </span>
        <span className="text-[12px] font-medium text-bright truncate">{label}</span>
      </div>
      <div className="mt-1 text-[10px] text-tertiary leading-tight truncate">{blurb}</div>
      <div className="mt-1.5 flex items-baseline gap-2 text-[10.5px] text-tertiary tabular-nums">
        <span><span className="text-bright">{live}</span> live</span>
        {pending > 0 && <span className="text-accent">· {pending} pending</span>}
      </div>
    </button>
  )
}

// ── Status filter ─────────────────────────────────────────────────────

function StatusFilter({
  value,
  onChange,
  pendingCount,
  liveCount,
}: {
  value: 'all' | 'live' | 'pending'
  onChange: (v: 'all' | 'live' | 'pending') => void
  pendingCount: number
  liveCount: number
}) {
  const OPTIONS = [
    { id: 'all' as const, label: 'All', count: pendingCount + liveCount },
    { id: 'pending' as const, label: 'Pending', count: pendingCount },
    { id: 'live' as const, label: 'Live', count: liveCount },
  ]
  return (
    <div className="inline-flex items-center gap-px rounded-md bg-l1/60 p-[2px] border border-line">
      {OPTIONS.map(opt => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={`text-[11.5px] font-medium px-2.5 py-[5px] rounded transition-colors cursor-pointer ${
              active ? 'bg-ink text-bright shadow-[0_1px_2px_rgba(0,0,0,0.3)]' : 'text-tertiary hover:text-secondary'
            }`}
          >
            {opt.label}
            <span className="text-tertiary ml-1.5 tabular-nums text-[10.5px]">{opt.count}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Pending list ──────────────────────────────────────────────────────

function PendingList({
  items,
  loading,
  busyItemId,
  recentlyResolved,
  onAction,
}: {
  items: ItemWithOverride[]
  loading: boolean
  busyItemId: string | null
  recentlyResolved: Record<string, 'approved' | 'rejected'>
  onAction: (itemId: string, action: 'promote' | 'dismiss') => void
}) {
  if (loading) {
    return (
      <div>
        <SectionHeader label="Pending" count={null} />
        <div className="rounded-lg border border-line bg-l1/30 h-32 animate-pulse" />
      </div>
    )
  }
  if (items.length === 0) return null

  return (
    <div>
      <SectionHeader label="Pending" count={items.length} accent />
      <ul className="space-y-2">
        {items.map(item => (
          <li key={item.itemId}>
            <PendingRow
              item={item}
              busy={busyItemId === item.itemId}
              resolved={recentlyResolved[item.itemId] ?? null}
              onAction={onAction}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function PendingRow({
  item,
  busy,
  resolved,
  onAction,
}: {
  item: ItemWithOverride
  busy: boolean
  resolved: 'approved' | 'rejected' | null
  onAction: (itemId: string, action: 'promote' | 'dismiss') => void
}) {
  const cat = categoryFor(item)
  const accent = ACCENT_CLASSES[cat.accent]
  const [open, setOpen] = useState(false)

  if (resolved) {
    return (
      <div className="rounded-lg border border-line bg-l1/30 px-4 py-3 transition-opacity duration-300 flex items-center gap-3 text-[12.5px]">
        <span className={resolved === 'approved' ? 'text-green' : 'text-tertiary'}>
          {resolved === 'approved' ? 'Approved' : 'Rejected'}
        </span>
        <span className="text-tertiary truncate">{item.title}</span>
      </div>
    )
  }

  // Show the canonical .harness/ path when available — that's the
  // most useful "where will this land if I approve" cue.
  const primaryPath = item.generated && item.generated.length > 0 ? item.generated[0] : null

  return (
    <div className={`rounded-lg border border-line bg-l1/40 hover:border-line2 transition-colors ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <span className={`mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${accent.tint} ${accent.text}`}>
          {cat.icon('w-3.5 h-3.5')}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-[10.5px] text-tertiary">
            <span className={`uppercase tracking-wider font-medium ${accent.text}`}>{cat.label}</span>
            <span>·</span>
            <span>{item.mode}</span>
            <span>·</span>
            <ConfidencePip value={item.confidence} />
          </div>
          <h4 className="mt-1 text-[13.5px] font-medium text-bright leading-snug">{item.title}</h4>
          {primaryPath && (
            <code className="mt-0.5 inline-block font-mono text-[10.5px] text-tertiary truncate max-w-full">{primaryPath}</code>
          )}
          <p className="mt-1.5 text-[12px] text-secondary leading-relaxed">{item.summary}</p>

          <dl className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
            {item.when && (
              <div className="flex items-baseline gap-1.5 min-w-0">
                <dt className="text-tertiary/80 flex-shrink-0">When</dt>
                <dd className="text-secondary truncate">{item.when}</dd>
              </div>
            )}
            {item.impact && (
              <div className="flex items-baseline gap-1.5 min-w-0">
                <dt className="text-tertiary/80 flex-shrink-0">Impact</dt>
                <dd className="text-secondary truncate">{item.impact}</dd>
              </div>
            )}
          </dl>

          {item.evidence.length > 0 && (
            <button
              onClick={() => setOpen(o => !o)}
              className="mt-2.5 inline-flex items-center gap-1 text-[10.5px] text-tertiary hover:text-secondary transition-colors cursor-pointer"
            >
              <svg className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Evidence ({item.evidence.length})
            </button>
          )}
          {open && item.evidence.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-tertiary border-l border-line pl-3">
              {item.evidence.map((e, i) => <li key={i} className="leading-relaxed">{e}</li>)}
            </ul>
          )}
          {open && item.generated && item.generated.length > 1 && (
            <div className="mt-2.5 text-[11px] text-tertiary">
              <span className="text-tertiary/80">Adds: </span>
              {item.generated.map((g, i) => (
                <span key={i}>
                  <code className="font-mono text-secondary bg-l2 px-1 py-[1px] rounded">{g}</code>
                  {i < item.generated.length - 1 && <span className="text-tertiary mx-1">·</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 -mt-0.5">
          <button
            onClick={() => onAction(item.itemId, 'dismiss')}
            disabled={busy}
            className="text-[11.5px] font-medium text-tertiary hover:text-secondary px-2.5 py-1.5 rounded-md hover:bg-l2 transition-colors cursor-pointer disabled:cursor-wait"
          >
            Reject
          </button>
          <button
            onClick={() => onAction(item.itemId, 'promote')}
            disabled={busy}
            className="text-[11.5px] font-medium text-bright bg-accent hover:bg-[#3fbad9] px-3 py-1.5 rounded-md transition-all cursor-pointer disabled:cursor-wait shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfidencePip({ value }: { value: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(value * 5)))
  return (
    <span className="inline-flex items-center gap-[2px]" title={`Agent confidence: ${Math.round(value * 100)}%`}>
      {[0, 1, 2, 3, 4].map(i => (
        <span key={i} className={`h-[3px] w-[3px] rounded-full ${i < filled ? 'bg-secondary' : 'bg-line'}`} />
      ))}
    </span>
  )
}

// ── Live list ─────────────────────────────────────────────────────────

function LiveList({
  items,
  loading,
  activeCat,
}: {
  items: ItemWithOverride[]
  loading: boolean
  activeCat: CategoryId | 'all'
}) {
  if (loading) {
    return (
      <div>
        <SectionHeader label="Live" count={null} />
        <div className="rounded-lg border border-line bg-l1/30 h-32 animate-pulse" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div>
        <SectionHeader label="Live" count={0} />
        <div className="rounded-lg border border-dashed border-line/70 bg-l1/30 px-4 py-6 text-center text-[12.5px] text-tertiary">
          {activeCat === 'all' ? 'No live items yet.' : `No live ${activeCat} yet.`}
        </div>
      </div>
    )
  }

  if (activeCat !== 'all') {
    return (
      <div>
        <SectionHeader label="Live" count={items.length} />
        <ul className="rounded-lg border border-line bg-l1/30 divide-y divide-line/50">
          {items.map(item => <LiveRow key={item.itemId} item={item} />)}
        </ul>
      </div>
    )
  }

  // Unfiltered view — group by category in a single bordered list with
  // subtle category sub-headers.
  const grouped: Record<CategoryId, ItemWithOverride[]> = {
    protocols: [], playbooks: [], sensors: [], learnings: [], references: [],
  }
  for (const it of items) grouped[categoryFor(it).id].push(it)

  return (
    <div>
      <SectionHeader label="Live" count={items.length} />
      <div className="rounded-lg border border-line bg-l1/30 divide-y divide-line/50 overflow-hidden">
        {CATEGORIES.map(cat => {
          const list = grouped[cat.id]
          if (list.length === 0) return null
          const accent = ACCENT_CLASSES[cat.accent]
          return (
            <div key={cat.id}>
              <div className="flex items-center gap-2 px-4 py-2 bg-ink/40 border-b border-line/40">
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded-sm ${accent.tint} ${accent.text}`}>
                  {cat.icon('w-2.5 h-2.5')}
                </span>
                <span className="text-[10.5px] uppercase tracking-wider font-medium text-tertiary">{cat.label}</span>
                <span className="text-[10.5px] text-tertiary tabular-nums">{list.length}</span>
                <span className="text-[10.5px] text-tertiary/70 hidden sm:inline">— {cat.blurb}</span>
              </div>
              <ul className="divide-y divide-line/50">
                {list.map(item => <LiveRow key={item.itemId} item={item} />)}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LiveRow({ item }: { item: ItemWithOverride }) {
  // Primary path is the most useful at-a-glance reference — that's
  // where the live item lives on disk (or where its closest .harness/
  // counterpart is).
  const primaryPath = item.generated && item.generated.length > 0 ? item.generated[0] : null
  const cat = categoryFor(item)
  const accent = ACCENT_CLASSES[cat.accent]

  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-l2/30 transition-colors">
      <span className={`mt-1.5 inline-flex h-1.5 w-1.5 rounded-full flex-shrink-0 ${accent.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12.5px] font-medium text-bright truncate">{item.title}</span>
          {item.mode === 'required' && (
            <span className="text-[9.5px] uppercase tracking-wider text-amber bg-amber/10 ring-1 ring-amber/30 rounded px-1 py-[1px]">required</span>
          )}
          {item.mode === 'automatic' && (
            <span className="text-[9.5px] uppercase tracking-wider text-tertiary bg-l2 ring-1 ring-line rounded px-1 py-[1px]">auto</span>
          )}
        </div>
        {primaryPath && (
          <code className="font-mono text-[10.5px] text-tertiary block truncate mt-0.5">{primaryPath}</code>
        )}
        <p className="text-[11.5px] text-tertiary leading-relaxed mt-1 line-clamp-2">{item.summary}</p>
      </div>
      {item.when && (
        <div className="text-[10.5px] text-tertiary/80 flex-shrink-0 hidden sm:block max-w-[200px] truncate" title={item.when}>
          {item.when}
        </div>
      )}
    </li>
  )
}

// ── Timeline ──────────────────────────────────────────────────────────

function Timeline({ history }: { history: NonNullable<HarnessSnapshot['history']> }) {
  return (
    <div>
      <SectionHeader label="Versions" count={history.length} />
      <div className="rounded-lg border border-line bg-l1/30 divide-y divide-line/50 overflow-hidden">
        {history.slice(0, 6).map(v => (
          <div key={v.versionSeq} className="flex items-baseline gap-3 px-4 py-2.5">
            <span className="font-mono text-tertiary tabular-nums w-10 flex-shrink-0 text-[11px]">{v.version}</span>
            <span className="text-bright text-[12px] truncate flex-1">{v.title}</span>
            {v.note && <span className="text-tertiary text-[10.5px] hidden sm:inline truncate max-w-[200px]" title={v.note}>{v.note}</span>}
            <span className="text-tertiary text-[10.5px] flex-shrink-0 tabular-nums">{relativeTime(v.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────

function SectionHeader({ label, count, accent }: { label: string; count: number | null; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <h3 className={`text-[10.5px] uppercase tracking-wider font-medium ${accent ? 'text-accent' : 'text-tertiary'}`}>{label}</h3>
      {count !== null && (
        <span className="text-[10.5px] text-tertiary tabular-nums">{count}</span>
      )}
      <span className="flex-1 h-px bg-line/50" />
    </div>
  )
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const delta = Date.now() - t
  const m = Math.floor(delta / 60_000)
  const h = Math.floor(delta / 3_600_000)
  const d = Math.floor(delta / 86_400_000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return 'just now'
}
