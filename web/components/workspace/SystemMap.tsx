'use client'

// Visual system map for a workspace's components. SVG-based — no
// dependency on react-flow, dagre, or anything heavy. Designed for
// the dashboard scale: 3-7 components per workspace, displayed inline
// in a card, no zoom/pan needed.
//
// Layout: components flow left-to-right in declaration order. Each
// node is a rounded box with an icon, name, role, port. Adjacent
// nodes are connected with a thin arrow — the order in the components
// array implies the data-flow path (e.g. Embedder → Vector DB → Search).
//
// Status dot per node: green if its port is in `liveServices`, grey
// otherwise. Same signal we already render on the pill version of the
// Arch tab.

import { useMemo } from 'react'
import { iconForComponent } from './componentIcons'
import type { WorkspaceComponent } from '@/lib/api'

interface Props {
  components: WorkspaceComponent[]
  liveServices?: { port: number; process: string; url: string }[]
  /** Compact mode shrinks padding for use on collapsed cards. */
  compact?: boolean
}

// Layout constants — kept here, not in CSS, so the SVG sizes itself
// deterministically without waiting on a font/layout pass. Easier to
// reason about and avoids the "boxes flash and reposition" you get
// from text-measure-then-redraw patterns.
const NODE_W = 156
const NODE_H = 58
const NODE_GAP_X = 28
const ROW_GAP_Y = 16
const PADDING_X = 12
const PADDING_Y = 12

export function SystemMap({ components, liveServices = [], compact = false }: Props) {
  const livePortSet = useMemo(
    () => new Set(liveServices.map(s => s.port)),
    [liveServices],
  )

  // Wrap into rows of ≤4 so very-wide arches stay readable. We pick 4
  // because that's where typical recsys / model-serving stacks
  // naturally end up — and beyond that the next chain reads as a
  // sub-pipeline.
  const COLS = 4
  const rows: WorkspaceComponent[][] = []
  for (let i = 0; i < components.length; i += COLS) {
    rows.push(components.slice(i, i + COLS))
  }

  const cols = Math.min(COLS, Math.max(1, components.length))
  const width  = PADDING_X * 2 + cols * NODE_W + (cols - 1) * NODE_GAP_X
  const height = PADDING_Y * 2 + rows.length * NODE_H + (rows.length - 1) * ROW_GAP_Y

  return (
    <div className={`overflow-x-auto ${compact ? 'py-1' : 'py-2'}`}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Architecture: ${components.map(c => c.name).join(' → ')}`}
        style={{ display: 'block' }}
      >
        <defs>
          {/* One arrowhead def reused by every connector */}
          <marker
            id="systemmap-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" fill="var(--color-tertiary, #7c8799)" />
          </marker>
        </defs>

        {rows.map((row, rowIdx) => (
          <g key={rowIdx}>
            {row.map((c, colIdx) => {
              const x = PADDING_X + colIdx * (NODE_W + NODE_GAP_X)
              const y = PADDING_Y + rowIdx * (NODE_H + ROW_GAP_Y)
              const live = c.port != null && livePortSet.has(c.port)
              const icon = iconForComponent(c.name, c.role)
              const isLastCol = colIdx === row.length - 1
              const arrowEndX = x + NODE_W + NODE_GAP_X
              const arrowStartX = x + NODE_W
              const midY = y + NODE_H / 2

              return (
                <g key={`${c.name}-${colIdx}`}>
                  {/* Connector to the next node in this row */}
                  {!isLastCol && (
                    <line
                      x1={arrowStartX}
                      y1={midY}
                      x2={arrowEndX - 2}
                      y2={midY}
                      stroke="var(--color-tertiary, #7c8799)"
                      strokeWidth={1.2}
                      strokeOpacity={0.5}
                      markerEnd="url(#systemmap-arrow)"
                    />
                  )}
                  <Node
                    x={x}
                    y={y}
                    component={c}
                    live={live}
                    color={icon.color}
                    iconSvg={icon.svg}
                    iconLabel={icon.label}
                  />
                </g>
              )
            })}
          </g>
        ))}
      </svg>
    </div>
  )
}

function Node({
  x,
  y,
  component,
  live,
  color,
  iconSvg,
  iconLabel,
}: {
  x: number
  y: number
  component: WorkspaceComponent
  live: boolean
  color: string
  iconSvg: React.ReactNode
  iconLabel: string
}) {
  // SVG `<foreignObject>` lets us drop in real HTML/CSS for the box
  // contents — much easier than calculating text widths in SVG, and
  // we inherit the design system's colors and font stack for free.
  return (
    <foreignObject x={x} y={y} width={NODE_W} height={NODE_H}>
      <div
        title={component.name + (component.role ? ` — ${component.role}` : '')}
        className="card-surface flex items-center gap-2 px-2.5 py-2 h-full"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <div
          className="w-5 h-5 flex-shrink-0 flex items-center justify-center"
          style={{ color }}
          aria-label={iconLabel}
        >
          {iconSvg}
        </div>
        <div className="flex-1 min-w-0 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] font-medium text-bright truncate">{component.name}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${live ? 'bg-accent' : 'bg-tertiary/40'}`}
              aria-label={live ? 'live' : 'not detected'}
            />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {component.role && (
              <span className="text-[10px] text-tertiary truncate">{component.role}</span>
            )}
            {component.port != null && (
              <span className="text-[10px] text-secondary font-mono shrink-0">:{component.port}</span>
            )}
          </div>
        </div>
      </div>
    </foreignObject>
  )
}
