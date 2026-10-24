'use client'

// Team management — extracted from `/dashboard/settings` so the sidebar
// can link straight here. Settings keeps a small "Manage your team →"
// card so the Settings tab on mobile still discovers this page.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  acceptTeamInvite,
  createTeam,
  createTeamInvite,
  getMyTeam,
  listPendingTeamInvites,
  removeTeamMember,
  renameTeam,
  updateTeamMemberRole,
  type Team,
  type TeamInvite,
  type TeamMember,
} from '@/lib/api'
import { getRestoredSession } from '@/lib/supabase'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-tertiary uppercase tracking-widest mb-3">{title}</p>
      <div className="card-surface">
        {children}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="px-5 py-4 flex flex-col gap-2.5 border-b border-line last:border-b-0">
      <p className="text-[13px] text-bright font-medium">{label}</p>
      {children}
    </div>
  )
}

export default function TeamPage() {
  const router = useRouter()

  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [team, setTeam] = useState<Team | null>(null)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [teamInvites, setTeamInvites] = useState<TeamInvite[]>([])
  const [pendingInvites, setPendingInvites] = useState<TeamInvite[]>([])
  const [teamName, setTeamName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [teamBusy, setTeamBusy] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  async function reloadTeamState() {
    const [teamResult, pendingResult] = await Promise.all([
      getMyTeam().catch(() => ({ team: null, members: [], invites: [] })),
      listPendingTeamInvites().catch(() => ({ invites: [] })),
    ])
    setTeam(teamResult.team)
    setTeamMembers(teamResult.members)
    setTeamInvites(teamResult.invites)
    setPendingInvites(pendingResult.invites)
    setTeamName(teamResult.team?.name ?? '')
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await getRestoredSession()
      if (cancelled) return
      if (!session) { router.replace('/'); return }
      setCurrentUserId(session.user.id)
      try { await reloadTeamState() } catch { /* ignore */ }
      if (!cancelled) setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [router])

  async function handleCreateTeam() {
    if (!teamName.trim()) return
    setTeamBusy(true); setTeamError(null)
    try {
      await createTeam(teamName.trim())
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  async function handleRenameTeam() {
    if (!team?.teamId || !teamName.trim()) return
    setTeamBusy(true); setTeamError(null)
    try {
      await renameTeam(team.teamId, teamName.trim())
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  async function handleInvite() {
    if (!team?.teamId || !inviteEmail.trim()) return
    setTeamBusy(true); setTeamError(null)
    try {
      await createTeamInvite(team.teamId, inviteEmail.trim(), inviteRole)
      setInviteEmail('')
      setInviteRole('member')
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  async function handleAcceptInvite(inviteId: string) {
    setTeamBusy(true); setTeamError(null)
    try {
      await acceptTeamInvite(inviteId)
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  async function handleChangeMemberRole(userId: string, role: 'admin' | 'member') {
    if (!team?.teamId) return
    setTeamBusy(true); setTeamError(null)
    try {
      await updateTeamMemberRole(team.teamId, userId, role)
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!team?.teamId) return
    setTeamBusy(true); setTeamError(null)
    try {
      await removeTeamMember(team.teamId, userId)
      await reloadTeamState()
    } catch (err) {
      setTeamError((err as Error).message)
    } finally {
      setTeamBusy(false)
    }
  }

  return (
    <div className="px-5 md:px-8 py-4 md:py-8 max-w-xl animate-fade-in">
      <div className="hidden md:block mb-8">
        <h1 className="text-[16px] font-semibold text-bright tracking-tight">Team</h1>
        <p className="text-[12px] text-tertiary mt-1">
          {team ? 'Manage members and invites.' : 'Create a team or accept an invite.'}
        </p>
      </div>

      <div className="flex flex-col gap-6 md:gap-8">
        <Section title="Team">
          <Row label="Team account">
            <div className="flex flex-col gap-3">
              {!loaded ? (
                <p className="text-[12px] text-tertiary">Loading…</p>
              ) : team ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      value={teamName}
                      onChange={e => setTeamName(e.target.value)}
                      disabled={teamBusy || team.role !== 'admin'}
                      className="input flex-1"
                    />
                    {team.role === 'admin' && (
                      <button
                        onClick={handleRenameTeam}
                        disabled={teamBusy || !teamName.trim()}
                        className="btn btn-secondary cursor-pointer"
                      >
                        Save
                      </button>
                    )}
                  </div>
                  <p className="text-[12px] text-secondary">
                    You are a <span className="text-bright">{team.role}</span>. New workspaces default to team-owned, but can still be created as personal.
                  </p>
                  {team.role === 'admin' && (
                    <div className="rounded-xl border border-line p-3 flex flex-col gap-2">
                      <p className="text-[12px] text-bright font-medium">Invite member</p>
                      <div className="flex gap-2">
                        <input
                          value={inviteEmail}
                          onChange={e => setInviteEmail(e.target.value)}
                          placeholder="name@example.com"
                          className="input flex-1 min-w-0"
                        />
                        <select
                          value={inviteRole}
                          onChange={e => setInviteRole(e.target.value as 'admin' | 'member')}
                          className="input shrink-0"
                          style={{ width: '7rem' }}
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={handleInvite}
                          disabled={teamBusy || !inviteEmail.trim()}
                          className="btn btn-secondary cursor-pointer shrink-0"
                        >
                          Invite
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {teamMembers.map(member => (
                      <div key={member.userId} className="rounded-xl border border-line px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] text-bright truncate">
                            {member.userId === currentUserId ? 'You' : (member.email || member.userId)}
                          </p>
                          <p className="text-[11px] text-tertiary">{member.role}</p>
                        </div>
                        {team.role === 'admin' && member.userId !== currentUserId && (
                          <>
                            <button
                              onClick={() => handleChangeMemberRole(member.userId, member.role === 'admin' ? 'member' : 'admin')}
                              disabled={teamBusy}
                              className="text-[11px] text-tertiary hover:text-secondary cursor-pointer"
                            >
                              Make {member.role === 'admin' ? 'member' : 'admin'}
                            </button>
                            <button
                              onClick={() => handleRemoveMember(member.userId)}
                              disabled={teamBusy}
                              className="text-[11px] text-danger cursor-pointer"
                            >
                              Remove
                            </button>
                          </>
                        )}
                        {member.userId === currentUserId && (
                          <button
                            onClick={() => handleRemoveMember(member.userId)}
                            disabled={teamBusy}
                            className="text-[11px] text-danger cursor-pointer"
                          >
                            Leave
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {team.role === 'admin' && (() => {
                    // Only count an invite as "pending" if it is both
                    // status=pending AND hasn't aged past its expiresAt.
                    // Without the expiry check the admin list shows
                    // technically-dead invites the recipient can no longer
                    // accept; without the post-filter length check the
                    // section header renders with an empty body when only
                    // accepted/revoked rows remain.
                    const now = Date.now()
                    const visible = teamInvites.filter(i =>
                      i.status === 'pending' && (!i.expiresAt || new Date(i.expiresAt).getTime() > now)
                    )
                    if (visible.length === 0) return null
                    return (
                      <div className="flex flex-col gap-2">
                        <p className="text-[12px] text-bright font-medium">Pending invites</p>
                        {visible.map(invite => (
                          <div key={invite.inviteId} className="rounded-xl border border-line px-3 py-2 text-[12px] text-secondary">
                            {invite.email} · {invite.role}
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </>
              ) : (
                <>
                  <p className="text-[12px] text-secondary">You are not currently on a team.</p>
                  <div className="flex gap-2">
                    <input
                      value={teamName}
                      onChange={e => setTeamName(e.target.value)}
                      placeholder="Team name"
                      className="input flex-1"
                    />
                    <button
                      onClick={handleCreateTeam}
                      disabled={teamBusy || !teamName.trim()}
                      className="btn btn-secondary cursor-pointer"
                    >
                      Create team
                    </button>
                  </div>
                  {pendingInvites.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[12px] text-bright font-medium">Pending invites</p>
                      {pendingInvites.map(invite => (
                        <div key={invite.inviteId} className="rounded-xl border border-line px-3 py-2 flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] text-bright">{invite.teamName || invite.teamId}</p>
                            <p className="text-[11px] text-tertiary">{invite.role}</p>
                          </div>
                          <button
                            onClick={() => handleAcceptInvite(invite.inviteId)}
                            disabled={teamBusy}
                            className="btn btn-secondary cursor-pointer"
                          >
                            Accept
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {teamError && <p className="text-[11px] text-danger">{teamError}</p>}
            </div>
          </Row>
        </Section>

        <Link
          href="/dashboard/settings"
          className="text-[12px] text-tertiary hover:text-secondary transition-colors self-start"
        >
          ← Back to Settings
        </Link>
      </div>
    </div>
  )
}
