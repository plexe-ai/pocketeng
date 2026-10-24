const SLACK_OAUTH_STATE_KEY = 'pe.slack.oauth.state'

function generateSlackOAuthState(): string {
  if (typeof window === 'undefined') {
    throw new Error('Slack OAuth state can only be generated in the browser')
  }

  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID()
  }

  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16)
    window.crypto.getRandomValues(bytes)
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function prepareSlackOAuthState(): string {
  const state = generateSlackOAuthState()
  window.sessionStorage.setItem(SLACK_OAUTH_STATE_KEY, state)
  return state
}

export function consumeSlackOAuthState(): string | null {
  if (typeof window === 'undefined') return null

  const state = window.sessionStorage.getItem(SLACK_OAUTH_STATE_KEY)
  if (state) {
    window.sessionStorage.removeItem(SLACK_OAUTH_STATE_KEY)
  }
  return state
}
