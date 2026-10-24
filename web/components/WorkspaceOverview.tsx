'use client'

// Workspace Overview — the "About this workspace" panel rendered inside
// each expanded ServerCard. Three tabs:
//
//   Arch  — user-curated description + components (services). Each
//           component cross-references the auto-discovered services
//           list so we can show a live status dot.
//   Infra — auto-queried EC2/EBS/tunnel/cost. Read-only.
//   Docs  — list + render markdown files under ~/projects on the
//           workspace. Free-form, on-demand SSH read.
//
// Architecture is stored on the workspace record (description +
// components[]). Editing is admin-only on team-owned workspaces —
// the backend enforces that; the UI just shows the edit button.

import { useEffect, useMemo, useState } from 'react'
import {
  detectWorkspaceArchitecture,
  getServer,
  listWorkspaceDocs,
  readWorkspaceDoc,
  updateWorkspaceOverview,
  type Server,
  type WorkspaceComponent,
  type WorkspaceInfra,
} from '@/lib/api'
import { SystemMap } from '@/components/workspace/SystemMap'

type Tab = 'arch' | 'infra' | 'docs'

/** Combine the user's existing components with auto-detect suggestions,
 *  preserving every existing entry unchanged. We dedup by lowercased
 *  name so a re-scan stays idempotent. Suggestions only contribute
 *  net-new names — never overwrites a role/port the user curated. */
function mergeComponents(
  existing: WorkspaceComponent[],
  suggestions: WorkspaceComponent[],
): WorkspaceComponent[] {
  const seen = new Set(existing.map(c => c.name.toLowerCase().trim()))
  const out = [...existing]
  for (const s of suggestions) {
    const key = (s.name || '').toLowerCase().trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

interface Props {
  server: Server
  // Auto-discovered services from the existing ServerCard scan — used
  // to render a live status dot next to declared components. Pass the
  // same array the card already maintains; we don't re-scan here.
  liveServices?: { port: number; process: string; url: string }[]
}

export function WorkspaceOverview({ server, liveServices = [] }: Props) {
  const [tab, setTab] = useState<Tab>('arch')

  // Architecture state — seeded from the server prop on mount, updated
  // locally on save so the panel reflects edits without waiting for
  // a parent refetch.
  const [description, setDescription] = useState(server.description ?? '')
  const [components, setComponents] = useState<WorkspaceComponent[]>(server.components ?? [])
  const [editing, setEditing] = useState(false)
  // Auto-detect state — separate from `editing` because we want users to
  // be able to fire a scan without entering edit mode. Suggestions are
  // merged-or-replaced (replaced when components is empty, merged
  // otherwise) and the user sees the result inline.
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  // Infra block lives on the single-server GET, NOT the list. Fetch
  // lazily the first time the user opens this panel so the dashboard
  // list page doesn't pay for it on every card.
  const [infra, setInfra] = useState<WorkspaceInfra | null>(server.infra ?? null)
  const [infraLoading, setInfraLoading] = useState(false)
  const [infraError, setInfraError] = useState<string | null>(null)

  useEffect(() => {
    if (infra !== null) return
    let cancelled = false
    setInfraLoading(true)
    setInfraError(null)
    void (async () => {
      try {
        const fresh = await getServer(server.serverId)
        if (cancelled) return
        setInfra(fresh.infra ?? null)
        if (fresh.description != null) setDescription(fresh.description)
        if (fresh.components != null) setComponents(fresh.components)
      } catch (err) {
        if (!cancelled) setInfraError((err as Error).message)
      } finally {
        if (!cancelled) setInfraLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [server.serverId, infra])

  return (
    <div className="border-t border-line">
      {/* Tab strip */}
      <div className="flex items-center gap-1 px-5 pt-3">
        {(['arch', 'infra', 'docs'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-[11px] font-medium uppercase tracking-wider transition-colors cursor-pointer ${
              tab === t
                ? 'bg-accent/10 text-accent'
                : 'text-tertiary hover:text-secondary'
            }`}
          >
            {t === 'arch' ? 'Architecture' : t === 'infra' ? 'Infrastructure' : 'Docs'}
          </button>
        ))}
      </div>

      <div className="px-5 py-4">
        {tab === 'arch' && (
          <ArchTab
            description={description}
            components={components}
            liveServices={liveServices}
            editing={editing}
            detecting={detecting}
            detectError={detectError}
            onEdit={() => setEditing(true)}
            onCancel={() => {
              // Revert local edits to the persisted state (server prop).
              setDescription(server.description ?? '')
              setComponents(server.components ?? [])
              setEditing(false)
            }}
            onChangeDescription={setDescription}
            onChangeComponents={setComponents}
            onSave={async () => {
              try {
                await updateWorkspaceOverview(server.serverId, { description, components })
                setEditing(false)
              } catch (err) {
                // Surface inline — overview saves are non-critical, no
                // toast layer yet. The textarea/input rows stay editable
                // so the user can fix and retry without losing input.
                alert(`Could not save: ${(err as Error).message}`)
              }
            }}
            onAutoDetect={async () => {
              setDetecting(true)
              setDetectError(null)
              try {
                const { suggestions } = await detectWorkspaceArchitecture(server.serverId)
                // Merge by lowercased name so a re-scan doesn't duplicate
                // anything the user already curated. Existing entries
                // win — we never overwrite a name/role/port the user set.
                const merged = mergeComponents(components, suggestions)
                setComponents(merged)
                // Persist immediately so the dot-flow renders without
                // requiring a separate Save click. Don't auto-set the
                // description — that's a free-text choice we leave to
                // the user.
                if (merged.length !== components.length) {
                  await updateWorkspaceOverview(server.serverId, { components: merged })
                }
              } catch (err) {
                setDetectError((err as Error).message)
              } finally {
                setDetecting(false)
              }
            }}
          />
        )}

        {tab === 'infra' && (
          <InfraTab infra={infra} loading={infraLoading} error={infraError} server={server} />
        )}

        {tab === 'docs' && (
          <DocsTab serverId={server.serverId} />
        )}
      </div>
    </div>
  )
}

/* ── Architecture tab ─────────────────────────────────────────────── */

function ArchTab(props: {
  description: string
  components: WorkspaceComponent[]
  liveServices: { port: number; process: string; url: string }[]
  editing: boolean
  detecting: boolean
  detectError: string | null
  onEdit: () => void
  onCancel: () => void
  onChangeDescription: (v: string) => void
  onChangeComponents: (v: WorkspaceComponent[]) => void
  onSave: () => void
  onAutoDetect: () => void
}) {
  const livePortSet = useMemo(
    () => new Set(props.liveServices.map(s => s.port)),
    [props.liveServices],
  )

  if (!props.editing) {
    const hasContent = props.description || props.components.length > 0
    return (
      <div className="flex flex-col gap-3">
        {hasContent ? (
          <>
            {props.description && (
              <p className="text-[13px] text-bright leading-relaxed">{props.description}</p>
            )}
            {props.components.length > 0 && (
              <SystemMap
                components={props.components}
                liveServices={props.liveServices}
              />
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-tertiary italic">
              No architecture described yet. Auto-detect scans the workspace
              for known services and dependencies — or edit by hand.
            </p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={props.onEdit}
            className="text-[11px] text-tertiary hover:text-secondary cursor-pointer"
          >
            {hasContent ? 'Edit' : '+ Add manually'}
          </button>
          <button
            onClick={props.onAutoDetect}
            disabled={props.detecting}
            className="text-[11px] text-accent hover:text-accent/80 cursor-pointer disabled:opacity-50"
          >
            {props.detecting ? 'Scanning…' : hasContent ? '↻ Re-scan' : '⚡ Auto-detect'}
          </button>
        </div>
        {props.detectError && (
          <p className="text-[11px] text-danger">{props.detectError}</p>
        )}
      </div>
    )
  }

  // Edit mode — inline form. Keep it simple: textarea for description,
  // one row per component with name / role / port + add/remove.
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="text-[10px] font-medium text-tertiary uppercase tracking-wider mb-1 block">Description</label>
        <textarea
          value={props.description}
          onChange={e => props.onChangeDescription(e.target.value.slice(0, 280))}
          rows={2}
          placeholder="What is this workspace for? (one or two lines)"
          className="input w-full text-[13px] resize-none"
        />
        <p className="text-[10px] text-tertiary mt-0.5">{props.description.length}/280</p>
      </div>

      <div>
        <label className="text-[10px] font-medium text-tertiary uppercase tracking-wider mb-1 block">Components</label>
        <div className="flex flex-col gap-1.5">
          {props.components.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={c.name}
                onChange={e => {
                  const next = [...props.components]
                  next[i] = { ...c, name: e.target.value.slice(0, 60) }
                  props.onChangeComponents(next)
                }}
                placeholder="Name (e.g. Vector DB)"
                className="input flex-1 min-w-0 text-[12px]"
              />
              <input
                value={c.role ?? ''}
                onChange={e => {
                  const next = [...props.components]
                  next[i] = { ...c, role: e.target.value.slice(0, 100) || undefined }
                  props.onChangeComponents(next)
                }}
                placeholder="Role"
                className="input flex-1 min-w-0 text-[12px]"
              />
              <input
                value={c.port ?? ''}
                onChange={e => {
                  const raw = e.target.value.trim()
                  const next = [...props.components]
                  if (!raw) {
                    next[i] = { ...c, port: undefined }
                  } else {
                    const n = Number(raw)
                    next[i] = { ...c, port: Number.isFinite(n) ? n : c.port }
                  }
                  props.onChangeComponents(next)
                }}
                placeholder="Port"
                inputMode="numeric"
                className="input text-[12px] font-mono shrink-0"
                style={{ width: '5rem' }}
              />
              <button
                onClick={() => {
                  const next = props.components.filter((_, j) => j !== i)
                  props.onChangeComponents(next)
                }}
                className="text-[11px] text-tertiary hover:text-danger cursor-pointer shrink-0 px-1"
                aria-label={`Remove ${c.name || 'component'}`}
              >
                ×
              </button>
            </div>
          ))}
          {props.components.length < 20 && (
            <button
              onClick={() => props.onChangeComponents([...props.components, { name: '' }])}
              className="text-[11px] text-tertiary hover:text-secondary self-start cursor-pointer"
            >
              + Add component
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button onClick={props.onSave} className="btn btn-primary btn-sm cursor-pointer">Save</button>
        <button onClick={props.onCancel} className="btn btn-ghost btn-sm cursor-pointer">Cancel</button>
      </div>
    </div>
  )
}

/* ── Infrastructure tab ───────────────────────────────────────────── */

function InfraTab({
  infra,
  loading,
  error,
  server,
}: {
  infra: WorkspaceInfra | null
  loading: boolean
  error: string | null
  server: Server
}) {
  if (error) {
    return <p className="text-[12px] text-danger">Could not load infra: {error}</p>
  }
  if (loading && !infra) {
    return <p className="text-[12px] text-tertiary">Loading infra…</p>
  }
  if (!infra) {
    return <p className="text-[12px] text-tertiary">No infra info available.</p>
  }
  if (infra.byos) {
    return (
      <div className="flex flex-col gap-1">
        <Field label="Type" value="BYOS (Bring Your Own Server)" />
        <Field label="Host" value={server.publicIp ?? '—'} />
        <p className="text-[11px] text-tertiary italic mt-1">
          Compute, storage, and cost aren&apos;t tracked for BYOS workspaces.
        </p>
      </div>
    )
  }

  const totalStorage = (infra.volumes ?? []).reduce((sum, v) => sum + (v.sizeGB || 0), 0)
  const uptime = infra.launchTime ? formatUptime(infra.launchTime) : null
  const cost = infra.estimatedMonthlyUsd != null ? `~$${infra.estimatedMonthlyUsd.toFixed(2)}/mo` : null

  return (
    <div className="flex flex-col gap-1.5">
      <Field
        label="Compute"
        value={`${infra.instanceType ?? server.instanceType} · ${infra.region ?? server.region ?? '—'}${
          uptime ? ` · up ${uptime}` : ''
        }`}
      />
      {(infra.volumes ?? []).length > 0 && (
        <Field
          label="Storage"
          value={`${totalStorage} GB ${(infra.volumes![0].type || '').toUpperCase()}${
            infra.volumes!.length > 1 ? ` (${infra.volumes!.length} volumes)` : ''
          }`}
        />
      )}
      <Field
        label="Network"
        value={
          <span>
            {server.publicIp ?? '—'}
            {infra.tunnelHostname && (
              <>
                {' · '}
                <a
                  href={`https://${infra.tunnelHostname}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {infra.tunnelHostname}
                </a>
              </>
            )}
          </span>
        }
      />
      {cost && (
        <Field
          label="Cost"
          value={
            <span>
              {cost}{' '}
              <span className="text-tertiary text-[10px]">(estimate, on-demand)</span>
            </span>
          }
        />
      )}
      {(server.agents?.length ?? 0) > 0 && (
        <Field label="Agent" value={(server.agents ?? []).join(', ')} />
      )}
      {(infra.skills?.length ?? 0) > 0 && (
        <Field label="Skills" value={infra.skills!.join(', ')} />
      )}
      {(infra.repos?.length ?? 0) > 0 && (
        <Field label="Repos" value={infra.repos!.join(', ')} />
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 items-baseline">
      <span className="text-[10px] font-medium text-tertiary uppercase tracking-wider">{label}</span>
      <span className="text-[12px] text-bright">{value}</span>
    </div>
  )
}

function formatUptime(launchTime: string): string {
  const launchMs = Date.parse(launchTime)
  if (Number.isNaN(launchMs)) return ''
  const totalMin = Math.max(0, Math.floor((Date.now() - launchMs) / 60_000))
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin % (60 * 24)) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${totalMin % 60}m`
  return `${totalMin}m`
}

/* ── Docs tab ─────────────────────────────────────────────────────── */

function DocsTab({ serverId }: { serverId: string }) {
  const [docs, setDocs] = useState<{ path: string; name: string }[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [truncated, setTruncated] = useState(false)
  const [docLoading, setDocLoading] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { docs } = await listWorkspaceDocs(serverId)
        if (!cancelled) setDocs(docs)
      } catch (err) {
        if (!cancelled) setListError((err as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [serverId])

  async function open(path: string) {
    setSelected(path)
    setDocLoading(true)
    setDocError(null)
    setContent('')
    setTruncated(false)
    try {
      const res = await readWorkspaceDoc(serverId, path)
      setContent(res.content)
      setTruncated(res.truncated)
    } catch (err) {
      setDocError((err as Error).message)
    } finally {
      setDocLoading(false)
    }
  }

  if (listError) {
    return <p className="text-[12px] text-danger">Could not list docs: {listError}</p>
  }
  if (docs === null) {
    return <p className="text-[12px] text-tertiary">Scanning workspace…</p>
  }
  if (docs.length === 0) {
    return (
      <p className="text-[12px] text-tertiary">
        No markdown files under <code className="font-mono text-[11px]">~/projects</code>.
      </p>
    )
  }

  return (
    <div className="grid grid-cols-[200px_1fr] gap-3 min-h-[200px]">
      {/* File list — split directory / filename so users can scan by
          name without losing the path context. The earlier single-line
          `text-secondary` rendering was so low-contrast on light theme
          that the file names looked like a column of dots. */}
      <div
        className="flex flex-col gap-0.5 max-h-[340px] overflow-y-auto pr-1 border-r border-line"
        style={{ scrollbarWidth: 'thin' }}
      >
        {docs.map(d => {
          const slash = d.path.lastIndexOf('/')
          const dir = slash > 0 ? d.path.slice(0, slash + 1) : ''
          const file = slash > 0 ? d.path.slice(slash + 1) : d.path
          const isSelected = selected === d.path
          return (
            <button
              key={d.path}
              onClick={() => open(d.path)}
              title={d.path}
              className={`text-left px-2 py-1.5 rounded cursor-pointer transition-colors flex flex-col min-w-0 ${
                isSelected ? 'bg-accent/10' : 'hover:bg-l2'
              }`}
            >
              <span className={`text-[12px] font-medium truncate ${isSelected ? 'text-accent' : 'text-bright'}`}>
                {file}
              </span>
              {dir && (
                <span className="text-[10px] text-tertiary truncate font-mono">{dir.replace(/\/$/, '')}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Doc body */}
      <div className="rounded-lg border border-line bg-l2/40 p-4 min-h-[200px] max-h-[420px] overflow-y-auto">
        {!selected && (
          <p className="text-[12px] text-tertiary italic">Pick a file on the left to read it.</p>
        )}
        {docLoading && <p className="text-[12px] text-tertiary">Loading…</p>}
        {docError && <p className="text-[12px] text-danger">{docError}</p>}
        {!docLoading && !docError && selected && (
          <>
            <pre className="text-[12px] text-bright font-mono whitespace-pre-wrap break-words leading-relaxed">{content}</pre>
            {truncated && (
              <p className="text-[10px] text-tertiary italic mt-2 pt-2 border-t border-line">
                Truncated at 100KB. Open the file in a session to see more.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
