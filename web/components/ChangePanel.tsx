'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { parseDiff, Diff, Hunk, tokenize, markEdits } from 'react-diff-view'
import type { RenderToken, FileData, HunkData, HunkTokens } from 'react-diff-view'
import { refractor } from 'refractor/core'
import typescript from 'refractor/typescript'
import tsx from 'refractor/tsx'
import javascript from 'refractor/javascript'
import jsx from 'refractor/jsx'
import python from 'refractor/python'
import cssLang from 'refractor/css'
import markdown from 'refractor/markdown'
import jsonLang from 'refractor/json'
import yaml from 'refractor/yaml'
import bash from 'refractor/bash'
import 'react-diff-view/style/index.css'
import {
  getGitDiffSummary,
  getGitDiffFile,
  type GitChangedFile,
  type GitDiffSummary,
  type GitDiffCategory,
} from '@/lib/api'

// Register only the languages we expect to diff. Keeps bundle small.
refractor.register(typescript)
refractor.register(tsx)
refractor.register(javascript)
refractor.register(jsx)
refractor.register(python)
refractor.register(cssLang)
refractor.register(markdown)
refractor.register(jsonLang)
refractor.register(yaml)
refractor.register(bash)

interface Props {
  serverId: string
  sessionId?: string
  onClose: () => void
}

// Ordered, user-facing section metadata.
const SECTIONS: readonly {
  key: GitDiffCategory
  label: string
  dot: string
  hint: string
}[] = [
  { key: 'branch',    label: 'Committed',  dot: 'bg-accent',  hint: 'Committed on this branch, not yet in base' },
  { key: 'staged',    label: 'Staged',     dot: 'bg-green',   hint: 'Added to the index, not yet committed' },
  { key: 'unstaged',  label: 'Unstaged',   dot: 'bg-amber',   hint: 'Modified in the working tree' },
  { key: 'untracked', label: 'Untracked',  dot: 'bg-purple',  hint: 'New files not tracked by git' },
]

const STATUS_LABEL: Record<string, string> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type', '?': 'new',
}
const STATUS_COLOR: Record<string, string> = {
  A: 'bg-green', M: 'bg-amber', D: 'bg-danger', R: 'bg-accent', C: 'bg-accent', T: 'bg-accent', '?': 'bg-purple',
}

// Display form of a branch name in the ribbon. `pe-session-<short>` branches are
// the Tier-1 auto-created worktree branches; they show as "Session <short>"
// because raw machine names confuse users. Everything else shows verbatim.
function formatBranchLabel(name: string): { display: string; title: string } {
  const m = name.match(/^pe-session-([0-9a-f]{6,})$/i)
  if (m) {
    return { display: `Session ${m[1].slice(0, 8)}`, title: name }
  }
  return { display: name, title: name }
}

// Files we never try to render a diff for — rendering a binary as text crashes
// the display and wastes a network round-trip.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|so|dylib|dll|exe|wasm|bin|o|a|class|jar|wav|mp3|mp4|mov|avi|webm|woff2?|ttf|otf|eot|psd|sketch|fig)$/i
function looksBinary(path: string): boolean {
  if (BINARY_EXT.test(path)) return true
  // Heuristic for no-extension binaries (e.g. `hld/hld-linux-amd64`):
  // path segment starts with a name that looks like a compiled artifact.
  const base = path.split('/').pop() ?? ''
  if (!base.includes('.') && /(linux-|darwin-|windows-|amd64|arm64|x86_64)/i.test(base)) return true
  return false
}

// Map file extension → Prism language for syntax highlighting. Unknown = no tokenize.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', css: 'css', scss: 'css', md: 'markdown', mdx: 'markdown',
  json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash',
}
function langFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? null
}

export default function ChangePanel({ serverId, sessionId, onClose }: Props) {
  const [summary, setSummary] = useState<GitDiffSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ branch: true, staged: true, unstaged: true, untracked: false })
  const [openFile, setOpenFile] = useState<{ path: string; category: GitDiffCategory } | null>(null)
  const [fileDiff, setFileDiff] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fetchTokenRef = useRef(0)

  const loadSummary = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await getGitDiffSummary(serverId, sessionId)
      setSummary(res)
    } catch (err) {
      console.error('[ChangePanel] summary fetch failed', err)
      setError('Failed to load changes')
    } finally {
      setLoading(false)
    }
  }, [serverId, sessionId])

  useEffect(() => {
    setOpenFile(null)
    setFileDiff(null)
    setFileError(null)
    void loadSummary()
  }, [loadSummary])

  // Auto-refresh when the window regains focus — simple replacement for a watcher.
  useEffect(() => {
    const onFocus = () => { void loadSummary() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSummary])

  // ─── Derived: category arrays, preferring the new `categories` field ───
  const categories: Record<GitDiffCategory, GitChangedFile[]> = useMemo(() => {
    if (!summary) return { branch: [], staged: [], unstaged: [], untracked: [] }
    if (summary.categories) return summary.categories
    // Legacy server response: bucket the flat list.
    const out: Record<GitDiffCategory, GitChangedFile[]> = { branch: [], staged: [], unstaged: [], untracked: [] }
    for (const f of summary.files) {
      if ((f as unknown as { untracked?: boolean }).untracked || f.status === '?') out.untracked.push(f)
      else if (f.staged) out.branch.push(f) // best guess pre-Ship-1
      else if (f.unstaged) out.unstaged.push(f)
    }
    return out
  }, [summary])

  const totals = useMemo(() => {
    const t = { additions: 0, deletions: 0, files: 0 }
    for (const k of ['branch', 'staged', 'unstaged'] as const) {
      for (const f of categories[k]) {
        t.additions += f.additions ?? 0
        t.deletions += f.deletions ?? 0
      }
    }
    t.files = categories.branch.length + categories.staged.length + categories.unstaged.length + categories.untracked.length
    return t
  }, [categories])

  // ─── Per-file diff load ───
  useEffect(() => {
    if (!openFile) {
      setFileDiff(null)
      setFileError(null)
      return
    }
    const token = ++fetchTokenRef.current
    setFileLoading(true)
    setFileError(null)
    void (async () => {
      try {
        const res = await getGitDiffFile(serverId, openFile.path, sessionId, undefined, openFile.category)
        if (fetchTokenRef.current !== token) return
        setFileDiff(res.diff)
      } catch (err) {
        if (fetchTokenRef.current !== token) return
        console.error('[ChangePanel] diff fetch failed', err)
        setFileError('Failed to load diff')
      } finally {
        if (fetchTokenRef.current === token) setFileLoading(false)
      }
    })()
  }, [openFile, serverId, sessionId])

  // ─── Render ───

  return (
    <div className="h-full w-full flex flex-col border-l border-line bg-ink">
      {/* Header */}
      <div
        className="flex-shrink-0 flex items-center justify-between border-b border-line"
        style={{
          paddingTop: 'max(0.5rem, var(--safe-area-top))',
          paddingBottom: '0.5rem',
          paddingLeft: '0.875rem',
          paddingRight: '0.75rem',
        }}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium">Changes</h3>
          {totals.files > 0 && (
            <span className="text-[10px] text-tertiary bg-l1 px-1.5 py-0.5 rounded">
              {totals.files} file{totals.files === 1 ? '' : 's'}
            </span>
          )}
          {(totals.additions > 0 || totals.deletions > 0) && (
            <span className="text-[10px] font-mono">
              {totals.additions > 0 && <span className="text-green">+{totals.additions}</span>}
              {totals.additions > 0 && totals.deletions > 0 && ' '}
              {totals.deletions > 0 && <span className="text-danger">-{totals.deletions}</span>}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 text-tertiary hover:text-secondary hover:bg-tertiary/10 rounded-md transition-colors cursor-pointer"
          aria-label="Close changes panel"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Branch ribbon */}
      {summary?.branch && (() => {
        const { display: branchDisplay, title: branchTitle } = formatBranchLabel(summary.branch)
        const baseShort = summary.base ? summary.base.replace(/^origin\//, '') : null
        return (
          <div className="flex-shrink-0 px-4 py-2.5 border-b border-line bg-l1/40">
            <div className="flex items-center gap-2 text-[12px]">
              <svg className="w-3.5 h-3.5 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 100 6 3 3 0 000-6zm12-6a3 3 0 11-6 0 3 3 0 016 0zm0 0v6a3 3 0 01-3 3h-6" />
              </svg>
              <span
                className="font-mono text-bright truncate min-w-0"
                title={branchTitle}
              >
                {branchDisplay}
              </span>
              {baseShort && summary.branch !== baseShort && (
                <>
                  <span className="text-tertiary">→</span>
                  <span className="font-mono text-secondary truncate min-w-0" title={summary.base ?? undefined}>
                    {baseShort}
                  </span>
                </>
              )}
            </div>
            {(summary.ahead ?? 0) > 0 || (summary.behind ?? 0) > 0 ? (
              <div className="flex items-center gap-3 mt-1 text-[11px] text-tertiary">
                {(summary.ahead ?? 0) > 0 && <span>{summary.ahead} ahead</span>}
                {(summary.behind ?? 0) > 0 && <span>{summary.behind} behind</span>}
              </div>
            ) : null}
          </div>
        )
      })()}

      {/* Body */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {loading && !summary ? (
          <SkeletonList />
        ) : error ? (
          <div className="p-6 text-center">
            <p className="text-[12px] text-danger mb-3">{error}</p>
            <button onClick={loadSummary} className="btn btn-secondary btn-sm">Retry</button>
          </div>
        ) : totals.files === 0 ? (
          <EmptyState branch={summary?.branch ?? null} base={summary?.base ?? null} />
        ) : (
          <div className="py-1">
            {SECTIONS.map(({ key, label, dot, hint }) => {
              const files = categories[key]
              if (files.length === 0) return null
              const isExpanded = expanded[key] ?? true
              const sectionTotal = files.reduce(
                (acc, f) => ({ add: acc.add + (f.additions ?? 0), del: acc.del + (f.deletions ?? 0) }),
                { add: 0, del: 0 },
              )
              return (
                <section key={key} className="border-b border-line/40 last:border-b-0">
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [key]: !isExpanded }))}
                    className="w-full flex items-center gap-2 px-4 py-2 hover:bg-l1 transition-colors cursor-pointer text-left"
                    title={hint}
                  >
                    <Chevron open={isExpanded} />
                    <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                    <span className="text-[12px] font-medium text-secondary">{label}</span>
                    <span className="text-[11px] text-tertiary">{files.length}</span>
                    <div className="ml-auto text-[11px] font-mono">
                      {sectionTotal.add > 0 && <span className="text-green">+{sectionTotal.add}</span>}
                      {sectionTotal.add > 0 && sectionTotal.del > 0 && ' '}
                      {sectionTotal.del > 0 && <span className="text-danger">-{sectionTotal.del}</span>}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="pb-1">
                      {files.map(file => {
                        const isOpen = openFile?.path === file.path && openFile.category === key
                        const binary = looksBinary(file.path)
                        return (
                          <div key={`${key}:${file.path}`}>
                            <button
                              onClick={() => {
                                if (binary) return
                                setOpenFile(isOpen ? null : { path: file.path, category: key })
                              }}
                              className={`w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-left transition-colors ${
                                binary ? 'cursor-default opacity-60' : 'hover:bg-l1 cursor-pointer'
                              } ${isOpen ? 'bg-l1 sticky top-0 z-10 backdrop-blur-sm border-b border-line/60' : ''}`}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLOR[file.status] ?? 'bg-tertiary'}`}
                                title={STATUS_LABEL[file.status] ?? file.status}
                              />
                              <span className="text-[12px] font-mono flex-1 truncate text-bright">{file.path}</span>
                              {binary && <span className="text-[10px] text-tertiary">binary</span>}
                              {!binary && (file.additions || file.deletions) ? (
                                <span className="text-[11px] font-mono flex-shrink-0">
                                  {file.additions ? <span className="text-green">+{file.additions}</span> : null}
                                  {file.additions && file.deletions ? ' ' : null}
                                  {file.deletions ? <span className="text-danger">-{file.deletions}</span> : null}
                                </span>
                              ) : null}
                            </button>

                            {isOpen && (
                              <div className="border-y border-line bg-l1/30">
                                {fileLoading ? (
                                  <div className="flex items-center justify-center p-6">
                                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent border-t-transparent" />
                                  </div>
                                ) : fileError ? (
                                  <div className="p-4 text-center text-[11px] text-danger">{fileError}</div>
                                ) : fileDiff ? (
                                  <DiffBody diffText={fileDiff} filePath={file.path} />
                                ) : (
                                  <div className="p-4 text-center text-[11px] text-tertiary">No diff content</div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

function SkeletonList() {
  return (
    <div className="py-1">
      {[0, 1, 2].map(i => (
        <div key={i} className="px-4 py-2">
          <div className="h-3 w-20 bg-l1 rounded mb-2 animate-pulse" />
          <div className="space-y-1.5 pl-5">
            <div className="h-3 w-3/4 bg-l1 rounded animate-pulse" />
            <div className="h-3 w-2/3 bg-l1 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ branch, base }: { branch: string | null; base: string | null }) {
  const branchLabel = branch ? formatBranchLabel(branch).display : null
  const baseLabel = base ? base.replace(/^origin\//, '') : null
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <svg className="w-10 h-10 text-green/70 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-[13px] font-medium text-secondary">No changes</p>
      {branchLabel && baseLabel ? (
        <p className="text-[11px] text-tertiary mt-1">
          <span className="text-secondary font-mono">{branchLabel}</span> is in sync with{' '}
          <span className="text-secondary font-mono">{baseLabel}</span>
        </p>
      ) : (
        <p className="text-[11px] text-tertiary mt-1">Working tree is clean.</p>
      )}
    </div>
  )
}

/**
 * Renders a unified diff with syntax highlighting.
 * The incoming diff from the backend is a single-file git diff string; parseDiff returns
 * an array of FileData. For category=untracked the script already emits a valid
 * `--- /dev/null / +++ b/path` header so the parser handles it.
 */
function DiffBody({ diffText, filePath }: { diffText: string; filePath: string }) {
  const files = useMemo<FileData[]>(() => {
    try {
      return parseDiff(diffText, { nearbySequences: 'zip' })
    } catch {
      return []
    }
  }, [diffText])

  const lang = langFor(filePath)
  // Compose markEdits (word-level add/remove highlighting within a changed
  // line) with Prism syntax-highlighting. Both run on the same hunks.
  const tokens: HunkTokens | undefined = useMemo(() => {
    if (!files[0]) return undefined
    const hunks = files[0].hunks as HunkData[]
    const enhancers = [markEdits(hunks, { type: 'block' })]
    try {
      const opts = lang
        ? { highlight: true as const, refractor, language: lang, enhancers }
        : { highlight: false as const, enhancers }
      return tokenize(hunks, opts) ?? undefined
    } catch {
      return undefined
    }
  }, [files, lang])

  const renderToken: RenderToken = (token, defaultRender, i) => defaultRender(token, i)

  if (!files.length || !files[0].hunks.length) {
    return (
      <div className="p-4 text-center text-[11px] text-tertiary font-mono">
        (empty diff)
      </div>
    )
  }

  return (
    <div className="pe-diff text-[11.5px] leading-[1.55] overflow-x-auto">
      {files.map((file, idx) => (
        <Diff
          key={idx}
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
          gutterType="default"
          renderToken={renderToken}
        >
          {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  )
}
