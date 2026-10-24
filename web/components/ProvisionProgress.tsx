'use client'

// ProvisionProgress — shown during onboarding Step 3 after the user picks a
// repo. Maps the backend readiness state machine (booting-ec2 → awaiting-ip →
// awaiting-ssh → installing-agents → pushing-credentials → verifying-auth →
// ready) down to 4 user-facing steps so the UX doesn't look like a debug log.

import type { Readiness } from '@/lib/api'

type UiStep = {
  key: 'start' | 'connect' | 'install' | 'ready'
  label: string
}

const STEPS: UiStep[] = [
  { key: 'start', label: 'Starting workspace' },
  { key: 'connect', label: 'Connecting' },
  { key: 'install', label: 'Installing your agent' },
  { key: 'ready', label: 'Ready' },
]

// Map backend stage → UI step index. Keep this conservative (always round
// DOWN to the step we're clearly in) so we never show a later step than
// what's actually true. Jumping backwards looks broken.
function stageToStep(readiness: Readiness | null | undefined): number {
  if (!readiness) return 0
  if (readiness.status === 'ready') return 3
  switch (readiness.stage) {
    case 'booting-ec2':
    case 'awaiting-ip':
      return 0
    case 'awaiting-ssh':
      return 1
    case 'installing-agents':
    case 'pushing-credentials':
    case 'verifying-auth':
      return 2
    case 'done':
      return 3
    case 'error':
      return 0
    default:
      return 0
  }
}

export function ProvisionProgress({
  readiness,
  repoLabel,
}: {
  readiness: Readiness | null | undefined
  repoLabel: string | null
}) {
  const failed = readiness?.status === 'failed' || readiness?.stage === 'error'
  const current = failed ? -1 : stageToStep(readiness)

  return (
    <div className="flex flex-col gap-5">
      {/* Context line — what are we provisioning, so the user knows which
          repo this is about. */}
      {repoLabel && (
        <p className="text-[12.5px] text-tertiary">
          Setting up your workspace{repoLabel !== 'blank' ? <> with <span className="text-bright">{repoLabel}</span></> : ''}…
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {STEPS.map((step, i) => {
          const isDone = !failed && i < current
          const isActive = !failed && i === current
          const isError = failed && i === 0
          return (
            <li key={step.key} className="flex items-center gap-3">
              <StatusDot done={isDone} active={isActive} error={isError} />
              <span
                className={`text-[13.5px] transition-colors ${
                  isActive
                    ? 'text-bright'
                    : isDone
                      ? 'text-tertiary'
                      : isError
                        ? 'text-danger'
                        : 'text-line2'
                }`}
              >
                {step.label}
              </span>
            </li>
          )
        })}
      </ul>

      {failed && (
        <p className="text-[12px] text-danger">
          {readiness?.error ?? 'Something went wrong. Please try again.'}
        </p>
      )}
    </div>
  )
}

function StatusDot({
  done,
  active,
  error,
}: {
  done: boolean
  active: boolean
  error: boolean
}) {
  if (error) {
    return (
      <span className="w-4 h-4 rounded-full bg-danger/15 flex items-center justify-center flex-shrink-0">
        <svg className="w-2.5 h-2.5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </span>
    )
  }
  if (done) {
    return (
      <span className="w-4 h-4 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
        <svg className="w-2.5 h-2.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    )
  }
  if (active) {
    return (
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
        <span className="w-3.5 h-3.5 border-2 border-line border-t-bright rounded-full animate-spin" />
      </span>
    )
  }
  return (
    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
      <span className="w-2 h-2 rounded-full bg-line" />
    </span>
  )
}
