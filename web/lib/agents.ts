export const SUPPORTED_CHAT_AGENTS = ['claude', 'codex', 'cursor', 'opencode'] as const
export type ChatAgent = (typeof SUPPORTED_CHAT_AGENTS)[number]

export const AGENT_META: Record<ChatAgent, { name: string; logo: string }> = {
  claude: { name: 'Claude Code', logo: '/logos/claude.png' },
  codex: { name: 'Codex', logo: '/logos/openai.svg' },
  cursor: { name: 'Cursor', logo: '/logos/cursor.svg' },
  opencode: { name: 'OpenCode', logo: '/logos/opencode.png' },
}

export function isSupportedAgent(agent: string | null | undefined): agent is ChatAgent {
  return Boolean(agent && SUPPORTED_CHAT_AGENTS.includes(agent as ChatAgent))
}

export function getAgentLogo(agent: string | null | undefined): string | null {
  if (!isSupportedAgent(agent)) return null
  return AGENT_META[agent].logo
}

export function getAgentName(agent: string | null | undefined): string {
  if (!isSupportedAgent(agent)) return agent || 'Unknown'
  return AGENT_META[agent].name
}