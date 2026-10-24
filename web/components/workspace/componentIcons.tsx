'use client'

// Icon + brand-color lookup for workspace components. Three layers of
// resolution, walked in order until one matches:
//
//   1. Brand match    — role/name contains "qdrant" → qdrant logo + color.
//                       For when we recognize specific tech.
//   2. Family match   — role contains "vector db" / "model" / "api" →
//                       generic family glyph in a neutral tint. Catches
//                       components whose tech we don't have a logo for
//                       but whose category is clear.
//   3. Fallback       — generic dot. Better than crash.
//
// All icons are inline SVG (no network), MIT-licensed simpleicons or
// hand-drawn. Sized to 14px by default so they slot into pills + boxes.

import type { ReactNode } from 'react'

export interface ComponentIcon {
  /** Inline SVG content sized at the parent's font-size box. */
  svg: ReactNode
  /** Brand color (HEX) — used as a small accent on the box outline. */
  color: string
  /** What this icon represents — shown in tooltip / aria-label. */
  label: string
}

interface BrandEntry {
  /** Regex tested against the lowercased `${name} ${role}` string. */
  match: RegExp
  icon: ComponentIcon
}

// ──── Brand icons ────────────────────────────────────────────────────
//
// Keep this list focused on tech we expect to see in real customer
// workspaces. Adding to it is cheap — one entry, one SVG. Removing
// is fine too; everything falls through to family icons.

const BRANDS: BrandEntry[] = [
  // Vector DBs
  {
    match: /\bqdrant\b/,
    icon: {
      label: 'Qdrant',
      color: '#DC382D',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1l10 5.5v11L12 23l-10-5.5v-11L12 1zm0 2.3L4 7.85v8.3L12 20.7l8-4.55v-8.3L12 3.3zm0 3.7l5 2.85V15L12 17.85 7 15V9.85L12 7z"/></svg>
      ),
    },
  },
  {
    match: /\bpinecone\b/,
    icon: {
      label: 'Pinecone',
      color: '#1B17F5',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6h-2v6h-2V8H9l3-6zm-3 12h6l-3 7-3-7z"/></svg>
      ),
    },
  },
  {
    match: /\bweaviate\b/,
    icon: {
      label: 'Weaviate',
      color: '#21B099',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 8v8l10 6 10-6V8L12 2zm0 2.4l7.5 4.5L12 13.4 4.5 8.9 12 4.4zM4 10.6l7 4.2v6.4l-7-4.2v-6.4zm9 10.6v-6.4l7-4.2v6.4l-7 4.2z"/></svg>
      ),
    },
  },
  {
    match: /\b(chroma|chromadb)\b/,
    icon: {
      label: 'Chroma',
      color: '#FF6B35',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5" opacity="0.6"/></svg>
      ),
    },
  },
  {
    match: /\b(pgvector)\b/,
    icon: {
      label: 'pgvector',
      color: '#336791',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/></svg>
      ),
    },
  },
  // LLM providers
  {
    match: /\bopenai\b/,
    icon: {
      label: 'OpenAI',
      color: '#10A37F',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"/></svg>
      ),
    },
  },
  {
    match: /\banthropic\b/,
    icon: {
      label: 'Anthropic',
      color: '#D97757',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 21h4.5l1.7-4.4h6.6L17.5 21H22l-7-18h-5L3 21zm7.3-8L12.5 7l2.2 6h-4.4z"/></svg>
      ),
    },
  },
  {
    match: /\bcohere\b/,
    icon: {
      label: 'Cohere',
      color: '#39594D',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="white" opacity="0.3"/></svg>
      ),
    },
  },
  // Frameworks
  {
    match: /\bfastapi\b/,
    icon: {
      label: 'FastAPI',
      color: '#009688',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0zm-1.3 18l1-5h-3l4-7-1 5h3l-4 7z"/></svg>
      ),
    },
  },
  {
    match: /\bflask\b/,
    icon: {
      label: 'Flask',
      color: '#000000',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 2v6L4 18a3 3 0 003 3h10a3 3 0 003-3l-4-10V2H8zm2 2h4v4h-4V4z"/></svg>
      ),
    },
  },
  {
    match: /\bdjango\b/,
    icon: {
      label: 'Django',
      color: '#092E20',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.146 0h3.924v18.166c-2.013.382-3.491.535-5.096.535-4.791 0-7.288-2.166-7.288-6.32 0-4.002 2.65-6.6 6.753-6.6.637 0 1.121.051 1.707.204V0zm0 9.143a3.894 3.894 0 00-1.325-.204c-1.988 0-3.134 1.223-3.134 3.365 0 2.09 1.096 3.236 3.109 3.236.433 0 .79-.025 1.35-.102V9.143z"/></svg>
      ),
    },
  },
  {
    match: /\bexpress\b/,
    icon: {
      label: 'Express',
      color: '#000000',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 18.588a1.529 1.529 0 01-1.895-.72l-3.45-4.771-.5-.667-4.003 5.444a1.466 1.466 0 01-1.802.72L17.59 12 12.61 5.452a1.561 1.561 0 011.901.708l3.546 4.83 3.605-4.81a1.435 1.435 0 011.795-.708l-1.945 2.66-2.62 3.397a.749.749 0 00-.022.985zm-24-3.65l1.04-.5L7.022 6.402h.4l3.69 4.971-1.193.018-3.061-4.069-2.78 3.616 6.103 8.262L24 5.91l-2.108 4.064-2.108 4.97-5.13.156 4.057-5.466z"/></svg>
      ),
    },
  },
  {
    match: /\bfastify\b/,
    icon: {
      label: 'Fastify',
      color: '#202020',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 4l9 6 9-6v4l-9 6-9-6V4zm0 8l9 6 9-6v4l-9 6-9-6v-4z"/></svg>
      ),
    },
  },
  {
    match: /\bnext(\.?js)?\b/,
    icon: {
      label: 'Next.js',
      color: '#000000',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M9 6v12M14 11V6h2v12" fill="none" stroke="white" strokeWidth="1.6"/></svg>
      ),
    },
  },
  // Data stores
  {
    match: /\b(postgres|postgresql|psycopg2?)\b/,
    icon: {
      label: 'Postgres',
      color: '#336791',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/></svg>
      ),
    },
  },
  {
    match: /\bredis\b/,
    icon: {
      label: 'Redis',
      color: '#DC382D',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 12l10 5 10-5M2 17l10 5 10-5"/></svg>
      ),
    },
  },
  {
    match: /\b(mongo|mongodb|pymongo)\b/,
    icon: {
      label: 'MongoDB',
      color: '#47A248',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4 4 7 4 12 0 4-2 7-4 8-2-1-4-4-4-8 0-5 3-8 4-12zm-1 18l1 2 1-2v-1h-2v1z"/></svg>
      ),
    },
  },
  // Orchestration
  {
    match: /\b(langchain|llama[-_]?index)\b/,
    icon: {
      label: 'Orchestration',
      color: '#9333EA',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 6h8M6 8v8M18 8v8M8 18h8"/></svg>
      ),
    },
  },
  // ML models / inference
  {
    match: /\b(torch|pytorch)\b/,
    icon: {
      label: 'PyTorch',
      color: '#EE4C2C',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L6 8a8.5 8.5 0 1012 0L12 2zm0 4.8l3.6 3.6a5 5 0 11-7.2 0L12 6.8zM15 5a1 1 0 110 2 1 1 0 010-2z"/></svg>
      ),
    },
  },
  {
    match: /\btensorflow\b/,
    icon: {
      label: 'TensorFlow',
      color: '#FF6F00',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 4l10-2v20l-4-2V8L2 6V4zm10 0l10 2v2l-6 2v12l-4 2V4z"/></svg>
      ),
    },
  },
  {
    match: /\btransformers\b/,
    icon: {
      label: 'HuggingFace',
      color: '#FFD21E',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1.5" fill="black"/><circle cx="16" cy="10" r="1.5" fill="black"/><path d="M8 15c1 1.5 2.5 2 4 2s3-.5 4-2" fill="none" stroke="black" strokeWidth="1.5"/></svg>
      ),
    },
  },
  // Misc infra
  {
    match: /\b(docker|uvicorn|gunicorn|node|nginx)\b/,
    icon: {
      label: 'Service',
      color: '#0DB7ED',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="6" width="18" height="12" rx="1"/><rect x="6" y="9" width="3" height="6" fill="white"/><rect x="11" y="9" width="3" height="6" fill="white"/><rect x="16" y="9" width="3" height="6" fill="white"/></svg>
      ),
    },
  },
  {
    match: /\b(celery|queue|kafka|rabbitmq)\b/,
    icon: {
      label: 'Queue',
      color: '#37814A',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="3"/><rect x="3" y="11" width="18" height="3"/><rect x="3" y="16" width="18" height="3"/></svg>
      ),
    },
  },
]

// ──── Family fallbacks ──────────────────────────────────────────────
// Catch-all for components whose specific tech we don't recognize, but
// whose role label is in a known category. Less branded, more generic
// geometry — but always better than the plain dot.

const FAMILIES: BrandEntry[] = [
  {
    match: /\b(vector\s*db|embedding)\b/,
    icon: {
      label: 'Vector DB',
      color: '#7C3AED',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 12l3-6h8l3 6-7 8-7-8zm5-6l2 6 2-6M7 12h10"/></svg>
      ),
    },
  },
  {
    match: /\b(model|llm|embedder|inference)\b/,
    icon: {
      label: 'Model',
      color: '#06B6D4',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" opacity="0.4"/><path d="M2 12h4M18 12h4M12 2v4M12 18v4"/></svg>
      ),
    },
  },
  {
    match: /\b(api|service|server|search|endpoint)\b/,
    icon: {
      label: 'API',
      color: '#3B82F6',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.5.4l3-3a5 5 0 00-7-7L11 5"/><path d="M14 11a5 5 0 00-7-.4l-3 3a5 5 0 007 7l1.5-1.5"/></svg>
      ),
    },
  },
  {
    match: /\b(database|store|persist)\b/,
    icon: {
      label: 'Database',
      color: '#0EA5E9',
      svg: (
        <svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/></svg>
      ),
    },
  },
  {
    match: /\b(queue|worker|job|task)\b/,
    icon: {
      label: 'Queue',
      color: '#10B981',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="3"/><rect x="3" y="11" width="18" height="3"/><rect x="3" y="16" width="18" height="3"/></svg>
      ),
    },
  },
  {
    match: /\b(cache)\b/,
    icon: {
      label: 'Cache',
      color: '#F97316',
      svg: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" fill="currentColor"/></svg>
      ),
    },
  },
]

const FALLBACK: ComponentIcon = {
  label: 'Component',
  color: '#6B7280',
  svg: (
    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
  ),
}

/** Resolve an icon for a component using brand → family → fallback. */
export function iconForComponent(name: string, role?: string): ComponentIcon {
  const haystack = `${name} ${role ?? ''}`.toLowerCase()
  for (const b of BRANDS) {
    if (b.match.test(haystack)) return b.icon
  }
  for (const f of FAMILIES) {
    if (f.match.test(haystack)) return f.icon
  }
  return FALLBACK
}
