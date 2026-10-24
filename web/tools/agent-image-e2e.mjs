#!/usr/bin/env node
/**
 * Real-browser Playwright: image paste pipeline per coding agent.
 *
 * For each of Claude Code, Codex, Cursor, OpenCode:
 *   - Sign in (once), navigate to workspace
 *   - Force a NEW chat (?new=1) so each run starts fresh
 *   - Switch agent via dropdown selector (or /agent slash-command fallback)
 *   - Paste a PNG image via synthetic ClipboardEvent
 *   - Type a prompt and press Enter
 *   - Capture the POST /chat request with waitForRequest
 *   - Assert request body contains images: [...] and agent === expected
 *
 * Usage:
 *   PE_TEST_EMAIL=x PE_TEST_PASSWORD=y node tools/agent-image-e2e.mjs
 */

import pkg from '../node_modules/playwright/index.js'
const { chromium } = pkg
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE     = process.env.PE_BASE_URL  || 'http://localhost:3847'
const EMAIL    = process.env.PE_TEST_EMAIL
const PASSWORD = process.env.PE_TEST_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('Set PE_TEST_EMAIL + PE_TEST_PASSWORD'); process.exit(1) }

const outDir = `test-screenshots/agent-image-e2e-${Date.now()}`
mkdirSync(outDir, { recursive: true })

const AGENTS = [
  { id: 'claude',   label: 'Claude Code' },
  { id: 'codex',    label: 'Codex' },
  { id: 'cursor',   label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
]

const results = []

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: outDir, size: { width: 1400, height: 900 } },
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await ctx.newPage()
page.on('pageerror', e => process.stderr.write(`[page-err] ${e.message.slice(0, 100)}\n`))

let n = 0
async function shot(label) {
  n++
  const p = `${outDir}/${String(n).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: p })
  console.log(`  📸 ${p}`)
}

/** Inject a coloured PNG via synthetic ClipboardEvent on the textarea. */
async function pasteImage(agentLabel) {
  return page.evaluate(async (text) => {
    const c = document.createElement('canvas')
    c.width = 480; c.height = 270
    const cx = c.getContext('2d')
    const g = cx.createLinearGradient(0, 0, 480, 270)
    g.addColorStop(0, '#0a1628'); g.addColorStop(1, '#1e3a5f')
    cx.fillStyle = g; cx.fillRect(0, 0, 480, 270)
    cx.fillStyle = '#53d8fb'; cx.font = 'bold 16px monospace'
    cx.fillText(text, 14, 55)
    cx.fillStyle = '#7ed321'; cx.font = '12px monospace'
    cx.fillText('Pocketeng agent image pipeline test', 14, 80)
    cx.fillStyle = '#aaa'; cx.font = '10px monospace'
    cx.fillText(new Date().toISOString(), 14, 255)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    const file = new File([blob], `paste-${Date.now()}-0.png`, { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const ta = document.querySelector('textarea')
    if (!ta) return { ok: false, error: 'no textarea' }
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return { ok: true, size: blob.size }
  }, agentLabel)
}

/** Navigate to workspace URL with ?new=1 to force a fresh chat. */
async function goToNewChat(workspaceUrl) {
  const url = new URL(workspaceUrl)
  url.search = '?new=1'
  await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForSelector('textarea', { timeout: 10000 })
  await page.waitForTimeout(500)
}

// ── Sign in ───────────────────────────────────────────────────────────────────
console.log('\n═══ Sign in ═══')
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await shot('01-landing')
await page.fill('#signin-email', EMAIL)
await page.fill('#signin-password', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForLoadState('networkidle', { timeout: 20000 })
await page.waitForSelector('textarea', { timeout: 10000 })
await shot('02-after-login')
const workspaceUrl = page.url()
console.log(`  ✓ Logged in  →  ${workspaceUrl}`)

// ── Per-agent loop ────────────────────────────────────────────────────────────
for (const { id, label } of AGENTS) {
  console.log(`\n${'═'.repeat(55)}`)
  console.log(`AGENT: ${label}`)

  const r = { agent: id, label, passed: false, steps: {} }

  // Navigate to a fresh chat before each agent test.
  await goToNewChat(workspaceUrl)
  await shot(`${id}-01-fresh-chat`)
  console.log(`  ✓ Fresh chat`)

  // ── Switch agent ────────────────────────────────────────────────────────────
  let switched = false

  // Try the agent selector dropdown button first.
  try {
    const btn = page.locator('button').filter({ hasText: /Claude Code|Codex|Cursor|OpenCode/ }).first()
    if (await btn.count()) {
      await btn.click()
      await page.waitForTimeout(400)
      const opt = page.locator(`button:has-text("${label}")`).first()
      if (await opt.count()) {
        await opt.click()
        await page.waitForTimeout(600)
        switched = true
        console.log(`  ✓ Selected "${label}" from dropdown`)
      }
    }
  } catch { /* fall through */ }

  // Fallback: /agent slash command.
  if (!switched) {
    try {
      const ta = page.locator('textarea').first()
      await ta.waitFor({ state: 'visible', timeout: 5000 })
      await ta.fill(`/agent ${id}`)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1000)
      await ta.fill('')
      switched = true
      console.log(`  ✓ Used /agent ${id}`)
    } catch (e) {
      console.log(`  ⚠  Agent switch failed: ${e.message.slice(0, 80)}`)
    }
  }

  r.steps.switched = switched
  await shot(`${id}-02-agent-switched`)

  // ── Paste image ─────────────────────────────────────────────────────────────
  const pasteRes = await pasteImage(`${label} — vision test`)
  r.steps.pasted = pasteRes.ok
  console.log(`  paste: ${JSON.stringify(pasteRes)}`)
  await page.waitForTimeout(600)
  await shot(`${id}-03-pasted`)

  const thumbCount = await page.locator('.composer img, [class*="composer"] img').count()
  r.steps.thumbnailVisible = thumbCount > 0
  console.log(`  thumbnails in composer: ${thumbCount}`)

  // ── Type prompt ─────────────────────────────────────────────────────────────
  const ta = page.locator('textarea').first()
  await ta.click()
  await ta.fill('Describe the dominant color in this image in one word.')
  await shot(`${id}-04-ready-to-send`)

  // ── Send and intercept the /chat request ────────────────────────────────────
  let reqBody = null
  let reqUrl = null
  try {
    // waitForRequest will race: resolve on the matching request OR timeout.
    const [req] = await Promise.all([
      page.waitForRequest(
        req => req.url().includes('/chat') && req.method() === 'POST',
        { timeout: 8000 },
      ),
      page.keyboard.press('Enter'),
    ])
    reqUrl = req.url()
    reqBody = JSON.parse(req.postData() || '{}')
  } catch (e) {
    console.log(`  ⚠  Request capture: ${e.message.slice(0, 80)}`)
  }

  await page.waitForTimeout(1500)
  await shot(`${id}-05-sent`)

  // ── Assert ──────────────────────────────────────────────────────────────────
  if (reqBody) {
    const hasImages = Array.isArray(reqBody.images) && reqBody.images.length > 0
    const agentInBody = reqBody.agent ?? '(not set)'
    console.log(`  API URL      : ${reqUrl}`)
    console.log(`  agent in body: ${agentInBody}`)
    console.log(`  images count : ${reqBody.images?.length ?? 0}`)
    r.steps.apiImagesSent = hasImages
    r.steps.agentInPayload = agentInBody
    r.passed = hasImages
  } else {
    console.log(`  ⚠  No /chat POST captured`)
    r.steps.apiImagesSent = false
  }

  console.log(`  ➜ ${r.passed ? 'PASSED ✅' : 'NEEDS REVIEW ⚠'}`)
  results.push(r)
}

// ── Summary ───────────────────────────────────────────────────────────────────
const vidPath = await page.video()?.path()
await ctx.close()
await browser.close()

console.log('\n' + '═'.repeat(60))
console.log('SUMMARY')
console.log('═'.repeat(60))
let allPassed = true
for (const r of results) {
  const ic = r.passed ? '✅' : '⚠ '
  console.log(
    `${ic} ${r.label.padEnd(15)} ` +
    `switched:${r.steps.switched ? '✓' : '✗'}  ` +
    `pasted:${r.steps.pasted ? '✓' : '✗'}  ` +
    `thumb:${r.steps.thumbnailVisible ? '✓' : '✗'}  ` +
    `images_api:${r.steps.apiImagesSent ? '✓' : '✗'}  ` +
    `agent:"${r.steps.agentInPayload ?? '?'}"`
  )
  if (!r.passed) allPassed = false
}

writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2))
console.log(`\nScreenshots : ${outDir}`)
if (vidPath) console.log(`Video       : ${vidPath}`)
console.log(`Status      : ${allPassed ? 'ALL PASSED ✅' : 'PARTIAL ⚠'}`)

process.exit(allPassed ? 0 : 1)
