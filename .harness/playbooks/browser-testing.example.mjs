#!/usr/bin/env node
/**
 * Example Playwright script for browser testing.
 *
 * Copy this file, adapt the SCENARIO block for your feature, and run it.
 * It records a video of the whole session, saves numbered screenshots at
 * every step, and logs network + console errors — the run folder is your
 * verification evidence.
 *
 * Paired doc: browser-testing.md
 *
 * Run:
 *   bash .harness/playbooks/browser-testing.sh    # one-time install
 *   export PE_TEST_EMAIL=... PE_TEST_PASSWORD=...
 *   NODE_PATH="$HOME/.pocketeng/browser-harness/node_modules" \
 *     node .harness/playbooks/browser-testing.example.mjs
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- config (override via env) ----
const BASE_URL = process.env.PE_BASE_URL || 'http://localhost:3000'
const EMAIL    = process.env.PE_TEST_EMAIL || ''
const PASSWORD = process.env.PE_TEST_PASSWORD || ''
const HEADLESS = process.env.PE_HEADLESS !== '0'

if (!EMAIL || !PASSWORD) {
  console.error('set PE_TEST_EMAIL and PE_TEST_PASSWORD before running')
  process.exit(1)
}

// ---- run folder: <repo>/test-screenshots/<YYYYMMDD-HHMMSS>/ ----
const here     = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const stamp    = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const runDir   = join(repoRoot, 'test-screenshots', stamp)
mkdirSync(runDir, { recursive: true })
console.log(`[run-folder] ${runDir}`)

// ---- numbered screenshot helper ----
let step = 0
async function shot(page, label) {
  step += 1
  const name = `${String(step).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(runDir, name), fullPage: true })
  console.log(`[shot] ${name}`)
}

// ---- DOM diagnostic — call whenever the page surprises you ----
async function diag(page, tag = 'diag') {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    roleButtons: document.querySelectorAll('[role="button"]').length,
    cards:       document.querySelectorAll('[class*="rounded"]').length,
    forms:       document.querySelectorAll('form').length,
    visibleText: (document.body.innerText || '').slice(0, 1500),
  }))
  console.log(`[${tag}]`, JSON.stringify(info, null, 2))
}

// ---- launch ----
const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--no-sandbox'],
})
const ctx = await browser.newContext({
  recordVideo: { dir: runDir, size: { width: 1280, height: 800 } },
  viewport:    { width: 1280, height: 800 },
})
const page = await ctx.newPage()

// always-on hooks — cheap, catches what screenshots miss
page.on('response', (r) => {
  const url = r.url()
  if (!url.startsWith(BASE_URL) && !url.includes('/api/')) return
  console.log(`[net ${r.status()}] ${r.request().method()} ${url}`)
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[browser-error]', m.text())
})
page.on('pageerror', (e) => console.log('[page-error]', e.message))

// ================== SCENARIO START ==================
// Adapt the block below for your feature. Keep every step's screenshot.
try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await shot(page, 'landing')

  // Login — selectors here match the current Supabase login form.
  // If yours has moved, call `await diag(page, 'login')` and adjust.
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button:has-text("Sign in")')
  await page.waitForLoadState('networkidle')
  await shot(page, 'after-login')

  // --- your scenario steps here ---
  // Example:
  //   await page.click('text=Workspaces')
  //   await shot(page, 'workspaces')
  //   if (await page.locator('[data-test="workspace-card"]').count() === 0) {
  //     await diag(page, 'workspaces-empty')
  //   }

  await shot(page, 'final')
} catch (err) {
  console.error('[scenario-error]', err.message)
  try { await shot(page, 'error') } catch { /* ignore */ }
  process.exitCode = 1
}
// =================== SCENARIO END ===================

const videoPath = await page.video()?.path()
await ctx.close()
await browser.close()

console.log('')
console.log(`[run-folder] ${runDir}`)
if (videoPath) console.log(`[video]      ${videoPath}`)
console.log('[done] read the screenshots in order, then watch the video')
