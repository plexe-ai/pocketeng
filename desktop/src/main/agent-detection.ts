/**
 * Detect locally-installed coding agents and read their credential files.
 *
 * The cloud-first move: when a user signs in on the desktop, we look for any
 * coding-agent CLIs they've already authenticated locally (Claude Code, Codex,
 * Cursor), and offer to copy the credential bundle to their cloud workspace
 * so the EC2 agent runs as them — without anyone (us included) ever brokering
 * an OAuth flow.
 *
 * Two layers:
 *   detectAgents()         — metadata only (installed?, hasCredentials?, identifier?).
 *                            Cheap, safe to call on every onboarding render.
 *   readAgentCredentials() — full credential JSON for ONE agent. Called only
 *                            after explicit user confirmation in the UI.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export type AgentId = 'claude' | 'codex' | 'cursor'

export interface AgentDetection {
  /** CLI binary is on PATH (or in a known install location). */
  installed: boolean
  /** Local credentials exist (file, keychain entry, or the CLI reports signed-in). */
  hasCredentials: boolean
  /**
   * We can extract those local credentials to a JSON blob and ship them to
   * the cloud. True for file/keychain sources. False for CLI-probe sources
   * (e.g. Cursor, whose auth lives inside app-encrypted storage). When false,
   * the UI should offer the paste-key path instead of a one-click import.
   */
  extractable: boolean
  /**
   * Best-effort human label so the UI can say "Logged in as foo@bar.com" or
   * "sk-ant-…XYZ". We never return secret material here.
   */
  identifier?: string
}

interface AgentSpec {
  id: AgentId
  binaries: string[]                   // names to look up via `which`
  /**
   * Sources to probe in order. `file` reads from disk; `keychain` queries the
   * macOS keychain via the `security` CLI. The first source that yields
   * content wins. Detection only checks existence; readAgentCredentials runs
   * the same probe to fetch the actual payload.
   */
  sources: CredentialSource[]
  identifyFromContents: (raw: string) => string | undefined
}

type CredentialSource =
  | { kind: 'file'; path: () => string }
  | { kind: 'keychain'; service: string }
  /**
   * Probe via a CLI subcommand (e.g. `cursor-agent status`) whose output
   * tells us whether the user is signed in. No token extraction — used for
   * agents whose auth is sealed in app storage. `parseOutput` returns an
   * identifier (e.g. the user's email) if signed in, or undefined.
   */
  | {
      kind: 'cli-probe'
      binary: string
      args: string[]
      parseOutput: (stdout: string, stderr: string) => string | undefined
    }

const AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    binaries: ['claude'],
    // Claude Code 2.x stores the user's managed API key in the macOS Keychain
    // under service "Claude Code" (after `claude login` OAuth completes).
    // The unrelated service "Claude Code-credentials" holds MCP plugin OAuth
    // tokens — do NOT read that, it's the wrong data and why this used to break.
    // Earlier versions used ~/.claude/.credentials.json as a file fallback.
    sources: [
      { kind: 'keychain', service: 'Claude Code' },
      { kind: 'file', path: () => path.join(homedir(), '.claude', '.credentials.json') },
    ],
    identifyFromContents: (raw) => {
      try {
        const parsed = JSON.parse(raw)
        // Shapes seen in the wild:
        //   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, ... } }
        //   { access_token, refresh_token, ... }
        //   { apiKey: 'sk-ant-...' }
        const oauth = parsed.claudeAiOauth ?? parsed
        if (oauth.email) return oauth.email
        if (oauth.subscriptionType) return `Claude ${oauth.subscriptionType}`
        if (parsed.apiKey) return maskKey(parsed.apiKey)
        if (oauth.accessToken || oauth.access_token) return 'Signed in'
      } catch { /* fall through */ }
      return undefined
    },
  },
  {
    id: 'codex',
    binaries: ['codex'],
    // `codex login` writes here.
    sources: [
      { kind: 'file', path: () => path.join(homedir(), '.codex', 'auth.json') },
    ],
    identifyFromContents: (raw) => {
      try {
        const parsed = JSON.parse(raw)
        if (parsed.OPENAI_API_KEY) return maskKey(parsed.OPENAI_API_KEY)
        if (parsed.tokens?.id_token) return 'Signed in via ChatGPT'
        if (parsed.email) return parsed.email
      } catch { /* */ }
      return undefined
    },
  },
  {
    id: 'cursor',
    binaries: ['cursor-agent'],
    // Cursor's auth is sealed in app-encrypted state — no extractable file
    // or keychain entry. Best we can do for detection is ask the CLI itself
    // whether the user is signed in. For cloud use the user still needs to
    // paste a Cursor API key (cursor.com/integrations); we use this probe
    // purely to show an accurate "Signed in locally as X" status.
    sources: [
      {
        kind: 'cli-probe',
        binary: 'cursor-agent',
        args: ['status'],
        parseOutput: (stdout) => {
          // Example output: "✓ Logged in as user@example.com"
          const m = stdout.match(/Logged in as\s+(\S+)/i)
          return m ? m[1] : undefined
        },
      },
    ],
    identifyFromContents: () => undefined,
  },
]

function maskKey(key: string): string {
  if (key.length < 12) return '••••••••'
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p)
    return stat.isFile()
  } catch {
    return false
  }
}

async function isOnPath(binary: string): Promise<boolean> {
  // PATH inside Electron on macOS is famously trimmed — `which` may miss tools
  // installed via brew/nvm that are visible in a shell but not here. Run the
  // user's login shell so PATH matches what they see in Terminal.
  try {
    await execFileP(process.env.SHELL || '/bin/zsh', ['-l', '-c', `command -v ${binary}`], {
      timeout: 4000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Check if a keychain entry exists. Doesn't fetch the value, so no permission
 * prompt is triggered. Returns true if the entry is present.
 */
async function keychainEntryExists(service: string): Promise<boolean> {
  try {
    await execFileP('/usr/bin/security', ['find-generic-password', '-s', service], {
      timeout: 4000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Fetch a keychain password (the OAuth bundle JSON for Claude). The first
 * call from a given executable triggers a system prompt; subsequent calls
 * proceed silently if the user clicked Always Allow.
 */
async function keychainGetPassword(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 8000 },
    )
    return stdout.trimEnd()
  } catch {
    return null
  }
}

/**
 * Probe whether content exists at any of the spec's sources, without fetching
 * the actual payload from the keychain (so we don't trigger a system prompt
 * during detection). For file sources we read content opportunistically so we
 * can extract an identifier label.
 */
async function probeSources(
  spec: AgentSpec,
): Promise<{ exists: boolean; extractable: boolean; identifier?: string }> {
  for (const source of spec.sources) {
    if (source.kind === 'file') {
      const p = source.path()
      if (!(await fileExists(p))) continue
      try {
        const raw = await fs.readFile(p, 'utf8')
        return { exists: true, extractable: true, identifier: spec.identifyFromContents(raw) }
      } catch {
        return { exists: true, extractable: true }
      }
    }
    if (source.kind === 'keychain') {
      if (await keychainEntryExists(source.service)) {
        // Don't read the value during detection — that triggers a permission
        // dialog. Identifier comes from the file fallback if there is one.
        return { exists: true, extractable: true }
      }
    }
    if (source.kind === 'cli-probe') {
      // Run the CLI in the user's login shell so PATH is correct.
      try {
        const cmd = [source.binary, ...source.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`)].join(' ')
        const { stdout, stderr } = await execFileP(
          process.env.SHELL || '/bin/zsh',
          ['-l', '-c', cmd],
          { timeout: 6000 },
        )
        const identifier = source.parseOutput(stdout, stderr)
        // cli-probe confirms sign-in but the creds themselves are sealed in
        // app storage — user will still need to paste an API key for cloud.
        if (identifier) return { exists: true, extractable: false, identifier }
      } catch {
        // CLI not installed, or returned non-zero — not signed in.
        continue
      }
    }
  }
  return { exists: false, extractable: false }
}

export async function detectOne(spec: AgentSpec): Promise<AgentDetection> {
  const [installedResults, probe] = await Promise.all([
    Promise.all(spec.binaries.map(isOnPath)),
    probeSources(spec),
  ])
  return {
    installed: installedResults.some(Boolean),
    hasCredentials: probe.exists,
    extractable: probe.extractable,
    identifier: probe.identifier,
  }
}

export async function detectAllAgents(): Promise<Record<AgentId, AgentDetection>> {
  const entries = await Promise.all(
    AGENTS.map(async (spec) => [spec.id, await detectOne(spec)] as const),
  )
  return Object.fromEntries(entries) as Record<AgentId, AgentDetection>
}

/**
 * Returns the raw credential file content for one agent. The caller is the
 * onboarding UI in the renderer, which should always confirm with the user
 * before invoking this. We do basic sanity checks (size, JSON-parsable) so a
 * corrupt file doesn't blow up the round-trip.
 */
export async function readAgentCredentials(id: string): Promise<{
  ok: boolean
  contents?: string
  /** Source the value came from, surfaced for telemetry / UI hints. */
  source?: 'file' | 'keychain'
  error?: string
}> {
  const spec = AGENTS.find((a) => a.id === id)
  if (!spec) return { ok: false, error: `Unknown agent: ${id}` }

  for (const source of spec.sources) {
    if (source.kind === 'file') {
      try {
        const stat = await fs.stat(source.path())
        if (!stat.isFile()) continue
        if (stat.size > 64 * 1024) continue
        const contents = await fs.readFile(source.path(), 'utf8')
        try { JSON.parse(contents) } catch { continue }
        return { ok: true, contents, source: 'file' }
      } catch { continue }
    }
    if (source.kind === 'keychain') {
      const password = await keychainGetPassword(source.service)
      if (!password) continue
      // Validate JSON — Claude stores a JSON object as the password.
      try { JSON.parse(password) } catch {
        // Not JSON. Wrap as { apiKey: ... } so the backend always sees JSON.
        return { ok: true, contents: JSON.stringify({ apiKey: password }), source: 'keychain' }
      }
      return { ok: true, contents: password, source: 'keychain' }
    }
  }
  return { ok: false, error: 'No readable credentials found' }
}

