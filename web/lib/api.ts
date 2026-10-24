import { supabase } from './supabase'

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL

export interface AgentReadiness {
  installed?: boolean | null
  authenticated?: boolean | null
  credentialStatus?: string | null
  error?: string | null
}

/** Written by FinalizeFunction after each stage of workspace prep. The UI
 * treats status === 'ready' as the gate for opening the workspace. */
export interface Readiness {
  status: 'provisioning' | 'installing' | 'authenticating' | 'ready' | 'failed'
  stage:
    | 'booting-ec2'
    | 'awaiting-ip'
    | 'awaiting-ssh'
    | 'installing-agents'
    | 'pushing-credentials'
    | 'verifying-auth'
    | 'done'
    | 'error'
  agents?: Record<string, AgentReadiness>
  error?: string | null
  updatedAt?: string
}

/** One user-declared service slice in the workspace. Free-form metadata —
 *  the backend doesn't reach out to verify that anything is actually
 *  listening on `port`; the ServerCard cross-references the auto-discovered
 *  services list to show a live status dot. */
export interface WorkspaceComponent {
  name: string
  role?: string
  port?: number
}

/** Per-workspace infrastructure block. Populated by GET /servers/{id} only
 *  (StatusFunction queries EC2 for volumes / launch time / cost estimate).
 *  The list endpoint omits this — too expensive to query per row. */
export interface WorkspaceInfra {
  instanceType?: string
  region?: string | null
  launchTime?: string | null
  volumes?: { id: string; sizeGB: number; type: string }[]
  tunnelHostname?: string | null
  estimatedMonthlyUsd?: number | null
  skills?: string[]
  repos?: string[]
  /** BYOS workspaces emit `{ byos: true }` — there's no EC2 to query. */
  byos?: boolean
}

export interface Server {
  serverId: string
  instanceId: string
  instanceState: string
  publicIp: string | null
  region: string
  envType: 'general' | 'byos'
  instanceType: string
  autoStopMinutes: number | null
  createdAt: string | null
  lastActivityAt: string | null
  sshPrivateKey: string | null
  agents?: string[]
  repos?: string[]
  hasVercel?: boolean
  hasSupabase?: boolean
  label?: string
  services?: { port: number; process: string; url: string }[]
  envVars?: Record<string, string>
  ownerType?: 'personal' | 'team'
  teamId?: string | null
  createdByUserId?: string | null
  /** Populated by StatusFunction from the readiness object FinalizeFunction
   * writes to DynamoDB. `null`/undefined for legacy servers provisioned before
   * this shipped — UI treats undefined as "ready" for backwards compat. */
  readiness?: Readiness | null
  /** User-editable architecture overview (Arch tab). Available on both
   *  GET /servers (list) and GET /servers/{id} (single). */
  description?: string | null
  components?: WorkspaceComponent[]
  /** Auto-queried infra metadata (Infra tab). Single-server endpoint only. */
  infra?: WorkspaceInfra | null
}

/** Manually retry finalize for a workspace (POST /servers/{id}/finalize).
 *  Safe to call repeatedly — it's idempotent on the backend. */
export async function finalizeServer(serverId: string): Promise<{ readiness: Readiness }> {
  const res = await fetch(`${BASE}/servers/${serverId}/finalize`, {
    method: 'POST',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

/** Look up how many sessions the caller has run on trial-mode
 *  workspaces. Drives the sidebar "X trial sessions used" widget.
 *  Backend soft-fails to {used: 0, hasTrialWorkspace: false} on any
 *  error, so the widget hides quietly when the API is unreachable. */
export async function getTrialUsage(): Promise<{
  trialSessionsUsed: number
  hasTrialWorkspace: boolean
}> {
  try {
    const res = await fetch(`${BASE}/account/trial-usage`, {
      headers: await authHeaders(),
    })
    if (!res.ok) return { trialSessionsUsed: 0, hasTrialWorkspace: false }
    return await res.json()
  } catch {
    return { trialSessionsUsed: 0, hasTrialWorkspace: false }
  }
}

/** Fire the onboarding welcome email (POST /account/welcome).
 *  Called from /onboarding mount; idempotent on the backend via
 *  Supabase user_metadata.welcomeEmailSent. Returns whether the email
 *  actually went out — caller doesn't need to do anything with the
 *  response, it's purely informational for debugging. */
export async function triggerWelcomeEmail(): Promise<{ sent: boolean; reason?: string }> {
  try {
    const res = await fetch(`${BASE}/account/welcome`, {
      method: 'POST',
      headers: await authHeaders(),
    })
    if (!res.ok) return { sent: false, reason: `http-${res.status}` }
    return await res.json()
  } catch {
    // Network error or whatever. Not worth retrying client-side; the
    // user gets a duplicate next visit at worst, no email at worst.
    return { sent: false, reason: 'network-error' }
  }
}


async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }
  return headers
}

async function handleResponse<T>(res: Response): Promise<T> {
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(res.ok ? `Server error: unexpected response` : `HTTP ${res.status}: ${text.slice(0, 100)}`)
  }
  if (!res.ok) throw new Error((json.error as string) ?? `HTTP ${res.status}`)
  return json as T
}

/* ── Push device registration ── */

export async function registerPushDevice(params: {
  installationId: string
  token: string
  platform: 'ios' | 'android'
  pushEnvironment: 'sandbox' | 'production'
  bundleId?: string
  appVersion?: string
  deviceName?: string
}): Promise<{ ok: boolean; installationId: string }> {
  const res = await fetch(`${BASE}/devices/push`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  })
  return handleResponse(res)
}

export async function unregisterPushDevice(installationId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/devices/push`, {
    method: 'DELETE',
    headers: await authHeaders(),
    body: JSON.stringify({ installationId }),
  })
  return handleResponse(res)
}

/**
 * Transcribe a voice prompt via the backend Whisper proxy. Client records
 * audio via MediaRecorder, base64-encodes the Blob, and posts here; backend
 * forwards to OpenAI, returns the text. Separate function (not a server-
 * scoped endpoint) because transcription has nothing to do with an EC2
 * workspace — any signed-in user can call it from any surface.
 */
export async function transcribeAudio(audioBase64: string, mime: string): Promise<{ text: string }> {
  const res = await fetch(`${BASE}/transcribe`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ audio: audioBase64, mime }),
  })
  return handleResponse(res)
}

export async function listServers(): Promise<{ servers: Server[] }> {
  const res = await fetch(`${BASE}/servers`, { headers: await authHeaders() })
  return handleResponse(res)
}

export async function getServer(serverId: string): Promise<Server> {
  const res = await fetch(`${BASE}/servers/${serverId}`, { headers: await authHeaders() })
  return handleResponse(res)
}

export async function provisionServer(params: {
  label?: string
  anthropicApiKey?: string
  openaiApiKey?: string
  cursorApiKey?: string
  githubUsername?: string
  githubToken?: string
  agents?: string[]
  repos?: string[]
  envType?: 'general'
  vercelToken?: string
  supabaseUrl?: string
  supabaseServiceKey?: string
  skills?: string[]
  customSkills?: { name: string; content: string }[]
  envVars?: Record<string, string>
  setupFiles?: { name: string; content: string }[]
  setupInstructions?: string
  ownerType?: 'personal' | 'team'
  teamId?: string
  /** Quick-start / trial flow. When true AND no anthropicApiKey is
   *  supplied, the backend substitutes PE's shared trial key so the user
   *  can start chatting on their first workspace without pasting an API
   *  key. The server record is marked `trial: true` for later metering.
   *  Ignored if the user already supplied their own key. */
  trial?: boolean
}): Promise<{ serverId: string; instanceId: string; status: string; region: string; envType: string; instanceType: string; label?: string }> {
  const res = await fetch(`${BASE}/servers`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  })
  return handleResponse(res)
}

export async function connectServer(params: {
  host: string
  sshUser?: string
  sshPrivateKey: string
  label?: string
}): Promise<{ serverId: string; agents?: string[]; warning?: string }> {
  const res = await fetch(`${BASE}/servers`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ envType: 'byos', ...params }),
  })
  return handleResponse(res)
}

export async function installAgent(serverId: string, agent: string = 'claude'): Promise<{ status: string; agent: string; agents?: string[]; credentialStatus?: Record<string, string> }> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'install-agent', agent }),
  })
  return handleResponse(res)
}

export async function renameServer(serverId: string, label: string): Promise<{ status: string; label: string }> {
  const res = await fetch(`${BASE}/servers/${serverId}/action`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'rename', label }),
  })
  return handleResponse(res)
}

export async function serverAction(serverId: string, action: 'start' | 'stop' | 'terminate'): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/servers/${serverId}/action`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action }),
  })
  return handleResponse(res)
}

export async function smsRegister(params: {
  phoneNumber: string
  defaultServerId?: string
}): Promise<{ ok: boolean; phoneNumber: string; defaultServerId: string | null }> {
  const res = await fetch(`${BASE}/sms/register`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  })
  return handleResponse(res)
}

export async function runCommand(serverId: string, command: string): Promise<{ command: string; output: string }> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'run-command', command }),
  })
  return handleResponse(res)
}

export async function discoverServices(serverId: string): Promise<{ services: { port: number; process: string; url: string }[] }> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'discover-services' }),
  })
  return handleResponse(res)
}

/** Persist the user-curated Architecture overview (description +
 *  components list shown in the Arch tab). Either field may be omitted
 *  to leave it unchanged. Admin-only on team workspaces (enforced
 *  backend-side via can_manage_owned_resource). */
export async function updateWorkspaceOverview(
  serverId: string,
  params: { description?: string; components?: WorkspaceComponent[] },
): Promise<{ status: string; description?: string; components?: WorkspaceComponent[] }> {
  const res = await fetch(`${BASE}/servers/${serverId}/action`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'update-overview', ...params }),
  })
  return handleResponse(res)
}

/** List markdown docs under ~/projects on the workspace. Backed by SSH
 *  find — only .md / .MD / .markdown files, depth-capped, prunes
 *  node_modules / .git / build dirs. */
export async function listWorkspaceDocs(serverId: string): Promise<{
  docs: { path: string; name: string }[]
}> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'list-docs' }),
  })
  return handleResponse(res)
}

/** Read one markdown doc from the workspace. Path is RELATIVE to
 *  ~/projects (e.g. "recsys/README.md"). 100KB cap; truncated=true
 *  when the file was larger and we returned a prefix. */
export async function readWorkspaceDoc(
  serverId: string,
  path: string,
): Promise<{ path: string; content: string; truncated: boolean }> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'read-doc', path }),
  })
  return handleResponse(res)
}

/** Heuristic-scan the workspace for components to populate the Arch
 *  panel. Reads listening ports, docker-compose services, and Python /
 *  Node dependency manifests — no agent invocation, no cost. Designed
 *  to take the friction out of "describe my architecture": the user
 *  clicks Auto-detect, sees suggestions, accepts or tweaks. */
export async function detectWorkspaceArchitecture(serverId: string): Promise<{
  suggestions: WorkspaceComponent[]
}> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'detect-architecture' }),
  })
  return handleResponse(res)
}

export async function updateEnvVars(serverId: string, envVars: Record<string, string>): Promise<{ status: string; envVars: Record<string, string>; applied: boolean; note: string | null }> {
  const res = await fetch(`${BASE}/servers/${serverId}/action`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'update-env-vars', envVars }),
  })
  return handleResponse(res)
}

export interface ChatSession {
  sessionId: string
  pid: string
}

export interface UploadedImage {
  /** Absolute path on the EC2 instance (e.g. /tmp/pe-uploads/paste-123.png). */
  path: string
  /** MIME type, e.g. "image/png". */
  mediaType: string
}

export async function startChatSession(
  serverId: string,
  prompt: string,
  agent = 'claude',
  model?: string,
  autopilot?: boolean,
  setupSession?: boolean,
  images?: UploadedImage[],
): Promise<ChatSession> {
  const body: Record<string, unknown> = { action: 'start-session', prompt, agent }
  if (model) body.model = model
  if (autopilot) body.autopilot = true
  if (setupSession) body.setupSession = true
  if (images?.length) body.images = images
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  return handleResponse(res)
}

export async function sendChatMessage(
  serverId: string,
  sessionId: string,
  prompt: string,
  agent?: string,
  model?: string,
  images?: UploadedImage[],
): Promise<ChatSession> {
  const body: Record<string, unknown> = { action: 'send-message', sessionId, prompt }
  if (agent) body.agent = agent
  if (model) body.model = model
  if (images?.length) body.images = images
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  return handleResponse(res)
}

/* ── Session events (phase 2 — replaces pollChatOutput for live reads) ── */

export type SessionEventKind =
  | 'run.started'
  | 'assistant.message'
  // Token-level streaming chunk. Claude bridge emits one per
  // content_block_delta when `includePartialMessages: true` is set,
  // so the UI can append text as it arrives instead of waiting for
  // the complete message.
  | 'assistant.text_delta'
  | 'tool.started'
  | 'tool.finished'
  | 'status'
  | 'run.finished'
  | 'heartbeat'

export interface SessionEvent {
  sessionId: string
  seq: number
  kind: SessionEventKind
  payload: Record<string, unknown>
  createdAt: string
  turnId?: string | null
}

export interface SessionEventsResponse {
  events: SessionEvent[]
  nextCursor: number
  sessionStatus: 'running' | 'done' | 'cancelled' | 'error'
  lastEventAt: string | null
  serverClock: string
}

export async function getSessionEvents(
  sessionId: string,
  afterSeq?: number,
  /** Optional — caller can cancel a fetch that is no longer relevant (e.g.
   *  the app was backgrounded and iOS WKWebView / throttled Chromium left
   *  the request suspended, defeating the client's single-flight guard).
   *  If omitted, request runs to completion as before. */
  signal?: AbortSignal,
): Promise<SessionEventsResponse> {
  const suffix = typeof afterSeq === 'number' ? `?after=${afterSeq}` : ''
  const res = await fetch(`${BASE}/sessions/${sessionId}/events${suffix}`, {
    headers: await authHeaders(),
    signal,
  })
  return handleResponse(res)
}

export async function cancelChat(serverId: string, sessionId: string, pid = ''): Promise<{ status: string }> {
  const res = await fetch(`${BASE}/servers/${serverId}/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'cancel', sessionId, pid }),
  })
  return handleResponse(res)
}

export interface ChatSessionRecord {
  sessionId: string
  serverId: string
  userId: string
  ownerType?: 'personal' | 'team'
  teamId?: string
  createdByUserId?: string
  createdAt: string
  updatedAt: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  prompt: string
  lastPrompt?: string
  /** User-supplied session title. When absent, UI derives one from prompt. */
  title?: string
  agent: string
  /** Model id for this session (e.g. "claude-opus-4", "gpt-5-codex") */
  model?: string
  remoteSessionId?: string
  nextSeq?: number
  currentRunSeqBase?: number
  currentRunOffset?: number
  lastEventSeq?: number
  autopilot?: boolean
  setupSession?: boolean
  prUrl?: string
  /** Tier 1 worktree fields, persisted since the Apr 17 backend deploy. */
  worktreePath?: string
  repoDir?: string
  branchName?: string
  /** Whether this session is pinned to the top of the sidebar. */
  pinned?: boolean
}

export interface ChatMessage {
  sessionId: string
  seq: number
  role: 'user' | 'agent'
  content: string
  createdAt: string
}

export interface ChatToolActivity {
  toolName: string
  input: string
  inputDataJSON?: string | null
  output?: string | null
  isError: boolean
  createdAt: string
}

export interface ChatTranscriptMessage {
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  state?: 'complete' | 'error' | 'interrupted' | 'streaming'
  tools?: ChatToolActivity[]
}

export async function getSessions(serverId: string, limit = 20): Promise<{ sessions: ChatSessionRecord[] }> {
  const res = await fetch(`${BASE}/servers/${serverId}/sessions?limit=${limit}`, {
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function deleteSession(sessionId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function renameSession(sessionId: string, title: string): Promise<ChatSessionRecord> {
  const res = await fetch(`${BASE}/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ title }),
  })
  return handleResponse(res)
}

export async function pinSession(sessionId: string, pinned: boolean): Promise<ChatSessionRecord> {
  const res = await fetch(`${BASE}/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ pinned }),
  })
  return handleResponse(res)
}

export async function deleteAccount(params?: {
  hasAppleIdentity?: boolean
  appleAccessToken?: string
  appleRefreshToken?: string
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/account`, {
    method: 'DELETE',
    headers: await authHeaders(),
    body: JSON.stringify(params ?? {}),
  })
  return handleResponse(res)
}

export interface TeamMember {
  userId: string
  teamId: string
  role: 'admin' | 'member'
  status: string
  joinedAt?: string
  email?: string | null
}

export interface Team {
  teamId: string
  name: string
  billingOwnerUserId: string
  createdAt?: string
  role: 'admin' | 'member'
}

export interface TeamInvite {
  inviteId: string
  teamId: string
  email: string
  role: 'admin' | 'member'
  status: string
  createdAt: string
  expiresAt: string
  teamName?: string | null
}

export async function getMyTeam(): Promise<{ team: Team | null; members: TeamMember[]; invites: TeamInvite[] }> {
  const res = await fetch(`${BASE}/teams/me`, { headers: await authHeaders() })
  return handleResponse(res)
}

export async function createTeam(name: string): Promise<{ team: Team }> {
  const res = await fetch(`${BASE}/teams`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ name }),
  })
  return handleResponse(res)
}

export async function renameTeam(teamId: string, name: string): Promise<{ ok: boolean; name: string }> {
  const res = await fetch(`${BASE}/teams/${teamId}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ name }),
  })
  return handleResponse(res)
}

export async function createTeamInvite(teamId: string, email: string, role: 'admin' | 'member'): Promise<{ inviteId: string; email: string; role: string }> {
  const res = await fetch(`${BASE}/teams/${teamId}/invites`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ email, role }),
  })
  return handleResponse(res)
}

export async function listPendingTeamInvites(): Promise<{ invites: TeamInvite[] }> {
  const res = await fetch(`${BASE}/team-invites`, { headers: await authHeaders() })
  return handleResponse(res)
}

export async function acceptTeamInvite(inviteId: string): Promise<{ ok: boolean; teamId: string }> {
  const res = await fetch(`${BASE}/team-invites/${inviteId}/accept`, {
    method: 'POST',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function updateTeamMemberRole(teamId: string, userId: string, role: 'admin' | 'member'): Promise<{ ok: boolean; role: string }> {
  const res = await fetch(`${BASE}/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ role }),
  })
  return handleResponse(res)
}

export async function removeTeamMember(teamId: string, userId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/teams/${teamId}/members/${userId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function syncOAuthCredential(params: {
  provider: 'apple'
  providerToken?: string
  providerRefreshToken?: string
}): Promise<{ ok: boolean; provider: string }> {
  const res = await fetch(`${BASE}/account/oauth-credentials`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  })
  return handleResponse(res)
}

/* ── File upload ── */

export async function uploadFile(serverId: string, fileName: string, fileData: string): Promise<{ path: string }> {
  const res = await fetch(`${BASE}/servers/${serverId}/upload`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ fileName, fileData }),
  })
  return handleResponse(res)
}

/* ── Repo browser ── */

export interface RepoEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
  gitStatus: 'untracked' | 'renamed' | 'deleted' | 'added' | 'modified' | 'mixed' | null
}

export interface RepoBreadcrumb {
  name: string
  path: string
}

export interface RepoDirectory {
  kind: 'directory'
  name: string
  rootPath: string
  repoRoot: string
  currentPath: string
  branch: string | null
  isGitRepo: boolean
  breadcrumbs: RepoBreadcrumb[]
  entries: RepoEntry[]
}

export interface RepoFile {
  kind: 'file'
  name: string
  rootPath: string
  currentPath: string
  breadcrumbs: RepoBreadcrumb[]
  size: number | null
  gitStatus: string | null
  binary: boolean
  truncated: boolean
  content: string | null
}

export type RepoResponse = RepoDirectory | RepoFile

export async function getRepoBrowser(serverId: string, path?: string, sessionId?: string): Promise<RepoResponse> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (sessionId) params.set('sessionId', sessionId)
  const res = await fetch(`${BASE}/servers/${serverId}/repo?${params}`, {
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function downloadRepoFile(serverId: string, path: string, sessionId?: string): Promise<Blob> {
  const params = new URLSearchParams({ path })
  if (sessionId) params.set('sessionId', sessionId)
  const res = await fetch(`${BASE}/servers/${serverId}/repo/download?${params}`, {
    headers: await authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text()
    let msg: string
    try { msg = JSON.parse(text).error } catch { msg = text.slice(0, 200) }
    throw new Error(msg || `HTTP ${res.status}`)
  }
  return res.blob()
}

/* ── Git operations ── */

export interface GitChangedFile {
  path: string
  staged: boolean
  unstaged: boolean
  status: string
  untracked?: boolean
  additions?: number
  deletions?: number
}

/**
 * Diff category — which comparison a file comes from.
 * - `branch`    committed on the current branch but not in the base (origin/HEAD)
 * - `staged`    in the index but not yet committed
 * - `unstaged`  modified in the working tree
 * - `untracked` new, not yet added
 * New in Ship 1. Legacy callers that don't pass a category get "auto" fallback server-side.
 */
export type GitDiffCategory = 'branch' | 'staged' | 'unstaged' | 'untracked'

export interface GitDiffSummary {
  branch: string | null
  /** New (Ship 1). May be null if origin has no default branch. */
  base?: string | null
  /** New (Ship 1). Commits on HEAD not in base. */
  ahead?: number
  /** New (Ship 1). Commits in base not yet on HEAD. */
  behind?: number
  /** New (Ship 1). Structured, one list per category. A file may appear in more than one. */
  categories?: Record<GitDiffCategory, GitChangedFile[]>
  /** Legacy flat view. Kept for back-compat with the current ChangePanel UI. */
  files: GitChangedFile[]
  totalFiles: number
}

export interface GitDiffFile {
  path: string
  diff: string
  /** New (Ship 1). Echoed back by the server so the client can confirm which comparison it got. */
  category?: GitDiffCategory | 'auto'
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
}

export interface GitCommitResult {
  success: boolean
  hash?: string
  branch?: string
  message?: string
  error?: string
}

export interface GitPRResult {
  success: boolean
  url?: string
  message?: string
  error?: string
}

async function gitAction<T>(serverId: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/servers/${serverId}/git`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })
  return handleResponse(res)
}

export async function getGitDiffSummary(serverId: string, sessionId?: string, workdir?: string): Promise<GitDiffSummary> {
  return gitAction(serverId, { action: 'diff-summary', sessionId, workdir })
}

export async function getGitDiffFile(
  serverId: string,
  path: string,
  sessionId?: string,
  workdir?: string,
  category?: GitDiffCategory,
): Promise<GitDiffFile> {
  return gitAction(serverId, { action: 'diff-file', path, sessionId, workdir, category })
}

export async function getGitLog(serverId: string, count = 20, sessionId?: string, workdir?: string): Promise<{ commits: GitCommit[] }> {
  return gitAction(serverId, { action: 'log', count, sessionId, workdir })
}

export async function gitCommit(serverId: string, message: string, files = '.', sessionId?: string, workdir?: string): Promise<GitCommitResult> {
  return gitAction(serverId, { action: 'commit', message, files, sessionId, workdir })
}

export async function gitCreatePR(serverId: string, title: string, body = '', sessionId?: string, workdir?: string): Promise<GitPRResult> {
  return gitAction(serverId, { action: 'create-pr', title, body, sessionId, workdir })
}

export interface ChatSessionMessagesResponse {
  messages: ChatMessage[]
  /** True when `messages` is intentionally empty on the initial-load
   *  path — the raw row dump is omitted to keep the response under
   *  API Gateway's 6 MB cap. Use `transcript` for rendering instead.
   *  False or absent on the afterSeq / beforeSeq paths, which return
   *  raw rows because the page count is bounded. */
  rawMessagesOmitted?: boolean
  transcript?: ChatTranscriptMessage[]
  replaceFromTranscriptSeq?: number | null
  latestSeq?: number | null
  oldestRawSeq?: number | null
  hasMoreBefore?: boolean
  truncated?: boolean
  totalMessages?: number | null
}

export async function getSessionMessages(
  sessionId: string,
  opts?: { afterSeq?: number; beforeSeq?: number },
): Promise<ChatSessionMessagesResponse> {
  const params = new URLSearchParams()
  if (typeof opts?.afterSeq === 'number') params.set('afterSeq', String(opts.afterSeq))
  if (typeof opts?.beforeSeq === 'number') params.set('beforeSeq', String(opts.beforeSeq))
  const suffix = params.size ? `?${params.toString()}` : ''
  const res = await fetch(`${BASE}/sessions/${sessionId}/messages${suffix}`, {
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

/* ── Harness ── */

export type HarnessItemKind =
  | 'validation_rule'
  | 'test_rule'
  | 'review_rule'
  | 'secondary_agent_check'
  | 'env_bootstrap'
  | 'integration_recipe'
  | 'skill'

export type HarnessItemMode = 'required' | 'automatic' | 'suggested' | 'informational'
export type HarnessItemStatus = 'pending' | 'live' | 'dismissed'
export type HarnessSurface = 'agent context' | 'validation' | 'review loop' | 'automation'

export interface HarnessAction {
  commands?: string[]
  checks?: string[]
  integrations?: string[]
  agent?: string
}

export interface HarnessItem {
  userId?: string
  itemId: string
  kind: HarnessItemKind
  mode: HarnessItemMode
  status: HarnessItemStatus
  title: string
  summary: string
  when: string
  source: string
  sourceRunIds?: string[]
  confidence: number
  impact: string
  evidence: string[]
  surfaces: HarnessSurface[]
  action: HarnessAction
  generated: string[]
  createdAt: string
  updatedAt?: string
  promotedAt?: string
  versionIntroduced?: number
}

export interface HarnessVersion {
  userId?: string
  versionSeq: number
  version: string
  createdAt: string
  title: string
  items: string[]
  note: string
}

export interface HarnessRunSummary {
  userId?: string
  runId: string
  createdAt: string
  title: string
  status: string
  repo: string
  commands: string[]
  validations: string[]
  outcome: string
}

export interface HarnessSnapshot {
  currentVersion: {
    label: string
    versionSeq: number
    createdAt: string
  } | null
  lastPromotedAt: string | null
  items: HarnessItem[]
  history: HarnessVersion[]
  runSummaries: HarnessRunSummary[]
}

export async function getHarness(): Promise<HarnessSnapshot> {
  const res = await fetch(`${BASE}/harness`, { headers: await authHeaders() })
  return handleResponse(res)
}

export async function updateHarnessItem(itemId: string, action: 'promote' | 'dismiss' | 'move-back'): Promise<HarnessSnapshot> {
  const res = await fetch(`${BASE}/harness`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ itemId, action }),
  })
  return handleResponse(res)
}

/* ── Agent credentials (Claude / Codex / Cursor / OpenCode credentials) ── */

export type AgentCredentialId = 'claude' | 'codex' | 'cursor' | 'opencode'

export type AgentCredentialSource = 'file' | 'keychain' | 'api-key' | 'browser-oauth'

/* ── BYO-AWS credentials (for provisioning EC2 in the user's own account) ── */

/** Public-safe view of the user's stored AWS creds. Never includes the
 *  decrypted secret — that only exists transiently in the backend when the
 *  provision handler uses it to call ec2.RunInstances on the user's behalf. */
export interface AwsCredentialsSummary {
  accessKeyId: string
  maskedAccessKeyId: string
  region: string
  createdAt?: string
  updatedAt?: string
}

export async function getAwsCredentials(): Promise<{ credentials: AwsCredentialsSummary | null }> {
  const res = await fetch(`${BASE}/account/aws-credentials`, {
    method: 'GET',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export async function saveAwsCredentials(params: {
  accessKeyId: string
  secretAccessKey: string
  region?: string
}): Promise<{ ok: true; credentials: AwsCredentialsSummary }> {
  const res = await fetch(`${BASE}/account/aws-credentials`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  })
  return handleResponse(res)
}

export async function deleteAwsCredentials(): Promise<{ ok: true }> {
  const res = await fetch(`${BASE}/account/aws-credentials`, {
    method: 'DELETE',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

export interface AgentCredentialSummary {
  agent: AgentCredentialId
  createdAt?: string
  updatedAt?: string
  source?: AgentCredentialSource
  identifier?: string
}

export async function listAgentCredentials(): Promise<{ credentials: AgentCredentialSummary[] }> {
  const res = await fetch(`${BASE}/account/agent-credentials`, {
    method: 'GET',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}

/**
 * Save an agent credential. Two accepted shapes:
 *   - `contents`: a raw JSON string copied from the user's local credential
 *     file (e.g. ~/.claude/.credentials.json). Used by the desktop auto-import.
 *   - `apiKey`: a bare API key. Backend wraps it in the right JSON shape for
 *     the agent. Used by the manual paste path.
 */
export async function saveAgentCredential(payload: {
  agent: AgentCredentialId
  contents?: string
  apiKey?: string
  source?: AgentCredentialSource
  identifier?: string
}): Promise<{ ok: true; agent: AgentCredentialId }> {
  const res = await fetch(`${BASE}/account/agent-credentials`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  })
  return handleResponse(res)
}

export async function deleteAgentCredential(agent: AgentCredentialId): Promise<{ ok: true; agent: AgentCredentialId }> {
  const res = await fetch(`${BASE}/account/agent-credentials?agent=${encodeURIComponent(agent)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  })
  return handleResponse(res)
}
