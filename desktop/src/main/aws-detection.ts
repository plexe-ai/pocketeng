/**
 * Auto-detect AWS profiles already configured on the user's local machine.
 *
 * We read the two files every AWS SDK / `aws-cli` user has in their home
 * directory:
 *   ~/.aws/credentials  — profiles with aws_access_key_id + aws_secret_access_key
 *   ~/.aws/config       — profile regions + (sometimes) SSO / role-assume settings
 *
 * Security design:
 *   • `detectAwsProfiles()` returns profile names + access key ID + region
 *     only. The secret NEVER leaves this function — safe to call freely
 *     from the onboarding render path.
 *   • `readAwsProfile(name)` returns the full credential (including secret)
 *     ONLY when the user has clicked "Use this profile" in the UI. The
 *     renderer immediately POSTs to /account/aws-credentials, where it's
 *     KMS-encrypted at rest. The secret is never persisted on the
 *     renderer side.
 *   • SSO profiles (those that have `sso_start_url` in config but no key
 *     in credentials) are flagged but not importable — AWS SSO requires
 *     interactive login and short-lived tokens, which don't transfer to
 *     our cloud EC2 provisioning path. We surface them greyed-out so the
 *     user knows why they appear but can't be used here.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CREDENTIALS_PATH = path.join(homedir(), '.aws', 'credentials')
const CONFIG_PATH = path.join(homedir(), '.aws', 'config')

export interface AwsProfileSummary {
  /** Profile name as it appears in [brackets]. `default` for [default]. */
  name: string
  /** First 4 + last 4 of the access key ID, for UI display. Empty for SSO-only. */
  maskedAccessKeyId: string
  /** Full access key ID (not the secret). AWS treats this as non-sensitive. */
  accessKeyId: string
  /** Region from ~/.aws/config if present, else undefined. */
  region?: string
  /** True when the profile has a `sso_*` block but no aws_access_key_id —
   *  can't be imported for our flow. */
  ssoOnly: boolean
}

export interface AwsProfileCredentials {
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/** Minimal INI parser. Returns { section → { key → value } }. Unknown
 *  section types get lumped in as strings. Comment lines starting with `#`
 *  or `;` are ignored. Handles both `[section]` and `[profile section]`
 *  (AWS config file quirk). */
function parseIni(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      current = section[1].trim()
      if (!out.has(current)) out.set(current, {})
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    out.get(current)![key] = value
  }
  return out
}

function maskKey(k: string): string {
  if (!k || k.length < 8) return ''
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

/** Strip the `profile ` prefix AWS writes into `~/.aws/config` for
 *  non-default profiles. `[profile work]` in config corresponds to `[work]`
 *  in credentials. `[default]` is the same in both files. */
function normalizeConfigProfile(sectionName: string): string {
  if (sectionName === 'default') return 'default'
  return sectionName.startsWith('profile ')
    ? sectionName.slice('profile '.length).trim()
    : sectionName
}

async function readOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export async function detectAwsProfiles(): Promise<AwsProfileSummary[]> {
  const [credsText, configText] = await Promise.all([
    readOrEmpty(CREDENTIALS_PATH),
    readOrEmpty(CONFIG_PATH),
  ])
  if (!credsText && !configText) return []

  const credsIni = parseIni(credsText)
  const configIni = parseIni(configText)

  // Region lookup keyed by canonical profile name
  const regionByProfile = new Map<string, string>()
  const ssoFlagByProfile = new Map<string, boolean>()
  for (const [section, fields] of configIni) {
    const name = normalizeConfigProfile(section)
    if (fields.region) regionByProfile.set(name, fields.region)
    const hasSso = Object.keys(fields).some(k => k.startsWith('sso_'))
    if (hasSso) ssoFlagByProfile.set(name, true)
  }

  // Start with profiles that have credentials (the common case)
  const profiles: AwsProfileSummary[] = []
  const seen = new Set<string>()
  for (const [name, fields] of credsIni) {
    seen.add(name)
    const accessKeyId = fields.aws_access_key_id || ''
    if (!accessKeyId) continue
    profiles.push({
      name,
      accessKeyId,
      maskedAccessKeyId: maskKey(accessKeyId),
      region: regionByProfile.get(name),
      ssoOnly: false,
    })
  }

  // Also surface SSO-configured profiles (credentials file is empty for
  // these) so the user sees them in the list even though they can't be
  // imported directly — clearer than silently dropping them.
  for (const [name, isSso] of ssoFlagByProfile) {
    if (seen.has(name)) continue
    if (!isSso) continue
    profiles.push({
      name,
      accessKeyId: '',
      maskedAccessKeyId: '',
      region: regionByProfile.get(name),
      ssoOnly: true,
    })
  }

  // Stable order: default first, then alphabetical.
  return profiles.sort((a, b) => {
    if (a.name === 'default') return -1
    if (b.name === 'default') return 1
    return a.name.localeCompare(b.name)
  })
}

export async function readAwsProfile(name: string): Promise<AwsProfileCredentials | null> {
  const [credsText, configText] = await Promise.all([
    readOrEmpty(CREDENTIALS_PATH),
    readOrEmpty(CONFIG_PATH),
  ])
  const credsIni = parseIni(credsText)
  const configIni = parseIni(configText)

  const fields = credsIni.get(name)
  if (!fields) return null
  const accessKeyId = fields.aws_access_key_id || ''
  const secretAccessKey = fields.aws_secret_access_key || ''
  if (!accessKeyId || !secretAccessKey) return null

  // Region: prefer the one in credentials if set, else fall back to config.
  // Both reads can be undefined — narrow via `|| undefined` so the typed
  // result matches AwsProfileCredentials' optional `region?: string`.
  const configKey = name === 'default' ? 'default' : `profile ${name}`
  const region = fields.region || configIni.get(configKey)?.region || undefined

  return { accessKeyId, secretAccessKey, region }
}
