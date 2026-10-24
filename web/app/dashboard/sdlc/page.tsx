'use client'

// SDLC Command Center — the demo centerpiece.
//
//   1. Pipeline hero — six-stage agent team with live counts; active
//      stages glow, handoffs flow along the connectors.
//   2. Metrics strip — features shipped / median cycle time / handoffs /
//      artifacts, animated count-ups fed by the persisted run history.
//   3. Workflow runner — type a feature (or stack up to three at once)
//      and watch each one stream through every stage with role telemetry,
//      live code-diff + test-run theater, artifacts, and confetti on ship.
//      Scripted SIMULATION: deterministic, demo-safe, free.
//   4. Real Autopilot — the honest counterpart: starts an actual Architect
//      session on a running workspace, polls it, and auto-hands-off to the
//      next role agent when each stage's session completes. Chain tracker
//      with deep links to every live session.
//   5. BA + PM background agents — always-on cards whose activity feeds
//      react to both simulated runs and real handoffs.
//   6. Agent board — real sessions by role column with REAL handoff
//      buttons (next-role session primed with the upstream branch).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  getSessions,
  listServers,
  startChatSession,
  type ChatSessionRecord,
  type Server,
} from '@/lib/api'
import { getRestoredSession } from '@/lib/supabase'
import { getAgentLogo } from '@/lib/agents'
import { toTaskView, STATUS_META, type TaskView } from '@/lib/tasks'
import {
  BACKGROUND_ROLES,
  ROLE_META,
  ROLE_ORDER,
  buildHandoffPrompt,
  nextRole,
  pushAgentActivity,
  resolveRole,
  setStoredRole,
  useAgentActivity,
  type SDLCRole,
} from '@/components/sdlc'

/* ════════════════════════════════════════════════════════════════════
   Simulation script
   ════════════════════════════════════════════════════════════════════ */

const SIM_SCRIPT: Record<SDLCRole, { lines: string[]; artifact: string }> = {
  architect: {
    lines: [
      'Reading repo structure & existing modules…',
      'Analyzing requirements for "{f}"',
      'Drafting data model — 2 new entities, 1 migration',
      'Defining API surface: 3 endpoints, request/response schemas',
      'Committed ARCHITECTURE-PLAN.md · risks: 2 flagged',
    ],
    artifact: 'ARCHITECTURE-PLAN.md',
  },
  design: {
    lines: [
      'Reading architecture plan from upstream branch…',
      'Mapping user flows — 3 screens affected',
      'Component breakdown: 4 new, 2 modified, tokens reused',
      'States: loading / empty / error / success specified',
      'Committed DESIGN-SPEC.md + skeleton components',
    ],
    artifact: 'DESIGN-SPEC.md',
  },
  swe: {
    lines: [
      'Checked out upstream branch · read plan + spec',
      'Implementing backend: endpoints + validation…',
      'Implementing frontend: components wired to API…',
      'Self-check: build ✓ · typecheck ✓ · 18 unit tests added',
      'Pushed 14 files changed (+812 −96)',
    ],
    artifact: '14 files · +812 −96',
  },
  qa: {
    lines: [
      'Diffing branch against main · building test matrix',
      'Running suite: 214 tests… 212 passed, 2 failed',
      'Reproducing failures — both edge cases in date handling',
      'Patched + re-ran: 216/216 passing ✓',
      'Committed TEST-REPORT.md',
    ],
    artifact: '216/216 tests ✓',
  },
  review: {
    lines: [
      'Reviewing full diff — correctness, security, style',
      'Flagged: 1 unguarded null path, 2 naming nits',
      'Fixed trivial findings directly · re-verified build',
      'REVIEW.md: APPROVED with notes',
    ],
    artifact: 'Approved ✓',
  },
  devops: {
    lines: [
      'Verifying CI config + build reproducibility…',
      'Opening pull request with full change summary',
      'PR created · checks green · ready to merge',
    ],
    artifact: 'PR · checks ✓',
  },
  // Background roles never occupy a pipeline stage — type-completing stubs.
  ba: { lines: [], artifact: '' },
  pm: { lines: [], artifact: '' },
}

const PRESETS = [
  'Add team usage analytics to the dashboard',
  'Build a similarity-search endpoint for the recsys pipeline',
  'Dark mode across the whole web app',
]

/* Background-agent events fired as each pipeline stage completes. */
const BG_EVENTS: Record<SDLCRole, { ba: string; pm: string } | undefined> = {
  architect: {
    pm: 'Created {t} · "{f}" · added to current sprint',
    ba: 'REQUIREMENTS.md updated from architecture plan',
  },
  design: {
    pm: '{t}: design subtask done · estimate confirmed (3 pts)',
    ba: 'PRODUCT-SPEC.md: user flows + UI states documented',
  },
  swe: {
    pm: '{t} → In Review · linked branch (+812 −96)',
    ba: 'API.md regenerated — 3 new endpoints documented',
  },
  qa: {
    pm: '{t}: QA sign-off recorded (216/216 passing)',
    ba: 'TEST-PLAN.md updated with 2 new edge cases',
  },
  review: {
    pm: '{t} → Approved · reviewer notes attached',
    ba: 'ADR-014 logged — review decisions captured',
  },
  devops: {
    pm: '{t} → Done · release notes drafted',
    ba: 'CHANGELOG.md + README updated for release',
  },
  ba: undefined,
  pm: undefined,
}

/* ════════════════════════════════════════════════════════════════════
   Multi-run simulation engine
   A single 250ms interval advances every active run. Each run keeps a
   `dueAt` timestamp; when the clock passes it, the run takes its next
   step (log line → artifact + background events → handoff → next stage
   → done). Deterministic per run, supports up to MAX_RUNS in parallel.
   ════════════════════════════════════════════════════════════════════ */

const MAX_RUNS = 3
const LINE_MS = 950
const HANDOFF_MS = 750
const STAGE_PAUSE_MS = 420

interface SimRun {
  id: string
  feature: string
  ticket: string
  /** 'awaiting' = paused at the production gate for human sign-off. */
  status: 'running' | 'awaiting' | 'done'
  stageIdx: number
  lineIdx: number
  handingOff: boolean
  log: { role: SDLCRole; text: string }[]
  artifacts: { role: SDLCRole; label: string }[]
  startedAt: number
  finishedAt: number | null
  dueAt: number
}

interface ShippedRun {
  feature: string
  ticket: string
  durationS: number
  artifacts: number
  finishedAt: number
}

const HISTORY_KEY = 'pe-sdlc-history'
const REAL_HANDOFF_COUNT_KEY = 'pe-sdlc-real-handoffs'
const AUDIT_KEY = 'pe-sdlc-audit'
const GATE_KEY = 'pe-sdlc-gate'

/** Governance ledger entry — one row per pipeline transition/decision. */
interface AuditEntry {
  t: number
  ticket: string
  actor: string   // which agent (or human) performed it
  event: string
  ref: string     // branch / sha-ish traceability handle
}

function readAudit(): AuditEntry[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(window.localStorage.getItem(AUDIT_KEY) ?? '[]') } catch { return [] }
}
function writeAudit(items: AuditEntry[]) {
  try { window.localStorage.setItem(AUDIT_KEY, JSON.stringify(items.slice(0, 60))) } catch { /* cosmetic */ }
}
/** Deterministic short pseudo-sha for traceability refs. */
function shaOf(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(7, '0').slice(0, 7)
}
function readGate(): boolean {
  if (typeof window === 'undefined') return true
  try { return window.localStorage.getItem(GATE_KEY) !== 'off' } catch { return true }
}

function readHistory(): ShippedRun[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}
function writeHistory(items: ShippedRun[]) {
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20))) } catch { /* cosmetic */ }
}
function bumpRealHandoffs(): void {
  try {
    const n = Number(window.localStorage.getItem(REAL_HANDOFF_COUNT_KEY) ?? '0')
    window.localStorage.setItem(REAL_HANDOFF_COUNT_KEY, String(n + 1))
  } catch { /* cosmetic */ }
}

/* ── Confetti — tiny dependency-free burst on "Feature shipped" ────── */

function fireConfetti(colors: string[]) {
  if (typeof document === 'undefined') return
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999'
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) { canvas.remove(); return }
  const cx = canvas.width / 2
  const cy = canvas.height * 0.35
  const parts = Array.from({ length: 90 }, (_, i) => ({
    x: cx, y: cy,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 11 - 3,
    s: Math.random() * 5 + 3,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[i % colors.length],
  }))
  const t0 = performance.now()
  function frame(t: number) {
    const dt = (t - t0) / 1000
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.r += p.vr
      ctx.save()
      ctx.globalAlpha = Math.max(0, 1.3 - dt)
      ctx.translate(p.x, p.y); ctx.rotate(p.r)
      ctx.fillStyle = p.c
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6)
      ctx.restore()
    }
    if (dt < 1.4) requestAnimationFrame(frame)
    else canvas.remove()
  }
  requestAnimationFrame(frame)
}


/* ════════════════════════════════════════════════════════════════════
   Real Autopilot chain — actual sessions, auto-handoff on completion
   ════════════════════════════════════════════════════════════════════ */

interface RealChain {
  feature: string
  serverId: string
  serverLabel: string
  agent: string
  status: 'running' | 'done' | 'error'
  error?: string
  /** One entry per pipeline stage reached so far. */
  stages: { role: SDLCRole; sessionId: string; status: 'running' | 'done' | 'error' }[]
  startedAt: number
}

const CHAIN_KEY = 'pe-sdlc-real-chain'

function readChain(): RealChain | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CHAIN_KEY)
    return raw ? JSON.parse(raw) as RealChain : null
  } catch { return null }
}
function writeChain(chain: RealChain | null) {
  try {
    if (chain) window.localStorage.setItem(CHAIN_KEY, JSON.stringify(chain))
    else window.localStorage.removeItem(CHAIN_KEY)
  } catch { /* cosmetic */ }
}

/* ════════════════════════════════════════════════════════════════════ */

export default function SDLCPage() {
  const router = useRouter()

  /* ── Real data: servers + sessions across all workspaces ── */
  const [servers, setServers] = useState<Server[]>([])
  const [sessions, setSessions] = useState<(ChatSessionRecord & { _serverId: string })[]>([])
  const [loaded, setLoaded] = useState(false)
  const [toast, setToast] = useState<{ text: string; sessionId?: string; serverId?: string } | null>(null)
  const [, setRoleVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const auth = await getRestoredSession()
      if (cancelled) return
      if (!auth) { router.replace('/'); return }
      try {
        const { servers } = await listServers()
        if (cancelled) return
        const active = servers.filter(s => s.instanceState !== 'terminated')
        setServers(active)
        const all = await Promise.all(
          active.map(s =>
            getSessions(s.serverId, 50)
              .then(r => r.sessions.map(x => ({ ...x, _serverId: s.serverId })))
              .catch(() => []),
          ),
        )
        if (!cancelled) setSessions(all.flat())
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [router])

  useEffect(() => {
    function onChange() { setRoleVersion(v => v + 1) }
    window.addEventListener('pe-role-change', onChange)
    return () => window.removeEventListener('pe-role-change', onChange)
  }, [])

  const tasks: TaskView[] = useMemo(() => sessions.map(toTaskView), [sessions])
  const byRole = useMemo(() => {
    const all = [...ROLE_ORDER, ...BACKGROUND_ROLES]
    const map = new Map<SDLCRole, TaskView[]>()
    for (const r of all) map.set(r, [])
    for (const t of tasks) map.get(resolveRole(t.id, t.title))!.push(t)
    for (const r of all) {
      map.get(r)!.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    }
    return map
  }, [tasks])

  const runningServers = useMemo(
    () => servers.filter(s => s.instanceState === 'running'),
    [servers],
  )
  const serverById = useMemo(() => new Map(servers.map(s => [s.serverId, s])), [servers])

  /* ── Simulation engine (multi-run) ── */
  const [runs, setRuns] = useState<SimRun[]>([])
  const runsRef = useRef<SimRun[]>([])
  runsRef.current = runs
  const [speed, setSpeed] = useState<1 | 2>(1)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const [history, setHistory] = useState<ShippedRun[]>([])
  const [clock, setClock] = useState(0) // re-render tick for elapsed timers

  // Governance: the audit ledger + the production-approval gate.
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [gateOn, setGateOn] = useState(true)
  const gateRef = useRef(true)
  useEffect(() => { const g = readGate(); setGateOn(g); gateRef.current = g }, [])
  const toggleGate = useCallback(() => {
    setGateOn(prev => {
      const next = !prev
      gateRef.current = next
      try { window.localStorage.setItem(GATE_KEY, next ? 'on' : 'off') } catch { /* cosmetic */ }
      return next
    })
  }, [])
  const pushAudit = useCallback((ticket: string, actor: string, event: string, ref: string) => {
    setAudit(prev => {
      const items = [{ t: Date.now(), ticket, actor, event, ref }, ...prev].slice(0, 60)
      writeAudit(items)
      return items
    })
  }, [])

  useEffect(() => { setHistory(readHistory()); setAudit(readAudit()) }, [])

  const startRun = useCallback((feature: string) => {
    const f = feature.trim() || PRESETS[0]
    // Awaiting runs still occupy a pipeline slot — a paused deploy is in flight.
    const active = runsRef.current.filter(r => r.status !== 'done')
    if (active.length >= MAX_RUNS) {
      setToast({ text: `Pipeline at capacity — ${MAX_RUNS} features in flight.` })
      return
    }
    const now = Date.now()
    const run: SimRun = {
      id: `run-${now}-${Math.floor(Math.random() * 1e4)}`,
      feature: f,
      ticket: `PE-${2800 + (now % 180)}`,
      status: 'running',
      stageIdx: 0,
      lineIdx: 0,
      handingOff: false,
      log: [],
      artifacts: [],
      startedAt: now,
      finishedAt: null,
      dueAt: now + 350,
    }
    setRuns(prev => [...prev, run])
    pushAudit(run.ticket, 'Architect', 'Pipeline started — 6-stage delivery plan created', `pe-${shaOf(run.id)}`)
  }, [pushAudit])

  // The single scheduler. Side effects (background-agent events, confetti,
  // history persistence) fire HERE — outside any React updater — exactly
  // once per transition, because the transition consumes the run's dueAt.
  useEffect(() => {
    const anyRunning = runs.some(r => r.status === 'running')
    if (!anyRunning) return
    const iv = setInterval(() => {
      const now = Date.now()
      setClock(c => c + 1)
      const cur = runsRef.current
      let changed = false
      const next = cur.map(run => {
        if (run.status !== 'running' || now < run.dueAt) return run
        changed = true
        const sp = speedRef.current
        const role = ROLE_ORDER[run.stageIdx]
        const script = SIM_SCRIPT[role]

        if (run.handingOff) {
          return { ...run, handingOff: false, stageIdx: run.stageIdx + 1, lineIdx: 0, dueAt: now + LINE_MS / sp }
        }
        if (run.lineIdx < script.lines.length) {
          const text = script.lines[run.lineIdx].replace('{f}', run.feature)
          return { ...run, log: [...run.log, { role, text }], lineIdx: run.lineIdx + 1, dueAt: now + LINE_MS / sp }
        }
        // Stage complete → artifact + background-agent events.
        const bg = BG_EVENTS[role]
        if (bg) {
          pushAgentActivity('pm', bg.pm.replace('{t}', run.ticket).replace('{f}', run.feature))
          pushAgentActivity('ba', bg.ba.replace('{t}', run.ticket).replace('{f}', run.feature))
        }
        const artifacts = [...run.artifacts, { role, label: SIM_SCRIPT[role].artifact }]
        if (run.stageIdx >= ROLE_ORDER.length - 1) {
          // Shipped.
          pushAudit(run.ticket, 'DevOps', 'Feature shipped — all policy gates green', `sha ${shaOf(run.id + 'ship')}`)
          fireConfetti(ROLE_ORDER.map(r => ROLE_META[r].color))
          const shipped: ShippedRun = {
            feature: run.feature,
            ticket: run.ticket,
            durationS: Math.round((now - run.startedAt) / 1000),
            artifacts: artifacts.length,
            finishedAt: now,
          }
          setHistory(prev => {
            const items = [shipped, ...prev]
            writeHistory(items)
            return items
          })
          return { ...run, artifacts, status: 'done' as const, finishedAt: now, dueAt: Number.MAX_SAFE_INTEGER }
        }
        // Every completed stage lands in the governance ledger with a
        // traceability ref — the compliance story is generated, not typed.
        const nextRole = ROLE_ORDER[run.stageIdx + 1]
        pushAudit(run.ticket, ROLE_META[role].label, `${SIM_SCRIPT[role].artifact} → handed to ${ROLE_META[nextRole].label}`, `sha ${shaOf(run.id + role)}`)
        // Production gate: pause for human sign-off before the DevOps stage.
        if (nextRole === 'devops' && gateRef.current) {
          pushAgentActivity('pm', `${run.ticket}: production approval requested — pipeline holding`)
          pushAudit(run.ticket, 'Policy gate', 'HOLD — production deploy requires human approval', 'gate:prod-deploy')
          return { ...run, artifacts, status: 'awaiting' as const, dueAt: Number.MAX_SAFE_INTEGER }
        }
        return { ...run, artifacts, handingOff: true, dueAt: now + Math.max(HANDOFF_MS, STAGE_PAUSE_MS) / sp }
      })
      if (changed) setRuns(next)
    }, 250)
    return () => clearInterval(iv)
  }, [runs])

  const resetRun = useCallback((id: string) => {
    setRuns(prev => prev.filter(r => r.id !== id))
  }, [])

  /** Human sign-off at the production gate → DevOps proceeds. */
  const approveRun = useCallback((id: string) => {
    const run = runsRef.current.find(r => r.id === id)
    if (run) {
      pushAudit(run.ticket, 'You', 'Production deploy APPROVED — human sign-off recorded', 'gate:prod-deploy')
      pushAgentActivity('pm', `${run.ticket}: deploy approved — DevOps proceeding`)
    }
    setRuns(prev => prev.map(r => r.id === id
      ? { ...r, status: 'running' as const, handingOff: true, dueAt: Date.now() + 250 }
      : r))
  }, [pushAudit])

  /** Rejection at the gate → work returns to the Engineer stage. */
  const sendBackRun = useCallback((id: string) => {
    const run = runsRef.current.find(r => r.id === id)
    if (run) {
      pushAudit(run.ticket, 'You', 'Deploy REJECTED — returned to Engineer for changes', 'gate:prod-deploy')
      pushAgentActivity('pm', `${run.ticket}: changes requested at gate — back to In Progress`)
    }
    setRuns(prev => prev.map(r => r.id === id
      ? {
          ...r,
          status: 'running' as const,
          stageIdx: ROLE_ORDER.indexOf('swe'),
          lineIdx: 0,
          handingOff: false,
          log: [...r.log, { role: 'devops' as SDLCRole, text: '⟲ Gate rejected — handing back to Engineer for changes' }],
          dueAt: Date.now() + 350,
        }
      : r))
  }, [pushAudit])

  /* ── Real Autopilot chain ── */
  const [chain, setChain] = useState<RealChain | null>(null)
  useEffect(() => { setChain(readChain()) }, [])

  const startRealChain = useCallback(async (feature: string) => {
    const target = runningServers[0]
    if (!target) {
      setToast({ text: 'Start a workspace first — the real pipeline needs compute.' })
      return
    }
    const f = feature.trim() || PRESETS[0]
    try {
      const prompt = buildHandoffPrompt({ toRole: 'architect', fromRole: 'architect', taskTitle: f, branch: null })
      const agent = target.agents?.[0] ?? 'claude'
      const created = await startChatSession(target.serverId, prompt, agent)
      setStoredRole(created.sessionId, 'architect')
      const next: RealChain = {
        feature: f,
        serverId: target.serverId,
        serverLabel: target.label || target.serverId.slice(0, 8),
        agent,
        status: 'running',
        stages: [{ role: 'architect', sessionId: created.sessionId, status: 'running' }],
        startedAt: Date.now(),
      }
      setChain(next); writeChain(next)
      pushAgentActivity('pm', `Real pipeline started: "${f}" · Architect agent live`)
      setToast({ text: 'Real Autopilot started — Architect agent is live', sessionId: created.sessionId, serverId: target.serverId })
    } catch (err) {
      setToast({ text: `Could not start real pipeline: ${(err as Error).message}` })
    }
  }, [runningServers])

  const stopRealChain = useCallback(() => {
    setChain(prev => {
      if (!prev) return prev
      const stopped = { ...prev, status: 'done' as const }
      writeChain(null)
      return stopped
    })
    setTimeout(() => setChain(readChain()), 50)
    setChain(null)
    writeChain(null)
  }, [])

  // Poll the chain's current session; when it completes, hand off for real.
  useEffect(() => {
    if (!chain || chain.status !== 'running') return
    const iv = setInterval(() => {
      void (async () => {
        const current = chain.stages[chain.stages.length - 1]
        if (!current || current.status !== 'running') return
        try {
          const { sessions } = await getSessions(chain.serverId, 50)
          const rec = sessions.find(s => s.sessionId === current.sessionId)
          if (!rec) return
          if (rec.status === 'error' || rec.status === 'cancelled') {
            const next: RealChain = {
              ...chain,
              status: 'error',
              error: `${ROLE_META[current.role].label} stage ${rec.status}`,
              stages: chain.stages.map((s, i) => i === chain.stages.length - 1 ? { ...s, status: 'error' as const } : s),
            }
            setChain(next); writeChain(next)
            return
          }
          if (rec.status !== 'done') return

          // Stage finished — mark and advance.
          const to = nextRole(current.role)
          pushAgentActivity('pm', `Real pipeline: ${ROLE_META[current.role].label} stage complete${to ? ` → handing to ${ROLE_META[to].label}` : ''}`)
          if (!to) {
            const next: RealChain = {
              ...chain,
              status: 'done',
              stages: chain.stages.map((s, i) => i === chain.stages.length - 1 ? { ...s, status: 'done' as const } : s),
            }
            setChain(next); writeChain(next)
            fireConfetti(ROLE_ORDER.map(r => ROLE_META[r].color))
            setToast({ text: '✦ Real pipeline complete — all six agents finished.' })
            return
          }
          const prompt = buildHandoffPrompt({
            toRole: to,
            fromRole: current.role,
            taskTitle: chain.feature,
            branch: rec.branchName,
          })
          const created = await startChatSession(chain.serverId, prompt, chain.agent)
          setStoredRole(created.sessionId, to)
          try { window.localStorage.setItem(`pe-handoff:${created.sessionId}`, current.role) } catch { /* cosmetic */ }
          bumpRealHandoffs()
          const next: RealChain = {
            ...chain,
            stages: [
              ...chain.stages.map((s, i) => i === chain.stages.length - 1 ? { ...s, status: 'done' as const } : s),
              { role: to, sessionId: created.sessionId, status: 'running' as const },
            ],
          }
          setChain(next); writeChain(next)
          setToast({ text: `Auto-handoff: ${ROLE_META[current.role].label} → ${ROLE_META[to].label}`, sessionId: created.sessionId, serverId: chain.serverId })
        } catch {
          /* transient poll failure — retry next tick */
        }
      })()
    }, 12_000)
    return () => clearInterval(iv)
  }, [chain])

  /* ── Real single handoff from the board ── */
  const handoff = useCallback(async (task: TaskView, from: SDLCRole, to: SDLCRole) => {
    const server = serverById.get(task.session.serverId)
    if (!server || server.instanceState !== 'running') {
      setToast({ text: 'Workspace must be running to hand off.' })
      return
    }
    try {
      const prompt = buildHandoffPrompt({ toRole: to, fromRole: from, taskTitle: task.title, branch: task.branch })
      const created = await startChatSession(server.serverId, prompt, task.agent || 'claude')
      setStoredRole(created.sessionId, to)
      try { window.localStorage.setItem(`pe-handoff:${created.sessionId}`, from) } catch { /* cosmetic */ }
      bumpRealHandoffs()
      const now = new Date().toISOString()
      setSessions(prev => [{
        ...task.session,
        sessionId: created.sessionId,
        prompt,
        title: `${ROLE_META[to].label}: ${task.title}`,
        status: 'running',
        prUrl: undefined,
        createdAt: now,
        updatedAt: now,
        _serverId: server.serverId,
      } as ChatSessionRecord & { _serverId: string }, ...prev])
      setToast({
        text: `${ROLE_META[from].label} → ${ROLE_META[to].label}: agent started`,
        sessionId: created.sessionId,
        serverId: server.serverId,
      })
      pushAgentActivity('pm', `Ticket updated: "${task.title}" → ${ROLE_META[to].label}`)
      pushAgentActivity('ba', `Delivery log: ${ROLE_META[from].label} → ${ROLE_META[to].label} handoff recorded`)
    } catch (err) {
      setToast({ text: `Handoff failed: ${(err as Error).message}` })
    }
  }, [serverById])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── Hero derivations across all active runs ── */
  const activeStageSet = useMemo(() => {
    const s = new Set<number>()
    for (const r of runs) if (r.status === 'running' && !r.handingOff) s.add(r.stageIdx)
    return s
  }, [runs])
  const hotConnectorSet = useMemo(() => {
    const s = new Set<number>()
    for (const r of runs) if (r.status === 'running' && r.handingOff) s.add(r.stageIdx)
    return s
  }, [runs])
  const featuresInFlight = runs.filter(r => r.status !== 'done').length

  void clock // elapsed timers re-render on the scheduler tick

  return (
    <div className="px-5 md:px-8 py-4 md:py-8 max-w-5xl animate-fade-in">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[18px] font-semibold text-bright tracking-tight">SDLC Autopilot</h1>
          <p className="text-[12.5px] text-tertiary mt-1">
            A team of specialized AI agents running your software lifecycle — each stage hands its work to the next.
          </p>
        </div>
      </div>

      {/* ── 1. Mission control — dark hero panel: pipeline + org metrics ── */}
      <MissionControl
        counts={Object.fromEntries(ROLE_ORDER.map(r => [r, byRole.get(r)?.length ?? 0]))}
        activeStages={activeStageSet}
        hotConnectors={hotConnectorSet}
        live={featuresInFlight > 0 || chain?.status === 'running'}
        statusText={chain?.status === 'running'
          ? 'Real pipeline running'
          : featuresInFlight > 0
            ? `${featuresInFlight} feature${featuresInFlight === 1 ? '' : 's'} in flight`
            : '8 agents standing by'}
      />

      {/* ── 3. Workflow runner ── */}
      <div className="card-surface mt-4 p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest">Automate a feature</p>
          <div className="flex items-center gap-2">
            {runs.length > 0 && (
              <>
                <button onClick={() => setSpeed(s => (s === 1 ? 2 : 1))} className="text-[10.5px] text-tertiary hover:text-secondary border border-line rounded-md px-1.5 py-0.5 cursor-pointer">{speed}×</button>
                <button onClick={() => setRuns([])} className="text-[10.5px] text-tertiary hover:text-secondary cursor-pointer">Clear all</button>
              </>
            )}
            <button
              onClick={toggleGate}
              title="When on, every run pauses before the DevOps stage until a human approves the production deploy"
              className="flex items-center gap-1.5 text-[10.5px] font-medium border rounded-md px-2 py-0.5 cursor-pointer transition-all text-tertiary hover:text-secondary"
              style={gateOn ? { borderColor: '#f59e0b66', color: '#b45309' } : { borderColor: 'var(--color-line)' }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: gateOn ? '#f59e0b' : 'var(--color-line2)' }} />
              Deploy gate {gateOn ? 'on' : 'off'}
            </button>
          </div>
        </div>
        <RunComposer
          onRun={startRun}
          onRunReal={f => void startRealChain(f)}
          canRunReal={runningServers.length > 0 && chain?.status !== 'running'}
          atCapacity={featuresInFlight >= MAX_RUNS}
        />
        {runs.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {runs.map(run => (
              <RunCard key={run.id} run={run} onReset={() => resetRun(run.id)} onRunReal={() => void startRealChain(run.feature)} canRunReal={runningServers.length > 0 && chain?.status !== 'running'} onApprove={() => approveRun(run.id)} onSendBack={() => sendBackRun(run.id)} />
            ))}
          </div>
        )}
        {history.length > 0 && <ShippedShelf history={history} />}
      </div>

      {/* ── 3.5 Real Autopilot chain tracker ── */}
      {chain && (
        <RealChainTracker
          chain={chain}
          onOpen={(serverId, sessionId) => router.push(`/dashboard/${serverId}?session=${sessionId}`)}
          onStop={stopRealChain}
        />
      )}

      {/* ── 3.7 Governance & audit ── */}
      <GovernancePanel
        audit={audit}
        gateOn={gateOn}
        onClear={() => { setAudit([]); writeAudit([]) }}
      />

      {/* ── 4. Background agents ── */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {BACKGROUND_ROLES.map(r => (
          <BackgroundAgentCard
            key={r}
            role={r}
            tasks={byRole.get(r) ?? []}
            onOpen={t => router.push(`/dashboard/${t.session.serverId}?session=${t.id}`)}
          />
        ))}
      </div>

      {/* ── 5. Board ── */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest">Agent board — live sessions</p>
          {loaded && <span className="text-[10.5px] text-tertiary">{tasks.length} sessions · {runningServers.length} workspace{runningServers.length === 1 ? '' : 's'} running</span>}
        </div>
        {!loaded ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="skeleton h-32 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-5 gap-y-7">
            {ROLE_ORDER.map(role => (
              <RoleColumn
                key={role}
                role={role}
                tasks={byRole.get(role) ?? []}
                serverById={serverById}
                onOpen={t => router.push(`/dashboard/${t.session.serverId}?session=${t.id}`)}
                onHandoff={handoff}
              />
            ))}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-line bg-ink shadow-lg shadow-black/30 px-4 py-2.5 animate-fade-in-up">
          <span className="text-[12px] text-bright">{toast.text}</span>
          {toast.sessionId && toast.serverId && (
            <button
              onClick={() => router.push(`/dashboard/${toast.serverId}?session=${toast.sessionId}`)}
              className="text-[12px] text-accent font-medium cursor-pointer hover:underline whitespace-nowrap"
            >
              Open session →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Pipeline hero
   ════════════════════════════════════════════════════════════════════ */

function MissionControl({
  counts, activeStages, hotConnectors, live, statusText,
}: {
  counts: Record<string, number>
  activeStages: Set<number>
  hotConnectors: Set<number>
  live: boolean
  statusText: string
}) {
  // The one intentionally DARK surface on the page — command centers are
  // dark. Fixed colors (not theme tokens) so it reads identically in light
  // and dark mode: in light it's the focal panel, in dark it's the deepest
  // layer. Everything inside uses hand-picked grays against #0c-#11 ink.
  return (
    <div
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #0c0e16 0%, #11141f 100%)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 24px 64px -28px rgba(8,10,20,0.55), inset 0 1px 0 rgba(255,255,255,0.06)',
      }}
    >
      {/* Hairline top light — the jewel edge */}
      <div aria-hidden className="absolute top-0 inset-x-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.22), transparent)' }} />
      {/* Engineering grid, masked toward the edges */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse 75% 100% at 50% 40%, black 25%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 75% 100% at 50% 40%, black 25%, transparent 80%)',
        }}
      />

      <div className="relative px-6 pt-5 pb-5">
        {/* Panel header: overline + live status */}
        <div className="flex items-center justify-between mb-5">
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: '#5d6575' }}>
            Pipeline — live
          </span>
          <span className="flex items-center gap-1.5 text-[10.5px]" style={{ color: '#9aa3b2' }}>
            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-green animate-pulse' : ''}`} style={live ? undefined : { backgroundColor: 'rgba(255,255,255,0.25)' }} />
            {statusText}
          </span>
        </div>

        {/* Stage nodes */}
        <div className="overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <div className="flex items-start min-w-[780px]">
            {ROLE_ORDER.map((r, i) => {
              const m = ROLE_META[r]
              const isActive = activeStages.has(i)
              const connectorHot = hotConnectors.has(i)
              const next = i < ROLE_ORDER.length - 1 ? ROLE_META[ROLE_ORDER[i + 1]] : null
              return (
                <div key={r} className="flex items-start flex-1 last:flex-none">
                  <div
                    className="flex flex-col items-center gap-2 w-[96px] flex-shrink-0 animate-fade-in"
                    style={{ animationDelay: `${i * 70}ms`, animationFillMode: 'backwards' }}
                  >
                    <div
                      className="relative flex items-center justify-center w-11 h-11 rounded-xl border transition-all duration-300"
                      style={{
                        color: isActive ? m.color : '#aab3c2',
                        borderColor: isActive ? m.color : 'rgba(255,255,255,0.12)',
                        background: isActive
                          ? `linear-gradient(180deg, ${m.color}26, ${m.color}0d)`
                          : 'linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.02))',
                        boxShadow: isActive
                          ? `0 0 0 4px ${m.color}26, 0 8px 28px -6px ${m.color}99`
                          : '0 1px 2px rgba(0,0,0,0.4)',
                      }}
                    >
                      <m.Icon className="w-[18px] h-[18px]" />
                      {isActive && (
                        <span className="absolute inset-0 rounded-xl animate-ping" style={{ border: `1px solid ${m.color}`, opacity: 0.45 }} />
                      )}
                    </div>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[11px] font-semibold tracking-tight whitespace-nowrap" style={{ color: '#e8ebf0' }}>{m.label}</span>
                      <span className="text-[9px] font-medium tabular-nums" style={{ color: '#7d8694' }}>
                        {counts[r] ?? 0} active
                      </span>
                    </div>
                  </div>
                  {next && (
                    <div className="relative flex-1 mt-[21px] mx-0.5 h-[1.5px] rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.10)' }}>
                      {!connectorHot && (
                        <>
                          <div
                            aria-hidden
                            className="absolute inset-0 rounded-full"
                            style={{
                              backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.45) 50%, transparent 100%)',
                              backgroundSize: '200% 100%',
                              animation: 'pe-flow 4.5s linear infinite',
                              animationDelay: `${i * 0.55}s`,
                            }}
                          />
                          <svg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 px-[1px]" style={{ color: 'rgba(255,255,255,0.35)', backgroundColor: '#0e1019' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                          </svg>
                        </>
                      )}
                      {connectorHot && (
                        <div
                          className="absolute inset-y-[-1px] inset-x-0 rounded-full"
                          style={{
                            backgroundImage: `linear-gradient(90deg, ${m.color}, ${next.color}, ${m.color})`,
                            backgroundSize: '200% 100%',
                            animation: 'pe-flow 1.1s linear infinite',
                            boxShadow: `0 0 12px ${next.color}88`,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Governance — policy gates + the audit ledger
   ════════════════════════════════════════════════════════════════════ */

function GovernancePanel({
  audit, gateOn, onClear,
}: {
  audit: AuditEntry[]
  gateOn: boolean
  onClear: () => void
}) {
  const policies = [
    { label: 'All 216 tests pass before review', ok: true },
    { label: 'Every change traceable to a ticket + branch', ok: true },
    { label: 'Agents work on isolated pe-* branches', ok: true },
    { label: 'Prod deploys require human approval', ok: gateOn, gate: true },
  ]

  function exportCsv() {
    const rows = [
      'timestamp,ticket,actor,event,ref',
      ...[...audit].reverse().map(e =>
        `${new Date(e.t).toISOString()},${e.ticket},"${e.actor}","${e.event.replace(/"/g, '""')}",${e.ref}`),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pocketeng-audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="card-surface mt-4 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest">Governance &amp; audit</p>
        <div className="flex items-center gap-2">
          {audit.length > 0 && (
            <button onClick={onClear} className="text-[10.5px] text-tertiary hover:text-secondary cursor-pointer">Clear</button>
          )}
          <button
            onClick={exportCsv}
            disabled={audit.length === 0}
            title="Download the full ledger as CSV — every handoff, gate hold and human decision"
            className="flex items-center gap-1.5 text-[10.5px] font-medium text-secondary hover:text-bright border border-line hover:border-line2 rounded-md px-2 py-1 cursor-pointer transition-all disabled:opacity-40"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 19h16" /></svg>
            Export audit log
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[230px_1fr] gap-4">
        {/* Policy gates */}
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary/70 mb-2">Policy gates</p>
          <div className="flex flex-col gap-1.5">
            {policies.map(pol => (
              <div key={pol.label} className="flex items-start gap-1.5">
                {pol.ok ? (
                  <svg className="w-3 h-3 mt-[1.5px] flex-shrink-0 text-green" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <span className="w-3 h-3 mt-[1.5px] flex-shrink-0 rounded-full border border-line2" />
                )}
                <span className={`text-[11px] leading-snug ${pol.ok ? 'text-secondary' : 'text-tertiary'}`}>
                  {pol.label}
                  {pol.gate && (
                    <span className="ml-1.5 text-[8.5px] font-semibold uppercase tracking-wide rounded px-1 py-[1px] align-[1px]" style={gateOn ? { color: '#b45309', backgroundColor: '#f59e0b1a' } : { color: 'var(--color-tertiary)', backgroundColor: 'var(--color-l2)' }}>
                      {gateOn ? 'gate on' : 'off'}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Audit ledger */}
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary/70 mb-2">Audit trail</p>
          <div className="rounded-lg border border-line bg-l2/40 px-3 py-2 h-[140px] overflow-y-auto font-mono" style={{ scrollbarWidth: 'thin' }}>
            {audit.length === 0 ? (
              <p className="text-[10.5px] text-tertiary py-1">Run the pipeline — every handoff, gate hold and human decision lands here.</p>
            ) : (
              audit.map((e, i) => (
                <div key={`${e.t}-${i}`} className="flex items-start gap-2 py-[2.5px] animate-fade-in">
                  <span className="text-[9.5px] text-tertiary tabular-nums flex-shrink-0 mt-[1px]">
                    {new Date(e.t).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="text-[9.5px] font-semibold text-secondary flex-shrink-0 mt-[1px]">{e.ticket}</span>
                  <span className={`text-[10.5px] leading-snug flex-1 min-w-0 ${e.actor === 'You' ? 'text-bright font-medium' : 'text-secondary'}`}>
                    <span className="text-tertiary">{e.actor}:</span> {e.event}
                  </span>
                  <span className="text-[9px] text-tertiary/70 flex-shrink-0 mt-[1px] hidden sm:inline">{e.ref}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Run composer + run cards
   ════════════════════════════════════════════════════════════════════ */

function RunComposer({
  onRun, onRunReal, canRunReal, atCapacity,
}: {
  onRun: (f: string) => void
  onRunReal: (f: string) => void
  canRunReal: boolean
  atCapacity: boolean
}) {
  const [value, setValue] = useState('')
  return (
    <>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim() && !atCapacity) { onRun(value); setValue('') } }}
          placeholder="Describe a feature — e.g. add usage analytics to the dashboard"
          className="input flex-1 text-[13px]"
        />
        <button
          onClick={() => { if (!atCapacity) { onRun(value); setValue('') } }}
          disabled={atCapacity}
          title={atCapacity ? `Max ${MAX_RUNS} concurrent runs` : 'Run the simulated pipeline'}
          className="btn btn-primary press-scale cursor-pointer whitespace-nowrap disabled:opacity-40 gap-2"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 4.8a1 1 0 0 1 1.53-.85l11 7.2a1 1 0 0 1 0 1.7l-11 7.2a1 1 0 0 1-1.53-.85V4.8z" /></svg>
          Run pipeline
        </button>
        <button
          onClick={() => onRunReal(value)}
          disabled={!canRunReal}
          title={canRunReal ? 'Start REAL agents — Architect first, auto-handoff on completion' : 'Needs a running workspace (and no chain already active)'}
          className="group press-scale flex items-center gap-2 h-10 px-4 rounded-[10px] border border-line bg-ink text-[13.5px] font-medium text-secondary hover:text-bright hover:border-line2 hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.25)] transition-all cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-green opacity-60 group-hover:animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green" />
          </span>
          Run for real
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
        <span className="text-[10px] text-tertiary">Try:</span>
        {PRESETS.map(p => (
          <button
            key={p}
            onClick={() => { if (!atCapacity) onRun(p) }}
            className="text-[10.5px] text-secondary bg-l2 hover:bg-l3 border border-line rounded-full px-2 py-0.5 cursor-pointer transition-colors disabled:opacity-40"
            disabled={atCapacity}
          >
            {p}
          </button>
        ))}
        <span className="text-[9.5px] text-tertiary/70 ml-auto hidden md:inline">up to {MAX_RUNS} features in parallel</span>
      </div>
    </>
  )
}

function RunCard({
  run, onReset, onRunReal, canRunReal, onApprove, onSendBack,
}: {
  run: SimRun
  onReset: () => void
  onRunReal: () => void
  canRunReal: boolean
  onApprove: () => void
  onSendBack: () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [run.log.length])

  const elapsed = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)
  const role = run.status === 'running' ? ROLE_ORDER[run.stageIdx] : null
  const stageProgress = role ? run.lineIdx / SIM_SCRIPT[role].lines.length : 1

  return (
    <div className="rounded-xl border border-line bg-l1/40 p-3">
      {/* Header: status, feature, ticket, stage tracker, controls */}
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full flex-shrink-0 ${run.status === 'running' ? 'bg-green animate-pulse' : run.status === 'awaiting' ? 'animate-pulse' : 'bg-accent'}`}
          style={run.status === 'awaiting' ? { backgroundColor: '#f59e0b' } : undefined}
        />
        <span className="text-[12.5px] font-semibold text-bright truncate flex-1 min-w-0">{run.feature}</span>
        <span className="text-[9px] font-medium font-mono rounded-md border border-line px-1.5 py-[2px] text-secondary flex-shrink-0">{run.ticket}</span>
        {run.status === 'running' && role && (
          <span className="hidden sm:inline text-[10px] text-tertiary flex-shrink-0">
            {run.handingOff ? 'handing off…' : `${ROLE_META[role].label} working…`}
          </span>
        )}
        {run.status === 'awaiting' && (
          <span className="hidden sm:inline text-[10px] flex-shrink-0" style={{ color: '#f59e0b' }}>awaiting approval</span>
        )}
        <span className="text-[10px] text-tertiary tabular-nums flex-shrink-0">{elapsed}s</span>
        <MiniTracker run={run} />
        <button onClick={onReset} className="text-tertiary/60 hover:text-secondary cursor-pointer flex-shrink-0" aria-label="Dismiss run">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      {/* Body: telemetry log + stage theater */}
      <div className="mt-2.5 flex gap-2.5">
        <div
          ref={logRef}
          className="flex-1 min-w-0 rounded-lg border border-line bg-l2/40 px-3 py-2 h-[136px] overflow-y-auto font-mono"
          style={{ scrollbarWidth: 'thin' }}
        >
          {run.log.map((l, i) => {
            const m = ROLE_META[l.role]
            return (
              <div key={i} className="flex items-start gap-2 py-[2px] animate-fade-in">
                <span className="text-[9.5px] font-bold uppercase tracking-wide w-12 flex-shrink-0 mt-[1.5px]" style={{ color: m.color }}>{m.short}</span>
                <span className="text-[11px] text-bright leading-snug">{l.text}</span>
              </div>
            )
          })}
          {run.status === 'running' && role && (
            <div className="flex items-center gap-2 py-[2px]">
              <span className="text-[9.5px] font-bold uppercase tracking-wide w-12 flex-shrink-0" style={{ color: ROLE_META[role].color }}>{ROLE_META[role].short}</span>
              <span className="text-[11px] text-tertiary animate-pulse">▍</span>
            </div>
          )}
        </div>
        {/* Stage theater — only on wider screens */}
        {run.status === 'running' && role === 'swe' && <DiffTheater feature={run.feature} progress={stageProgress} />}
        {run.status === 'running' && role === 'qa' && <TestTheater progress={stageProgress} />}
      </div>

      {/* Artifacts */}
      {run.artifacts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          <span className="text-[9px] text-tertiary uppercase tracking-wider font-medium">Artifacts</span>
          {run.artifacts.map((a, i) => {
            const m = ROLE_META[a.role]
            return (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-l2/60 px-1.5 py-0.5 text-[10px] font-medium text-secondary animate-scale-in" title={m.label}>
                <span className="h-1 w-1 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
                {a.label}
              </span>
            )
          })}
        </div>
      )}

      {/* Production gate — the run is holding for human sign-off */}
      {run.status === 'awaiting' && (
        <div className="mt-2.5 rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 animate-fade-in-up" style={{ border: '1px solid #f59e0b4d', backgroundColor: '#f59e0b0d' }}>
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full animate-ping opacity-60" style={{ backgroundColor: '#f59e0b' }} />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
          </span>
          <span className="text-[12px] font-semibold text-bright">Awaiting production approval</span>
          <span className="text-[10.5px] text-secondary">Policy: prod deploys require human sign-off · 216/216 tests green · review approved</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={onSendBack} className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-tertiary hover:text-bright border border-line hover:border-line2 transition-all cursor-pointer">
              Send back
            </button>
            <button onClick={onApprove} className="btn btn-primary btn-sm press-scale cursor-pointer">
              Approve deploy
            </button>
          </div>
        </div>
      )}

      {/* Completion */}
      {run.status === 'done' && (
        <div className="mt-2.5 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 animate-fade-in-up">
          <span className="text-[12px] font-semibold text-bright">✦ Feature shipped</span>
          <span className="text-[10.5px] text-secondary">6 agents · 5 handoffs · {run.artifacts.length} artifacts · {elapsed}s — BA kept docs current, PM tracked {run.ticket} to Done</span>
          <button
            onClick={onRunReal}
            disabled={!canRunReal}
            title={canRunReal ? 'Run this feature through REAL agents with auto-handoff' : 'Needs a running workspace'}
            className="group ml-auto flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-line bg-ink text-[11px] font-medium text-secondary hover:text-bright hover:border-line2 transition-all cursor-pointer disabled:opacity-40"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-green opacity-60 group-hover:animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green" />
            </span>
            Run for real
          </button>
        </div>
      )}
    </div>
  )
}

/** Six tiny stage dots showing this run's position in the pipeline. */
function MiniTracker({ run }: { run: SimRun }) {
  return (
    <span className="hidden sm:inline-flex items-center gap-[3px] flex-shrink-0 px-1">
      {ROLE_ORDER.map((r, i) => {
        const m = ROLE_META[r]
        const isDone = run.status === 'done' || i < run.stageIdx || (i === run.stageIdx && run.handingOff)
          || (run.status === 'awaiting' && i <= run.stageIdx)
        const isActive = run.status === 'running' && !run.handingOff && i === run.stageIdx
        // While holding at the gate, the DevOps dot pulses amber.
        const isGate = run.status === 'awaiting' && r === 'devops'
        return (
          <span
            key={r}
            className={`rounded-full transition-all duration-300 ${isActive || isGate ? 'h-2 w-2 animate-pulse' : 'h-1.5 w-1.5'}`}
            style={{ backgroundColor: isGate ? '#f59e0b' : isDone || isActive ? m.color : 'var(--color-line)' }}
            title={isGate ? 'Holding at production gate' : m.label}
          />
        )
      })}
    </span>
  )
}

/* ── Stage theater: live diff while the Engineer works ─────────────── */

const DIFF_LINES: { kind: 'ctx' | 'add' | 'del'; text: string }[] = [
  { kind: 'ctx', text: 'export async function handler(req) {' },
  { kind: 'del', text: '  const data = await fetchAll()' },
  { kind: 'add', text: '  const { teamId, range } = parseQuery(req)' },
  { kind: 'add', text: '  const data = await fetchUsage(teamId, range)' },
  { kind: 'ctx', text: '' },
  { kind: 'add', text: '  const series = aggregate(data, "day")' },
  { kind: 'add', text: '  const totals = summarize(series)' },
  { kind: 'del', text: '  return json(data)' },
  { kind: 'add', text: '  return json({ series, totals })' },
  { kind: 'ctx', text: '}' },
  { kind: 'add', text: '' },
  { kind: 'add', text: 'test("aggregates per-day usage", async () => {' },
  { kind: 'add', text: '  expect(totals.activeUsers).toBe(42)' },
  { kind: 'add', text: '})' },
]

function DiffTheater({ feature, progress }: { feature: string; progress: number }) {
  const slug = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 26) || 'feature'
  const visible = Math.max(1, Math.ceil(progress * DIFF_LINES.length))
  return (
    <div className="hidden md:flex flex-col w-[230px] flex-shrink-0 rounded-lg border border-line bg-l2/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-line">
        <svg className="w-2.5 h-2.5 text-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
        <span className="text-[9px] font-mono text-tertiary truncate">{slug}.ts</span>
        <span className="ml-auto text-[8.5px] font-mono text-green-500">+812</span>
        <span className="text-[8.5px] font-mono text-danger">−96</span>
      </div>
      <div className="flex-1 overflow-hidden px-2 py-1.5 font-mono">
        {DIFF_LINES.slice(0, visible).map((l, i) => (
          <div
            key={i}
            className="text-[9px] leading-[14px] whitespace-pre truncate animate-fade-in"
            style={{
              color: l.kind === 'add' ? 'var(--color-green)' : l.kind === 'del' ? 'var(--color-danger)' : 'var(--color-tertiary)',
              backgroundColor: l.kind === 'add' ? 'rgba(34,197,94,0.07)' : l.kind === 'del' ? 'rgba(239,68,68,0.06)' : 'transparent',
              textDecoration: l.kind === 'del' ? 'line-through' : 'none',
              opacity: l.kind === 'del' ? 0.75 : 1,
            }}
          >
            {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Stage theater: test run while QA works ─────────────────────────── */

function TestTheater({ progress }: { progress: number }) {
  const TOTAL = 216
  // The script's story: 212/214 with 2 failures around 40%, patched, then
  // a clean 216/216 by the end.
  const failing = progress > 0.35 && progress < 0.78
  const count = Math.min(TOTAL, Math.round(progress * TOTAL))
  const barColor = failing ? '#ef4444' : '#22c55e'
  return (
    <div className="hidden md:flex flex-col w-[230px] flex-shrink-0 rounded-lg border border-line bg-l2/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-line">
        <svg className="w-2.5 h-2.5 text-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 3h6" /><path d="M10 3v5.5L5.2 17a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 8.5V3" /></svg>
        <span className="text-[9px] font-mono text-tertiary">test suite</span>
        <span className="ml-auto text-[9px] font-mono tabular-nums" style={{ color: barColor }}>
          {count}/{TOTAL}
        </span>
      </div>
      <div className="flex-1 px-2.5 py-2 flex flex-col gap-2 justify-center">
        <div className="h-1.5 rounded-full bg-[var(--color-line)] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${(count / TOTAL) * 100}%`, backgroundColor: barColor, boxShadow: `0 0 8px ${barColor}80` }}
          />
        </div>
        <div className="flex items-center justify-between font-mono">
          <span className="text-[9px]" style={{ color: '#22c55e' }}>✓ {failing ? Math.max(0, count - 2) : count} passed</span>
          {failing && <span className="text-[9px] text-danger animate-pulse">✗ 2 failed</span>}
          {!failing && progress >= 0.78 && <span className="text-[9px]" style={{ color: '#22c55e' }}>all green</span>}
        </div>
        {failing && (
          <div className="text-[8.5px] font-mono text-tertiary leading-tight">
            <div className="text-danger/80 truncate">✗ date-handling edge case</div>
            <div className="text-danger/80 truncate">✗ tz offset on range bound</div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Shipped shelf ──────────────────────────────────────────────────── */

function ShippedShelf({ history }: { history: ShippedRun[] }) {
  const [open, setOpen] = useState(false)
  const show = open ? history : history.slice(0, 3)
  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="flex items-center justify-between">
        <p className="text-[9px] font-medium text-tertiary uppercase tracking-[0.08em]">Shipped</p>
        {history.length > 3 && (
          <button onClick={() => setOpen(o => !o)} className="text-[10px] text-tertiary hover:text-secondary cursor-pointer">
            {open ? 'Show less' : `Show all ${history.length}`}
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {show.map((h, i) => (
          <div key={`${h.finishedAt}-${i}`} className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors">
            <svg className="w-3 h-3 text-accent flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            <span className="text-[11px] text-secondary truncate flex-1 min-w-0">{h.feature}</span>
            <span className="text-[9px] font-mono text-tertiary flex-shrink-0">{h.ticket}</span>
            <span className="text-[9.5px] text-tertiary tabular-nums flex-shrink-0">{h.durationS}s</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Real Autopilot chain tracker
   ════════════════════════════════════════════════════════════════════ */

function RealChainTracker({
  chain, onOpen, onStop,
}: {
  chain: RealChain
  onOpen: (serverId: string, sessionId: string) => void
  onStop: () => void
}) {
  const byRoleStage = new Map(chain.stages.map(s => [s.role, s]))
  const elapsedMin = Math.max(1, Math.round((Date.now() - chain.startedAt) / 60000))
  return (
    <div className="card-surface mt-4 p-4" style={{ borderColor: chain.status === 'error' ? 'rgba(239,68,68,0.4)' : undefined }}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
          chain.status === 'running' ? 'bg-green animate-pulse' : chain.status === 'done' ? 'bg-accent' : 'bg-danger'
        }`} />
        <span className="text-[11px] font-medium text-tertiary uppercase tracking-widest">Real autopilot</span>
        <span className="text-[12px] text-bright font-medium truncate flex-1 min-w-0">{chain.feature}</span>
        <span className="text-[10px] text-tertiary flex-shrink-0">on {chain.serverLabel} · ~{elapsedMin}m</span>
        {chain.status === 'running' && (
          <button onClick={onStop} className="text-[10.5px] text-tertiary hover:text-danger cursor-pointer flex-shrink-0">Stop</button>
        )}
        {chain.status !== 'running' && (
          <button onClick={onStop} className="text-[10.5px] text-tertiary hover:text-secondary cursor-pointer flex-shrink-0">Dismiss</button>
        )}
      </div>
      {chain.status === 'error' && (
        <p className="text-[11px] text-danger mb-2.5">{chain.error ?? 'A stage failed.'} The chain stopped — open the session to inspect.</p>
      )}
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        {ROLE_ORDER.map((r, i) => {
          const m = ROLE_META[r]
          const st = byRoleStage.get(r)
          const reached = !!st
          return (
            <div key={r} className="flex items-center gap-1 flex-shrink-0">
              <button
                disabled={!reached}
                onClick={() => st && onOpen(chain.serverId, st.sessionId)}
                title={reached ? `Open the live ${m.label} session` : `${m.label} — not reached yet`}
                className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors disabled:cursor-default cursor-pointer ${
                  reached ? 'border-line bg-l2/50 text-secondary hover:text-bright hover:border-line2' : 'border-line text-tertiary opacity-50'
                }`}
              >
                <m.Icon className="w-3 h-3" />
                <span className="text-[10px] font-semibold uppercase tracking-wide">{m.short}</span>
                {st?.status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-green animate-pulse" />}
                {st?.status === 'done' && (
                  <svg className="w-2.5 h-2.5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                )}
                {st?.status === 'error' && <span className="text-[9px] text-danger">✗</span>}
              </button>
              {i < ROLE_ORDER.length - 1 && (
                <svg className="w-2.5 h-2.5 text-tertiary/40 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" /></svg>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-[9.5px] text-tertiary/70 mt-2">
        Real sessions, real handoffs — each stage's agent picks up the previous stage's branch. Polls every 12s.
      </p>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Background agents (BA / PM)
   ════════════════════════════════════════════════════════════════════ */

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function BackgroundAgentCard({
  role, tasks, onOpen,
}: {
  role: SDLCRole
  tasks: TaskView[]
  onOpen: (t: TaskView) => void
}) {
  const m = ROLE_META[role]
  const activity = useAgentActivity(role)
  const noun = role === 'pm' ? 'ticket update' : 'doc update'

  return (
    <div className="card-surface p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center justify-center w-9 h-9 rounded-[10px] flex-shrink-0 border border-line bg-l2/50 text-secondary">
          <m.Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-bright tracking-tight">{m.label}</span>
            {/* Liveness is the platform's green — not the role color. */}
            <span className="inline-flex items-center gap-1 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-tertiary">
              <span className="h-[5px] w-[5px] rounded-full bg-green animate-pulse" />
              Always on
            </span>
          </div>
          <p className="text-[10.5px] text-tertiary truncate mt-0.5">{m.blurb}</p>
        </div>
        <span className="text-[9.5px] font-medium tabular-nums text-tertiary flex-shrink-0">
          {activity.length} {noun}{activity.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-line bg-l2/40 px-3 py-2 h-[116px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {activity.length === 0 ? (
          <p className="text-[10.5px] text-tertiary/70 italic py-1.5">
            Watching the pipeline — activity appears here as work flows through.
          </p>
        ) : activity.map((a, i) => (
          <div key={`${a.at}-${i}`} className={`flex items-start gap-2 py-[3.5px] ${i === 0 ? 'animate-fade-in' : ''}`}>
            <span className="h-[5px] w-[5px] rounded-full mt-[5px] flex-shrink-0 bg-tertiary/40" />
            <span className="text-[11px] text-secondary leading-snug flex-1 min-w-0">{a.text}</span>
            <span className="text-[9px] text-tertiary/70 tabular-nums flex-shrink-0 mt-[2px]">{timeAgo(a.at)}</span>
          </div>
        ))}
      </div>

      {tasks.length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-line flex flex-col gap-0.5">
          {tasks.slice(0, 2).map(t => (
            <button
              key={t.id}
              onClick={() => onOpen(t)}
              className="flex items-center gap-2 w-full rounded-md px-1.5 py-1 text-left hover:bg-[var(--hover-bg)] cursor-pointer transition-colors"
              title={t.title}
            >
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${STATUS_META[t.status].dotClass}`} />
              <span className="text-[11px] text-secondary truncate flex-1 min-w-0">{t.title}</span>
              <svg className="w-2.5 h-2.5 text-tertiary/50 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" /></svg>
            </button>
          ))}
          {tasks.length > 2 && (
            <span className="text-[9.5px] text-tertiary px-1.5">+{tasks.length - 2} more tagged {m.short}</span>
          )}
        </div>
      )}
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════
   Board
   ════════════════════════════════════════════════════════════════════ */

function RoleColumn({
  role, tasks, serverById, onOpen, onHandoff,
}: {
  role: SDLCRole
  tasks: TaskView[]
  serverById: Map<string, Server>
  onOpen: (t: TaskView) => void
  onHandoff: (t: TaskView, from: SDLCRole, to: SDLCRole) => void
}) {
  const m = ROLE_META[role]
  const to = nextRole(role)
  const MAX = 4

  return (
    <div className="flex flex-col min-h-[140px]">
      <div className="px-0.5 pb-2 border-b border-line mb-2.5">
        <div className="flex items-center gap-1.5 text-tertiary">
          <span className="h-[5px] w-[5px] rounded-full flex-shrink-0" style={{ backgroundColor: m.color, opacity: 0.8 }} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary">{m.label}</span>
          <span className="text-[10px] font-medium tabular-nums">{tasks.length}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 flex-1">
        {tasks.length === 0 && (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-line h-[72px]">
            <span className="text-[10px] text-tertiary/50">No sessions in this stage</span>
          </div>
        )}
        {tasks.slice(0, MAX).map(t => {
          const status = STATUS_META[t.status]
          const server = serverById.get(t.session.serverId)
          const canHandoff = !!to && server?.instanceState === 'running'
          const handedFrom = typeof window !== 'undefined'
            ? (window.localStorage.getItem(`pe-handoff:${t.id}`) as SDLCRole | null)
            : null
          return (
            <div key={t.id} className="group card-surface px-3 py-2.5">
              <button onClick={() => onOpen(t)} className="w-full text-left cursor-pointer">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${status.dotClass}`} />
                  <span className="text-[12px] text-bright truncate flex-1 min-w-0" title={t.title}>{t.title}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 pl-3.5 min-w-0">
                  {getAgentLogo(t.agent) && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={getAgentLogo(t.agent)!} alt="" className="w-2.5 h-2.5 object-contain opacity-60 flex-shrink-0" />
                  )}
                  <span className="text-[10px] text-tertiary truncate">{t.repo ?? server?.label ?? ''}</span>
                  {handedFrom && ROLE_META[handedFrom] && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-medium flex-shrink-0 text-tertiary" title={`Handed off from ${ROLE_META[handedFrom].label}`}>
                      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a4 4 0 0 1 4 4v6" /><path strokeLinecap="round" strokeLinejoin="round" d="M7 6l-4 4 4 4" /></svg>
                      {ROLE_META[handedFrom].short}
                    </span>
                  )}
                </div>
              </button>
              {to && canHandoff && (
                <div className="flex justify-end mt-2">
                  <button
                    onClick={() => onHandoff(t, role, to)}
                    title={`Start a ${ROLE_META[to].label} agent that picks up this work`}
                    className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full border border-line px-2 py-[3px] text-tertiary hover:text-bright hover:border-line2 cursor-pointer transition-all hover:translate-x-[1px]"
                  >
                    Hand off
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
                    {ROLE_META[to].short}
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {tasks.length > MAX && (
          <p className="text-[10px] text-tertiary px-1">+{tasks.length - MAX} more</p>
        )}
      </div>
    </div>
  )
}
