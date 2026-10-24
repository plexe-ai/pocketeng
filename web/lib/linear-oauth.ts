const LINEAR_OAUTH_STATE_KEY = 'pe.linear.oauth.state'

function generateLinearOAuthState(): string {
  if (typeof window === 'undefined') {
    throw new Error('Linear OAuth state can only be generated in the browser')
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

export function prepareLinearOAuthState(): string {
  const state = generateLinearOAuthState()
  window.sessionStorage.setItem(LINEAR_OAUTH_STATE_KEY, state)
  return state
}

export function consumeLinearOAuthState(): string | null {
  if (typeof window === 'undefined') return null

  const state = window.sessionStorage.getItem(LINEAR_OAUTH_STATE_KEY)
  if (state) {
    window.sessionStorage.removeItem(LINEAR_OAUTH_STATE_KEY)
  }
  return state
}
