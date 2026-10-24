/**
 * Task view model derived from a ChatSessionRecord.
 *
 * The backend schema stays session-shaped. The UI reads a TaskView instead —
 * it carries the user-meaningful bits (title, status, repo, branch, PR link)
 * with the raw session available for any caller that needs it.
 *
 * This is a pure module: no I/O, no state, just derivation.
 */
import type { ChatSessionRecord } from './api'

export type TaskStatus =
  | 'running'           // session is actively executing
  | 'ready-for-review'  // completed + has a PR — user's next action is review
  | 'done'              // completed, no PR (chat/exploration tasks)
  | 'failed'            // errored
  | 'cancelled'

export interface TaskView {
  id: string
  title: string
  status: TaskStatus
  /** Repo short name (last segment of repoDir), e.g. "pocketeng". */
  repo?: string
  /** Raw branch name from the session record, e.g. "pe-session-abc12345". */
  branch?: string
  /** Human label for the branch, e.g. "Session abc12345" for auto-branches. */
  branchLabel?: string
  prUrl?: string
  prNumber?: number
  agent: string
  model?: string
  autopilot?: boolean
  setupSession?: boolean
  pinned?: boolean
  createdAt: string
  updatedAt: string
  /** Escape hatch: the full session record, for callers that need more. */
  session: ChatSessionRecord
}

const AUTOPILOT_PROMPT_PREFIX =
  /^(?:\[.*?\]\s*)?You are in AUTOPILOT mode\.[\s\S]*?---\s*\n\s*Task:\s*/i
const SESSION_CONTEXT_PREFIX =
  /^\[Session context — not from the user\][\s\S]*?\[End session context\]\s*/i

/**
 * Produce a one-line title from the first prompt. Strips the worktree/autopilot
 * scaffolding we prepend server-side so what the user sees is their actual
 * instruction, not the framing.
 */
export function summarizeFirstPrompt(prompt: string): string {
  if (!prompt) return 'Untitled task'
  let text = prompt.trim()
  text = text.replace(SESSION_CONTEXT_PREFIX, '').trim()
  text = text.replace(AUTOPILOT_PROMPT_PREFIX, '').trim()
  // First non-empty line
  const firstLine = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
  if (!firstLine) return 'Untitled task'
  const MAX = 64
  return firstLine.length > MAX ? firstLine.slice(0, MAX - 1).trimEnd() + '…' : firstLine
}

/**
 * Auto-generated worktree branches are named `pe-session-<12-hex>`. That's
 * machine-shaped; show users "Session <8-hex>". Anything else (user-created
 * feature branch on a BYOS server, legacy session on main) is shown verbatim.
 */
export function humanizeBranch(branch?: string | null): string | undefined {
  if (!branch) return undefined
  const m = branch.match(/^pe-session-([0-9a-f]{6,})$/i)
  if (m) return `Session ${m[1].slice(0, 8)}`
  return branch
}

export function parsePrNumber(url?: string | null): number | undefined {
  if (!url) return undefined
  const m = url.match(/\/pull\/(\d+)/)
  return m ? Number.parseInt(m[1], 10) : undefined
}

function deriveStatus(session: ChatSessionRecord): TaskStatus {
  if (session.status === 'running') return 'running'
  if (session.status === 'error') return 'failed'
  if (session.status === 'cancelled') return 'cancelled'
  // done
  if (session.prUrl) return 'ready-for-review'
  return 'done'
}

function deriveRepo(session: ChatSessionRecord): string | undefined {
  const repoDir = session.repoDir
  if (!repoDir) return undefined
  const parts = repoDir.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : undefined
}

export function toTaskView(session: ChatSessionRecord): TaskView {
  return {
    id: session.sessionId,
    title: session.title || summarizeFirstPrompt(session.prompt),
    status: deriveStatus(session),
    repo: deriveRepo(session),
    branch: session.branchName,
    branchLabel: humanizeBranch(session.branchName),
    prUrl: session.prUrl,
    prNumber: parsePrNumber(session.prUrl),
    agent: session.agent,
    model: session.model,
    autopilot: session.autopilot,
    setupSession: session.setupSession,
    pinned: session.pinned ?? false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    session,
  }
}

export interface GroupedTasks {
  running: TaskView[]
  readyForReview: TaskView[]
  recent: TaskView[]
}

export interface WorkspaceTaskGroup {
  serverId: string
  label: string
  tasks: TaskView[]
  updatedAt: string
}

const byPinnedThenRecency = (a: TaskView, b: TaskView) => {
  if (a.pinned && !b.pinned) return -1
  if (!a.pinned && b.pinned) return 1
  return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)
}

export function groupTasks(tasks: TaskView[]): GroupedTasks {
  const running: TaskView[] = []
  const readyForReview: TaskView[] = []
  const recent: TaskView[] = []
  for (const t of tasks) {
    if (t.status === 'running') running.push(t)
    else if (t.status === 'ready-for-review') readyForReview.push(t)
    else recent.push(t)
  }
  running.sort(byPinnedThenRecency)
  readyForReview.sort(byPinnedThenRecency)
  recent.sort(byPinnedThenRecency)
  return { running, readyForReview, recent }
}

export function groupTasksByWorkspace(
  tasks: TaskView[],
  labelFor: (task: TaskView) => string,
): WorkspaceTaskGroup[] {
  const byServer = new Map<string, WorkspaceTaskGroup>()
  for (const task of tasks) {
    const serverId = task.session.serverId
    const updatedAt = task.updatedAt || task.createdAt
    const existing = byServer.get(serverId)
    if (existing) {
      existing.tasks.push(task)
      if (updatedAt.localeCompare(existing.updatedAt) > 0) existing.updatedAt = updatedAt
    } else {
      byServer.set(serverId, {
        serverId,
        label: labelFor(task),
        tasks: [task],
        updatedAt,
      })
    }
  }

  const groups = Array.from(byServer.values())
  for (const group of groups) group.tasks.sort(byPinnedThenRecency)
  groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return groups
}

export interface StatusMeta {
  label: string
  /** Tailwind classes for the status dot. */
  dotClass: string
  /** Tailwind classes for the label chip text. */
  textClass: string
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  running:           { label: 'Running',          dotClass: 'bg-green animate-pulse', textClass: 'text-green' },
  'ready-for-review': { label: 'Ready for review', dotClass: 'bg-accent',              textClass: 'text-accent' },
  done:              { label: 'Done',             dotClass: 'bg-tertiary',            textClass: 'text-tertiary' },
  failed:            { label: 'Failed',           dotClass: 'bg-danger',              textClass: 'text-danger' },
  cancelled:         { label: 'Cancelled',        dotClass: 'bg-amber',               textClass: 'text-amber' },
}
