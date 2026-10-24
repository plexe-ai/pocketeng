'use client'

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  ChatMessage,
  ChatSessionMessagesResponse,
  ChatSession,
  ChatSessionRecord,
  ChatTranscriptMessage,
  RepoEntry,
  RepoResponse,
  Server,
  SessionEvent,
  cancelChat,
  downloadRepoFile,
  getGitLog,
  getRepoBrowser,
  getSessionEvents,
  getSessionMessages,
  getSessions,
  listServers,
  renameSession,
  runCommand,
  sendChatMessage,
  startChatSession,
  uploadFile,
  type UploadedImage,
} from '@/lib/api'
import {
  isImageLikeFile,
  isRasterImageFile,
  mergePendingAttachments,
  resolveClipboardImageFilesFromPasteEvent,
  type PendingAttachment,
} from '@/lib/composerImagePaste'
import { readCache, writeCache } from '@/lib/cache'
import { SUPPORTED_CHAT_AGENTS, ChatAgent, AGENT_META, isSupportedAgent } from '@/lib/agents'
import { RolePicker, RoleSelect, setStoredRole, type SDLCRole } from '@/components/sdlc'
import type { codeToHtml as CodeToHtmlFn } from 'shiki/bundle/web'

let _codeToHtml: typeof CodeToHtmlFn | null = null
async function getCodeToHtml() {
  if (!_codeToHtml) {
    const mod = await import('shiki/bundle/web')
    _codeToHtml = mod.codeToHtml
  }
  return _codeToHtml
}
import { useTheme } from './ThemeProvider'
import PreviewPanel from './PreviewPanel'
import ResizablePanel from './ResizablePanel'
import ChangePanel from './ChangePanel'
import { hapticMedium, hasSpeechRecognition, isNative, onAppResume, requestSpeechPermission, startListening, stopListening } from '@/lib/native'
import { notify, primeNotifications } from '@/lib/notifications'
import { buildPreviewUrl, ensurePreviewCookie, isCloudflareManaged } from '@/lib/preview'

/* ── Types ── */

export type ToolDetail = {
  toolName: string
  input: Record<string, unknown> | null
  output?: string
  isError?: boolean
}
export type ToolEntry = { name: string; output?: string; isError?: boolean; detail?: ToolDetail }
export type AgentTextBlock = { kind: 'text'; text: string }
export type AgentToolBlock = { kind: 'tool'; entry: ToolEntry }
export type AgentBlock = AgentTextBlock | AgentToolBlock
export type AgentMsg = {
  role: 'agent'
  blocks: AgentBlock[]
  done: boolean
  timestamp: string
  _lastEventSeq?: number
}
export type SystemMsg = { role: 'system'; text: string; timestamp: string; command?: string }
export type Msg =
  | { role: 'user'; text: string; timestamp: string }
  | AgentMsg
  | SystemMsg

function buildAttachmentPrompt(
  userText: string,
  imagePaths: string[],
  otherPaths: string[],
): string {
  const parts: string[] = []
  if (userText) parts.push(userText)
  if (imagePaths.length) {
    const n = imagePaths.length
    const list = imagePaths.map(p => `- ${p}`).join('\n')
    const first = imagePaths[0] ?? ''
    parts.push(
      `I've attached ${n} image file${n > 1 ? 's' : ''} for you to analyze. The file${n > 1 ? 's' : ''} on the server ${n > 1 ? 'are' : 'is'} at:\n${list}\n\n` +
        `Please use the Read tool or Bash to open the image and analyze it visually. (For example, read: ${first})`
    )
  }
  if (otherPaths.length) {
    const list = otherPaths.map(p => `- ${p}`).join('\n')
    if (otherPaths.length === 1) {
      parts.push(`Attached file:\n${list}`)
    } else {
      parts.push(`Attached files:\n${list}`)
    }
  }
  return parts.length ? parts.join('\n\n') : ''
}

/**
 * Strip the injected attachment-prompt boilerplate from a user message and
 * return the human-authored text plus the image paths we embedded.
 *
 * Handles the two patterns written by `buildAttachmentPrompt`:
 *   1. "I've attached N image file(s)…\n- /tmp/pe-uploads/…\n\nPlease use…"
 *   2. "Attached file(s):\n- /path/…"
 */
function parseUserBubble(raw: string): { displayText: string; imagePaths: string[]; otherPaths: string[] } {
  let text = raw
  const imagePaths: string[] = []
  const otherPaths: string[] = []

  // Strip the image attachment block (multiline)
  const imgBlock = /\n*I've attached \d+ image files? for you to analyze\.[\s\S]*?(?:\(For example, read:[^\)]+\))/g
  text = text.replace(imgBlock, (match) => {
    const lines = match.split('\n').filter(l => l.startsWith('- '))
    for (const l of lines) imagePaths.push(l.slice(2).trim())
    return ''
  })

  // Strip the non-image file attachment block
  const otherBlock = /\n*Attached files?:\n((?:- .+\n?)+)/g
  text = text.replace(otherBlock, (match, list: string) => {
    const lines = list.split('\n').filter(l => l.startsWith('- '))
    for (const l of lines) otherPaths.push(l.slice(2).trim())
    return ''
  })

  return { displayText: text.trim(), imagePaths, otherPaths }
}

function messageRenderKey(msg: Msg): string {
  if (msg.role === 'system') return `system:${msg.timestamp}:${msg.command ?? ''}`
  return `${msg.role}:${msg.timestamp}`
}

function agentText(msg: AgentMsg): string {
  return msg.blocks.filter((b): b is AgentTextBlock => b.kind === 'text').map(b => b.text).join('\n\n')
}
function agentTools(msg: AgentMsg): ToolEntry[] {
  return msg.blocks.filter((b): b is AgentToolBlock => b.kind === 'tool').map(b => b.entry)
}
function agentHasText(msg: AgentMsg): boolean {
  return msg.blocks.some(b => b.kind === 'text' && b.text)
}
function agentHasTools(msg: AgentMsg): boolean {
  return msg.blocks.some(b => b.kind === 'tool')
}


/* ── Model definitions ── */

type AIModel = {
  id: string
  displayName: string
  shortLabel: string
  tier: string
  icon: React.ReactNode
  color: string
}

// Claude model IDs are the Anthropic API aliases — NOT pinned snapshot IDs.
// Using aliases means Anthropic rolls us forward automatically when they
// publish a new pointed release under the same version. Verified against
// https://platform.claude.com/docs/en/docs/about-claude/models/overview
// as of 2026-04. Current-gen lineup is Opus 4.7 + Sonnet 4.6 + Haiku 4.5;
// there is no Sonnet 4.7 or Haiku 4.7. Opus 4.6 kept as a legacy fallback
// — it still works and is cheaper for less demanding tasks. Once the 4.8
// generation ships, drop 4.6 and promote 4.7 to legacy.
const CLAUDE_MODELS: AIModel[] = [
  {
    id: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    shortLabel: 'Opus 4.7',
    tier: 'Most capable — step-change in agentic coding, 1M context',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    shortLabel: 'Sonnet 4.6',
    tier: 'Best speed/intelligence balance, 1M context',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    shortLabel: 'Haiku 4.5',
    tier: 'Fastest with near-frontier intelligence',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    shortLabel: 'Opus 4.6',
    tier: 'Previous-gen Opus — kept for backwards compatibility',
    icon: null,
    color: 'var(--text-bright)',
  },
]

const CODEX_MODELS: AIModel[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT‑5.5',
    shortLabel: 'GPT‑5.5',
    tier: 'Flagship — coding, reasoning, and agentic workflows',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT‑5.4',
    shortLabel: 'GPT‑5.4',
    tier: 'Previous flagship — strong all-rounder',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT‑5.4 Mini',
    shortLabel: 'GPT‑5.4 Mini',
    tier: 'Fast and efficient for lighter tasks',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT‑5.3 Codex',
    shortLabel: '5.3 Codex',
    tier: 'Industry-leading coding model',
    icon: null,
    color: 'var(--text-bright)',
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT‑5.2',
    shortLabel: 'GPT‑5.2',
    tier: 'Previous gen — good for deep debugging',
    icon: null,
    color: 'var(--text-bright)',
  },
]

const CURSOR_MODELS: AIModel[] = [
  { id: 'auto', displayName: 'Auto', shortLabel: 'Auto', tier: 'Automatically picks the best model', icon: null, color: 'var(--text-bright)' },
  { id: 'claude-4.6-sonnet-medium', displayName: 'Claude 4.6 Sonnet', shortLabel: 'Sonnet 4.6', tier: 'Balanced — fast and capable', icon: null, color: 'var(--text-bright)' },
  { id: 'claude-4.6-sonnet-medium-thinking', displayName: 'Claude 4.6 Sonnet (Thinking)', shortLabel: 'Sonnet 4.6 Think', tier: 'Extended thinking for harder problems', icon: null, color: 'var(--text-bright)' },
  { id: 'claude-4.6-opus-high', displayName: 'Claude 4.6 Opus', shortLabel: 'Opus 4.6', tier: 'Most capable for ambitious work', icon: null, color: 'var(--text-bright)' },
  { id: 'claude-4.6-opus-high-thinking', displayName: 'Claude 4.6 Opus (Thinking)', shortLabel: 'Opus 4.6 Think', tier: 'Most capable with extended thinking', icon: null, color: 'var(--text-bright)' },
  { id: 'claude-4.6-opus-max', displayName: 'Claude 4.6 Opus Max', shortLabel: 'Opus Max', tier: 'Maximum context and capability', icon: null, color: 'var(--text-bright)' },
  { id: 'gpt-5.4-medium', displayName: 'GPT-5.4', shortLabel: 'GPT-5.4', tier: 'Flagship reasoning and agentic workflows', icon: null, color: 'var(--text-bright)' },
  { id: 'gpt-5.4-high', displayName: 'GPT-5.4 High', shortLabel: 'GPT-5.4 Hi', tier: 'Higher compute for complex tasks', icon: null, color: 'var(--text-bright)' },
  { id: 'gpt-5.4-mini-medium', displayName: 'GPT-5.4 Mini', shortLabel: 'GPT-5.4 Mini', tier: 'Fast and efficient for lighter tasks', icon: null, color: 'var(--text-bright)' },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', shortLabel: '5.3 Codex', tier: 'Industry-leading coding model', icon: null, color: 'var(--text-bright)' },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', shortLabel: 'Gemini 3.1', tier: 'Google multimodal model', icon: null, color: 'var(--text-bright)' },
  { id: 'grok-4-20', displayName: 'Grok 4', shortLabel: 'Grok 4', tier: 'xAI reasoning model', icon: null, color: 'var(--text-bright)' },
  { id: 'grok-4-20-thinking', displayName: 'Grok 4 (Thinking)', shortLabel: 'Grok 4 Think', tier: 'xAI with extended thinking', icon: null, color: 'var(--text-bright)' },
]

// v1 OpenCode auth is provider-env based, and the backend does not yet map a
// free-form UI model id into OpenCode's provider/model object. Hide model
// selection until that wiring lands.
const OPENCODE_MODELS: AIModel[] = []

const AGENT_MODELS: Record<ChatAgent, AIModel[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  cursor: CURSOR_MODELS,
  opencode: OPENCODE_MODELS,
}

/* ── File type icons ── */

type FileIcon = { icon: string; color: string }

function getFileIcon(name: string): FileIcon {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, FileIcon> = {
    ts: { icon: 'TS', color: '#3178c6' }, tsx: { icon: 'TX', color: '#3178c6' },
    js: { icon: 'JS', color: '#f7df1e' }, jsx: { icon: 'JX', color: '#f7df1e' },
    py: { icon: 'PY', color: '#3776ab' }, rs: { icon: 'RS', color: '#dea584' },
    go: { icon: 'GO', color: '#00add8' }, rb: { icon: 'RB', color: '#cc342d' },
    swift: { icon: 'SW', color: '#f05138' }, kt: { icon: 'KT', color: '#7f52ff' },
    java: { icon: 'JA', color: '#b07219' }, cs: { icon: 'C#', color: '#239120' },
    css: { icon: 'CS', color: '#1572b6' }, html: { icon: 'HT', color: '#e34f26' },
    json: { icon: '{}', color: '#6b7280' }, yaml: { icon: 'YM', color: '#cb171e' },
    yml: { icon: 'YM', color: '#cb171e' }, md: { icon: 'MD', color: '#6b7280' },
    sh: { icon: 'SH', color: '#4eaa25' }, bash: { icon: 'SH', color: '#4eaa25' },
    sql: { icon: 'SQ', color: '#e38c00' }, toml: { icon: 'TM', color: '#9c4221' },
    xml: { icon: 'XM', color: '#e44d26' }, c: { icon: 'C', color: '#555555' },
    cpp: { icon: 'C+', color: '#00599c' }, h: { icon: 'H', color: '#555555' },
    php: { icon: 'PH', color: '#8892bf' }, r: { icon: 'R', color: '#276dc3' },
    tf: { icon: 'TF', color: '#7b42bc' }, dockerfile: { icon: 'DK', color: '#2496ed' },
    lock: { icon: 'LK', color: '#6b7280' },
  }
  // Handle special filenames
  const basename = name.split('/').pop()?.toLowerCase() ?? ''
  if (basename === 'dockerfile') return { icon: 'DK', color: '#2496ed' }
  if (basename === 'makefile') return { icon: 'MK', color: '#6b7280' }
  if (basename.startsWith('.env')) return { icon: 'EN', color: '#ecd53f' }
  return map[ext] ?? { icon: ext.slice(0, 2).toUpperCase() || 'F', color: '#6b7280' }
}

function FileTypeIcon({ name, className = 'w-5 h-5' }: { name: string; className?: string }) {
  const fi = getFileIcon(name)
  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded text-[8px] font-bold tracking-tight flex-shrink-0`}
      style={{ background: `${fi.color}18`, color: fi.color }}
    >
      {fi.icon}
    </span>
  )
}

/* ── Helpers ── */


function getPreferredAgent(server: Server, preferred?: string | null): ChatAgent | null {
  const available = (server.agents?.length ? server.agents : ['claude']).filter(isSupportedAgent)
  if (isSupportedAgent(preferred) && available.includes(preferred)) return preferred
  return available[0] ?? null
}

function formatTime(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function autosizeComposer(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 200)}px`
}

/* ── Content cleaning ── */

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function stripLineNumbers(text: string): string {
  return text.split('\n').map(line => line.replace(/^\s*\d+[\t→]\s?/, '')).join('\n')
}

/* ── Text sanitization ── */

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]/gu
function stripEmojis(text: string): string {
  return text.replace(EMOJI_RE, '').replace(/  +/g, ' ').trim()
}

/* ── NDJSON parsing ── */

function getString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asObject(raw: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw !== 'string') return raw
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : null } catch { return null }
}

function extractToolInput(input: Record<string, unknown> | null): string {
  if (!input) return ''
  for (const k of ['command', 'file_path', 'pattern']) { const v = getString(input[k]); if (v) return v }
  if (getString(input.prompt)) return (getString(input.prompt) ?? '').slice(0, 100)
  if (getString(input.old_string)) return `edit: ${(getString(input.old_string) ?? '').slice(0, 80)}`
  try { return JSON.stringify(input).slice(0, 200) } catch { return '' }
}

type ParsedLine =
  | { kind: 'assistantText'; mode: 'delta' | 'snapshot'; text: string }
  | { kind: 'toolUse'; name: string; toolName: string; input: Record<string, unknown> | null }
  | { kind: 'toolResult'; output: string; isError: boolean }

function parseAssistantBlocks(blocks: unknown[]): ParsedLine | null {
  const texts: string[] = []
  let toolLabel: string | null = null
  let rawToolName: string | null = null
  let rawToolInput: Record<string, unknown> | null = null
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const r = b as Record<string, unknown>
    if (getString(r.type) === 'text') { const t = getString(r.text); if (t) texts.push(t) }
    else if (getString(r.type) === 'tool_use' && !toolLabel) {
      const name = getString(r.name) ?? 'tool'
      if (HIDDEN_TOOLS.has(name)) continue
      const inputObj = r.input && typeof r.input === 'object' ? r.input as Record<string, unknown> : null
      const inp = extractToolInput(inputObj)
      toolLabel = inp ? `${name}: ${inp}` : name
      rawToolName = name
      rawToolInput = inputObj
    }
  }
  if (texts.length) return { kind: 'assistantText', mode: 'snapshot', text: texts.join('') }
  if (toolLabel) return { kind: 'toolUse', name: toolLabel, toolName: rawToolName ?? 'tool', input: rawToolInput }
  return null
}

function extractTextBlocks(blocks: unknown[]): string | null {
  const parts: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const t = getString((b as Record<string, unknown>).text)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim() || null
}

const HIDDEN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ToolSearch'])

function parseLine(raw: string | Record<string, unknown>): ParsedLine | null {
  const obj = asObject(raw)
  if (!obj) return null
  const type = getString(obj.type)
  switch (type) {
    case 'assistant':
    case 'message': {
      const msg = obj.message
      if (msg && typeof msg === 'object') { const c = (msg as Record<string, unknown>).content; if (Array.isArray(c)) return parseAssistantBlocks(c) }
      if (Array.isArray(obj.content)) return parseAssistantBlocks(obj.content)
      const text = getString(obj.message); return text ? { kind: 'assistantText', mode: 'snapshot', text } : null
    }
    case 'tool_use': {
      const tool = obj.tool && typeof obj.tool === 'object' ? obj.tool as Record<string, unknown> : null
      const name = getString(tool?.name) ?? getString(obj.name) ?? getString(obj.tool_name) ?? 'tool'
      if (HIDDEN_TOOLS.has(name)) return null
      const inputObj = tool?.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : obj.input && typeof obj.input === 'object' ? obj.input as Record<string, unknown> : null
      const inp = extractToolInput(inputObj)
      return { kind: 'toolUse', name: inp ? `${name}: ${inp}` : name, toolName: name, input: inputObj }
    }
    case 'tool_result': {
      const t = getString(obj.content) ?? getString(obj.output) ?? (Array.isArray(obj.content) ? extractTextBlocks(obj.content) : null)
      return t ? { kind: 'toolResult', output: t, isError: obj.is_error === true } : null
    }
    case 'user': {
      const message = obj.message
      if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>).content
        if (Array.isArray(content)) {
          const outputs = content
            .filter(block => block && typeof block === 'object' && getString((block as Record<string, unknown>).type) === 'tool_result')
            .map(block => {
              const record = block as Record<string, unknown>
              return getString(record.content) ?? (Array.isArray(record.content) ? extractTextBlocks(record.content) : null)
            })
            .filter((value): value is string => Boolean(value))
          const isError = content.some(block => block && typeof block === 'object' && (block as Record<string, unknown>).is_error === true)
          if (outputs.length || isError) return { kind: 'toolResult', output: outputs.join('\n'), isError }
        }
      }
      const toolUseResult = obj.tool_use_result
      if (typeof toolUseResult === 'string' && toolUseResult) {
        return { kind: 'toolResult', output: toolUseResult, isError: toolUseResult.toLowerCase().startsWith('error:') }
      }
      if (toolUseResult && typeof toolUseResult === 'object') {
        const record = toolUseResult as Record<string, unknown>
        const output = getString(record.stdout) ?? getString(record.stderr) ?? ''
        return output || record.is_error === true ? { kind: 'toolResult', output, isError: record.is_error === true } : null
      }
      return null
    }
    case 'content_block_delta': {
      const d = obj.delta
      if (!d || typeof d !== 'object') return null
      if (getString((d as Record<string, unknown>).type) !== 'text_delta') return null
      const t = getString((d as Record<string, unknown>).text)
      return t ? { kind: 'assistantText', mode: 'delta', text: t } : null
    }
    case 'result': {
      const t = getString(obj.result)
      return t ? { kind: 'assistantText', mode: 'snapshot', text: t } : null
    }
    case 'text': {
      const t = getString(obj.content)
      return t ? { kind: 'assistantText', mode: 'delta', text: t } : null
    }
    // Codex output format
    case 'item.completed': {
      const item = obj.item && typeof obj.item === 'object' ? obj.item as Record<string, unknown> : null
      if (!item) return null
      const itemType = getString(item.type)
      if (itemType === 'agent_message') {
        const text = getString(item.text)
        return text ? { kind: 'assistantText', mode: 'snapshot', text } : null
      }
      if (itemType === 'command_execution') {
        const cmd = getString(item.command) ?? getString(item.args_string) ?? 'command'
        const output = getString(item.output) ?? ''
        const exitCode = item.exit_code
        const isError = exitCode !== undefined && exitCode !== 0
        return output ? { kind: 'toolResult', output: `$ ${cmd}\n${output}`, isError } : { kind: 'toolUse', name: `Bash: ${cmd}`, toolName: 'Bash', input: null }
      }
      if (itemType === 'file_changes') {
        const files = Array.isArray(item.changes) ? item.changes as Record<string, unknown>[] : []
        const summary = files.map(f => `${getString(f.type) ?? 'edit'}: ${getString(f.file) ?? '?'}`).join('\n')
        return summary ? { kind: 'toolResult', output: summary, isError: false } : null
      }
      return null
    }
    // Cursor CLI tool_call events (subtype: started/completed)
    case 'tool_call': {
      const subtype = getString(obj.subtype)
      const tc = obj.tool_call && typeof obj.tool_call === 'object' ? obj.tool_call as Record<string, unknown> : null
      if (!tc) return null

      const CURSOR_TOOL_KEYS: Record<string, string> = {
        readToolCall: 'Read', writeToolCall: 'Write', editToolCall: 'Edit',
        shellToolCall: 'Bash', searchToolCall: 'Search', grepToolCall: 'Grep',
        globToolCall: 'Glob', fetchToolCall: 'WebFetch',
      }
      let toolName = 'tool'
      let toolData: Record<string, unknown> | null = null
      for (const [key, name] of Object.entries(CURSOR_TOOL_KEYS)) {
        if (key in tc) {
          toolName = name
          toolData = tc[key] && typeof tc[key] === 'object' ? tc[key] as Record<string, unknown> : null
          break
        }
      }
      if (toolName === 'tool') {
        const fn = tc.function && typeof tc.function === 'object' ? tc.function as Record<string, unknown> : null
        if (fn) toolName = getString(fn.name) ?? 'tool'
      }

      if (HIDDEN_TOOLS.has(toolName)) return null

      if (subtype === 'started') {
        const args = toolData?.args && typeof toolData.args === 'object' ? toolData.args as Record<string, unknown> : null
        const inp = extractToolInput(args)
        return { kind: 'toolUse', name: inp ? `${toolName}: ${inp}` : toolName, toolName, input: args }
      }

      if (subtype === 'completed') {
        const result = toolData?.result && typeof toolData.result === 'object' ? toolData.result as Record<string, unknown> : null
        let output = ''
        let isError = false
        if (result) {
          const success = result.success && typeof result.success === 'object' ? result.success as Record<string, unknown> : null
          const error = result.error
          if (success) {
            output = getString(success.content) ?? getString(success.path) ?? JSON.stringify(success).slice(0, 3000)
          } else if (error && typeof error === 'object') {
            output = getString((error as Record<string, unknown>).message) ?? JSON.stringify(error).slice(0, 3000)
            isError = true
          } else if (typeof error === 'string') {
            output = error.slice(0, 3000)
            isError = true
          }
        }
        return output || isError ? { kind: 'toolResult', output, isError } : null
      }

      return null
    }
    case 'turn.completed':
    case 'turn.started':
    case 'thread.started':
      return null
    default: return null
  }
}

function mergeSnapshotText(current: string, snapshot: string): string {
  if (!snapshot) return current
  if (!current) return snapshot
  if (snapshot === current || current.endsWith(snapshot)) return current
  if (snapshot.startsWith(current)) return snapshot
  if (current.startsWith(snapshot)) return current
  return `${current}\n\n${snapshot}`
}

function appendToAgent(msg: AgentMsg, parsed: ParsedLine): AgentMsg {
  const blocks = [...msg.blocks]
  switch (parsed.kind) {
    case 'assistantText': {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'text') {
        blocks[blocks.length - 1] = {
          kind: 'text',
          text: parsed.mode === 'snapshot'
            ? mergeSnapshotText(last.text, parsed.text)
            : last.text + parsed.text,
        }
      } else {
        blocks.push({ kind: 'text', text: parsed.text })
      }
      return { ...msg, blocks }
    }
    case 'toolUse':
      blocks.push({ kind: 'tool', entry: { name: parsed.name, detail: { toolName: parsed.toolName, input: parsed.input } } })
      return { ...msg, blocks }
    case 'toolResult': {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === 'tool') {
          const prev = (blocks[i] as AgentToolBlock).entry
          blocks[i] = {
            kind: 'tool',
            entry: {
              ...prev,
              output: parsed.output,
              isError: parsed.isError,
              detail: prev.detail ? { ...prev.detail, output: parsed.output, isError: parsed.isError } : undefined,
            },
          }
          break
        }
      }
      return { ...msg, blocks }
    }
  }
}

/**
 * Apply a single session event to the current message list. Pure function —
 * returns a new array. Used by phase-2 event-stream polling instead of the
 * old NDJSON-per-line pollChatOutput path.
 *
 * Contract:
 *   - run.started       — ensure the last agent message is open (new one if needed)
 *   - assistant.message — append/merge a text block into the current agent message
 *   - tool.started      — append a tool block
 *   - tool.finished     — attach output to the matching tool block (by toolCallId,
 *                         falling back to the most recent tool block without output)
 *   - run.finished      — mark the current agent message done
 *   - status, heartbeat — no-op (heartbeat is a liveness signal, status is UX-only)
 */
/** Ensure the last message is an open agent bubble, creating one if needed.
 *  Used before appending assistant.message / tool.started content — handles
 *  the case where we missed the run.started event (skip or out-of-order) and
 *  prevents accidentally merging new-turn output into a prior DONE bubble. */
function ensureOpenAgent(messages: Msg[], timestamp: string): Msg[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'agent' && !last.done) return [...messages]
  return [...messages, { role: 'agent', blocks: [], done: false, timestamp }]
}

function applyEventToMessages(messages: Msg[], event: SessionEvent): Msg[] {
  const last = messages[messages.length - 1]
  if (last?.role === 'agent' && typeof last._lastEventSeq === 'number' && event.seq <= last._lastEventSeq) {
    return messages
  }

  switch (event.kind) {
    case 'heartbeat':
    case 'status':
      return messages

    case 'run.started': {
      const next = ensureOpenAgent(messages, event.createdAt)
      const agent = next[next.length - 1]
      if (agent?.role === 'agent') next[next.length - 1] = { ...agent, _lastEventSeq: event.seq }
      return next
    }

    case 'assistant.message': {
      const text = typeof event.payload.text === 'string' ? event.payload.text : ''
      if (!text) return messages
      const next = ensureOpenAgent(messages, event.createdAt)
      const last = next[next.length - 1] as AgentMsg
      next[next.length - 1] = { ...appendToAgent(last, {
        kind: 'assistantText', mode: 'snapshot', text,
      }), _lastEventSeq: event.seq }
      return next
    }

    case 'assistant.text_delta': {
      // Token-level streaming chunk. Bridge emits one event per
      // `content_block_delta.text_delta` from the Anthropic SSE stream.
      // `mode: 'delta'` tells appendToAgent to concatenate to the last
      // text block rather than replace it, so the reply visibly grows
      // character-by-character instead of arriving as a single blob at
      // the end. The bridge dedupes the final `assistant.message` so
      // we don't re-apply the full text on top of the streamed deltas.
      const text = typeof event.payload.text === 'string' ? event.payload.text : ''
      if (!text) return messages
      const next = ensureOpenAgent(messages, event.createdAt)
      const last = next[next.length - 1] as AgentMsg
      next[next.length - 1] = { ...appendToAgent(last, {
        kind: 'assistantText', mode: 'delta', text,
      }), _lastEventSeq: event.seq }
      return next
    }

    case 'tool.started': {
      const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName : 'Tool'
      const input = (event.payload.input ?? null) as Record<string, unknown> | null
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : null
      const next = ensureOpenAgent(messages, event.createdAt)
      const agent = next[next.length - 1] as AgentMsg
      // _startedAt persists the tool's start timestamp on the entry so
      // the live working-indicator can show "Running Bash · npm test ·
      // 22s" — without it we'd have nothing to compute elapsed against
      // (the agent message's timestamp covers the whole turn, not the
      // individual tool call).
      const entry: ToolEntry = { name: toolName, detail: { toolName, input } }
      // Tag with internal-only metadata via cast — keeps the public
      // ToolEntry type narrow while letting us thread ids + timestamps.
      const tagged = entry as ToolEntry & { _callId?: string; _startedAt?: string }
      if (toolCallId) tagged._callId = toolCallId
      tagged._startedAt = event.createdAt
      const blocks: AgentBlock[] = [...agent.blocks, { kind: 'tool', entry: tagged }]
      next[next.length - 1] = { ...agent, blocks, _lastEventSeq: event.seq }
      return next
    }

    case 'tool.finished': {
      const output = typeof event.payload.output === 'string' ? event.payload.output : ''
      const isError = Boolean(event.payload.isError)
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : null
      const next = [...messages]
      const last = next[next.length - 1]
      if (!last || last.role !== 'agent') return messages
      const agent = last as AgentMsg
      const blocks = [...agent.blocks]
      let targetIdx = -1
      if (toolCallId) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b.kind === 'tool' && (b.entry as unknown as { _callId?: string })._callId === toolCallId) {
            targetIdx = i; break
          }
        }
      }
      if (targetIdx < 0) {
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].kind === 'tool' && (blocks[i] as AgentToolBlock).entry.output === undefined) {
            targetIdx = i; break
          }
        }
      }
      if (targetIdx < 0) return messages
      const prev = (blocks[targetIdx] as AgentToolBlock).entry
      blocks[targetIdx] = {
        kind: 'tool',
        entry: {
          ...prev, output, isError,
          detail: prev.detail ? { ...prev.detail, output, isError } : undefined,
        },
      }
      next[next.length - 1] = { ...agent, blocks, _lastEventSeq: event.seq }
      return next
    }

    case 'run.finished': {
      const next = [...messages]
      const last = next[next.length - 1]
      if (last?.role === 'agent') next[next.length - 1] = { ...last, done: true, _lastEventSeq: event.seq }
      return next
    }

    default:
      return messages
  }
}


function dbMessagesToMsgs(dbMessages: ChatMessage[], isRunning = false): Msg[] {
  const result: Msg[] = []
  let currentAgent: AgentMsg | null = null
  for (const message of dbMessages) {
    if (message.role === 'user') {
      if (currentAgent) { result.push({ ...currentAgent, done: true }); currentAgent = null }
      result.push({ role: 'user', text: message.content, timestamp: message.createdAt }); continue
    }
    if (!currentAgent) currentAgent = { role: 'agent', blocks: [], done: false, timestamp: message.createdAt }
    const parsed = parseLine(message.content)
    if (parsed) currentAgent = appendToAgent(currentAgent, parsed)
  }
  if (currentAgent) result.push({ ...currentAgent, done: !isRunning })
  return result
}

function transcriptToMsgs(transcript: ChatTranscriptMessage[], isRunning = false): Msg[] {
  const result: Msg[] = []
  for (const message of [...transcript].sort((a, b) => a.seq - b.seq)) {
    if (message.role === 'user') {
      result.push({ role: 'user', text: message.content, timestamp: message.createdAt })
      continue
    }
    const blocks: AgentBlock[] = []
    if (message.content) blocks.push({ kind: 'text', text: message.content })
    for (const tool of (message.tools ?? [])) {
      if (HIDDEN_TOOLS.has(tool.toolName)) continue
      const inputObj: Record<string, unknown> = {}
      if (tool.inputDataJSON) {
        try { Object.assign(inputObj, JSON.parse(tool.inputDataJSON)) } catch {}
      }
      if (!Object.keys(inputObj).length && tool.input) {
        if (tool.toolName === 'Bash') inputObj.command = tool.input
        else if (['Read', 'Write', 'Edit', 'Glob'].includes(tool.toolName)) inputObj.file_path = tool.input
        else if (tool.toolName === 'Grep') inputObj.pattern = tool.input
      }
      blocks.push({
        kind: 'tool',
        entry: {
          name: tool.input ? `${tool.toolName}: ${tool.input}` : tool.toolName,
          output: tool.output ?? undefined,
          isError: tool.isError,
          detail: {
            toolName: tool.toolName,
            input: Object.keys(inputObj).length ? inputObj : null,
            output: tool.output ?? undefined,
            isError: tool.isError,
          },
        },
      })
    }
    result.push({
      role: 'agent',
      blocks,
      done: !(isRunning && message.state === 'interrupted'),
      timestamp: message.createdAt,
    })
  }
  return result
}

function responseToMsgs(response: { messages: ChatMessage[]; transcript?: ChatTranscriptMessage[] }, isRunning = false): Msg[] {
  if (response.transcript?.length) return transcriptToMsgs(response.transcript, isRunning)
  return dbMessagesToMsgs(response.messages, isRunning)
}

// Session-message cache: paint the prior transcript instantly on session
// open, then refresh in the background. Keyed per-session. TTL is short
// because the server transcript can grow between visits and we don't want
// to hide new turns behind a stale cache for long. The background fetch
// reconciles in either case — TTL just bounds how stale the first paint
// can be before we suppress it entirely.
const SESSION_MSG_CACHE_TTL_MS = 5 * 60 * 1000
const sessionMsgCacheKey = (sessionId: string) => `session-messages:${sessionId}`

/* ── Shiki syntax highlighting ── */

const shikiCache = new Map<string, string>()

function guessLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    css: 'css', html: 'html', json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', toml: 'toml', xml: 'xml', swift: 'swift',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    php: 'php', kt: 'kotlin', scala: 'scala', r: 'r',
    tf: 'hcl', dockerfile: 'dockerfile', makefile: 'makefile',
  }
  return map[ext] || 'text'
}

function HighlightedCode({ code, lang, darkBg }: { code: string; lang: string; darkBg?: boolean }) {
  const [html, setHtml] = useState<string | null>(null)
  const { resolved } = useTheme()
  const theme = darkBg ? 'github-dark' : resolved === 'dark' ? 'github-dark' : 'github-light'
  const cacheKey = `${lang}:${theme}:${code.slice(0, 100)}:${code.length}`

  useEffect(() => {
    const cached = shikiCache.get(cacheKey)
    if (cached) { setHtml(cached); return }
    let cancelled = false
    getCodeToHtml().then(fn => {
      fn(code, { lang: lang || 'text', theme }).then(result => {
        if (!cancelled) { shikiCache.set(cacheKey, result); setHtml(result) }
      }).catch(() => {
        if (!cancelled) {
          fn(code, { lang: 'text', theme }).then(result => {
            if (!cancelled) { shikiCache.set(cacheKey, result); setHtml(result) }
          }).catch(() => {})
        }
      })
    })
    return () => { cancelled = true }
  }, [code, lang, theme, cacheKey])

  if (html) {
    return (
      <div
        className="shiki-wrapper text-[12.5px] leading-[1.6] font-mono overflow-x-auto [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <pre className="text-[12.5px] leading-[1.6] font-mono overflow-x-auto whitespace-pre">{code}</pre>
  )
}

/* ── Tool Content Renderers ── */

function ToolIcon({ name, className = 'w-3.5 h-3.5' }: { name: string; className?: string }) {
  const cls = `${className} flex-shrink-0`
  switch (name) {
    case 'Bash':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" /></svg>
    case 'Read':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
    case 'Write':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
    case 'Edit':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
    case 'Glob':
    case 'Grep':
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
    default:
      return <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A.6.6 0 015.7 11.4l5.384-3.19a.6.6 0 01.916.51v6.38a.6.6 0 01-.58.58z" /></svg>
  }
}

function getToolSummary(detail: ToolDetail): string {
  const { toolName, input } = detail
  if (!input) return toolName
  if (toolName === 'Bash') {
    const cmd = getString(input.command)
    if (cmd) { const short = cmd.split('\n')[0].slice(0, 80); return short.length < cmd.split('\n')[0].length ? `${short}...` : short }
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Glob') {
    const fp = getString(input.file_path) ?? getString(input.pattern)
    if (fp) { const parts = fp.split('/'); return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : fp }
  }
  if (toolName === 'Edit') {
    const fp = getString(input.file_path)
    if (fp) { const parts = fp.split('/'); return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : fp }
  }
  if (toolName === 'Grep') {
    const pattern = getString(input.pattern)
    if (pattern) return pattern.slice(0, 60)
  }
  return toolName
}

const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})(\/\S*)?/g

function detectPreviewPorts(text: string): { port: number; path: string }[] {
  const seen = new Set<number>()
  const results: { port: number; path: string }[] = []
  for (const m of text.matchAll(LOCALHOST_RE)) {
    const port = parseInt(m[1], 10)
    if (port >= 3000 && port <= 9000 && !seen.has(port)) {
      seen.add(port)
      results.push({ port, path: m[2] ?? '' })
    }
  }
  return results
}

function BashContent({ detail, onOpenPreview }: { detail: ToolDetail; onOpenPreview?: (port: number) => void }) {
  const command = getString(detail.input?.command) ?? ''
  const output = stripSystemReminders(detail.output ?? '')
  const isErr = detail.isError
  const ports = onOpenPreview ? detectPreviewPorts(command + '\n' + output) : []
  return (
    <div className="rounded-lg overflow-hidden border border-line" style={{ background: 'var(--code-bg)' }}>
      <div className="px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.6] overflow-x-auto" style={{ color: 'var(--code-text)' }}>
        <div className="flex items-start gap-2">
          <span style={{ color: 'var(--code-prompt)' }} className="select-none flex-shrink-0">$</span>
          <span className="whitespace-pre-wrap break-all">{command}</span>
        </div>
        {output && (
          <div className={`mt-2 whitespace-pre-wrap break-words`} style={{ color: isErr ? 'var(--code-error)' : 'var(--code-muted)' }}>
            {output}
          </div>
        )}
      </div>
      {ports.length > 0 && (
        <div className="px-3.5 py-2 border-t border-line flex flex-wrap gap-2">
          {ports.map(({ port }) => (
            <button
              key={port}
              onClick={() => onOpenPreview?.(port)}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent hover:text-accent/80 bg-accent/10 rounded-md px-2 py-1 transition-colors cursor-pointer"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Preview :{port}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ReadContent({ detail }: { detail: ToolDetail }) {
  const filePath = getString(detail.input?.file_path) ?? ''
  const raw = stripSystemReminders(detail.output ?? '')
  const code = stripLineNumbers(raw)
  const lang = guessLang(filePath)
  const fileName = filePath.split('/').pop() ?? filePath
  return (
    <div className="rounded-lg overflow-hidden border border-line bg-l1">
      {filePath && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 border-b border-line">
          <FileTypeIcon name={fileName} className="w-4 h-4" />
          <span className="text-[11px] font-mono text-tertiary truncate">{fileName}</span>
        </div>
      )}
      <div className="px-3.5 py-2.5 overflow-x-auto">
        <HighlightedCode code={code} lang={lang} />
      </div>
    </div>
  )
}

function WriteContent({ detail }: { detail: ToolDetail }) {
  const filePath = getString(detail.input?.file_path) ?? ''
  const content = getString(detail.input?.content) ?? stripSystemReminders(detail.output ?? '')
  const code = stripLineNumbers(content)
  const lang = guessLang(filePath)
  const fileName = filePath.split('/').pop() ?? filePath
  return (
    <div className="rounded-lg overflow-hidden border border-line bg-l1">
      {filePath && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 border-b border-line">
          <FileTypeIcon name={fileName} className="w-4 h-4" />
          <span className="text-[11px] font-mono text-tertiary truncate">{fileName}</span>
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-green/10 text-green flex-shrink-0">created</span>
        </div>
      )}
      <div className="px-3.5 py-2.5 overflow-x-auto">
        <HighlightedCode code={code} lang={lang} />
      </div>
    </div>
  )
}

/* ── Diff context collapsing ── */

type DiffLine = { type: 'del' | 'add'; text: string }
type DiffSection = { kind: 'hunk'; lines: DiffLine[] } | { kind: 'collapsed'; count: number; startIdx: number }

function collapseDiffContext(oldLines: string[], newLines: string[], contextSize = 3): DiffSection[] {
  // Build unified diff lines
  const allLines: DiffLine[] = [
    ...oldLines.map(l => ({ type: 'del' as const, text: l })),
    ...newLines.map(l => ({ type: 'add' as const, text: l })),
  ]

  // If total lines <= 12, don't collapse
  if (allLines.length <= 12) return [{ kind: 'hunk', lines: allLines }]

  // Find change boundaries - the transition from del to add
  const delEnd = oldLines.length
  const sections: DiffSection[] = []

  // Show first `contextSize` lines of deletions
  if (oldLines.length > contextSize * 2) {
    sections.push({ kind: 'hunk', lines: allLines.slice(0, contextSize) })
    sections.push({ kind: 'collapsed', count: oldLines.length - contextSize * 2, startIdx: contextSize })
    sections.push({ kind: 'hunk', lines: allLines.slice(delEnd - contextSize, delEnd) })
  } else {
    sections.push({ kind: 'hunk', lines: allLines.slice(0, delEnd) })
  }

  // Show first `contextSize` lines of additions
  if (newLines.length > contextSize * 2) {
    sections.push({ kind: 'hunk', lines: allLines.slice(delEnd, delEnd + contextSize) })
    sections.push({ kind: 'collapsed', count: newLines.length - contextSize * 2, startIdx: delEnd + contextSize })
    sections.push({ kind: 'hunk', lines: allLines.slice(allLines.length - contextSize) })
  } else {
    sections.push({ kind: 'hunk', lines: allLines.slice(delEnd) })
  }

  return sections.filter(s => s.kind === 'collapsed' ? s.count > 0 : s.lines.length > 0)
}

function EditContent({ detail }: { detail: ToolDetail }) {
  const oldStr = getString(detail.input?.old_string) ?? ''
  const newStr = getString(detail.input?.new_string) ?? ''
  const filePath = getString(detail.input?.file_path) ?? ''
  const fileName = filePath.split('/').pop() ?? ''
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

  if (!oldStr && !newStr) {
    const output = stripSystemReminders(detail.output ?? '')
    return (
      <div className="rounded-lg overflow-hidden border border-line bg-l1">
        <pre className="px-3.5 py-2.5 text-[12.5px] leading-[1.6] font-mono text-bright overflow-x-auto whitespace-pre-wrap">{output}</pre>
      </div>
    )
  }

  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const sections = collapseDiffContext(oldLines, newLines)

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  // Get all lines for an expanded section
  const getExpandedLines = (section: DiffSection & { kind: 'collapsed' }): DiffLine[] => {
    const allLines: DiffLine[] = [
      ...oldLines.map(l => ({ type: 'del' as const, text: l })),
      ...newLines.map(l => ({ type: 'add' as const, text: l })),
    ]
    return allLines.slice(section.startIdx, section.startIdx + section.count)
  }

  return (
    <div className="rounded-lg overflow-hidden border border-line">
      {/* File header */}
      {fileName && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 border-b border-line bg-l1">
          <FileTypeIcon name={fileName} className="w-4 h-4" />
          <span className="text-[11px] font-mono text-tertiary truncate">{fileName}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[10px] font-medium text-[var(--diff-del-mark)]">-{oldLines.length}</span>
            <span className="text-[10px] font-medium text-[var(--diff-add-mark)]">+{newLines.length}</span>
          </span>
        </div>
      )}
      <div className="font-mono text-[12.5px] leading-[1.6] overflow-x-auto">
        {sections.map((section, si) => {
          if (section.kind === 'collapsed') {
            if (expandedSections.has(si)) {
              const lines = getExpandedLines(section)
              return (
                <div key={si}>
                  {lines.map((line, li) => (
                    <div key={li} className="px-3.5 py-0 flex" style={{ background: line.type === 'del' ? 'var(--diff-del-bg)' : 'var(--diff-add-bg)' }}>
                      <span className="select-none w-5 text-right mr-2 flex-shrink-0" style={{ color: line.type === 'del' ? 'var(--diff-del-mark)' : 'var(--diff-add-mark)' }}>
                        {line.type === 'del' ? '-' : '+'}
                      </span>
                      <span className="whitespace-pre-wrap" style={{ color: line.type === 'del' ? 'var(--diff-del-text)' : 'var(--diff-add-text)' }}>{line.text}</span>
                    </div>
                  ))}
                </div>
              )
            }
            return (
              <button
                key={si}
                onClick={() => toggleSection(si)}
                className="w-full flex items-center justify-center gap-1.5 py-1 border-y border-line bg-l1 hover:bg-l2 transition-colors cursor-pointer"
              >
                <svg className="w-3 h-3 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
                <span className="text-[10px] font-medium text-tertiary">{section.count} unchanged lines</span>
              </button>
            )
          }

          return (
            <div key={si}>
              {section.lines.map((line, li) => (
                <div key={li} className="px-3.5 py-0 flex" style={{ background: line.type === 'del' ? 'var(--diff-del-bg)' : 'var(--diff-add-bg)' }}>
                  <span className="select-none w-5 text-right mr-2 flex-shrink-0" style={{ color: line.type === 'del' ? 'var(--diff-del-mark)' : 'var(--diff-add-mark)' }}>
                    {line.type === 'del' ? '-' : '+'}
                  </span>
                  <span className="whitespace-pre-wrap" style={{ color: line.type === 'del' ? 'var(--diff-del-text)' : 'var(--diff-add-text)' }}>{line.text}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GlobGrepContent({ detail }: { detail: ToolDetail }) {
  const output = stripSystemReminders(detail.output ?? '')
  const lines = output.split('\n').filter(Boolean)
  const isGlob = detail.toolName === 'Glob'

  return (
    <div className="rounded-lg overflow-hidden border border-line bg-l1">
      <div className="px-3.5 py-2.5 space-y-0.5">
        {lines.slice(0, 30).map((line, i) => {
          const fileName = line.split(':')[0] || line
          return (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <FileTypeIcon name={fileName} className="w-4 h-4" />
              <span className="text-[12px] font-mono text-secondary truncate">{line}</span>
            </div>
          )
        })}
        {lines.length > 30 && (
          <p className="text-[11px] text-tertiary pt-1">...and {lines.length - 30} more {isGlob ? 'files' : 'matches'}</p>
        )}
      </div>
    </div>
  )
}

function PlainContent({ detail }: { detail: ToolDetail }) {
  const output = stripSystemReminders(detail.output ?? '')
  return (
    <div className="rounded-lg overflow-hidden border border-line bg-l1">
      <pre className="px-3.5 py-2.5 text-[12.5px] leading-[1.6] font-mono text-secondary overflow-x-auto whitespace-pre-wrap">{output}</pre>
    </div>
  )
}

function ToolContentRenderer({ detail, onOpenPreview }: { detail: ToolDetail; onOpenPreview?: (port: number) => void }) {
  switch (detail.toolName) {
    case 'Bash': return <BashContent detail={detail} onOpenPreview={onOpenPreview} />
    case 'Read': return <ReadContent detail={detail} />
    case 'Write': return <WriteContent detail={detail} />
    case 'Edit': return <EditContent detail={detail} />
    case 'Glob':
    case 'Grep': return <GlobGrepContent detail={detail} />
    default: return <PlainContent detail={detail} />
  }
}

/* ── CopyButton ────────────────────────────────────────────────────────────
 * Tiny utility: clicks copy to clipboard, briefly flips the icon to a
 * checkmark so the user gets immediate tactile feedback. Used on every
 * chat bubble so the user can yank prior prompts / agent replies back
 * into the composer without selecting-and-copying (annoying on mobile). */
function CopyButton({ text, label = 'Copy message', className = '' }: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Fallback for Capacitor/WebView where clipboard API might be
      // restricted: create a temporary textarea, select + execCommand.
      try {
        const el = document.createElement('textarea')
        el.value = text
        el.setAttribute('readonly', '')
        el.style.position = 'absolute'
        el.style.left = '-9999px'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      } catch { /* give up silently */ }
    }
  }
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center h-5 w-5 rounded text-tertiary/60 hover:text-bright hover:bg-l1 active:scale-95 transition-[color,background,transform] duration-100 cursor-pointer ${className}`}
      aria-label={label}
      title={copied ? 'Copied' : label}
    >
      {copied ? (
        <svg className="w-3 h-3 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
        </svg>
      )}
    </button>
  )
}

/* ── Agent message → plain text ────────────────────────────────────────────
 * Flatten an agent message's blocks into copyable plain text. Tool blocks
 * become a bracketed summary line; text blocks pass through unchanged.
 * Ordering preserved so the copy round-trips semantically — good enough
 * for re-feeding into the composer as context. */
function agentMessageToPlainText(msg: AgentMsg): string {
  const chunks: string[] = []
  for (const block of msg.blocks) {
    if (block.kind === 'text') {
      chunks.push(block.text)
    } else {
      const name = block.entry.detail?.toolName ?? block.entry.name
      const summary = block.entry.detail ? getToolSummary(block.entry.detail) : ''
      chunks.push(`[${name}${summary ? ' ' + summary : ''}]`)
    }
  }
  return chunks.join('\n\n').trim()
}

/* ── Tool-call cluster ──────────────────────────────────────────────────────
 * Groups consecutive tool calls into a single collapsed row so an agent that
 * runs 10 Greps + 5 Reads doesn't eat 15 rows of vertical space. Summary row
 * shows a stack of icons + total count; clicking expands into the individual
 * ToolBlock rows (which in turn expand to show per-call input/output). We
 * keep per-tool ToolBlocks inside because their content renderers (Bash
 * stdout, diff views, grep matches) are still the most useful peek-behind. */
function ToolCluster({ tools, onOpenPreview, defaultExpanded }: {
  tools: ToolEntry[]
  onOpenPreview?: (port: number) => void
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded))
  // Pick up to 4 distinct tool names to stack as icons in the summary.
  const distinctNames: string[] = []
  for (const t of tools) {
    const n = t.detail?.toolName ?? t.name
    if (!distinctNames.includes(n)) distinctNames.push(n)
    if (distinctNames.length >= 4) break
  }
  const hasError = tools.some(t => t.isError)
  const pending = tools.some(t => t.detail?.output === undefined && !t.isError)

  // Only one tool: skip the cluster wrapper entirely, render the bare ToolBlock.
  // The cluster affordance is only useful for 2+ calls.
  if (tools.length === 1) {
    return <ToolBlock tool={tools[0]} onOpenPreview={onOpenPreview} />
  }

  return (
    <div className="rounded-lg border border-line overflow-visible">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors duration-100 cursor-pointer hover:bg-l1 ${expanded ? 'bg-l1' : ''}`}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <div className="flex items-center -space-x-1">
          {distinctNames.map(n => (
            <span key={n} className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-l1 border border-line text-secondary">
              <ToolIcon name={n} className="w-2.5 h-2.5" />
            </span>
          ))}
        </div>
        <span className="text-[12px] font-semibold text-secondary">{tools.length} tool calls</span>
        <span className="text-[11px] text-tertiary truncate">
          {distinctNames.slice(0, 3).join(', ')}{distinctNames.length > 3 ? '…' : ''}
        </span>
        {pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-accent flex-shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            running
          </span>
        )}
        {hasError && !pending && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-danger/10 text-danger flex-shrink-0">error</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 animate-fade-in space-y-1.5">
          {tools.map((tool, i) => (
            <ToolBlock key={i} tool={tool} onOpenPreview={onOpenPreview} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Collapsible Tool Block ── */

function ToolBlock({ tool, onOpenPreview }: { tool: ToolEntry; onOpenPreview?: (port: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const detail = tool.detail
  const toolName = detail?.toolName ?? 'tool'
  const summary = detail ? getToolSummary(detail) : tool.name
  const hasContent = Boolean(detail?.output || detail?.input?.command || detail?.input?.old_string || detail?.input?.content)
  const isWrite = toolName === 'Write'
  const filePath = getString(detail?.input?.file_path) ?? ''
  const fileName = filePath.split('/').pop() ?? ''

  return (
    <div className="rounded-lg border border-line overflow-visible">
      <button
        onClick={() => hasContent && setExpanded(prev => !prev)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors duration-100 ${
          hasContent ? 'cursor-pointer hover:bg-l1' : 'cursor-default'
        } ${expanded ? 'bg-l1' : ''}`}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''} ${!hasContent ? 'opacity-30' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>

        <span className="text-secondary"><ToolIcon name={toolName} className="w-3 h-3" /></span>

        {/* File type icon for file-based tools */}
        {fileName && ['Read', 'Write', 'Edit'].includes(toolName) && (
          <FileTypeIcon name={fileName} className="w-4 h-4" />
        )}

        <span className="text-[12px] font-semibold text-secondary flex-shrink-0">{toolName}</span>
        <span className="text-[12px] font-mono text-tertiary truncate">{summary}</span>

        {isWrite && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-green/10 text-green flex-shrink-0">new file</span>
        )}
        {tool.isError && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-danger/10 text-danger flex-shrink-0">error</span>
        )}
      </button>

      {expanded && detail && (
        <div className="px-3 pb-3 animate-fade-in">
          <ToolContentRenderer detail={detail} onOpenPreview={onOpenPreview} />
        </div>
      )}
    </div>
  )
}

/* ── Markdown renderer ── */

function MarkdownContent({ text }: { text: string }) {
  const { resolved } = useTheme()
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++
      elements.push(
        <div key={key++} className="my-2.5 rounded-lg border border-line overflow-hidden" style={{ background: 'var(--code-bg)' }}>
          {lang && (
            <div className="px-3 py-1 border-b border-line text-[10px] font-mono" style={{ color: 'var(--code-muted)' }}>{lang}</div>
          )}
          <div className="px-3.5 py-2.5">
            <HighlightedCode code={codeLines.join('\n')} lang={lang || 'text'} darkBg />
          </div>
        </div>
      )
      continue
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const sizes = ['text-[16px]', 'text-[15px]', 'text-[14px]', 'text-[13px]']
      elements.push(
        <p key={key++} className={`${sizes[level - 1]} font-semibold text-bright mt-3 mb-1`}>
          {renderInline(headingMatch[2], resolved)}
        </p>
      )
      i++; continue
    }

    if (line.match(/^[-*]\s+/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++ }
      elements.push(
        <ul key={key++} className="my-1.5 ml-4 space-y-0.5">
          {items.map((item, idx) => (
            <li key={idx} className="text-[14px] leading-[1.7] text-bright list-disc">
              {renderInline(item, resolved)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++ }
      elements.push(
        <ol key={key++} className="my-1.5 ml-4 space-y-0.5">
          {items.map((item, idx) => (
            <li key={idx} className="text-[14px] leading-[1.7] text-bright list-decimal">
              {renderInline(item, resolved)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    // Markdown table
    if (line.match(/^\|(.+)\|$/) && i + 1 < lines.length && lines[i + 1].match(/^\|[-\s:|]+\|$/)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].match(/^\|(.+)\|$/)) { tableLines.push(lines[i]); i++ }
      const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim())
      const headers = parseRow(tableLines[0])
      const dataRows = tableLines.slice(2).map(parseRow) // skip separator row
      elements.push(
        <div key={key++} className="my-2.5 rounded-lg border border-line overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-l1">
                {headers.map((h, hi) => (
                  <th key={hi} className="px-3 py-1.5 text-left font-semibold text-secondary whitespace-nowrap">{renderInline(h, resolved)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, ri) => (
                <tr key={ri} className="border-b border-line last:border-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-bright whitespace-nowrap">{renderInline(cell, resolved)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Blockquotes
    if (line.match(/^>\s?/)) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].match(/^>\s?/)) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i++ }
      elements.push(
        <blockquote key={key++} className="my-2 pl-3 border-l-2 border-accent/30 text-[14px] leading-[1.7] text-secondary italic">
          {quoteLines.map((ql, qi) => <span key={qi}>{renderInline(ql, resolved)}{qi < quoteLines.length - 1 && <br />}</span>)}
        </blockquote>
      )
      continue
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}\s*$/)) { elements.push(<hr key={key++} className="my-3 border-line" />); i++; continue }

    if (!line.trim()) { elements.push(<div key={key++} className="h-2" />); i++; continue }

    elements.push(
      <p key={key++} className="text-[14px] leading-[1.7] text-bright">
        {renderInline(line, resolved)}
      </p>
    )
    i++
  }

  return <div className="space-y-0.5">{elements}</div>
}

function renderInline(text: string, _theme: string = 'dark'): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  const patterns: { re: RegExp; render: (m: RegExpMatchArray) => React.ReactNode }[] = [
    {
      re: /`([^`]+)`/,
      render: (m) => (
        <code key={key++} className="px-1.5 py-0.5 rounded-md bg-l2 border border-line text-[12.5px] font-mono text-bright">
          {m[1]}
        </code>
      ),
    },
    {
      re: /\*\*([^*]+)\*\*/,
      render: (m) => <strong key={key++} className="font-semibold">{m[1]}</strong>,
    },
    {
      re: /(?<!\*)\*([^*]+)\*(?!\*)/,
      render: (m) => <em key={key++} className="italic">{m[1]}</em>,
    },
    {
      re: /!\[([^\]]*)\]\(([^)]+)\)/,
      render: (m) => <ImageContent key={key++} src={m[2]} alt={m[1]} />,
    },
    {
      re: /\[([^\]]+)\]\(([^)]+)\)/,
      render: (m) => (
        <a key={key++} href={m[2]} target="_blank" rel="noopener noreferrer"
          className="text-accent hover:text-accent/80 underline underline-offset-2 decoration-accent/30">
          {m[1]}
        </a>
      ),
    },
  ]

  while (remaining.length > 0) {
    let earliest: { index: number; length: number; node: React.ReactNode } | null = null
    for (const p of patterns) {
      const m = remaining.match(p.re)
      if (m && m.index !== undefined) {
        if (!earliest || m.index < earliest.index) {
          earliest = { index: m.index, length: m[0].length, node: p.render(m) }
        }
      }
    }
    if (!earliest) { parts.push(<span key={key++}>{remaining}</span>); break }
    if (earliest.index > 0) parts.push(<span key={key++}>{remaining.slice(0, earliest.index)}</span>)
    parts.push(earliest.node)
    remaining = remaining.slice(earliest.index + earliest.length)
  }
  return parts
}

/* ── Model Picker ── */

function ModelPicker({ selectedModel, onSelect, agent, running }: {
  selectedModel: AIModel | null
  onSelect: (model: AIModel) => void
  agent: ChatAgent | null
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const models = agent ? AGENT_MODELS[agent] ?? [] : []
  if (!models.length) return null

  // Default to the first entry in each agent's model list. For Claude that's
  // Opus 4.7 — deliberately the top tier, since the agent bridge benefits
  // from the step-change in agentic-coding quality. Users can downshift to
  // Sonnet 4.6 / Haiku 4.5 via the picker for cost or latency.
  const defaultModel = models[0]
  const current = selectedModel ?? defaultModel

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !running && setOpen(prev => !prev)}
        disabled={running}
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-medium text-secondary transition-all duration-150 hover:text-bright cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span>{current.shortLabel}</span>
        <svg className={`w-2.5 h-2.5 text-tertiary transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-56 rounded-xl border border-line bg-ink shadow-lg shadow-black/20 overflow-hidden animate-scale-in z-50">
          <div className="py-1.5">
            {models.map(model => {
              const isSelected = current.id === model.id
              return (
                <button
                  key={model.id}
                  onClick={() => { onSelect(model); setOpen(false) }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${
                    isSelected ? '' : 'hover:bg-[var(--hover-bg)]'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-medium ${isSelected ? 'text-bright' : 'text-secondary'}`}>{model.shortLabel}</p>
                  </div>
                  {isSelected && (
                    <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Agent Picker ──────────────────────────────────────────────────────────
 *
 * Shows a dropdown of the agents installed on this workspace. Hidden when
 * only one agent is available (nothing to pick). Selecting a different agent
 * switches subsequent turns to that agent — if a session is currently active,
 * we enter draft mode so the selection actually takes effect on the NEXT
 * prompt (agents can't be swapped mid-session).
 */
function AgentPicker({ agents, current, onSelect, disabled }: {
  agents: ChatAgent[]
  current: ChatAgent | null
  onSelect: (agent: ChatAgent) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Nothing to pick from — don't render the control at all.
  if (agents.length <= 1) return null

  const label = current ? AGENT_META[current].name : 'Agent'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(prev => !prev)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[12px] font-medium text-secondary transition-all duration-150 hover:text-bright cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        title={disabled ? 'Finish or cancel the current turn to switch agents' : 'Pick coding agent'}
      >
        {current && (
          <img src={AGENT_META[current].logo} alt="" className="w-3.5 h-3.5 object-contain" />
        )}
        <span>{label}</span>
        <svg className={`w-2.5 h-2.5 text-tertiary transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-56 rounded-xl border border-line bg-ink shadow-lg shadow-black/20 overflow-hidden animate-scale-in z-50">
          <div className="py-1.5">
            {agents.map(agent => {
              const meta = AGENT_META[agent]
              const isSelected = current === agent
              return (
                <button
                  key={agent}
                  onClick={() => { onSelect(agent); setOpen(false) }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${
                    isSelected ? '' : 'hover:bg-[var(--hover-bg)]'
                  }`}
                >
                  <img src={meta.logo} alt="" className="w-4 h-4 object-contain flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-medium ${isSelected ? 'text-bright' : 'text-secondary'}`}>{meta.name}</p>
                  </div>
                  {isSelected && (
                    <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Scroll to Bottom Button ── */

function ScrollToBottomButton({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShow(distFromBottom > 200)
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [containerRef])

  if (!show) return null

  return (
    <button
      onClick={() => containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' })}
      className="absolute bottom-20 right-8 z-40 flex items-center justify-center w-9 h-9 rounded-full bg-l2 border border-line shadow-lg hover:bg-l3 transition-all cursor-pointer animate-fade-in"
      aria-label="Scroll to bottom"
    >
      <svg className="w-4 h-4 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
      </svg>
    </button>
  )
}

/* ── Image Content Renderer ── */

function ImageContent({ src, alt }: { src: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  if (error) return null

  return (
    <div className="my-2 rounded-lg border border-line overflow-hidden bg-l1 inline-block max-w-full">
      {!loaded && (
        <div className="w-48 h-32 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
        </div>
      )}
      <img
        src={src}
        alt={alt ?? 'Image'}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        className={`max-w-full max-h-[400px] object-contain ${loaded ? '' : 'hidden'}`}
      />
    </div>
  )
}

/* ── File Browser Panel ── */

function gitStatusBadge(status: RepoEntry['gitStatus']) {
  if (!status) return null
  const map: Record<string, { label: string; color: string }> = {
    modified: { label: 'M', color: '#e5a00d' },
    added: { label: 'A', color: '#22c55e' },
    deleted: { label: 'D', color: '#ef4444' },
    untracked: { label: 'U', color: '#6b7280' },
    renamed: { label: 'R', color: '#3b82f6' },
    mixed: { label: '~', color: '#a78bfa' },
  }
  const s = map[status]
  if (!s) return null
  return (
    <span className="text-[10px] font-bold flex-shrink-0 w-4 text-center" style={{ color: s.color }}>
      {s.label}
    </span>
  )
}

function FileBrowser({ serverId, sessionId, onClose }: { serverId: string; sessionId?: string; onClose: () => void }) {
  const [repo, setRepo] = useState<RepoResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)

  const loadPath = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await getRepoBrowser(serverId, path, sessionId)
      setRepo(data)
      setCurrentPath(path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [serverId, sessionId])

  useEffect(() => { void loadPath() }, [loadPath])

  return (
    <div className="flex flex-col h-full border-l border-line bg-ink w-full">
      {/* Header — pads under iOS safe-area-top so the Dynamic Island
          doesn't overlap title/close on mobile fullscreen. md:reset
          because on desktop this panel sits inside the chat column,
          not at the viewport top. */}
      <div
        className="flex items-center justify-between px-3 border-b border-line flex-shrink-0"
        style={{
          paddingTop: 'max(0.5rem, var(--safe-area-top))',
          paddingBottom: '0.5rem',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-3.5 h-3.5 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
          <span className="text-[12px] font-semibold text-bright truncate">Files</span>
          {repo?.kind === 'directory' && repo.branch && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent bg-accent/10 rounded px-1.5 py-0.5 flex-shrink-0">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0-12.814a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0 12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
              </svg>
              {repo.branch}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-tertiary hover:text-secondary transition-colors cursor-pointer p-2 -m-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Breadcrumbs */}
      {repo?.kind === 'directory' && repo.breadcrumbs.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line text-[11px] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <button onClick={() => loadPath()} className="text-tertiary hover:text-accent transition-colors cursor-pointer flex-shrink-0">~</button>
          {repo.breadcrumbs.map((bc, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              <span className="text-tertiary/40">/</span>
              <button onClick={() => loadPath(bc.path)} className="text-tertiary hover:text-accent transition-colors cursor-pointer">{bc.name}</button>
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-center">
            <p className="text-[12px] text-danger">{error}</p>
            <button onClick={() => loadPath(currentPath)} className="text-[11px] text-tertiary hover:text-secondary mt-1 cursor-pointer">Retry</button>
          </div>
        ) : repo?.kind === 'directory' ? (
          <div className="py-1">
            {currentPath && (
              <button
                onClick={() => {
                  const parent = currentPath.split('/').slice(0, -1).join('/')
                  loadPath(parent || undefined)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--hover-bg)] transition-colors cursor-pointer"
              >
                <span className="text-[11px] text-tertiary">..</span>
              </button>
            )}
            {repo.entries
              .sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .map(entry => (
                <button
                  key={entry.path}
                  onClick={() => loadPath(entry.path)}
                  className="w-full flex items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-[var(--hover-bg)] cursor-pointer"
                >
                  {entry.kind === 'directory' ? (
                    <svg className="w-3.5 h-3.5 text-accent/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                  ) : (
                    <FileTypeIcon name={entry.name} className="w-3.5 h-3.5" />
                  )}
                  <span className={`text-[12px] truncate ${entry.kind === 'directory' ? 'font-medium text-bright' : 'text-secondary'}`}>
                    {entry.name}
                  </span>
                  {gitStatusBadge(entry.gitStatus)}
                </button>
              ))}
          </div>
        ) : repo?.kind === 'file' ? (
          <div>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line">
              <button onClick={() => loadPath(currentPath?.split('/').slice(0, -1).join('/') || undefined)}
                className="text-[11px] text-tertiary hover:text-accent cursor-pointer">&larr; Back</button>
              <FileTypeIcon name={repo.name} className="w-4 h-4" />
              <span className="text-[11px] font-mono text-secondary truncate flex-1">{repo.name}</span>
              <button
                onClick={async () => {
                  try {
                    const blob = await downloadRepoFile(serverId, currentPath!, sessionId)
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = repo.name
                    document.body.appendChild(a)
                    a.click()
                    a.remove()
                    URL.revokeObjectURL(url)
                  } catch (e) {
                    setError(`Failed to download ${repo.name}: ${(e as Error).message}`)
                  }
                }}
                className="text-[11px] text-tertiary hover:text-accent cursor-pointer flex-shrink-0 flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download
              </button>
            </div>
            {repo.binary ? (
              <p className="px-3 py-4 text-[12px] text-tertiary text-center">Binary file</p>
            ) : repo.content ? (
              <div className="px-3 py-2 overflow-x-auto">
                <HighlightedCode code={repo.content} lang={guessLang(repo.name)} />
              </div>
            ) : (
              <p className="px-3 py-4 text-[12px] text-tertiary text-center">Empty file</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ── Main Component ── */

type ActiveSession = ChatSession & { agent: ChatAgent }

interface Props {
  server: Server
  onHistoryChange?: (sessions: ChatSessionRecord[]) => void
}

export default function ChatWindow({ server, onHistoryChange }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [messages, setMessages] = useState<Msg[]>([])
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [selectedRecord, setSelectedRecord] = useState<ChatSessionRecord | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  // Set by cancelRename and consumed by commitRename — needed because
  // flipping `renamingTitle` unmounts the input and fires onBlur, which
  // would otherwise commit whatever draft the user had typed.
  const skipRenameCommitRef = useRef(false)
  const [offset, setOffset] = useState(0)
  const [running, setRunning] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ChatSessionRecord[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draftMode, setDraftMode] = useState(false)
  const [oldestRawSeq, setOldestRawSeq] = useState<number | null>(null)
  const [hasMoreBefore, setHasMoreBefore] = useState(false)
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(CLAUDE_MODELS[0])
  const [showFileBrowser, setShowFileBrowser] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  // "Has unviewed activity" counters for the Files / Changes panel
  // toggles. Each tracks how many file-write tool blocks the user has
  // already acknowledged (by opening the panel). When the live count
  // exceeds the viewed count, we render a small accent dot on the tab.
  // Preview gets no dot in v1 — that'd require periodic discoverServices
  // polling we don't have a slot for yet.
  const [filesViewedCount, setFilesViewedCount] = useState(0)
  const [changesViewedCount, setChangesViewedCount] = useState(0)
  const [autopilot, setAutopilot] = useState(false)
  // SDLC role for the task being composed. 'auto' = infer from the title
  // (the pre-picker behavior). Applied right after startChatSession returns
  // a sessionId; reset to auto for the next draft.
  const [draftRole, setDraftRole] = useState<SDLCRole | 'auto'>('auto')
  const [branchName, setBranchName] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])
  const [composerDragOver, setComposerDragOver] = useState(false)
  const [listening, setListening] = useState(false)
  // After the user taps stop on the mic, we need a second to round-trip audio
  // to the backend + Whisper. Track it separately so the button can show a
  // distinct "sending…" state instead of pretending it's idle.
  const [transcribing, setTranscribing] = useState(false)
  // Mic button renders when MediaRecorder is available in the browser.
  // Settled post-mount to avoid SSR hydration mismatch (server → no button,
  // first client paint → no button, then effect flips it).
  const [micAvailable, setMicAvailable] = useState(false)
  useEffect(() => { setMicAvailable(hasSpeechRecognition()) }, [])
  const [allServers, setAllServers] = useState<Server[]>([])
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const imagePreviewUrlById = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of attachedFiles) {
      if (isImageLikeFile(a.file)) m.set(a.id, URL.createObjectURL(a.file))
    }
    return m
  }, [attachedFiles])
  useEffect(() => {
    return () => {
      imagePreviewUrlById.forEach(u => URL.revokeObjectURL(u))
    }
  }, [imagePreviewUrlById])
  const addPendingAttachments = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return
    let reported: string | null = null
    setAttachedFiles(prev => {
      const m = mergePendingAttachments(prev, incoming)
      reported = m.error
      return m.next
    })
    if (reported) setError(reported)
    else setError(null)
  }, [setError])
  const handleComposerPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const fromClipboard = await resolveClipboardImageFilesFromPasteEvent(e)
      if (fromClipboard.length === 0) return
      addPendingAttachments(fromClipboard)
    },
    [addPendingAttachments],
  )
  const handleComposerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const types = e.dataTransfer.types
    const hasFiles = types
      ? Array.prototype.indexOf.call(types as ArrayLike<string>, 'Files') >= 0
      : false
    if (hasFiles) {
      e.dataTransfer.dropEffect = 'copy'
      setComposerDragOver(true)
    }
  }, [])
  const handleComposerDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const t = e.relatedTarget
    if (t && t instanceof Node && (e.currentTarget as HTMLElement).contains(t)) return
    setComposerDragOver(false)
  }, [])
  const handleComposerDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setComposerDragOver(false)
      const raw = Array.from(e.dataTransfer.files)
      const files = raw.filter(
        f =>
          f.type.startsWith('image/') ||
          f.type.startsWith('text/') ||
          f.type === 'application/pdf' ||
          f.type === '' ||
          /\.(png|jpe?g|gif|webp|pdf|txt|md|svg|bmp)$/i.test(f.name),
      )
      if (files.length === 0) return
      addPendingAttachments(files)
    },
    [addPendingAttachments],
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestedSessionId = searchParams.get('session')
  const draftRequested = searchParams.get('new') === '1'

  const bottomRef = useRef<HTMLDivElement>(null)
  const chatFeedRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionRef = useRef<ActiveSession | null>(null)
  const offsetRef = useRef(0)
  const runningRef = useRef(false)
  const oldestRawSeqRef = useRef<number | null>(null)
  const hasMoreBeforeRef = useRef(false)
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  // Monotonic counter that increments only when handleLoadOlder
  // actually prepends older messages. The viewport-restore
  // useLayoutEffect depends on this counter (not on `messages`) so a
  // live-poll text_delta landing during the older-history fetch can't
  // consume the anchor before the prepend it was snapshotted for. See
  // Greptile P2 review on PR #106.
  const [prependCount, setPrependCount] = useState(0)
  // The url-driven session loader needs to read `history` without
  // re-firing every time refreshHistory mutates it. Putting `history`
  // in that effect's dep array creates a feedback loop:
  // refreshHistory -> setHistory -> effect re-fires -> loadSessionRecord
  // -> refreshHistory -> setHistory -> ... — observed in prod as ~2 req/sec
  // on /sessions/{id}/messages, eventually exhausting the browser's
  // per-host fetch pool and locking up Chrome. The ref breaks that:
  // the effect's actual triggers are draftRequested + requestedSessionId
  // (the things the URL drives), and it just reads history snapshot via
  // ref when it fires.
  const historyRef = useRef<ChatSessionRecord[]>([])
  // Each loadSessionRecord call gets a new token. After the network
  // round-trip we compare against the latest token — if a newer load
  // has started (user switched sessions mid-fetch), we bail before
  // touching state. Closes the session-switch race where two
  // loadSessionRecord calls could interleave and leave session B
  // looking at session A's metadata. See Greptile P2 on PR #106.
  const loadTokenRef = useRef(0)
  const selectedRecordRef = useRef<ChatSessionRecord | null>(null)
  const draftModeRef = useRef(false)
  const requestedSessionIdRef = useRef<string | null>(null)
  const draftRequestedRef = useRef(false)
  // Event polling refs — phase 2 replaces pollChatOutput/offsetRef
  const eventCursorRef = useRef(0)
  const lastAppliedEventSeqRef = useRef(0)
  const cursorSessionIdRef = useRef<string | null>(null) // which sessionId the cursor belongs to
  const pollInFlightRef = useRef(false)
  const lastEventAtRef = useRef<number>(0)
  const pollNowRef = useRef<() => void>(() => {})
  // AbortController for the currently in-flight getSessionEvents fetch. We
  // keep a handle so the visibility/resume handler can cancel a suspended
  // request when the app returns to the foreground — without this, iOS
  // WKWebView and Chromium backgrounded windows can leave a fetch pending
  // indefinitely (promise never resolves, `finally` never runs, the single-
  // flight flag stays stuck at `true`, polling freezes). See
  // .harness/learnings/2026-04-session-polling-single-flight-stuck.md.
  const pollAbortRef = useRef<AbortController | null>(null)
  // Tracks whether we've received at least one event since this polling
  // session started. Until we have, we cannot trust `sessionStatus: done`
  // from the server — a follow-up turn can easily race: the client polls
  // before the backend has processed sendChatMessage and marked the
  // session running again, so status is stale from the previous turn.
  const seenEventsThisPollRef = useRef(false)
  // Counts consecutive polls where status is terminal and no events have
  // been observed. Used to bail out gracefully for agents that don't emit
  // events (Cursor) — otherwise polling would spin forever.
  const staleDonePollsRef = useRef(0)
  // Error budget: if the events endpoint fails `MAX_CONSECUTIVE_POLL_ERRORS`
  // times in a row, stop polling and surface it as a real failure instead of
  // spinning forever as 'reconnecting'. Reset to 0 on any successful poll.
  const pollErrorCountRef = useRef(0)

  const [connectionState, setConnectionState] = useState<'live' | 'reconnecting' | 'stalled'>('live')
  // Working indicator visibility — keeps the spinner on-screen for at least
  // 700ms after running flips true so fast turns (sub-second responses) are
  // still perceptible. With the old SSH-poll path, the 1-2s polling floor
  // masked this; the events path completes a trivial turn in one request.
  const [showWorking, setShowWorking] = useState(false)
  const showWorkingUntilRef = useRef(0)
  // Live "now" timestamp that ticks while the working indicator is up
  // so the elapsed-seconds counter actually advances. We re-render
  // every 2s during work; idle periods cost nothing because the
  // effect's setInterval only runs while showWorking is true.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!showWorking) return
    const id = setInterval(() => setNowTick(Date.now()), 2000)
    return () => clearInterval(id)
  }, [showWorking])

  sessionRef.current = session; offsetRef.current = offset; runningRef.current = running
  oldestRawSeqRef.current = oldestRawSeq; hasMoreBeforeRef.current = hasMoreBefore
  selectedRecordRef.current = selectedRecord; draftModeRef.current = draftMode
  historyRef.current = history
  requestedSessionIdRef.current = requestedSessionId; draftRequestedRef.current = draftRequested

  // Count of file-mutating tool blocks the agent has run in this session.
  // Drives the "unviewed activity" dots on the Files / Changes panel
  // toggles. Edit/Write/MultiEdit/NotebookEdit are the only Claude Code
  // tools that change repo state — Read/Grep/Glob don't count, Bash is
  // ambiguous (could be `rm` or `ls`) so we exclude it conservatively.
  const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  const fileWriteCount = useMemo(() => {
    let n = 0
    for (const m of messages) {
      if (m.role !== 'agent') continue
      for (const block of m.blocks) {
        if (block.kind === 'tool' && FILE_WRITE_TOOLS.has(block.entry.detail?.toolName ?? '')) n += 1
      }
    }
    return n
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Most recent tool that started but hasn't finished. Drives the
  // live "Running Bash · npm test · 22s" detail in the working
  // indicator. Returns null when no tool is currently in flight (the
  // agent is between calls — could be reasoning, calling the model,
  // or just done).
  const currentRunningTool = useMemo(() => {
    if (messages.length === 0) return null
    // Walk the LAST agent message backwards. A tool only counts as
    // "currently running" if it's in the current turn's agent message
    // and its output hasn't landed yet. Agent messages further back
    // belong to prior turns and their tools are by definition done.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'agent') continue
      const blocks = m.blocks
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j]
        if (b.kind !== 'tool') continue
        const entry = b.entry as ToolEntry & { _startedAt?: string }
        if (entry.output !== undefined) {
          // Latest tool already finished → nothing currently running.
          return null
        }
        return {
          toolName: entry.detail?.toolName ?? entry.name ?? 'Tool',
          input: entry.detail?.input ?? null,
          startedAt: entry._startedAt ?? null,
        }
      }
      // Agent message has text but no tools → no current tool.
      return null
    }
    return null
  }, [messages])
  // Reset viewed counts when switching sessions — otherwise the dot from
  // session A would carry over and immediately show on session B.
  useEffect(() => {
    setFilesViewedCount(0)
    setChangesViewedCount(0)
  }, [session?.sessionId])
  // Auto-mark as viewed when the panel is currently open (user is
  // actively looking) — keeps the dot from popping while they're in it.
  useEffect(() => { if (showFileBrowser) setFilesViewedCount(fileWriteCount) }, [showFileBrowser, fileWriteCount])
  useEffect(() => { if (showChanges) setChangesViewedCount(fileWriteCount) }, [showChanges, fileWriteCount])
  // PR existence is also a "Changes worth seeing" signal — bump the dot
  // until acknowledged. Independent of write count so it shows even on
  // resumed sessions where we didn't see the writes happen live.
  const hasUnviewedFiles = fileWriteCount > filesViewedCount
  const hasUnviewedChanges =
    fileWriteCount > changesViewedCount ||
    (!!selectedRecord?.prUrl && changesViewedCount === 0)

  // ── Slash commands ──────────────────────────────────────────────────────
  const [slashFilter, setSlashFilter] = useState<string | null>(null) // null = popup hidden
  const [slashIdx, setSlashIdx] = useState(0)

  const SLASH_COMMANDS: { cmd: string; aliases?: string[]; description: string; tier: 'client' | 'ssh' }[] = [
    { cmd: '/help', description: 'Show available commands', tier: 'client' },
    { cmd: '/new', aliases: ['/clear', '/reset'], description: 'Start a new session', tier: 'client' },
    { cmd: '/cancel', description: 'Cancel running session', tier: 'client' },
    { cmd: '/model', description: 'Switch model (e.g. /model opus)', tier: 'client' },
    { cmd: '/fast', description: 'Toggle fast mode', tier: 'client' },
    { cmd: '/status', description: 'Show session info', tier: 'client' },
    { cmd: '/cost', description: 'Show token usage from last response', tier: 'client' },
    { cmd: '/compact', description: 'Ask agent to summarize conversation', tier: 'client' },
    { cmd: '/diff', description: 'Open git diff panel', tier: 'client' },
    { cmd: '/copy', description: 'Copy last assistant response', tier: 'client' },
    { cmd: '/doctor', description: 'System diagnostics (Node, Python, git, disk, agents)', tier: 'ssh' },
    { cmd: '/env', description: 'Show custom environment variables', tier: 'ssh' },
    { cmd: '/init', description: 'Show CLAUDE.md project config', tier: 'ssh' },
    { cmd: '/memory', description: 'Show CLAUDE.md contents', tier: 'ssh' },
    { cmd: '/tasks', description: 'List running agent processes', tier: 'ssh' },
    { cmd: '/agent', description: 'Switch agent (e.g. /agent codex)', tier: 'client' },
  ]

  const filteredCommands = slashFilter !== null
    ? SLASH_COMMANDS.filter(c => {
        const q = slashFilter.toLowerCase()
        return c.cmd.includes(q) || c.aliases?.some(a => a.includes(q)) || c.description.toLowerCase().includes(q)
      })
    : []

  function addSystemMessage(text: string, command?: string) {
    setMessages(prev => [...prev, { role: 'system' as const, text, timestamp: new Date().toISOString(), command }])
  }

  function resolveCommand(raw: string): string | null {
    const lower = raw.toLowerCase()
    for (const c of SLASH_COMMANDS) {
      if (c.cmd === lower) return c.cmd
      if (c.aliases?.includes(lower)) return c.cmd
    }
    return null
  }

  // Disable the parent layout scroller so only the chat feed scrolls.
  // The CSS :has() selector is unreliable in WKWebView — it sometimes
  // doesn't re-evaluate after mount, leaving two nested overflow-y-auto
  // containers that fight over touch events and kill scrolling entirely.
  useEffect(() => {
    const el = document.getElementById('dashboard-content')
    if (!el) return
    el.style.overflow = 'hidden'
    return () => { el.style.overflow = '' }
  }, [])

  const workspaceRunning = server.instanceState === 'running'
  const defaultAgent = getPreferredAgent(server)
  const [agentOverride, setAgentOverride] = useState<ChatAgent | null>(null)
  const availableAgent = session?.agent ?? agentOverride ?? getPreferredAgent(server, selectedRecord?.agent) ?? defaultAgent
  const activeAgentMeta = availableAgent ? AGENT_META[availableAgent] : AGENT_META.claude

  useEffect(() => {
    const models = availableAgent ? AGENT_MODELS[availableAgent] ?? [] : []
    if (models.length) {
      setSelectedModel(prev => {
        if (prev && models.some(m => m.id === prev.id)) return prev
        return availableAgent === 'claude' && models.length > 1 ? models[1] : models[0]
      })
    }
  }, [availableAgent])

  // Track whether the user wants to stay pinned to the bottom. We update this
  // from actual scroll events rather than computing distFromBottom inside the
  // message-change effect, because on iOS WKWebView `scrollTop` lags during
  // momentum-scroll — by the time a streaming delta fires React, the browser
  // still reports "at bottom" even though the user has started swiping up,
  // so the auto-scroll would keep yanking them back down and make upward
  // scroll impossible. A scroll-listener-driven ref stays honest.
  const stickyRef = useRef(true)
  useEffect(() => {
    const el = chatFeedRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickyRef.current = distFromBottom < 60
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll on new messages only when the user is pinned at the bottom.
  // If they've scrolled up to read history, leave them alone.
  useEffect(() => {
    const el = chatFeedRef.current
    if (!el) return
    if (stickyRef.current) {
      // Direct scrollTo is less janky than smooth scrollIntoView in WKWebView
      // during rapid streaming updates.
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // Prepending older history should preserve the user's viewport
  // anchor instead of jumping them to a different scroll position.
  // Depending on `prependCount` (not `messages`) is deliberate: the
  // chat feed's `messages` state changes for many reasons (live polls,
  // sends, optimistic updates), and if this effect fired on every
  // change it would consume the anchor on the first unrelated update
  // that happened to land between handleLoadOlder's snapshot and its
  // own setMessages — leaving the prepend itself with no anchor and
  // the viewport jumping. handleLoadOlder bumps `prependCount` ONLY
  // when it actually prepends, batched with the corresponding
  // setMessages call, so this effect runs exactly once per prepend.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const el = chatFeedRef.current
    if (!anchor || !el) return
    const delta = el.scrollHeight - anchor.scrollHeight
    el.scrollTop = anchor.scrollTop + delta
    prependAnchorRef.current = null
  }, [prependCount])

  // Auto-scroll to bottom on initial load or session change. Reset sticky so
  // the fresh session starts pinned even if the previous session left it off.
  useEffect(() => {
    const el = chatFeedRef.current
    if (!el || messages.length === 0) return

    if (isInitialLoad && messages.length > 0) {
      stickyRef.current = true
      el.scrollTop = el.scrollHeight
      setIsInitialLoad(false)
    }
  }, [messages, isInitialLoad])

  useEffect(() => { autosizeComposer(composerRef.current) }, [input])

  // Fetch branch name
  useEffect(() => {
    if (!workspaceRunning) return
    const sid = selectedRecord?.sessionId
    getRepoBrowser(server.serverId, undefined, sid).then(data => {
      if (data.kind === 'directory' && data.branch) setBranchName(data.branch)
    }).catch(() => {})
  }, [server.serverId, workspaceRunning, selectedRecord?.sessionId])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      // Cmd+N — new session
      if (isMod && e.key === 'n') {
        e.preventDefault()
        enterDraftMode()
      }
      // Cmd+B — toggle file browser
      if (isMod && e.key === 'b') {
        e.preventDefault()
        setShowFileBrowser(prev => {
          const next = !prev
          if (next) { setShowPreview(false); setShowChanges(false) }
          return next
        })
      }
      // Cmd+D — toggle changes (diff) panel. Match the single-letter pattern
      // of ⌘N/⌘B/⌘K. preventDefault so browsers/Electron don't trigger the
      // bookmark shortcut.
      if (isMod && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        setShowChanges(prev => {
          const next = !prev
          if (next) { setShowFileBrowser(false); setShowPreview(false) }
          return next
        })
      }
      // Cmd+/ — focus composer
      if (isMod && e.key === '/') {
        e.preventDefault()
        composerRef.current?.focus()
      }
      // Cmd+. — cancel running agent
      if (isMod && e.key === '.') {
        e.preventDefault()
        const s = sessionRef.current
        if (running && s) { cancelChat(server.serverId, s.sessionId, s.pid).catch(() => {}) }
      }
      // Escape — close panels
      if (e.key === 'Escape') {
        if (showFileBrowser) setShowFileBrowser(false)
        if (showPreview) setShowPreview(false)
        if (showChanges) setShowChanges(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showFileBrowser, showPreview, showChanges]) // eslint-disable-line react-hooks/exhaustive-deps

  const openPreview = useCallback((port: number) => {
    if (!server?.serverId) return
    // Only the legacy /api/preview proxy needs the cookie. Cloudflare
    // tunnels are reached directly by the browser at a different origin.
    if (!isCloudflareManaged(server.envType)) {
      void ensurePreviewCookie()
    }
    window.open(
      buildPreviewUrl(server.serverId, port, '', server.envType),
      '_blank',
      'noopener,noreferrer',
    )
  }, [server?.serverId, server?.envType])

  const setRouteSelection = useCallback((nextSessionId: string | null, nextDraft = false) => {
    const params = new URLSearchParams()
    if (nextDraft) params.set('new', '1'); else if (nextSessionId) params.set('session', nextSessionId)
    router.replace(`${pathname}${params.toString() ? '?' + params.toString() : ''}`, { scroll: false })
  }, [pathname, router])

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  // Apply pagination metadata from a fetched messages response. The
  // caller (loadSessionRecord today) is responsible for ensuring this
  // response is still relevant — the load-token check at the call site
  // bails out before this runs if a newer load has superseded.
  //
  // The min-merge logic is deliberate: a no-cache initial load can
  // happen on a session where the user has already pulled in older
  // pages (the don't-shrink rule on the messages setter preserves
  // them). The fresh response's oldestRawSeq is the cap-window start,
  // which is GREATER than the oldest-loaded seq. We keep the smaller
  // value so the Load Older button still points at unloaded history.
  // Same shape for hasMoreBefore.
  const applyHistoryWindowMeta = useCallback((response: ChatSessionMessagesResponse) => {
    const nextOldest = typeof response.oldestRawSeq === 'number' ? response.oldestRawSeq : null
    const nextHasMore = Boolean(response.hasMoreBefore)
    const currentOldest = oldestRawSeqRef.current
    setOldestRawSeq(prev => {
      if (nextOldest == null) return prev
      if (prev == null) return nextOldest
      return nextOldest < prev ? nextOldest : prev
    })
    setHasMoreBefore(prev => {
      if (currentOldest != null && nextOldest != null && nextOldest > currentOldest) return prev
      return nextHasMore
    })
  }, [])

  const loadSessionRecord = useCallback(async (record: ChatSessionRecord) => {
    // Mid-send guard at the SOURCE. While a send is in flight, the local
    // state holds optimistic bubbles (user message + agent placeholder) the
    // server doesn't know about yet. Replacing `messages` from a server
    // fetch in this window wipes them — the user sees their text flash and
    // vanish.
    //
    // This covers two races:
    //   1. Same session: the nav effect tries to reload the session we're
    //      mid-send on; `getSessionMessages` returns empty (DDB hasn't
    //      persisted yet) and wipes state.
    //   2. Different session: a stale `refreshHistory` queued by the pre-send
    //      5s polling interval finally resolves AFTER the send started. Its
    //      `target` falls back to `sessions[0]` (NOT our brand-new session —
    //      that isn't in the list yet due to eventual consistency). A naive
    //      "same-session" guard misses this because the record being loaded
    //      is a *different* sessionId. Refusing any load while running=true
    //      closes both paths. Session-events polling keeps the live view
    //      in sync; no server-side message reload is needed mid-send.
    if (runningRef.current) return
    // Capture a token for this load. After the network round-trip we
    // verify we're still the latest active load before mutating state
    // — closes the session-switch race the Greptile P2 review flagged.
    // Without this, two interleaved loadSessionRecord calls (e.g. user
    // taps session B before A's fetch returns) can leave session B
    // looking at a mix of A's metadata and B's messages.
    const loadToken = ++loadTokenRef.current
    prependAnchorRef.current = null
    setLoadingOlder(false)
    stopPolling(); setError(null)
    // Paint the last-seen transcript instantly from localStorage so users
    // re-opening a long session see content on first frame instead of an
    // empty pane while the network round-trip resolves. The fresh fetch
    // below still runs and reconciles via the same don't-shrink logic
    // used for poll updates — cache is a head-start, not a source of truth.
    // Deliberately skipped when shouldPoll (live session) WOULD be true:
    // we still seed, because the server fetch immediately follows and
    // hydrates the running state. If the cache is empty/stale, this is
    // a no-op.
    const agent = getPreferredAgent(server, record.agent)
    const shouldPoll = workspaceRunning && record.status === 'running' && Boolean(agent)
    setDraftMode(false); setHistory(prev => prev.map(item => item.sessionId === record.sessionId ? record : item))
    const cached = readCache<{ messages: ChatMessage[]; transcript?: ChatTranscriptMessage[] }>(
      sessionMsgCacheKey(record.sessionId), SESSION_MSG_CACHE_TTL_MS,
    )
    if (cached) {
      const cachedMsgs = responseToMsgs(cached, shouldPoll)
      if (cachedMsgs.length > 0) {
        setSelectedRecord(record)
        setMessages(cachedMsgs)
        setSession(agent ? { sessionId: record.sessionId, pid: '', agent } : null)
        setOffset(record.currentRunOffset ?? 0)
      }
    }
    const response = await getSessionMessages(record.sessionId)
    // Bail if a newer loadSessionRecord call took over while our fetch
    // was in flight. Everything below this line writes state that
    // belongs to `record`; if the user has navigated away, applying
    // any of it would leave them on the wrong session's metadata.
    if (loadToken !== loadTokenRef.current) return
    writeCache(sessionMsgCacheKey(record.sessionId), {
      messages: response.messages,
      transcript: response.transcript,
    })
    const fetched = responseToMsgs(response, shouldPoll)
    applyHistoryWindowMeta(response)
    // Defensive: never shrink the transcript from this replacement. Multiple
    // paths call loadSessionRecord after `running` has already flipped back
    // to false (e.g. doOnePoll's `giveUpNoBridgeAgent` branch, which fires
    // ~5s after the session goes "done" but events haven't arrived). If the
    // server hasn't finished persisting the final turn yet, `fetched` is
    // shorter than what we have locally — replacing it would blank the
    // user's message that they literally just watched stream in. If the
    // current session matches AND the fetch is shorter, keep what we have;
    // a later poll or ingest-event will catch up. Still replace freely when
    // switching sessions (different id) because the local state doesn't
    // belong to the target session.
    setSelectedRecord(record)
    setMessages(prev => {
      // Refusing to shrink applies at TWO levels:
      //   (a) whole-message count: the mid-send DDB race where sessions/messages
      //       hasn't persisted the latest turn yet.
      //   (b) block count on the trailing agent message: the events stream
      //       produces a richer transcript than `getSessionMessages` — it
      //       includes tool_use / tool_result blocks that the server-side
      //       `messages` table doesn't persist (it stores only the final
      //       assistant text). Reloading after run.finished would replace
      //       a 5-block agent message (text + 4 Glob/Read tools) with a
      //       1-block version and the UI would lose every tool row. Keep
      //       what we have when we already have strictly more detail.
      if (sessionRef.current?.sessionId !== record.sessionId) return fetched
      if (fetched.length < prev.length) return prev
      const lastF = fetched[fetched.length - 1]
      const lastP = prev[prev.length - 1]
      // P0 correctness: detect and replace a STALE EMPTY agent bubble.
      // Scenario that created the bug: run.started created an agent bubble
      // locally, then polling stalled (Electron App Nap, network hiccup,
      // etc.) before any text events arrived. On reload, `fetched` comes
      // back with the real populated bubble from the messages table — but
      // the block-count check below used to keep `prev` because the old
      // bubble was "same length" (1 message each) and we only guarded
      // against fetched being SHORTER. Result: the populated fetched
      // bubble replaced only once in state but the empty bubble could
      // persist in the DOM when React reconciled on a later render,
      // showing both side-by-side. Explicitly throw the empty one away.
      if (lastF?.role === 'agent' && lastP?.role === 'agent'
          && lastP.blocks.length === 0 && !lastP.done
          && lastF.blocks.length > 0) {
        return fetched
      }
      if (lastF?.role === 'agent' && lastP?.role === 'agent'
          && lastF.blocks.length < lastP.blocks.length) {
        return prev
      }
      return fetched
    })
    setSession(agent ? { sessionId: record.sessionId, pid: '', agent } : null)
    setOffset(record.currentRunOffset ?? 0); setRunning(shouldPoll); setIsInitialLoad(true)
  }, [applyHistoryWindowMeta, server, stopPolling, workspaceRunning])

  const refreshHistory = useCallback(async (preferredSessionId?: string, opts?: { skipMessageReload?: boolean }) => {
    const { sessions } = await getSessions(server.serverId, 20)
    setHistory(sessions); onHistoryChange?.(sessions)
    // Empty-list path used to wipe everything (messages, session, running)
    // unconditionally — but DynamoDB has eventual-consistency lag right
    // after a new session is created, so the FIRST poll after sending a
    // message can briefly come back empty and blow away the optimistic
    // "you sent a message" bubble. Respect skipMessageReload here so the
    // post-send refresh in handleSendText doesn't trash its own state.
    if (sessions.length === 0) {
      // Also bail if we're mid-send — the sessions list comes back empty
      // because the new session hasn't landed in DDB yet (eventual
      // consistency). Wiping here would nuke the optimistic message the
      // user just typed.
      if (!draftModeRef.current && !opts?.skipMessageReload && !runningRef.current) {
        setSelectedRecord(null); setSession(null); setOffset(0); setRunning(false); setMessages([])
        setOldestRawSeq(null); setHasMoreBefore(false); setLoadingOlder(false)
      }
      return
    }
    if (draftRequestedRef.current && !preferredSessionId) return
    const targetId = preferredSessionId ?? requestedSessionIdRef.current ?? selectedRecordRef.current?.sessionId ?? sessions[0]?.sessionId
    const target = sessions.find(s => s.sessionId === targetId) ?? sessions[0]
    const active = selectedRecordRef.current
    const shouldReload = !active || active.sessionId !== target.sessionId || active.updatedAt !== target.updatedAt || active.status !== target.status || Boolean(preferredSessionId)
    const shouldSkipReload = opts?.skipMessageReload || (runningRef.current && active?.sessionId === target.sessionId && target.status === 'running')
    if (!shouldSkipReload && shouldReload) {
      if (target.sessionId !== requestedSessionIdRef.current && !draftRequestedRef.current) setRouteSelection(target.sessionId)
      await loadSessionRecord(target); return
    }
    if (!active || shouldSkipReload) setSelectedRecord(target)
  }, [loadSessionRecord, onHistoryChange, server.serverId, setRouteSelection])

  /**
   * Poll the backend event stream for the current session.
   *
   * Replaces the old pollChatOutput/NDJSON-over-SSH path. Key differences:
   *  - reads from DynamoDB via a plain HTTP GET (no Lambda SSH tunnel)
   *  - single-flight: skips ticks while a request is still in flight
   *  - heartbeat-aware: distinguishes "alive but quiet" from "stalled"
   *  - surfaces transient errors as connectionState='reconnecting' instead of swallowing
   *
   * pollNowRef exposes an imperative "fire a poll right now" for lifecycle
   * handlers (visibility / Capacitor app resume) so a backgrounded iOS
   * WebView can catch up the instant it returns to the foreground.
   */
  const doOnePoll = useCallback(async () => {
    const s = sessionRef.current
    if (!s || pollInFlightRef.current) return
    pollInFlightRef.current = true
    // Track this request so visibility-resume can abort it if the app was
    // backgrounded mid-flight. Without this, iOS WKWebView (and throttled
    // Chromium windows) keep the fetch suspended indefinitely — the promise
    // never resolves, `finally` never runs, the single-flight flag stays
    // stuck at `true`, and every subsequent poll returns early at the guard
    // above until the user manually reloads.
    const controller = new AbortController()
    pollAbortRef.current = controller
    try {
      const result = await getSessionEvents(s.sessionId, eventCursorRef.current, controller.signal)
      eventCursorRef.current = result.nextCursor
      if (result.lastEventAt) {
        const t = Date.parse(result.lastEventAt)
        if (!Number.isNaN(t)) lastEventAtRef.current = t
      }

      // Any successful response resets the error budget — transient 5xx or
      // timeouts shouldn't permanently close the connection if the server
      // recovers mid-stream.
      pollErrorCountRef.current = 0

      const newEvents = result.events.filter(e => e.seq > lastAppliedEventSeqRef.current)
      if (newEvents.length > 0) {
        lastAppliedEventSeqRef.current = newEvents[newEvents.length - 1].seq
        seenEventsThisPollRef.current = true
        // startTransition marks this as a non-urgent update so React 19 can
        // interrupt it to keep input/scroll responsive when a big batch of
        // text_delta events lands at once. The reducer is pure, so yielding
        // is safe; the user just sees the text paint a frame later.
        startTransition(() => {
          setMessages(prev => newEvents.reduce((acc, ev) => applyEventToMessages(acc, ev), prev))
        })
      }
      const sawRunFinished = newEvents.some(e => e.kind === 'run.finished')

      setConnectionState(() => {
        if (result.sessionStatus !== 'running') return 'live'
        const age = Date.now() - (lastEventAtRef.current || Date.now())
        if (age > 15_000) return 'stalled'
        return 'live'
      })

      const terminalStatus = result.sessionStatus === 'done'
        || result.sessionStatus === 'cancelled'
        || result.sessionStatus === 'error'
      // A `done` status is only authoritative if we've actually seen events
      // since polling started — otherwise it's likely stale from the prior
      // turn. `run.finished` in the current batch is always authoritative.
      if (terminalStatus && !seenEventsThisPollRef.current) {
        staleDonePollsRef.current += 1
      } else if (!terminalStatus) {
        staleDonePollsRef.current = 0
      }
      // Safety fallback for agents that never emit events — polling would
      // otherwise loop forever waiting for a tick that never arrives. Most
      // agents (including Cursor via the bridge) DO emit events, so this
      // is a rare edge case. But for the common case of a follow-up turn
      // the chain "client send → lambda warm → ssh → agent create-chat →
      // cursor cold-start → first event" can take 6-10 seconds, during
      // which status is still 'done' from the prior turn and we're polling
      // empty. Set the threshold generously (20 polls × 500ms = 10s) so
      // we don't prematurely give up and miss the real response — the
      // cost of being a bit slower to fall back on the truly broken case
      // is far less than the cost of dropping a legit reply.
      const giveUpNoBridgeAgent = staleDonePollsRef.current >= 20
      const shouldStop = sawRunFinished
        || (terminalStatus && seenEventsThisPollRef.current)
        || giveUpNoBridgeAgent
      if (shouldStop) {
        stopPolling()
        setRunning(false)
        setMessages(prev => {
          const next = [...prev]; const last = next[next.length - 1]
          if (last?.role === 'agent') next[next.length - 1] = { ...last, done: true }
          return next
        })
        // Native desktop banner when the user isn't looking at the app.
        // `notify()` auto-suppresses if document.hasFocus() is true, so
        // this is silent when the user is already watching the chat.
        // Tag by sessionId so follow-up turns replace the previous
        // banner rather than stacking 5 deep.
        try {
          const agentId = selectedRecordRef.current?.agent ?? session?.agent
          const agentName = isSupportedAgent(agentId)
            ? AGENT_META[agentId].name
            : 'Pocket Eng'
          notify(`${agentName} finished`, {
            body: 'Task complete — click to open.',
            tag: `pe-session-${s.sessionId}`,
          })
        } catch { /* notifications are best-effort */ }
        // For the no-bridge-agent fallback, reload the transcript so the
        // agent's response (persisted to the messages table on completion)
        // actually shows up.
        await refreshHistory(s.sessionId, giveUpNoBridgeAgent ? {} : { skipMessageReload: true })
      }
    } catch (err) {
      // Deliberate aborts (from the visibility-resume path) shouldn't be
      // counted as errors or surfaced to the user — they're a housekeeping
      // cancellation, not a connection failure. The fresh poll that
      // replaces the aborted one will report its own outcome.
      if ((err as Error | undefined)?.name === 'AbortError' || controller.signal.aborted) {
        return
      }
      pollErrorCountRef.current += 1
      setConnectionState('reconnecting')
      // ~10 consecutive failures ≈ 2s of wall-clock at the 200ms cadence.
      // That's long enough to weather a Lambda cold-start or a transient
      // DNS blip, but short enough that a truly broken connection surfaces
      // as an error instead of a silent forever-spin.
      const MAX_CONSECUTIVE_POLL_ERRORS = 10
      if (pollErrorCountRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) {
        console.error(
          `Session events poll gave up after ${pollErrorCountRef.current} consecutive errors`,
          err,
        )
        stopPolling()
        setError('Lost connection to the session. Reload to try again.')
      } else {
        console.warn('Session events poll failed (will retry):', err)
      }
    } finally {
      pollInFlightRef.current = false
      // Only clear the ref if we're still the active controller. If a
      // concurrent visibility-resume already swapped in a newer one,
      // don't clobber it.
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null
      }
    }
  }, [refreshHistory, stopPolling])

  // Keep a stable imperative handle for lifecycle-driven pokes.
  pollNowRef.current = () => { void doOnePoll() }

  const startEventPolling = useCallback(async () => {
    const s = sessionRef.current
    if (!s) return

    // Only reset the cursor when we're starting to poll a DIFFERENT session
    // than the one the cursor currently points at. Within one session, the
    // cursor must keep advancing across follow-up turns — otherwise every
    // follow-up re-applies the first turn's events.
    if (cursorSessionIdRef.current !== s.sessionId) {
      // Fetch a FRESH session record — selectedRecord can be stale (loaded
      // at page open) and its lastEventSeq would send cursor backward.
      // Falling back to stale state is better than cursor=0, which would
      // replay the whole session on top of the transcript.
      let initialCursor = selectedRecordRef.current?.lastEventSeq ?? 0
      try {
        const { sessions } = await getSessions(server.serverId, 20)
        const fresh = sessions.find(x => x.sessionId === s.sessionId)
        if (typeof fresh?.lastEventSeq === 'number') initialCursor = fresh.lastEventSeq
      } catch {
        // keep stale value
      }
      eventCursorRef.current = initialCursor
      lastAppliedEventSeqRef.current = initialCursor
      cursorSessionIdRef.current = s.sessionId
    }
    pollInFlightRef.current = false
    pollErrorCountRef.current = 0
    lastEventAtRef.current = Date.now()
    seenEventsThisPollRef.current = false
    staleDonePollsRef.current = 0
    setConnectionState('live')
    void doOnePoll()
    // 200ms cadence. Single-flight protects the backend from overlapping
    // requests; the wire is plain HTTP GET to a Lambda hitting DynamoDB so
    // bandwidth is negligible. The interval has walked down: 1000ms → 500ms
    // → 200ms. At 200ms the perceived lag ("agent typed something but I
    // haven't seen it") is under one frame most of the time, close to SSE
    // feel without the infra work. Cost delta is ~2.5× more GETs to a
    // PAY_PER_REQUEST table — cents per user per month at our volume.
    pollRef.current = setInterval(() => { void doOnePoll() }, 200)
  }, [doOnePoll, server.serverId])

  const startPolling = useCallback(async (_serverId: string) => {
    stopPolling()
    const s = sessionRef.current; if (!s) return
    startEventPolling()
  }, [startEventPolling, stopPolling])

  const startPollingRef = useRef(startPolling)
  startPollingRef.current = startPolling

  useEffect(() => { let c = false; setLoadingHistory(true); refreshHistory().catch(() => { if (!c) setError('Could not load chat history') }).finally(() => { if (!c) setLoadingHistory(false) }); return () => { c = true } }, [refreshHistory])
  useEffect(() => { listServers().then(r => setAllServers(r.servers.filter(s => s.instanceState === 'running'))).catch(() => {}) }, [])
  useEffect(() => { if (running && session && workspaceRunning) void startPollingRef.current(server.serverId); else stopPolling() }, [running, server.serverId, session, stopPolling, workspaceRunning])
  useEffect(() => () => stopPolling(), [stopPolling])
  // Idle list-refresh: picks up new sessions / status changes on sessions we
  // aren't actively viewing. Pass skipMessageReload so it never reloads the
  // active session's messages — that path replaces local state with the
  // server transcript, which can briefly differ from what just streamed in
  // and wipes the trailing assistant reply ("last message disappears ~5s
  // after it lands, comes back on reload"). Live polling is the source of
  // truth for the active session; this interval only needs to refresh the
  // session list metadata.
  useEffect(() => { if (running) return; const i = setInterval(() => { void refreshHistory(undefined, { skipMessageReload: true }) }, 5000); return () => clearInterval(i) }, [refreshHistory, running])

  // Drive the working-indicator state with a 700ms minimum display time.
  useEffect(() => {
    if (running) {
      setShowWorking(true)
      showWorkingUntilRef.current = Date.now() + 700
      return
    }
    const remaining = showWorkingUntilRef.current - Date.now()
    if (remaining <= 0) { setShowWorking(false); return }
    const t = setTimeout(() => setShowWorking(false), remaining)
    return () => clearTimeout(t)
  }, [running])

  // Force an immediate poll when the app/tab returns to the foreground.
  // This is the core fix for the "close app and come back" symptom — iOS
  // WKWebView and backgrounded Chromium windows aggressively throttle
  // setInterval AND suspend in-flight fetches. The suspended fetch never
  // resolves, which leaves `pollInFlightRef.current` stuck at `true` in
  // `doOnePoll`'s try block. Every subsequent poll attempt then returns
  // early at the single-flight guard.
  //
  // resumeAndPoll() fixes that in two steps:
  //   1. Abort the pending controller — its promise rejects with AbortError
  //      which the catch+finally in doOnePoll handle by resetting the flag.
  //   2. Belt-and-suspenders: force-reset the flag ourselves in case the
  //      controller was already cleared or the abort didn't propagate in
  //      some environment.
  //   3. Kick a fresh poll so the catch-up fetch actually runs.
  //
  // Four wake-up signals, each catching a different platform's resume path:
  //   • visibilitychange — covers tab-switch, minimize, screen-off
  //   • pageshow         — covers Safari bfcache restore on iOS WKWebView
  //   • window.focus     — covers Electron desktop app-switching
  //                        (Cmd-Tab on macOS, Alt-Tab on Windows). The
  //                        Electron window stays
  //                        visibilityState='visible' the whole time
  //                        (only minimize flips it to 'hidden'), so
  //                        visibilitychange NEVER fires for app-switch.
  //                        Without this listener the desktop app gets
  //                        stuck exactly the way iOS used to: in-flight
  //                        fetch suspended by the OS deprioritizing the
  //                        background renderer, single-flight flag
  //                        wedged, only escape is reload. This was the
  //                        regression reported as "the previous claude
  //                        messages dont fucking show on desktop".
  //   • online           — network came back from a transient drop (VPN
  //                        toggle, sleep/wake, captive-portal). The
  //                        in-flight fetch may have errored quietly or
  //                        be pending against a dead socket; force a
  //                        catch-up either way.
  //
  // See .harness/learnings/2026-04-session-polling-single-flight-stuck.md.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const resumeAndPoll = () => {
      pollAbortRef.current?.abort()
      pollInFlightRef.current = false
      pollNowRef.current()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') resumeAndPoll() }
    const onPageShow = () => { resumeAndPoll() }
    const onFocus = () => { resumeAndPoll() }
    const onOnline = () => { resumeAndPoll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    let unsub = () => {}
    // Capacitor iOS/Android app-resume path — same shape as the
    // visibilitychange recovery, same reason.
    const resumeAndPoll = () => {
      pollAbortRef.current?.abort()
      pollInFlightRef.current = false
      pollNowRef.current()
    }
    void onAppResume(resumeAndPoll).then(fn => { unsub = fn })
    return () => { unsub() }
  }, [])

  const enterDraftMode = useCallback((updateUrl = true) => {
    stopPolling(); setDraftMode(true); setError(null); setSession(null); setSelectedRecord(null); setOffset(0); setRunning(false); setMessages([])
    setOldestRawSeq(null); setHasMoreBefore(false); setLoadingOlder(false)
    if (updateUrl) setRouteSelection(null, true)
  }, [setRouteSelection, stopPolling])

  const handleLoadOlder = useCallback(async () => {
    const record = selectedRecordRef.current
    const beforeSeq = oldestRawSeqRef.current
    if (!record || loadingOlder || beforeSeq == null || beforeSeq <= 0 || !hasMoreBeforeRef.current) return
    const targetSessionId = record.sessionId

    setLoadingOlder(true)
    setError(null)
    try {
      const response = await getSessionMessages(targetSessionId, { beforeSeq })
      if (selectedRecordRef.current?.sessionId !== targetSessionId) return
      const older = responseToMsgs(response, false)
      if (older.length > 0) {
        // Snapshot scroll position RIGHT BEFORE the prepend, after the
        // await — that captures the most recent scrollHeight including
        // any live-poll updates that landed during the fetch. Pairing
        // it with `setPrependCount(c => c + 1)` makes the
        // useLayoutEffect on `prependCount` fire exactly for this
        // prepend; React 18 batches the two state updates into a
        // single render so the effect sees the new scrollHeight and
        // the live anchor together.
        const el = chatFeedRef.current
        if (el) {
          prependAnchorRef.current = {
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          }
        }
        setMessages(prev => [...older, ...prev])
        setPrependCount(c => c + 1)
      }
      setOldestRawSeq(typeof response.oldestRawSeq === 'number' ? response.oldestRawSeq : beforeSeq)
      setHasMoreBefore(Boolean(response.hasMoreBefore))
    } catch (err) {
      setError((err as Error).message || 'Could not load older messages')
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder])

  useEffect(() => {
    if (draftRequested) {
      // Mid-send race: when the user hits Send from draft mode, the flow
      // is `setDraftMode(false) → setSession(started) → await refreshHistory
      // → setRouteSelection(newId)`. Between the first state update and
      // the URL update, `draftRequested` is still true (URL is `?new=1`)
      // but `draftMode` is already false. Without this guard the effect
      // fires `enterDraftMode(false)` which calls `setMessages([])` —
      // the user's message bubble + agent placeholder flash and vanish.
      // If we already have a running session, the URL is just stale and
      // about to update; ignore this tick.
      if (runningRef.current && sessionRef.current) return
      if (!draftModeRef.current || selectedRecordRef.current || sessionRef.current) enterDraftMode(false); return
    }
    if (requestedSessionId && requestedSessionId !== selectedRecordRef.current?.sessionId) {
      // Same race, different branch: if we're mid-send and the new session
      // is already wired up, don't reload from server. DDB hasn't persisted
      // our optimistic messages yet so `getSessionMessages()` would return
      // empty and wipe the transcript. Polling catches up in ~500ms.
      if (runningRef.current && sessionRef.current?.sessionId === requestedSessionId) return
      // historyRef (not the `history` state) — having `history` in the
      // dep array of this effect made every refreshHistory tick refire
      // the effect, which called refreshHistory again, looping at
      // ~2 req/sec until the browser refused new fetches.
      const target = historyRef.current.find(r => r.sessionId === requestedSessionId)
      if (target) void loadSessionRecord(target); else void refreshHistory(requestedSessionId).catch(() => setError('Could not load chat history'))
    }
  }, [draftRequested, enterDraftMode, loadSessionRecord, refreshHistory, requestedSessionId])

  async function handleSlashCommand(text: string): Promise<boolean> {
    const parts = text.split(/\s+/)
    const cmdRaw = parts[0]
    const args = parts.slice(1).join(' ').trim()
    const cmd = resolveCommand(cmdRaw)
    if (!cmd) {
      addSystemMessage(`Unknown command: ${cmdRaw}. Type /help for available commands.`)
      return true
    }

    setInput(''); setSlashFilter(null)

    switch (cmd) {
      case '/help': {
        const lines = SLASH_COMMANDS.map(c => {
          const aliases = c.aliases ? ` (${c.aliases.join(', ')})` : ''
          return `  ${c.cmd}${aliases} — ${c.description}`
        }).join('\n')
        addSystemMessage(`Available commands:\n\n${lines}`, 'help')
        return true
      }
      case '/new':
        if (running && session) { try { await cancelChat(server.serverId, session.sessionId, session.pid) } catch {} }
        enterDraftMode()
        addSystemMessage('Session cleared. Start a new conversation.', 'new')
        return true
      case '/cancel':
        if (running && session) {
          try { await cancelChat(server.serverId, session.sessionId, session.pid) } catch {}
          setRunning(false)
          addSystemMessage('Session cancelled.', 'cancel')
        } else {
          addSystemMessage('No running session to cancel.', 'cancel')
        }
        return true
      case '/model': {
        const agentModels = availableAgent ? (AGENT_MODELS[availableAgent] ?? []) : []
        if (!args) {
          const list = agentModels.map(m => `${m.id === selectedModel?.id ? '* ' : '  '}${m.displayName} (${m.id})`).join('\n')
          addSystemMessage(`Current: ${selectedModel?.displayName ?? 'default'}\n\nAvailable:\n${list}\n\nSwitch: /model <name>  (also accepts raw model IDs)`, 'model')
          return true
        }
        const q = args.toLowerCase()
        const match = agentModels.find(m => m.id.toLowerCase() === q)
          || agentModels.find(m => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
        if (match) {
          setSelectedModel(match)
          addSystemMessage(`Model set to ${match.displayName}`, 'model')
        } else {
          const adhoc: AIModel = { id: args, displayName: args, shortLabel: args, tier: 'Custom model ID', icon: null, color: 'var(--text-bright)' }
          setSelectedModel(adhoc)
          addSystemMessage(`Model set to ${args} (custom ID — not in preset list)`, 'model')
        }
        return true
      }
      case '/fast': {
        const allModels = Object.values(AGENT_MODELS).flat()
        const haiku = allModels.find(m => m.id.includes('haiku'))
        if (haiku && selectedModel?.id !== haiku.id) { setSelectedModel(haiku); addSystemMessage(`Fast mode on — switched to ${haiku.displayName}`, 'fast') }
        else {
          const sonnet = allModels.find(m => m.id.includes('sonnet'))
          if (sonnet) { setSelectedModel(sonnet); addSystemMessage(`Fast mode off — switched to ${sonnet.displayName}`, 'fast') }
        }
        return true
      }
      case '/status': {
        const info = [
          `Server: ${server.label || server.serverId}`,
          `IP: ${server.publicIp ?? 'n/a'}`,
          `State: ${server.instanceState}`,
          `Agent: ${session?.agent ?? availableAgent ?? 'none'}`,
          `Model: ${selectedModel?.displayName ?? 'default'}`,
          `Session: ${session?.sessionId ?? 'none'}`,
        ].join('\n')
        addSystemMessage(info, 'status')
        return true
      }
      case '/cost': {
        const lastResult = [...messages].reverse().find(m => m.role === 'agent' && 'text' in m)
        if (!lastResult) { addSystemMessage('No responses yet.', 'cost'); return true }
        // Cost info is in the raw NDJSON — look for it in the agent text or just show what we have
        addSystemMessage('Cost info is displayed in the session metadata after each response.', 'cost')
        return true
      }
      case '/compact':
        // Send as a regular message to Claude
        return false // let it through as a normal prompt
      case '/diff':
        setShowChanges(true)
        setShowFileBrowser(false)
        setShowPreview(false)
        addSystemMessage('Opened changes panel.', 'diff')
        return true
      case '/copy': {
        const lastAgent = [...messages].reverse().find(m => m.role === 'agent' && agentHasText(m as AgentMsg)) as AgentMsg | undefined
        if (lastAgent) {
          await navigator.clipboard.writeText(agentText(lastAgent))
          addSystemMessage('Copied last response to clipboard.', 'copy')
        } else {
          addSystemMessage('No response to copy.', 'copy')
        }
        return true
      }
      case '/agent': {
        const available = (server.agents?.length ? server.agents : ['claude']).filter(isSupportedAgent)
        if (!args) {
          const current = availableAgent ?? 'none'
          const list = available.map(a => `${a === current ? '* ' : '  '}${a} (${AGENT_META[a as ChatAgent]?.name ?? a})`).join('\n')
          addSystemMessage(`Current: ${current}\n\nAvailable:\n${list}\n\nSwitch: /agent <name>`, 'agent')
          return true
        }
        const target = available.find(a => a.toLowerCase().includes(args.toLowerCase()))
        if (!target) {
          addSystemMessage(`Unknown agent: ${args}. Available: ${available.join(', ')}`, 'agent')
          return true
        }
        if (running && session) { try { await cancelChat(server.serverId, session.sessionId, session.pid) } catch {} }
        setAgentOverride(target as ChatAgent)
        enterDraftMode()
        addSystemMessage(`Switched to ${AGENT_META[target as ChatAgent]?.name ?? target}. Next message starts a new session.`, 'agent')
        return true
      }
      // SSH commands
      case '/doctor':
      case '/env':
      case '/init':
      case '/memory':
      case '/tasks': {
        addSystemMessage(`Running ${cmd}...`, cmd.slice(1))
        try {
          const res = await runCommand(server.serverId, cmd.slice(1))
          addSystemMessage(res.output, cmd.slice(1))
        } catch (e) {
          addSystemMessage(`Error: ${(e as Error).message}`, cmd.slice(1))
        }
        return true
      }
      default:
        return false
    }
  }

  async function handleSendText(overrideText?: string) {
    const text = (overrideText ?? input).trim(); if (!text && attachedFiles.length === 0) return
    // Safety: if running is stuck but session is done or missing, reset it
    if (running && (!session || (selectedRecord && selectedRecord.status !== 'running'))) {
      setRunning(false)
    }
    if (running) return

    // Intercept slash commands
    if (text.startsWith('/') && attachedFiles.length === 0) {
      const handled = await handleSlashCommand(text)
      if (handled) return
      // /compact falls through as a normal prompt to the agent
    }

    void hapticMedium()
    // First time the user sends a task, silently request desktop
    // notification permission. This runs inside a user gesture so the
    // OS-level prompt actually appears. If the user denies we never ask
    // again — permission is persisted by the browser. The later
    // `run.finished` path fires `notify()` and quietly no-ops if denied.
    void primeNotifications()
    const agent = availableAgent; if (!agent) { setError('Install Claude, Codex, or OpenCode on this workspace.'); return }
    const agentModels = AGENT_MODELS[agent] ?? []
    const modelId = agentModels.length && selectedModel ? selectedModel.id : undefined

    // Upload attached files first
    let fullPrompt = text
    const uploadedImages: UploadedImage[] = []
    if (attachedFiles.length > 0) {
      const imagePaths: string[] = []
      const otherPaths: string[] = []
      for (const { file } of attachedFiles) {
        try {
          const b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve((reader.result as string).split(',')[1])
            reader.onerror = reject
            reader.readAsDataURL(file)
          })
          const { path } = await uploadFile(server.serverId, file.name, b64)
          if (isRasterImageFile(file)) {
            imagePaths.push(path)
            uploadedImages.push({ path, mediaType: file.type || 'image/png' })
          } else {
            otherPaths.push(path)
          }
        } catch (e) {
          setError(`Failed to upload ${file.name}: ${(e as Error).message}`)
          return
        }
      }
      fullPrompt = buildAttachmentPrompt(text, imagePaths, otherPaths)
    }

    // Push BOTH the user message AND an empty agent placeholder in one
    // state update — the placeholder is what the "Thinking…" indicator
    // attaches to. Without it the chat looks frozen for the ~2-15s
    // between `setRunning(true)` and the first event from the bridge
    // (see bridge.mjs: agent SDK yields complete messages, not deltas).
    // `ensureLatestAgentMsg` in applyEventToMessages already checks for
    // a not-yet-done agent at the tail and reuses it, so this placeholder
    // merges with the real message when events arrive.
    setInput('')
    setAttachedFiles([])
    setError(null)
    if (!session) {
      setOldestRawSeq(null)
      setHasMoreBefore(false)
    }
    const now = new Date().toISOString()
    setMessages(prev => [
      ...prev,
      { role: 'user', text: fullPrompt, timestamp: now },
      { role: 'agent', blocks: [], done: false, timestamp: now },
    ])
    setRunning(true)
    try {
      if (!session) {
        const started = await startChatSession(server.serverId, fullPrompt, agent, modelId, autopilot || undefined, undefined, uploadedImages.length ? uploadedImages : undefined)
        // Tag the newborn session with the composer's SDLC role. 'auto'
        // writes nothing — resolveRole falls back to title inference.
        if (draftRole !== 'auto') setStoredRole(started.sessionId, draftRole)
        setDraftRole('auto')
        setDraftMode(false); setSession({ ...started, agent }); setOffset(0); setAutopilot(false); await refreshHistory(started.sessionId, { skipMessageReload: true }); setRouteSelection(started.sessionId)
      } else {
        const nextRun = await sendChatMessage(server.serverId, session.sessionId, fullPrompt, session.agent, modelId, uploadedImages.length ? uploadedImages : undefined)
        setSession({ ...nextRun, agent: session.agent }); setOffset(0); await refreshHistory(session.sessionId, { skipMessageReload: true })
      }
    } catch (err) {
      // Rollback the optimistic pair (user msg + empty agent placeholder)
      // on a send failure so the chat doesn't show a ghost "Thinking…"
      // bubble with no matching user message above it.
      setMessages(prev => {
        const next = [...prev]
        const top = next[next.length - 1]
        if (top?.role === 'agent' && top.blocks.length === 0 && !top.done) next.pop()
        const user = next[next.length - 1]
        if (user?.role === 'user' && user.text === fullPrompt) next.pop()
        return next
      })
      setError((err as Error).message); setRunning(false)
    }
  }

  async function handleCancel() {
    if (!session) return; stopPolling()
    try { await cancelChat(server.serverId, session.sessionId, session.pid) } catch {}
    setRunning(false)
    setMessages(prev => { const next = [...prev]; const last = next[next.length - 1]; if (last?.role === 'agent') next[next.length - 1] = { ...last, done: true }; return next })
    await refreshHistory(session.sessionId)
  }

  async function handleMicToggle() {
    if (listening) {
      // Flip visual state immediately so the pulsing red halo goes away
      // and the button shows a "transcribing" spinner during the round-trip.
      setListening(false)
      setTranscribing(true)
      try { await stopListening() } finally { setTranscribing(false) }
      return
    }
    if (transcribing) return  // second tap during upload: ignore
    const granted = await requestSpeechPermission()
    if (!granted) return
    void hapticMedium()
    setListening(true)
    // onResult fires once, after the backend Whisper call completes (inside
    // stopListening's await) — append to whatever's already in the textarea
    // so a user pre-typed prompt isn't nuked.
    await startListening((text) => {
      setInput(prev => prev ? `${prev.trimEnd()} ${text}` : text)
    })
  }

  const workspaceName = server.label || 'Workspace'
  const sessionAgent = selectedRecord?.agent ?? availableAgent ?? 'claude'
  const agentLabel = AGENT_META[sessionAgent as ChatAgent]?.name ?? sessionAgent

  /* ── Render ── */

  return (
    <section className="flex h-full flex-col" style={{ minHeight: 0 }}>
      {/* ── Task header ── */}
      {selectedRecord && (() => {
        const derivedTitleRaw = (selectedRecord.prompt || selectedRecord.lastPrompt || 'Untitled task').replace(/^\[Session context[\s\S]*?\[End session context\]\s*/i, '').replace(/^(?:\[.*?\]\s*)?You are in AUTOPILOT mode\.[\s\S]*?---\s*\n\s*Task:\s*/i, '').trim()
        const derivedTitle = derivedTitleRaw.split(/\r?\n/).find(Boolean)?.slice(0, 140) || 'Untitled task'
        const taskTitle = selectedRecord.title || derivedTitle
        const sid = selectedRecord.sessionId
        const commitRename = async () => {
          setRenamingTitle(false)
          if (skipRenameCommitRef.current) { skipRenameCommitRef.current = false; return }
          const trimmed = titleDraft.trim()
          // Compare against the displayed title (user-set OR derived) — if the
          // user opened rename and blurred without changing anything, no-op.
          // Otherwise we'd needlessly promote a derived title to explicit.
          if (!trimmed || trimmed === taskTitle) return
          const prev = selectedRecord
          // Optimistic: update title immediately so the header doesn't flash.
          setSelectedRecord({ ...prev, title: trimmed })
          try {
            const updated = await renameSession(sid, trimmed)
            // Merge the server record (bringing the new updatedAt) into both
            // selectedRecord and the matching history entry. Without this the
            // history-poll sees updatedAt drift and triggers an unnecessary
            // full session reload on the next tick.
            setSelectedRecord(curr => curr && curr.sessionId === sid ? { ...curr, ...updated } : curr)
            setHistory(hist => hist.map(h => h.sessionId === sid ? { ...h, ...updated } : h))
          } catch {
            setSelectedRecord(prev)
          }
        }
        const cancelRename = () => {
          skipRenameCommitRef.current = true
          setRenamingTitle(false)
        }
        // sessionBranch / branchDisplay removed alongside the header chip
        // that used to render them. Still available via selectedRecord
        // or the /status slash command if someone asks for it.
        const statusKind =
          selectedRecord.status === 'error' ? 'error'
          : running ? 'running'
          : selectedRecord.status === 'cancelled' ? 'cancelled'
          : selectedRecord.prUrl ? 'review'
          : 'done'
        const statusMeta = {
          running:   { dot: 'bg-green animate-pulse',  label: 'Running' },
          review:    { dot: 'bg-accent',               label: 'Ready for review' },
          done:      { dot: 'bg-tertiary/40',          label: 'Complete' },
          error:     { dot: 'bg-danger',               label: 'Error' },
          cancelled: { dot: 'bg-amber',                label: 'Cancelled' },
        }[statusKind]
        return (
        <div className="border-b border-line px-3 md:px-5 sm:px-8">
          {/* Vertical breathing room trimmed on mobile — phones only have
              ~700px of usable height after the system UI eats into it, so
              every row this header spends is a row the chat feed loses. */}
          <div className="mx-auto flex items-start gap-3 py-1.5 sm:py-2.5 max-w-3xl lg:max-w-4xl xl:max-w-5xl">
            {/* Left: title + context */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full flex-shrink-0 ${statusMeta.dot}`} title={statusMeta.label} />
                {renamingTitle ? (
                  <input
                    autoFocus
                    value={titleDraft}
                    maxLength={100}
                    onChange={e => setTitleDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    // Inline style kills the browser's default focus ring
                    // outright (Tailwind v4's focus:outline-none still lets
                    // WebKit render its native ring on inputs on macOS).
                    style={{ outline: 'none', boxShadow: 'none' }}
                    className="text-[13px] font-semibold text-bright bg-l2/60 appearance-none border-0 rounded-md -mx-1.5 px-1.5 py-0.5 min-w-[6rem] max-w-full truncate [field-sizing:content]"
                  />
                ) : (
                  <span
                    role="button"
                    tabIndex={0}
                    className="text-[13px] font-semibold text-bright truncate cursor-text rounded-md -mx-1.5 px-1.5 py-0.5 hover:bg-l2/60 transition-colors"
                    title={taskTitle}
                    onClick={() => { setTitleDraft(taskTitle); setRenamingTitle(true) }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTitleDraft(taskTitle); setRenamingTitle(true) } }}
                  >{taskTitle}</span>
                )}
                {selectedRecord.setupSession && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded-full flex-shrink-0 uppercase tracking-wide">
                    {running ? 'Setting up' : 'Setup'}
                  </span>
                )}
                {selectedRecord.autopilot && !selectedRecord.setupSession && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full flex-shrink-0 uppercase tracking-wide">
                    Autopilot
                  </span>
                )}
                {/* SDLC role — click to reassign which kind of agent this
                    session represents (Architect / Engineer / QA / …). */}
                <RolePicker sessionId={selectedRecord.sessionId} title={taskTitle} size="sm" />
                {running && connectionState !== 'live' && (
                  <span className={`inline-flex items-center gap-1 text-[10px] font-medium flex-shrink-0 ${connectionState === 'reconnecting' ? 'text-amber-400' : 'text-tertiary'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${connectionState === 'reconnecting' ? 'bg-amber-400 animate-pulse' : 'bg-tertiary/60'}`} />
                    {connectionState === 'reconnecting' ? 'Reconnecting…' : 'Waiting…'}
                  </span>
                )}
              </div>
              <div className="mt-0.5 sm:mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 sm:gap-y-1 text-[10.5px] text-tertiary pl-4">
                <span className="text-secondary font-medium truncate max-w-[180px]" title={workspaceName}>
                  {workspaceName}
                </span>
                <span className="inline-flex items-center gap-1">
                  <img src={activeAgentMeta.logo} alt="" className="h-2.5 w-2.5 object-contain opacity-60" />
                  {agentLabel}
                  {selectedModel && availableAgent && (AGENT_MODELS[availableAgent]?.length ?? 0) > 0 && (
                    <span className="ml-1 font-medium" style={{ color: selectedModel.color }}>{selectedModel.shortLabel}</span>
                  )}
                </span>
                {/* The "Session <hex>" / branch-name chip used to live here.
                    It was an opaque identifier for end users and the biggest
                    contributor to header clutter on phones (alongside the
                    repos chip, which moved to sm-only). The sidebar entry
                    for the session still shows it ("…· Session abed5b73")
                    and it's in the URL, so power users can still see it;
                    no value in echoing it in the header above the feed. */}
                {server.repos?.length ? (
                  // Hide the repos chip on phones — the workspace name already
                  // implies the repo, and this was the biggest contributor to
                  // the metadata line wrapping to a second row on narrow
                  // screens. Re-shows at sm and up.
                  <span className="hidden sm:inline-flex items-center gap-1 truncate max-w-[200px]" title={server.repos.join(', ')}>
                    <svg className="w-2.5 h-2.5 flex-shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                    </svg>
                    {server.repos.map(r => r.split('/').pop()).join(', ')}
                  </span>
                ) : null}
              </div>
            </div>
            {/* Right: panel tabs */}
            <div className="inline-flex items-center gap-px rounded-[10px] bg-l2/80 p-[3px] backdrop-blur-sm flex-shrink-0 mt-0.5">
              {([
                {
                  id: 'files' as const,
                  active: showFileBrowser,
                  hasDot: hasUnviewedFiles,
                  toggle: () => { setShowFileBrowser(prev => !prev); setShowPreview(false); setShowChanges(false) },
                  icon: (
                    <svg className="w-[13px] h-[13px]" viewBox="0 0 16 16" fill="none">
                      <path d="M2 3.5A1.5 1.5 0 013.5 2h2.879a1.5 1.5 0 011.06.44l.622.62a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 5v7.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ),
                  label: 'Files',
                },
                {
                  id: 'preview' as const,
                  active: showPreview,
                  hasDot: false, // v1: no dot — see comment near filesViewedCount
                  toggle: () => { setShowPreview(prev => !prev); setShowFileBrowser(false); setShowChanges(false) },
                  icon: (
                    <svg className="w-[13px] h-[13px]" viewBox="0 0 16 16" fill="none">
                      <rect x="1.5" y="2.5" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="8" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  ),
                  label: 'Preview',
                },
                {
                  id: 'changes' as const,
                  active: showChanges,
                  hasDot: hasUnviewedChanges,
                  toggle: () => { setShowChanges(prev => !prev); setShowPreview(false); setShowFileBrowser(false) },
                  icon: (
                    <svg className="w-[13px] h-[13px]" viewBox="0 0 16 16" fill="none">
                      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M4 6v2a2 2 0 002 2h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  ),
                  label: 'Changes',
                },
              ]).map(tab => (
                <button
                  key={tab.id}
                  onClick={tab.toggle}
                  className={`relative inline-flex items-center gap-[5px] text-[11px] font-medium pl-2 pr-2.5 py-[5px] rounded-[7px] transition-all duration-200 cursor-pointer ${
                    tab.active
                      ? 'text-bright bg-ink shadow-[0_1px_3px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(255,255,255,0.06)_inset]'
                      : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                  {tab.hasDot && !tab.active && (
                    // Tiny accent dot — drawn over the top-right of the
                    // tab. Hidden when the tab is already active so we
                    // don't nag while the user is looking at the panel.
                    <span
                      className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent"
                      aria-label="Unviewed activity"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── Main content area (chat + optional file browser) ── */}
      <div className="flex flex-1" style={{ minHeight: 0, height: 0 }}>
        {/* ── Chat column ── */}
        <div className="flex flex-col flex-1 min-w-0" style={{ minHeight: 0 }}>
          {/* ── Task Hero (PR / branch summary) ── */}
          {selectedRecord?.prUrl && !selectedRecord.setupSession && (
            <div className="flex-shrink-0 border-b border-line bg-gradient-to-b from-l1/60 to-transparent">
              <div className="mx-auto max-w-3xl lg:max-w-4xl xl:max-w-5xl px-5 sm:px-8 py-3">
                {(() => {
                  const prUrl = selectedRecord.prUrl
                  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
                  const repoFull = m?.[1]
                  const prNumber = m?.[2]
                  return (
                    <div className="flex items-center gap-3 rounded-xl bg-l1 border border-line/60 px-3.5 py-2.5 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]">
                      <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                        <svg className="w-[18px] h-[18px] text-accent" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.7}>
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <path d="M4 6v2a2 2 0 002 2h4" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12.5px] font-semibold text-bright">
                            {prNumber ? `Pull request #${prNumber}` : 'Pull request ready'}
                          </span>
                          <span className="inline-flex items-center gap-1 text-[9.5px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Open</span>
                        </div>
                        {repoFull && (
                          <p className="text-[11px] text-tertiary mt-0.5 truncate font-mono">{repoFull}</p>
                        )}
                      </div>
                      <button
                        onClick={() => { setShowChanges(true); setShowFileBrowser(false); setShowPreview(false) }}
                        className="inline-flex items-center gap-1 h-8 px-3 rounded-lg text-[11.5px] font-medium text-secondary bg-l2 hover:bg-l3 hover:text-bright transition-colors cursor-pointer flex-shrink-0"
                        title="Open the Changes panel (⌘D)"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.7">
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <path d="M4 6v2a2 2 0 002 2h4" strokeLinecap="round" />
                        </svg>
                        <span className="hidden sm:inline">Changes</span>
                      </button>
                      <a
                        href={prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[11.5px] font-medium text-white bg-accent hover:bg-accent/90 transition-colors cursor-pointer flex-shrink-0 shadow-[0_1px_0_rgba(255,255,255,0.15)_inset]"
                      >
                        <span>View PR</span>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                      </a>
                    </div>
                  )
                })()}
              </div>
            </div>
          )}
          {/* ── Chat feed ── */}
          {/* `overscrollBehavior: contain` stops scroll-chaining: when the
              user reaches the top/bottom of the chat and keeps dragging,
              the gesture is absorbed here instead of bubbling to the
              parent dashboard-content scroller (or the body, on the rare
              iOS WKWebView build that lets the body scroll). Without this
              the chain produces the "scroll the chat → see the sign-in
              page underneath" symptom on iPhone. */}
          <div className="flex-1 overflow-y-auto" ref={chatFeedRef} style={{ minHeight: 0, scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
            <ScrollToBottomButton containerRef={chatFeedRef} />
        <div className="mx-auto px-5 sm:px-8 max-w-3xl lg:max-w-4xl xl:max-w-5xl">
          {messages.length === 0 && !loadingHistory ? (
            <div className="flex min-h-full flex-1 items-center justify-center py-20">
              <div className="w-full max-w-md text-center animate-fade-in">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-l1">
                  <img src={activeAgentMeta.logo} alt="" className="h-7 w-7 object-contain" />
                </div>
                <p className="text-[17px] font-semibold tracking-tight text-bright">Start a new session</p>
                <p className="mt-1.5 text-[13px] text-tertiary leading-relaxed">
                  Each session runs on its own branch.
                </p>
                {/* Workspace picker */}
                {allServers.length > 1 && (
                  <div className="mt-4 relative inline-block">
                    <button
                      onClick={() => setShowWorkspacePicker(prev => !prev)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-line hover:border-accent/30 hover:bg-l1 transition-all cursor-pointer"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="text-[12px] font-medium text-secondary">{server.label || server.serverId}</span>
                      <svg className="w-3 h-3 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                    {showWorkspacePicker && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowWorkspacePicker(false)} />
                        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 w-56 bg-l1 border border-line rounded-xl shadow-lg py-1 animate-fade-in">
                          {allServers.map(s => (
                            <button
                              key={s.serverId}
                              onClick={() => {
                                setShowWorkspacePicker(false)
                                if (s.serverId !== server.serverId) router.push(`/dashboard/${s.serverId}?new=1`)
                              }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--hover-bg)] transition-colors cursor-pointer ${
                                s.serverId === server.serverId ? 'text-accent' : 'text-secondary'
                              }`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${s.serverId === server.serverId ? 'bg-accent' : 'bg-tertiary/40'}`} />
                              <span className="text-[12px] font-medium truncate">{s.label || s.serverId}</span>
                              {s.serverId === server.serverId && (
                                <svg className="w-3 h-3 ml-auto text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {['Build a feature', 'Fix a bug', 'Review code', 'Refactor'].map(label => (
                    <button key={label} onClick={() => setInput(label.toLowerCase())}
                      className="rounded-full border border-line px-4 py-2 text-[12px] font-medium text-secondary hover:border-accent/30 hover:text-bright hover:bg-l1 transition-all duration-150 cursor-pointer">
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-4 sm:py-6 space-y-5">
              {(hasMoreBefore || loadingOlder) && (
                <div className="flex justify-center pb-1">
                  <button
                    onClick={() => { void handleLoadOlder() }}
                    disabled={loadingOlder}
                    className="inline-flex items-center gap-2 rounded-full border border-line bg-l1/80 px-3 py-1.5 text-[11.5px] font-medium text-secondary hover:border-accent/30 hover:text-bright hover:bg-l2 transition-colors disabled:opacity-60 disabled:cursor-default"
                  >
                    {loadingOlder ? (
                      <>
                        <span className="h-3 w-3 rounded-full border border-accent/20 border-t-accent animate-spin" />
                        Loading older messages...
                      </>
                    ) : (
                      'Load older messages'
                    )}
                  </button>
                </div>
              )}
              {messages.map((msg) => (
                <div key={messageRenderKey(msg)} className="animate-fade-in">
                  {msg.role === 'system' ? (
                    <div className="max-w-full px-4 py-3 rounded-lg bg-l1 border border-line/50">
                      <div className="flex items-center gap-2 mb-1.5">
                        <svg className="w-3 h-3 text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                        {msg.command && <span className="text-[10px] font-mono text-tertiary">/{msg.command}</span>}
                      </div>
                      <pre className="text-[12px] text-secondary font-mono whitespace-pre-wrap leading-relaxed">{stripEmojis(msg.text)}</pre>
                    </div>
                  ) : msg.role === 'user' ? (
                    <div className="flex justify-end">
                      {/* min-w-0 lets max-w-[85%] actually clamp this flex
                          child. Without it, a long unbreakable string —
                          typically an API key the user pastes — overrides
                          max-width via flex's default min-width:auto and
                          expands the bubble past the message column,
                          producing horizontal overflow inside the chat
                          feed (visible as a "drag-to-pan" symptom on
                          iPhone). See learnings/2026-04-chat-user-bubble-overflow-iphone.md. */}
                      <div className="max-w-[85%] min-w-0">
                        <div className="flex items-center gap-2 mb-2 justify-end">
                          <CopyButton text={parseUserBubble(msg.text).displayText || msg.text} label="Copy your message" />
                          <span className="text-[10px] text-tertiary">{formatTime(msg.timestamp)}</span>
                          <span className="text-[11px] font-semibold text-secondary">You</span>
                          <div className="h-4 w-4 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
                            <svg className="w-2.5 h-2.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                            </svg>
                          </div>
                        </div>
                        <div className="mb-3 bg-accent/10 rounded-2xl rounded-tr-md px-4 py-3 border border-accent/20">
                          {(() => {
                            const { displayText, imagePaths, otherPaths } = parseUserBubble(msg.text)
                            return (
                              <>
                                {imagePaths.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mb-2">
                                    {imagePaths.map((p, i) => (
                                      <div key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/15 border border-accent/25 text-[11px] text-accent font-medium">
                                        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                                        </svg>
                                        {p.split('/').pop()}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {otherPaths.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mb-2">
                                    {otherPaths.map((p, i) => (
                                      <div key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[11px] text-secondary font-medium">
                                        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                        </svg>
                                        {p.split('/').pop()}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* break-words wraps long unbreakable tokens
                                    (API keys, hashes, URLs) so they stay inside
                                    the bubble; whitespace-pre-wrap alone wraps
                                    only at whitespace and lets a 100-char key
                                    push the column wider. */}
                                {displayText && (
                                  <p className="text-[14px] leading-[1.6] whitespace-pre-wrap break-words text-bright">{displayText}</p>
                                )}
                              </>
                            )
                          })()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-full">
                      <div className="flex items-center gap-2 mb-2">
                        <img src={activeAgentMeta.logo} alt="" className="h-4 w-4 object-contain opacity-80" />
                        <span className="text-[11px] font-semibold text-secondary">{activeAgentMeta.name}</span>
                        <span className="text-[10px] text-tertiary">{formatTime(msg.timestamp)}</span>
                        {!msg.done && (
                          <span className="inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                            <span className="text-[10px] font-medium text-accent">Live</span>
                          </span>
                        )}
                        {/* Copy the whole agent reply (text + bracketed tool
                            summaries) to clipboard. Only surface after the
                            run finishes — copying a half-streamed reply is
                            rarely useful and the text would keep changing
                            under the user. */}
                        {msg.done && agentHasText(msg) && (
                          <CopyButton
                            text={agentMessageToPlainText(msg)}
                            label="Copy reply"
                            className="ml-auto"
                          />
                        )}
                      </div>
                      {/* Walk blocks; coalesce consecutive tool entries into
                          a single ToolCluster row. Text interrupts a cluster
                          so a "tool → explanation → tool" sequence stays
                          readable (the explanation sits between two clusters
                          rather than hiding inside one). */}
                      {(() => {
                        const rendered: React.ReactNode[] = []
                        let toolBuffer: ToolEntry[] = []
                        let bufferStart = 0
                        // After a parent calls the Agent tool (Task/Agent —
                        // both names supported), Opus often re-runs Read /
                        // Grep / Glob / Bash to verify the subagent's
                        // findings. Functionally fine but visually noisy:
                        // a single delegation balloons to "5 tool calls"
                        // when the parent really only made one decision.
                        // We can't fully prompt-engineer the verification
                        // away on Opus, so split the cluster at the
                        // rendering layer: Agent (and anything before)
                        // gets its own cluster, the redundant follow-ups
                        // collapse into a separate cluster the user can
                        // expand if they're curious. The model still does
                        // the work — we just stop showing it as the
                        // headline event.
                        const VERIFY_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"])
                        const isAgentTool = (t: ToolEntry) => {
                          const n = t.detail?.toolName ?? t.name
                          return n === "Agent" || n === "Task"
                        }
                        const splitForVerification = (buf: ToolEntry[]): { primary: ToolEntry[]; verify: ToolEntry[] } => {
                          // Find LAST Agent in the cluster (multi-Agent
                          // turns are rare; if it happens, treat
                          // verification as belonging to the most recent
                          // delegation).
                          let lastAgent = -1
                          for (let i = 0; i < buf.length; i++) if (isAgentTool(buf[i])) lastAgent = i
                          if (lastAgent < 0 || lastAgent === buf.length - 1) {
                            return { primary: buf, verify: [] }
                          }
                          const tail = buf.slice(lastAgent + 1)
                          const allVerify = tail.every(t =>
                            VERIFY_TOOLS.has(t.detail?.toolName ?? t.name)
                          )
                          if (!allVerify) return { primary: buf, verify: [] }
                          return { primary: buf.slice(0, lastAgent + 1), verify: tail }
                        }
                        const flushTools = () => {
                          if (toolBuffer.length === 0) return
                          const { primary, verify } = splitForVerification(toolBuffer)
                          rendered.push(
                            <div key={`tc-${bufferStart}`} className="mb-1.5">
                              <ToolCluster tools={primary} onOpenPreview={openPreview} />
                            </div>
                          )
                          if (verify.length > 0) {
                            rendered.push(
                              <div key={`tc-${bufferStart}-verify`} className="mb-1.5 -mt-0.5 opacity-70 hover:opacity-100 transition-opacity">
                                <ToolCluster tools={verify} onOpenPreview={openPreview} />
                              </div>
                            )
                          }
                          toolBuffer = []
                        }
                        msg.blocks.forEach((block, j) => {
                          if (block.kind === 'tool') {
                            if (toolBuffer.length === 0) bufferStart = j
                            toolBuffer.push(block.entry)
                          } else {
                            flushTools()
                            rendered.push(
                              <div key={`tx-${j}`} className="mb-3">
                                <MarkdownContent text={stripEmojis(block.text)} />
                              </div>
                            )
                          }
                        })
                        flushTools()
                        return rendered
                      })()}
                      {!msg.done && (
                        <div className="flex items-center gap-2 py-1.5 mt-1">
                          <div className="flex gap-1">
                            {[0, 1, 2].map(d => (
                              <span key={d} className="h-1.5 w-1.5 rounded-full bg-accent/40 animate-pulse" style={{ animationDelay: `${d * 200}ms` }} />
                            ))}
                          </div>
                          <span className="text-[11px] text-tertiary">
                            {!agentHasText(msg) && !agentHasTools(msg)
                              ? 'Thinking...'
                              : agentHasTools(msg) && !agentHasText(msg)
                              ? 'Working...'
                              : 'Writing...'}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {/* Inline PR card replaced by the TaskHero card above the feed. */}
              <div ref={bottomRef} />
            </div>
          )}
            </div>
          </div>

          {/* ── Composer ── */}
          <div className="border-t border-line">
          {showWorking && (
            <div className="flex items-center gap-2 px-5 sm:px-8 py-2 max-w-3xl lg:max-w-4xl xl:max-w-5xl mx-auto">
              <div className="w-3 h-3 border-[1.5px] border-accent/20 border-t-accent rounded-full animate-spin flex-shrink-0" />
              <span className="text-[12px] text-tertiary truncate">
                {(() => {
                  // Prefer "Running Bash · npm test · 22s" detail when
                  // we know a specific tool is in flight; fall back to
                  // generic "<agent> is working..." between tool calls
                  // (agent reasoning, drafting reply, etc).
                  if (!currentRunningTool) {
                    return availableAgent
                      ? `${AGENT_META[availableAgent].name} is working...`
                      : 'Agent is working...'
                  }
                  const name = currentRunningTool.toolName
                  const input = currentRunningTool.input as Record<string, unknown> | null
                  // Same priority order voice's session_status helper
                  // uses for picking a snippet to read aloud — keeps
                  // the chat UI and voice phrasing aligned.
                  const snippetRaw =
                    (input && (input.command || input.file_path || input.pattern)) ?? ''
                  const snippet = typeof snippetRaw === 'string'
                    ? snippetRaw.replace(/\s+/g, ' ').slice(0, 60)
                    : ''
                  const elapsed = currentRunningTool.startedAt
                    ? Math.max(0, Math.floor((nowTick - new Date(currentRunningTool.startedAt).getTime()) / 1000))
                    : 0
                  const elapsedLabel = elapsed >= 60
                    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                    : `${elapsed}s`
                  const parts = [`Running ${name}`]
                  if (snippet) parts.push(snippet)
                  if (elapsed > 0) parts.push(elapsedLabel)
                  return parts.join(' · ')
                })()}
              </span>
            </div>
          )}
        {/* Composer footer — tighter padding on mobile so the chat feed
            above doesn't get squeezed. 16px → 8px top/bottom, gutters
            trimmed to match. */}
        <div className="mx-auto px-3 sm:px-8 py-2 sm:py-3 max-w-3xl lg:max-w-4xl xl:max-w-5xl">
          {error && (
            <div className="flex items-center gap-2 mb-2 animate-fade-in">
              <svg className="w-3 h-3 text-danger flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-[12px] text-danger">{error}</p>
            </div>
          )}

          {!workspaceRunning ? (
            <p className="text-[12px] text-tertiary py-1">Start this workspace to send messages.</p>
          ) : !availableAgent ? (
            <p className="text-[12px] text-tertiary py-1">Install Claude, Codex, or OpenCode to use web chat.</p>
          ) : (
            <div>
              {/* Agent + model picker row */}
              <div className="flex items-center gap-2 mb-1.5 sm:mb-2">
                <AgentPicker
                  agents={(server.agents ?? []).filter(isSupportedAgent) as ChatAgent[]}
                  current={availableAgent}
                  disabled={running}
                  onSelect={(next) => {
                    if (next === availableAgent) return
                    // Agents can't swap mid-session — enter draft mode so the
                    // selection applies to the next prompt, mirroring /agent.
                    setAgentOverride(next)
                    if (session || selectedRecord) enterDraftMode()
                  }}
                />
                <ModelPicker
                  selectedModel={selectedModel}
                  onSelect={setSelectedModel}
                  agent={availableAgent}
                  running={running}
                />
                {/* Role applies at session creation — once a session exists
                    its role is managed from the header RolePicker instead. */}
                {!session && (
                  <RoleSelect value={draftRole} onChange={setDraftRole} disabled={running} />
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length > 0) addPendingAttachments(files)
                  // Reset after a tick so the FileList isn't GC'd mid-read
                  setTimeout(() => { e.target.value = '' }, 0)
                }}
              />
              <div
                className={`composer relative rounded-[22px] border border-line bg-l1/80 backdrop-blur-sm transition-all duration-150 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset,0_8px_24px_-12px_rgba(0,0,0,0.25)] hover:border-line2 focus-within:border-line2 focus-within:bg-ink focus-within:shadow-[0_1px_0_rgba(255,255,255,0.02)_inset,0_12px_36px_-14px_rgba(0,0,0,0.35)] ${composerDragOver ? 'ring-2 ring-accent/35 border-accent/30' : ''}`}
                onDragOver={handleComposerDragOver}
                onDragLeave={handleComposerDragLeave}
                onDrop={handleComposerDrop}
              >
                {/* Attached files inside the container */}
                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-3 pt-3">
                    {attachedFiles.map((a) => {
                      const file = a.file
                      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
                      const isImagePill = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)
                      const preview = imagePreviewUrlById.get(a.id)
                      return (
                        <div key={a.id} className="group relative flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg bg-ink/60 border border-line/50 text-[12px] text-secondary">
                          {preview ? (
                            <div className="h-9 w-9 flex-shrink-0 overflow-hidden rounded-md border border-line/40">
                              <img
                                src={preview}
                                alt={file.name}
                                className="h-full w-full object-cover"
                              />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0" style={{ background: isImagePill ? 'var(--color-accent-muted, rgba(85,198,229,0.1))' : 'var(--hover-bg)' }}>
                              {isImagePill ? (
                                <svg className="w-3 h-3 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                                </svg>
                              ) : (
                                <svg className="w-3 h-3 text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                </svg>
                              )}
                            </div>
                          )}
                          <span className="truncate max-w-[100px] text-[11px] font-medium">{file.name}</span>
                          <button
                            onClick={() => setAttachedFiles(prev => prev.filter(x => x.id !== a.id))}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-tertiary hover:text-bright hover:bg-line/60 transition-colors cursor-pointer flex-shrink-0"
                            type="button"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                {/* Slash command autocomplete */}
                {slashFilter !== null && filteredCommands.length > 0 && (
                  <div className="absolute bottom-full left-0 right-0 mx-3 mb-2 rounded-lg border border-line bg-l1 shadow-lg overflow-hidden animate-fade-in z-50">
                    {filteredCommands.map((c, i) => (
                      <button
                        key={c.cmd}
                        onPointerDown={e => { e.preventDefault(); setInput(c.cmd + ' '); setSlashFilter(null); composerRef.current?.focus() }}
                        className={`w-full text-left px-3 py-2 flex items-baseline gap-3 transition-colors cursor-pointer ${
                          i === slashIdx ? 'bg-accent/10 text-bright' : 'text-secondary hover:bg-[var(--hover-bg)]'
                        }`}
                      >
                        <span className="text-[13px] font-mono font-medium text-accent flex-shrink-0">{c.cmd}</span>
                        <span className="text-[11px] text-tertiary truncate">{c.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Textarea */}
                <textarea
                  ref={composerRef}
                  value={input}
                  onChange={e => {
                    const val = e.target.value
                    setInput(val)
                    // Show/hide slash command popup
                    if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
                      setSlashFilter(val); setSlashIdx(0)
                    } else {
                      setSlashFilter(null)
                    }
                  }}
                  onPaste={handleComposerPaste}
                  onKeyDown={e => {
                    // Slash autocomplete navigation
                    if (slashFilter !== null && filteredCommands.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => Math.min(i + 1, filteredCommands.length - 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx(i => Math.max(i - 1, 0)); return }
                      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                        e.preventDefault()
                        const selected = filteredCommands[slashIdx]
                        if (selected) { setInput(selected.cmd + ' '); setSlashFilter(null) }
                        return
                      }
                      if (e.key === 'Escape') { setSlashFilter(null); return }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSendText() }
                  }}
                  placeholder={session ? `Reply to ${activeAgentMeta.name}…` : `What would you like ${activeAgentMeta.name} to do?  ·  type  /  for commands`}
                  disabled={running}
                  rows={1}
                  className="w-full min-h-[48px] resize-none bg-transparent px-4 pt-3 pb-1 text-[16px] leading-[1.45] text-bright placeholder:text-tertiary/50 focus:outline-none focus-visible:outline-none disabled:opacity-40 selection:bg-accent/25"
                  style={{ scrollbarWidth: 'thin' }}
                  onInput={e => autosizeComposer(e.currentTarget)}
                />
                {/* Bottom toolbar */}
                <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={running}
                      className="flex items-center justify-center w-8 h-8 rounded-lg text-tertiary hover:text-bright hover:bg-[var(--hover-bg)] active:scale-[0.96] transition-[background,color,transform] duration-100 cursor-pointer disabled:opacity-40 disabled:hover:bg-transparent"
                      aria-label="Attach file"
                      title="Attach file"
                    >
                      <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                      </svg>
                    </button>
                    {micAvailable && (
                      <button
                        onClick={() => void handleMicToggle()}
                        disabled={running || transcribing}
                        className={`flex items-center justify-center w-8 h-8 rounded-lg active:scale-[0.96] transition-[background,color,transform] duration-100 cursor-pointer disabled:opacity-40 ${
                          listening
                            ? 'text-danger bg-danger/10'
                            : transcribing
                              ? 'text-accent'
                              : 'text-tertiary hover:text-bright hover:bg-[var(--hover-bg)]'
                        }`}
                        aria-label={listening ? 'Stop listening' : transcribing ? 'Transcribing…' : 'Voice input'}
                        title={listening ? 'Stop listening' : transcribing ? 'Transcribing…' : 'Voice input'}
                      >
                        {listening ? (
                          <span className="relative flex items-center justify-center">
                            <span className="absolute w-5 h-5 rounded-full bg-danger/20 animate-ping" />
                            <svg className="w-[17px] h-[17px] relative" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                            </svg>
                          </span>
                        ) : transcribing ? (
                          <svg className="w-[17px] h-[17px] animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                            <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        ) : (
                          <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                          </svg>
                        )}
                      </button>
                    )}
                    {/* Autopilot toggle — only for new sessions */}
                    {!session && !running && (
                      <button
                        onClick={() => setAutopilot(prev => !prev)}
                        className={`flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[11.5px] font-medium active:scale-[0.98] transition-[background,color,transform] duration-100 cursor-pointer ${
                          autopilot
                            ? 'text-accent bg-accent/10 ring-1 ring-accent/20'
                            : 'text-tertiary hover:text-bright hover:bg-[var(--hover-bg)]'
                        }`}
                        title="Autopilot: agent implements, tests, and creates a PR autonomously"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={autopilot ? 2 : 1.7}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41m5.96 5.96a14.926 14.926 0 01-5.84 2.58m0 0a6 6 0 01-7.38-5.84h4.8" />
                        </svg>
                        Autopilot
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {running ? (
                      <button
                        onClick={() => void handleCancel()}
                        // Icon-only on mobile (tight composer real estate),
                        // icon + "Stop" on desktop where the wider composer
                        // can afford the label and it makes the destructive
                        // action more discoverable.
                        className="flex items-center justify-center h-8 w-8 sm:w-auto sm:px-3 sm:gap-1.5 rounded-lg bg-danger/10 text-danger hover:bg-danger/20 active:scale-[0.96] transition-all duration-100 cursor-pointer"
                        aria-label="Stop"
                        title="Stop"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                        <span className="hidden sm:inline text-[11.5px] font-semibold tracking-wide">Stop</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleSendText()}
                        disabled={!input.trim() && attachedFiles.length === 0}
                        // Width logic:
                        //   mobile: icon-only square (w-8)
                        //   desktop autopilot: "Launch" + icon (px-3 gap-1.5)
                        //   desktop default: "Send" + icon (sm:px-3 sm:gap-1.5)
                        // Keeps the composer balanced on phones where every
                        // pixel matters, gives clear affordance on desktop.
                        className={`flex items-center justify-center h-8 rounded-lg bg-accent text-white font-medium shadow-[0_1px_0_rgba(255,255,255,0.15)_inset,0_4px_10px_-4px_rgba(85,198,229,0.6)] hover:shadow-[0_1px_0_rgba(255,255,255,0.15)_inset,0_6px_14px_-4px_rgba(85,198,229,0.7)] hover:-translate-y-[1px] active:translate-y-0 active:scale-[0.97] transition-all duration-100 cursor-pointer disabled:opacity-25 disabled:shadow-none disabled:hover:translate-y-0 ${autopilot ? 'px-3 gap-1.5' : 'w-8 sm:w-auto sm:px-3 sm:gap-1.5'}`}
                        aria-label={autopilot ? 'Launch autopilot' : 'Send'}
                        title={autopilot ? 'Launch autopilot' : 'Send'}
                      >
                        {autopilot ? (
                          <span className="text-[11px] font-semibold tracking-wide">Launch</span>
                        ) : (
                          <span className="hidden sm:inline text-[11.5px] font-semibold tracking-wide">Send</span>
                        )}
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d={autopilot ? "M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41m5.96 5.96a14.926 14.926 0 01-5.84 2.58m0 0a6 6 0 01-7.38-5.84h4.8" : "M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18"} />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-2 hidden md:flex items-center justify-center gap-4 text-[10px] text-tertiary/50 select-none">
                <span className="flex items-center gap-1.5"><kbd className="font-mono bg-l2/70 border border-line/70 rounded-[5px] px-1.5 py-[1px] leading-none text-tertiary/70 min-w-[14px] text-center">&#9166;</kbd><span>send</span></span>
                <span className="flex items-center gap-1.5"><kbd className="font-mono bg-l2/70 border border-line/70 rounded-[5px] px-1.5 py-[1px] leading-none text-tertiary/70">&#8984;K</kbd><span>search</span></span>
                <span className="flex items-center gap-1.5"><kbd className="font-mono bg-l2/70 border border-line/70 rounded-[5px] px-1.5 py-[1px] leading-none text-tertiary/70">&#8984;B</kbd><span>files</span></span>
                <span className="flex items-center gap-1.5"><kbd className="font-mono bg-l2/70 border border-line/70 rounded-[5px] px-1.5 py-[1px] leading-none text-tertiary/70">&#8984;D</kbd><span>changes</span></span>
              </div>
            </div>
          )}
        </div>
      </div>
        </div>

        {/* ── File Browser Panel ── */}
        {showFileBrowser && workspaceRunning && (
          <>
            <div className="fixed inset-0 z-50 bg-ink md:hidden">
              <FileBrowser serverId={server.serverId} sessionId={selectedRecord?.sessionId} onClose={() => setShowFileBrowser(false)} />
            </div>
            <div className="hidden md:block">
              <ResizablePanel storageKey="pe-panel-width-files" defaultWidth={300}>
                <FileBrowser serverId={server.serverId} sessionId={selectedRecord?.sessionId} onClose={() => setShowFileBrowser(false)} />
              </ResizablePanel>
            </div>
          </>
        )}

        {/* ── Preview Panel ── */}
        {showPreview && workspaceRunning && (
          <>
            <div className="fixed inset-0 z-50 bg-ink md:hidden">
              <PreviewPanel serverId={server.serverId} envType={server.envType} onClose={() => setShowPreview(false)} />
            </div>
            <div className="hidden md:block">
              <ResizablePanel storageKey="pe-panel-width-preview" defaultWidth={420}>
                <PreviewPanel serverId={server.serverId} envType={server.envType} onClose={() => setShowPreview(false)} />
              </ResizablePanel>
            </div>
          </>
        )}

        {/* ── Change Panel ── */}
        {showChanges && workspaceRunning && (
          <>
            <div className="fixed inset-0 z-50 bg-ink md:hidden">
              <ChangePanel serverId={server.serverId} sessionId={selectedRecord?.sessionId} onClose={() => setShowChanges(false)} />
            </div>
            <div className="hidden md:block">
              <ResizablePanel storageKey="pe-panel-width-changes" defaultWidth={520}>
                <ChangePanel serverId={server.serverId} sessionId={selectedRecord?.sessionId} onClose={() => setShowChanges(false)} />
              </ResizablePanel>
            </div>
          </>
        )}

      </div>
    </section>
  )
}
