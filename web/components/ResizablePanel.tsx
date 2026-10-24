'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// How much room we always leave for the chat column on the left, even when the
// user drags the panel as wide as it'll go. Below this, the chat becomes
// unusable, so we clamp instead of letting it shrink to zero.
const MIN_CHAT_WIDTH = 360

interface Props {
  storageKey: string
  defaultWidth: number
  minWidth?: number
  maxWidth?: number
  children: React.ReactNode
}

export default function ResizablePanel({
  storageKey,
  defaultWidth,
  minWidth = 260,
  maxWidth = 900,
  children,
}: Props) {
  const [width, setWidth] = useState<number>(defaultWidth)
  const [vpWidth, setVpWidth] = useState<number>(0)
  // Tracks the in-flight drag. `latestWidth` is updated on each pointermove so
  // pointerup persists the final value even if React hasn't re-rendered yet
  // (event handlers can fire faster than the render cycle).
  const dragRef = useRef<{ startX: number; startWidth: number; latestWidth: number } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(storageKey)
    if (stored) {
      const n = Number(stored)
      if (Number.isFinite(n) && n > 0) setWidth(n)
    }
    setVpWidth(window.innerWidth)
    const onResize = () => setVpWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [storageKey])

  const effectiveMax = vpWidth > 0
    ? Math.max(minWidth, Math.min(maxWidth, vpWidth - MIN_CHAT_WIDTH))
    : maxWidth
  const displayWidth = Math.max(minWidth, Math.min(effectiveMax, width))

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startWidth: displayWidth, latestWidth: displayWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [displayWidth])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.startWidth + (drag.startX - e.clientX)
    drag.latestWidth = next
    setWidth(next)
  }, [])

  const finishDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    if (typeof window !== 'undefined') {
      const persisted = Math.max(minWidth, Math.min(effectiveMax, drag.latestWidth))
      window.localStorage.setItem(storageKey, String(persisted))
    }
  }, [storageKey, minWidth, effectiveMax])

  const onDoubleClick = useCallback(() => {
    setWidth(defaultWidth)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(storageKey)
    }
  }, [defaultWidth, storageKey])

  return (
    <div className="relative h-full flex-shrink-0" style={{ width: displayWidth }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={onDoubleClick}
        title="Drag to resize · double-click to reset"
        className="absolute top-0 left-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize z-20 group touch-none"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-line group-hover:bg-accent group-hover:w-[2px] group-active:bg-accent group-active:w-[2px] transition-all" />
      </div>
      <div className="h-full">{children}</div>
    </div>
  )
}
