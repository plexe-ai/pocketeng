'use client'

// RepoQuickPicker — onboarding-only repo selector.
//
// Kept intentionally thin (vs. the full ProvisionForm repo UI): single-select,
// recent-sort, search box, no multi-select checkboxes, no advanced filters.
// The goal is <3-minute onboarding — anything more than "pick one and go"
// belongs in the post-onboarding ProvisionForm on /dashboard.

import { useEffect, useMemo, useState } from 'react'
import { hapticSelection, hapticLight } from '@/lib/native'

interface Repo {
  full_name: string
  name: string
  private: boolean
  description: string | null
  pushed_at?: string
}

interface GithubRepoRaw {
  full_name: string
  name: string
  private: boolean
  description: string | null
  pushed_at?: string
}

export function RepoQuickPicker({
  githubToken,
  onSelect,
  onSkip,
  disabled,
}: {
  githubToken: string
  onSelect: (fullName: string) => void
  onSkip: () => void
  disabled?: boolean
}) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setFetching(true)
      setError(null)
      try {
        const res = await fetch(
          'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
          { headers: { Authorization: `Bearer ${githubToken}` } },
        )
        if (!res.ok) {
          // 401 = token revoked/expired; anything else = transient.
          throw new Error(
            res.status === 401
              ? 'GitHub connection expired. Go back a step to reconnect.'
              : `GitHub API error (${res.status}).`,
          )
        }
        const data: GithubRepoRaw[] = await res.json()
        if (cancelled) return
        setRepos(
          data.map(r => ({
            full_name: r.full_name,
            name: r.name,
            private: r.private,
            description: r.description,
            pushed_at: r.pushed_at,
          })),
        )
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load repos.')
      } finally {
        if (!cancelled) setFetching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [githubToken])

  const filtered = useMemo(() => {
    if (!query.trim()) return repos
    const q = query.toLowerCase()
    return repos.filter(
      r =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q),
    )
  }, [repos, query])

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search repos…"
          disabled={disabled || fetching}
          className="w-full h-10 rounded-lg border border-line bg-l1 px-3.5 text-[13.5px] text-bright placeholder:text-tertiary focus:outline-none focus:border-line2 disabled:opacity-60"
        />
      </div>

      {/* List */}
      <div
        className="rounded-xl border border-line bg-l1 overflow-hidden"
        // Cap list height so the "Skip for now" button stays visible above the
        // fold on short viewports (onboarding runs inside a max-w-480 column).
        style={{ maxHeight: 320, overflowY: 'auto' }}
      >
        {fetching ? (
          <RepoSkeleton />
        ) : error ? (
          <div className="p-6 text-center">
            <p className="text-[13px] text-danger">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-[13px] text-tertiary">
              {repos.length === 0 ? 'No repos found on your GitHub account.' : 'No matches.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map(repo => (
              <li key={repo.full_name}>
                <button
                  onClick={() => {
                    // iOS selection haptic — matches the "picked a row" feel
                    // of a native picker. No-ops on web.
                    void hapticSelection()
                    onSelect(repo.full_name)
                  }}
                  disabled={disabled}
                  className="w-full text-left px-4 py-3 hover:bg-l2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13.5px] font-medium text-bright truncate">
                      {repo.full_name}
                    </span>
                    {repo.private && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-line text-tertiary flex-shrink-0">
                        private
                      </span>
                    )}
                    <svg
                      className="w-4 h-4 text-tertiary group-hover:text-bright transition-colors ml-auto flex-shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                  {repo.description && (
                    <p className="text-[12px] text-tertiary mt-0.5 truncate">
                      {repo.description}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Skip — always available; provisioning a blank workspace is a real
          choice for users who want to start from scratch. */}
      <button
        onClick={() => {
          // Lighter haptic for "skip" — less committed than picking a repo.
          void hapticLight()
          onSkip()
        }}
        disabled={disabled}
        className="text-[12px] text-tertiary hover:text-bright transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer self-center underline-offset-2 hover:underline"
      >
        Skip for now — start with a blank workspace
      </button>
    </div>
  )
}

function RepoSkeleton() {
  return (
    <ul className="divide-y divide-line">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className="px-4 py-3">
          <div className="h-3.5 w-2/3 rounded bg-l2 animate-pulse mb-1.5" />
          <div className="h-3 w-1/2 rounded bg-l2 animate-pulse" />
        </li>
      ))}
    </ul>
  )
}
