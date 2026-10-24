'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isImageLikeFile,
  mergePendingAttachments,
  resolveClipboardImageFilesFromPasteEvent,
  type PendingAttachment,
} from '@/lib/composerImagePaste'

/**
 * Minimal composer shell that uses the **same** clipboard → File[] pipeline
 * as `ChatWindow.tsx`, so Playwright can prove Cmd+V / Ctrl+V works without
 * logging into the full app.
 */
export default function PasteSmokeClient() {
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])
  const [error, setError] = useState<string | null>(null)

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
  }, [])

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const fromClipboard = await resolveClipboardImageFilesFromPasteEvent(e)
      if (fromClipboard.length === 0) return
      addPendingAttachments(fromClipboard)
    },
    [addPendingAttachments],
  )

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-[#e2e2e8] p-8">
      <h1 className="text-lg font-semibold mb-2">Paste smoke (dev only)</h1>
      <p className="text-sm text-[#888] mb-6 max-w-xl">
        Focus the textarea, then Cmd+V (mac) or Ctrl+V (Windows) with an image on the clipboard.
        The attachment strip below uses the same code path as the chat composer.
      </p>

      <div
        className="max-w-xl rounded-[22px] border border-[#2a2a2e] bg-[#18181b]/80 p-0 overflow-hidden"
        data-testid="paste-smoke-shell"
      >
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="paste-attachment-strip">
            {attachedFiles.map(a => {
              const preview = imagePreviewUrlById.get(a.id)
              return (
                <div
                  key={a.id}
                  className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px]"
                  data-testid="paste-attachment-pill"
                >
                  {preview ? (
                    <img
                      src={preview}
                      alt={a.file.name}
                      className="h-9 w-9 object-cover rounded-md border border-white/10"
                      data-testid="paste-thumbnail"
                    />
                  ) : (
                    <span className="h-9 w-9 rounded-md bg-white/10" data-testid="paste-doc-icon" />
                  )}
                  <span className="truncate max-w-[120px]">{a.file.name}</span>
                </div>
              )
            })}
          </div>
        )}
        <textarea
          data-testid="paste-composer-textarea"
          className="w-full min-h-[100px] bg-transparent px-4 py-3 text-[15px] text-[#e2e2e8] outline-none resize-none"
          placeholder="Click here, then paste a screenshot (Cmd+V / Ctrl+V)…"
          onPaste={handlePaste}
          defaultValue=""
        />
      </div>

      <p className="mt-4 text-sm" data-testid="paste-attachment-count">
        attachments: <span className="font-mono text-accent">{attachedFiles.length}</span>
      </p>
      {error ? (
        <p className="mt-2 text-sm text-red-400" data-testid="paste-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
