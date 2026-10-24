import type { ClipboardEvent } from 'react'

/** Shared image-attachment rules for the chat composer (paste / drag-drop / paperclip). */

export const MAX_RASTER_IMAGES_PER_MESSAGE = 5
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const RASTER_MIME: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  /** macOS / Preview sometimes put TIFF on the clipboard */
  'image/tiff',
]

export type PendingAttachment = { id: string; file: File }

export function isRasterImageFile(file: File): boolean {
  const t = file.type.toLowerCase()
  if (RASTER_MIME.includes(t)) return true
  if (t) return false
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff'].includes(ext)
}

export function isImageLikeFile(file: File): boolean {
  if (file.type.toLowerCase().startsWith('image/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff'].includes(ext)
}

export function mergePendingAttachments(
  prev: PendingAttachment[],
  incoming: File[],
): { next: PendingAttachment[]; error: string | null } {
  if (incoming.length === 0) {
    return { next: prev, error: null }
  }
  const next = [...prev]
  let rasterCount = next.filter(a => isRasterImageFile(a.file)).length
  const errors: string[] = []
  for (const file of incoming) {
    if (isRasterImageFile(file)) {
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`${file.name} is larger than 5MB`)
        continue
      }
      if (rasterCount >= MAX_RASTER_IMAGES_PER_MESSAGE) {
        errors.push(`At most ${MAX_RASTER_IMAGES_PER_MESSAGE} images per message`)
        break
      }
      next.push({ id: crypto.randomUUID(), file })
      rasterCount += 1
    } else {
      next.push({ id: crypto.randomUUID(), file })
    }
  }
  return { next, error: errors[0] ?? null }
}

function mimeToExt(mime: string): string {
  const t = mime.toLowerCase()
  if (t === 'image/png') return 'png'
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg'
  if (t === 'image/gif') return 'gif'
  if (t === 'image/webp') return 'webp'
  if (t === 'image/tiff') return 'tiff'
  return 'png'
}

/** Pick a concrete image/* MIME from clipboard hints (WebKit often leaves `DataTransferItem.type` empty). */
function pickImageMime(itemType: string, raw: File): string | null {
  const ft = (raw.type || '').toLowerCase()
  if (ft.startsWith('image/')) return ft === 'image/jpg' ? 'image/jpeg' : ft
  const it = (itemType || '').toLowerCase()
  if (it.startsWith('image/')) return it === 'image/jpg' ? 'image/jpeg' : it
  return null
}

function dedupeKey(f: File): string {
  return `${f.size}:${f.lastModified}:${f.name}`
}

/**
 * Synchronous extraction from `clipboardData` (paste event).
 * Handles Chrome-style `image/*` item types and macOS/WebKit where `kind === 'file'`
 * but `item.type` is empty while `File.type` is still `image/png`, plus `files` fallback.
 */
export function imageFilesFromClipboardData(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  const seen = new Set<string>()

  function pushImage(raw: File, itemType: string) {
    const mime = pickImageMime(itemType, raw)
    if (!mime) return
    const k = dedupeKey(raw)
    if (seen.has(k)) return
    seen.add(k)
    const ext = mimeToExt(mime)
    out.push(new File([raw], `paste-${Date.now()}-${out.length}.${ext}`, { type: mime }))
  }

  if (data.items) {
    for (const it of Array.from(data.items)) {
      if (it.kind !== 'file') continue
      const raw = it.getAsFile()
      if (!raw || raw.size === 0) continue
      pushImage(raw, it.type || '')
    }
  }

  if (data.files?.length) {
    for (let i = 0; i < data.files.length; i++) {
      const raw = data.files.item(i)
      if (!raw || raw.size === 0) continue
      pushImage(raw, raw.type || '')
    }
  }

  return out
}

/** Magic-byte sniff for pasted files when MIME is missing (common on Safari + macOS screenshots). */
export async function sniffImageMimeFromBytes(blob: Blob): Promise<string | null> {
  const buf = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  if (buf.length < 6) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a) {
    return 'image/png'
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return 'image/tiff'
  }
  return null
}

/**
 * After the sync pass returns nothing, try `kind === 'file'` items again using
 * binary signatures — Safari/macOS often omits MIME on pasteboard-backed files.
 */
export async function sniffClipboardImagesIfSyncEmpty(data: DataTransfer | null): Promise<File[]> {
  if (!data?.items?.length) return []
  const out: File[] = []
  const seen = new Set<string>()

  for (const it of Array.from(data.items)) {
    if (it.kind !== 'file') continue
    const raw = it.getAsFile()
    if (!raw || raw.size === 0) continue

    const k = dedupeKey(raw)
    if (seen.has(k)) continue

    const fromMeta = pickImageMime(it.type || '', raw)
    if (fromMeta) {
      seen.add(k)
      out.push(new File([raw], `paste-${Date.now()}-${out.length}.${mimeToExt(fromMeta)}`, { type: fromMeta }))
      continue
    }

    if (raw.size < 12) continue
    const sniffed = await sniffImageMimeFromBytes(raw)
    if (!sniffed) continue

    seen.add(k)
    out.push(new File([raw], `paste-${Date.now()}-${out.length}.${mimeToExt(sniffed)}`, { type: sniffed }))
  }

  if (data.files?.length) {
    for (let i = 0; i < data.files.length; i++) {
      const raw = data.files.item(i)
      if (!raw || raw.size === 0) continue
      const k = dedupeKey(raw)
      if (seen.has(k)) continue

      const fromMeta = pickImageMime(raw.type || '', raw)
      if (fromMeta) {
        seen.add(k)
        out.push(new File([raw], `paste-${Date.now()}-${out.length}.${mimeToExt(fromMeta)}`, { type: fromMeta }))
        continue
      }

      if (raw.size < 12) continue
      const sniffed = await sniffImageMimeFromBytes(raw)
      if (!sniffed) continue

      seen.add(k)
      out.push(new File([raw], `paste-${Date.now()}-${out.length}.${mimeToExt(sniffed)}`, { type: sniffed }))
    }
  }

  return out
}

/**
 * Call synchronously from `onPaste` **before** any `await` when the sync path
 * returned nothing but the clipboard still looks like an image-only paste
 * (WebKit/macOS often omits MIME until we sniff bytes). Otherwise the browser
 * may run the default paste action while the async sniff is in flight.
 */
export function shouldPreventDefaultBeforeAsyncImageSniff(data: DataTransfer | null): boolean {
  if (!data?.items?.length) return false
  if (imageFilesFromClipboardData(data).length > 0) return false

  let hasPlainText = false
  let needsSniff = false

  for (const it of Array.from(data.items)) {
    if (it.kind === 'string' && it.type === 'text/plain') {
      hasPlainText = true
    }
    if (it.kind !== 'file') continue
    const raw = it.getAsFile()
    if (!raw || raw.size === 0) continue

    const itemT = (it.type || '').toLowerCase()
    const fileT = (raw.type || '').toLowerCase()
    const hint = fileT || itemT

    if (hint.startsWith('image/')) {
      needsSniff = true
      continue
    }
    if (hint.startsWith('text/') || hint.startsWith('application/pdf')) return false
    if (hint.startsWith('application/') && hint !== 'application/octet-stream') return false

    if (!hint || hint === 'application/octet-stream') {
      needsSniff = true
    }
  }

  return needsSniff && !hasPlainText
}

/**
 * Full pipeline for `onPaste`: sync extraction, optional early `preventDefault`
 * (so the default paste does not run mid-await on WebKit), then binary sniff.
 */
export async function resolveClipboardImageFilesFromPasteEvent(
  e: ClipboardEvent<HTMLTextAreaElement>,
): Promise<File[]> {
  const dt = e.clipboardData
  const sync = imageFilesFromClipboardData(dt)
  if (sync.length > 0) {
    e.preventDefault()
    return sync
  }
  if (shouldPreventDefaultBeforeAsyncImageSniff(dt)) e.preventDefault()
  const rest = await sniffClipboardImagesIfSyncEmpty(dt)
  if (rest.length > 0) {
    if (!e.defaultPrevented) e.preventDefault()
    return rest
  }
  return []
}
