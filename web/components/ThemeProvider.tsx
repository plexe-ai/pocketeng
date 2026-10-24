'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

const ThemeCtx = createContext<{
  theme: Theme
  resolved: Theme
  setTheme: (t: Theme) => void
}>({ theme: 'dark', resolved: 'dark', setTheme: () => {} })

export function useTheme() { return useContext(ThemeCtx) }

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark')

  // Initialize from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('pe-theme') as Theme | null
    const t = (stored === 'light' || stored === 'dark') ? stored : 'dark'
    setThemeState(t)
    applyTheme(t)
  }, [])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    localStorage.setItem('pe-theme', t)
    applyTheme(t)
  }, [])

  return (
    <ThemeCtx.Provider value={{ theme, resolved: theme, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  )
}
