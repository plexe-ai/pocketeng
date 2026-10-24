'use client'

// SDLC role layer — a cosmetic overlay that tags each coding session with a
// software-development-lifecycle role (Architect / Designer / Engineer / QA /
// Reviewer / DevOps). The story it tells: PocketEngineer isn't one generic
// coding agent, it's a *team* of specialized agents automating the SDLC.
//
// Deliberately client-only for now. Role assignment lives in localStorage
// keyed by sessionId — no backend schema change, nothing to break in a live
// demo. A session's role is either explicitly set by the user or inferred
// from its title via keyword heuristics, so an existing session list lights
// up with roles immediately without any manual tagging.
//
// If this graduates from demo to real feature, the persistence swaps to a
// `role` field on the session record (backend) and `inferRole` becomes the
// fallback for legacy rows — the component API here stays the same.

import { useCallback, useEffect, useRef, useState } from 'react'

export type SDLCRole =
  | 'architect' | 'design' | 'swe' | 'qa' | 'review' | 'devops'
  | 'ba' | 'pm'

/** Canonical SDLC order — drives the pipeline strip left-to-right.
 *  Background roles (BA / PM) are intentionally NOT in here: they don't
 *  occupy a pipeline stage, they run alongside the whole pipeline. */
export const ROLE_ORDER: SDLCRole[] = ['architect', 'design', 'swe', 'qa', 'review', 'devops']

/** Always-on roles that observe the pipeline rather than sit in it.
 *  BA keeps requirements/docs in sync; PM creates & moves tickets. */
export const BACKGROUND_ROLES: SDLCRole[] = ['ba', 'pm']

interface RoleMeta {
  id: SDLCRole
  label: string   // "Architect"
  short: string   // "ARCH" — for compact chips
  color: string   // brand hex; chips tint bg/border off this
  blurb: string   // one-liner for the picker dropdown
  Icon: (props: { className?: string }) => React.ReactNode
}

const stroke = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export const ROLE_META: Record<SDLCRole, RoleMeta> = {
  architect: {
    id: 'architect',
    label: 'Architect',
    short: 'ARCH',
    color: '#8b5cf6', // violet
    blurb: 'System design, data models, technical planning',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><path d="M3 21h18" /><path d="M5 21V7l8-4v18" /><path d="M19 21V11l-6-4" /><path d="M9 9h.01M9 12h.01M9 15h.01" /></svg>
    ),
  },
  design: {
    id: 'design',
    label: 'Designer',
    short: 'DESIGN',
    color: '#ec4899', // pink
    blurb: 'UI/UX, layout, visual & interaction design',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.012 17.5 2 12 2z" /></svg>
    ),
  },
  swe: {
    id: 'swe',
    label: 'Engineer',
    short: 'ENG',
    color: '#22c55e', // green
    blurb: 'Implementation — write & ship the code',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
    ),
  },
  qa: {
    id: 'qa',
    label: 'QA',
    short: 'QA',
    color: '#06b6d4', // cyan
    blurb: 'Testing, verification, regression catching',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><path d="M9 3h6" /><path d="M10 3v5.5L5.2 17a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 8.5V3" /><path d="M7.5 14h9" /></svg>
    ),
  },
  review: {
    id: 'review',
    label: 'Reviewer',
    short: 'REVIEW',
    color: '#f59e0b', // amber
    blurb: 'Code review, PR feedback, quality gate',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v6a3 3 0 0 0 3 3h6" /><path d="M15 6h6" /></svg>
    ),
  },
  devops: {
    id: 'devops',
    label: 'DevOps',
    short: 'DEVOPS',
    color: '#3b82f6', // blue
    blurb: 'CI/CD, infra, deploy & release',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>
    ),
  },
  ba: {
    id: 'ba',
    label: 'Business Analyst',
    short: 'BA',
    color: '#14b8a6', // teal
    blurb: 'Keeps requirements, specs & docs in sync',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h5" /></svg>
    ),
  },
  pm: {
    id: 'pm',
    label: 'Product Manager',
    short: 'PM',
    color: '#6366f1', // indigo
    blurb: 'Creates tickets, tracks delivery & status',
    Icon: ({ className }) => (
      <svg className={className} viewBox="0 0 24 24" {...stroke}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8v8M12 8v5M17 8v3" /></svg>
    ),
  },
}

// ── Persistence (localStorage) ──────────────────────────────────────────

const KEY = (sessionId: string) => `pe-role:${sessionId}`
const CHANGE_EVENT = 'pe-role-change'

function isRole(v: unknown): v is SDLCRole {
  // Background roles are storable too — RoleSelect and the SDLC flows can
  // tag a session 'ba'/'pm'; validating against ROLE_ORDER alone silently
  // dropped those on read.
  return typeof v === 'string' && ([...ROLE_ORDER, ...BACKGROUND_ROLES] as string[]).includes(v)
}

export function getStoredRole(sessionId: string): SDLCRole | null {
  if (typeof window === 'undefined' || !sessionId) return null
  try {
    const v = window.localStorage.getItem(KEY(sessionId))
    return isRole(v) ? v : null
  } catch {
    return null
  }
}

export function setStoredRole(sessionId: string, role: SDLCRole): void {
  if (typeof window === 'undefined' || !sessionId) return
  try {
    window.localStorage.setItem(KEY(sessionId), role)
    // Notify every mounted badge/picker for this session so they re-read
    // without a full refresh. localStorage events don't fire in the same
    // tab, hence the custom event.
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { sessionId, role } }))
  } catch {
    /* ignore quota / privacy-mode failures — cosmetic feature */
  }
}

// ── Inference ───────────────────────────────────────────────────────────

/** Best-effort role guess from a session title/prompt. Order matters:
 *  the most distinctive categories are checked first; Engineer is the
 *  catch-all because most coding tasks are implementation. */
export function inferRole(text: string | undefined | null): SDLCRole {
  const t = (text || '').toLowerCase()
  const has = (...words: string[]) => words.some(w => t.includes(w))

  if (has('architect', 'architecture', 'system design', 'data model', 'schema', 'scaffold', 'design doc', 'rfc', 'diagram', 'tech spec', 'plan the')) return 'architect'
  if (has('deploy', 'ci/cd', 'cicd', ' ci ', 'pipeline', 'docker', 'dockerfile', 'terraform', 'kubernetes', 'k8s', 'helm', 'infra', 'release', 'provision', 'rollout')) return 'devops'
  if (has('test', 'tests', 'qa', 'e2e', 'unit test', 'coverage', 'regression', 'verify', 'failing', 'pytest', 'jest', 'vitest', 'playwright')) return 'qa'
  if (has('review', 'pull request', ' pr ', 'audit', 'security review', 'code review', 'lint')) return 'review'
  if (has('ticket', 'backlog', 'roadmap', 'sprint', 'prioriti', 'user stor', 'jira', 'linear issue', 'milestone')) return 'pm'
  if (has('requirements', 'documentation', 'update docs', 'the docs', 'readme', 'changelog', 'user guide', 'business analy', 'write up', 'spec out')) return 'ba'
  if (has('ui', 'ux', 'css', 'style', 'styling', 'layout', 'design system', 'component', 'frontend', 'responsive', 'theme', 'figma', 'tailwind', 'animation', 'visual')) return 'design'
  return 'swe'
}

// ── Background-agent activity feed ──────────────────────────────────────
// The BA and PM cards on the SDLC page show a rolling feed of what those
// always-on agents have "done" — doc updates, ticket moves. Events are
// pushed by the workflow runner (in sync with stage completions) and by
// real handoffs. Same localStorage + custom-event pattern as roles.

export interface AgentActivity {
  text: string
  at: number // epoch ms
}

const ACT_KEY = (role: SDLCRole) => `pe-bg-activity:${role}`
const ACT_EVENT = 'pe-bg-activity'
const ACT_CAP = 30

export function pushAgentActivity(role: SDLCRole, text: string): void {
  if (typeof window === 'undefined') return
  try {
    const prev: AgentActivity[] = JSON.parse(window.localStorage.getItem(ACT_KEY(role)) ?? '[]')
    const next = [{ text, at: Date.now() }, ...prev].slice(0, ACT_CAP)
    window.localStorage.setItem(ACT_KEY(role), JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(ACT_EVENT, { detail: { role } }))
  } catch { /* cosmetic */ }
}

export function useAgentActivity(role: SDLCRole): AgentActivity[] {
  const [items, setItems] = useState<AgentActivity[]>([])
  useEffect(() => {
    function read() {
      try {
        setItems(JSON.parse(window.localStorage.getItem(ACT_KEY(role)) ?? '[]'))
      } catch {
        setItems([])
      }
    }
    read()
    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail as { role?: SDLCRole } | undefined
      if (!detail || detail.role === role) read()
    }
    window.addEventListener(ACT_EVENT, onChange)
    return () => window.removeEventListener(ACT_EVENT, onChange)
  }, [role])
  return items
}

/** Stored role if the user set one, else inferred from the title. */
export function resolveRole(sessionId: string, title?: string | null): SDLCRole {
  return getStoredRole(sessionId) ?? inferRole(title)
}

/** The stage after `role` in the canonical pipeline, or null at the end. */
export function nextRole(role: SDLCRole): SDLCRole | null {
  const i = ROLE_ORDER.indexOf(role)
  return i >= 0 && i < ROLE_ORDER.length - 1 ? ROLE_ORDER[i + 1] : null
}

/** Role-specific instructions for a REAL handoff session. The receiving
 *  agent gets the upstream session's title + branch so it can pick up the
 *  actual work product (the branch is a real worktree branch on the same
 *  workspace). This is what makes the demo honest: the next-stage agent
 *  genuinely reads the previous stage's output. */
const HANDOFF_INSTRUCTIONS: Record<SDLCRole, string> = {
  architect:
    'You are the ARCHITECT agent. Analyze the request below, explore the repo, and produce a concise technical plan: affected modules, data-model changes, API surface, and risks. Write it to ARCHITECTURE-PLAN.md and commit it on your branch so the next agent can build from it.',
  design:
    'You are the DESIGNER agent. Based on the upstream work, define the UI/UX: component breakdown, states, layout, and styling decisions consistent with the existing design system. Write a DESIGN-SPEC.md and any skeleton components on your branch.',
  swe:
    'You are the ENGINEER agent. Implement the work described below. Check out the upstream branch, read any plan/spec docs committed there, then build the feature end-to-end with tests. Commit as you go.',
  qa:
    'You are the QA agent. Check out the upstream branch, review what changed (git diff against main), run the full test suite, and exercise edge cases the engineer may have missed. Fix small issues directly; report anything structural with specifics.',
  review:
    'You are the REVIEWER agent. Check out the upstream branch and do a rigorous code review: correctness, security, naming, dead code, missed edge cases. Leave your findings as a REVIEW.md with severity labels, and fix the trivial ones directly.',
  devops:
    'You are the DEVOPS agent. The work on the upstream branch has passed review. Prepare it to ship: verify the build passes, check CI config, and open a pull request with a clear summary of the full change set.',
  ba:
    'You are the BUSINESS ANALYST agent. Review the work below and bring the documentation in line with reality: update README / REQUIREMENTS / CHANGELOG to reflect what actually shipped, and flag any requirement that was missed.',
  pm:
    'You are the PRODUCT MANAGER agent. Review the work below and produce delivery tracking: a concise status summary, ticket-shaped breakdowns of any follow-up work, and priorities. Write them to BACKLOG.md.',
}

/** Build the prompt for a real next-stage session. */
export function buildHandoffPrompt(opts: {
  toRole: SDLCRole
  fromRole: SDLCRole
  taskTitle: string
  branch?: string | null
}): string {
  const from = ROLE_META[opts.fromRole]
  const branchLine = opts.branch
    ? `Upstream branch with their work: ${opts.branch} (check it out / diff it first).`
    : 'No upstream branch recorded — start from main.'
  return (
    `[SDLC pipeline handoff — ${from.label} → ${ROLE_META[opts.toRole].label}]\n` +
    `${HANDOFF_INSTRUCTIONS[opts.toRole]}\n\n` +
    `Task: ${opts.taskTitle}\n${branchLine}`
  )
}

/** Reactive role for a session — re-reads on cross-component changes. */
export function useSessionRole(sessionId: string, title?: string | null): [SDLCRole, (r: SDLCRole) => void] {
  const [role, setRole] = useState<SDLCRole>(() => resolveRole(sessionId, title))

  useEffect(() => {
    setRole(resolveRole(sessionId, title))
    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined
      if (!detail || detail.sessionId === sessionId) {
        setRole(resolveRole(sessionId, title))
      }
    }
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [sessionId, title])

  const set = useCallback((r: SDLCRole) => setStoredRole(sessionId, r), [sessionId])
  return [role, set]
}

// ── Presentational components ───────────────────────────────────────────

type BadgeSize = 'xs' | 'sm'

export function RoleBadge({
  role,
  size = 'sm',
  showLabel = true,
  long = false,
  className = '',
}: {
  role: SDLCRole
  size?: BadgeSize
  showLabel?: boolean
  /** Use the full label ("Architect") instead of the short ("ARCH"). */
  long?: boolean
  className?: string
}) {
  const m = ROLE_META[role]
  // Neutral chip — the role's color survives only as a small identity dot.
  // Full-tint chips made any list of sessions read like a rainbow; quiet
  // text + dot keeps the information without the noise.
  const text = size === 'xs' ? 'text-[8.5px] gap-1' : 'text-[9.5px] gap-1.5'
  const dot = size === 'xs' ? 'h-[4px] w-[4px]' : 'h-[5px] w-[5px]'
  return (
    <span
      className={`inline-flex items-center font-semibold uppercase tracking-wide flex-shrink-0 text-tertiary ${text} ${className}`}
      title={`${m.label} — ${m.blurb}`}
    >
      <span className={`rounded-full flex-shrink-0 ${dot}`} style={{ backgroundColor: m.color, opacity: 0.85 }} />
      {showLabel && <span>{long ? m.label : m.short}</span>}
    </span>
  )
}

/** Interactive role badge — click to reassign. Used in the chat header. */
export function RolePicker({
  sessionId,
  title,
  size = 'sm',
}: {
  sessionId: string
  title?: string | null
  size?: BadgeSize
}) {
  const [role, setRole] = useSessionRole(sessionId, title)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center cursor-pointer rounded-full hover:opacity-80 transition-opacity"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change agent role"
      >
        <RoleBadge role={role} size={size} />
        <svg className="w-2.5 h-2.5 ml-0.5 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-60 py-1 rounded-lg border border-line bg-ink shadow-lg shadow-black/20 animate-in fade-in slide-in-from-top-1 duration-100">
          <p className="px-3 py-1 text-[9px] uppercase tracking-wider text-tertiary/60 font-medium">Assign SDLC role</p>
          {[...ROLE_ORDER, ...BACKGROUND_ROLES].map(r => {
            const m = ROLE_META[r]
            const active = r === role
            return (
              <div key={r}>
              {r === BACKGROUND_ROLES[0] && (
                <p className="px-3 pt-1.5 pb-0.5 mt-1 border-t border-line text-[9px] uppercase tracking-wider text-tertiary/60 font-medium">Background</p>
              )}
              <button
                type="button"
                onClick={() => { setRole(r); setOpen(false) }}
                className={`flex items-start gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer ${active ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`}
              >
                <span className="mt-[1px]"><RoleBadge role={r} size="xs" showLabel={false} /></span>
                <span className="min-w-0">
                  <span className="block text-[11.5px] text-bright font-medium">{m.label}</span>
                  <span className="block text-[10px] text-tertiary leading-tight">{m.blurb}</span>
                </span>
                {active && (
                  <svg className="w-3 h-3 ml-auto mt-1 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Controlled role select for the composer — pick which SDLC agent a NEW
 *  task belongs to before it exists. 'auto' defers to title inference.
 *  Styled to sit beside AgentPicker/ModelPicker: quiet text trigger,
 *  dropdown opens upward, neutral palette (role color appears only as a
 *  small identity dot). */
export function RoleSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: SDLCRole | 'auto'
  onChange: (v: SDLCRole | 'auto') => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = value === 'auto' ? null : ROLE_META[value]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(p => !p)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[12px] font-medium text-secondary transition-all duration-150 hover:text-bright cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        title="Which SDLC agent is this task for?"
      >
        {current ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: current.color }} />
            <span>{current.label}</span>
          </>
        ) : (
          <>
            <svg className="w-3 h-3 text-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.2 3.6-5 7-5s6.2 1.8 7 5" /></svg>
            <span>Role: Auto</span>
          </>
        )}
        <svg className={`w-2.5 h-2.5 text-tertiary transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-60 rounded-xl border border-line bg-ink shadow-lg shadow-black/20 overflow-hidden animate-scale-in z-50">
          <div className="py-1.5 max-h-72 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            <button
              onClick={() => { onChange('auto'); setOpen(false) }}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors cursor-pointer ${value === 'auto' ? '' : 'hover:bg-[var(--hover-bg)]'}`}
            >
              <span className="w-4 flex justify-center"><span className="h-1.5 w-1.5 rounded-full bg-tertiary/50" /></span>
              <div className="flex-1 min-w-0">
                <p className={`text-[12.5px] font-medium ${value === 'auto' ? 'text-bright' : 'text-secondary'}`}>Auto</p>
                <p className="text-[10px] text-tertiary">Infer the role from the task description</p>
              </div>
              {value === 'auto' && (
                <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
              )}
            </button>
            {[...ROLE_ORDER, ...BACKGROUND_ROLES].map(r => {
              const m = ROLE_META[r]
              const isSelected = value === r
              return (
                <div key={r}>
                  {r === BACKGROUND_ROLES[0] && (
                    <p className="px-4 pt-1.5 pb-0.5 mt-1 border-t border-line text-[9px] uppercase tracking-wider text-tertiary/60 font-medium">Background</p>
                  )}
                  <button
                    onClick={() => { onChange(r); setOpen(false) }}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors cursor-pointer ${isSelected ? '' : 'hover:bg-[var(--hover-bg)]'}`}
                  >
                    <span className="w-4 flex justify-center" style={{ color: m.color }}><m.Icon className="w-3.5 h-3.5" /></span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12.5px] font-medium ${isSelected ? 'text-bright' : 'text-secondary'}`}>{m.label}</p>
                      <p className="text-[10px] text-tertiary truncate">{m.blurb}</p>
                    </div>
                    {isSelected && (
                      <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Horizontal SDLC pipeline strip — the demo centerpiece. Shows the six
 *  roles as a left-to-right flow with a count of sessions currently in each
 *  stage. Reads as "this is an automated software-development lifecycle." */
export function RolePipeline({ counts }: { counts: Partial<Record<SDLCRole, number>> }) {
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto px-1 py-1.5" style={{ scrollbarWidth: 'none' }}>
      {ROLE_ORDER.map((r, i) => {
        const m = ROLE_META[r]
        const n = counts[r] ?? 0
        const dim = n === 0
        return (
          <div key={r} className="flex items-center gap-0.5 flex-shrink-0">
            <div
              className="flex items-center gap-1 rounded-md px-1.5 py-1 transition-opacity"
              style={{
                color: m.color,
                backgroundColor: `${m.color}14`,
                opacity: dim ? 0.4 : 1,
              }}
              title={`${m.label} — ${n} session${n === 1 ? '' : 's'}`}
            >
              <m.Icon className="w-3 h-3" />
              <span className="text-[9px] font-semibold uppercase tracking-wide">{m.short}</span>
              {n > 0 && (
                <span className="text-[9px] font-bold tabular-nums rounded-full px-1" style={{ backgroundColor: `${m.color}26` }}>{n}</span>
              )}
            </div>
            {i < ROLE_ORDER.length - 1 && (
              <svg className="w-2.5 h-2.5 text-tertiary/40 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
              </svg>
            )}
          </div>
        )
      })}
    </div>
  )
}
