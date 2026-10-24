#!/usr/bin/env node
/**
 * Real-browser proof: image on clipboard → Cmd+V / Ctrl+V → thumbnail appears.
 *
 * Prerequisites:
 *   npm install && npx playwright install chromium
 *   npm run dev:webpack   # in another terminal
 *
 * Run:
 *   PE_BASE_URL=http://localhost:3000 npm run test:paste-e2e
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = (process.env.PE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const HEADLESS = process.env.PE_HEADLESS !== '0'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const outDir = join(webRoot, 'test-screenshots', `paste-e2e-${Date.now()}`)
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})

const ctx = await browser.newContext({
  viewport: { width: 900, height: 700 },
  recordVideo: { dir: outDir, size: { width: 900, height: 700 } },
  permissions: ['clipboard-read', 'clipboard-write'],
})

const page = await ctx.newPage()

page.on('console', msg => {
  if (msg.type() === 'error') console.error('[browser]', msg.text())
})

try {
  await page.goto(`${BASE}/paste-smoke`, { waitUntil: 'networkidle', timeout: 60_000 })
} catch (e) {
  console.error(`Failed to load ${BASE}/paste-smoke — is Next dev running? (${e.message})`)
  process.exit(1)
}

// Snipping-tool style: put a real PNG on the system clipboard from the page context.
await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 120
  canvas.height = 80
  const ctx2 = canvas.getContext('2d')
  if (!ctx2) throw new Error('no 2d context')
  ctx2.fillStyle = '#1a3a4a'
  ctx2.fillRect(0, 0, 120, 80)
  ctx2.fillStyle = '#55c6e5'
  ctx2.font = 'bold 22px sans-serif'
  ctx2.fillText('PE paste', 12, 48)
  const blob = await new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
})

await page.screenshot({ path: join(outDir, '01-before-paste.png'), fullPage: true })

const ta = page.locator('[data-testid="paste-composer-textarea"]')
await ta.click()
await ta.focus()

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
await page.keyboard.press(`${modifier}+KeyV`)

await page.waitForSelector('[data-testid="paste-thumbnail"]', { timeout: 15_000 })

const countText = await page.locator('[data-testid="paste-attachment-count"]').innerText()
const nPills = await page.locator('[data-testid="paste-attachment-pill"]').count()

await page.screenshot({ path: join(outDir, '02-after-paste-thumbnail.png'), fullPage: true })

const videoPath = await page.video()?.path()
await ctx.close()
await browser.close()

console.log('')
console.log(`[PASS] Clipboard image + ${modifier}+V produced a thumbnail.`)
console.log(`[count] ${countText.trim()}`)
console.log(`[pills] ${nPills}`)
console.log(`[screenshots] ${outDir}`)
if (videoPath) console.log(`[video] ${videoPath}`)

if (!/attachments:\s*1/.test(countText) || nPills !== 1) {
  console.error('[FAIL] expected exactly 1 attachment')
  process.exit(1)
}
