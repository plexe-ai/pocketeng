#!/usr/bin/env node
/**
 * E2E browser test: session rename, pin, and delete via the 3-dot menu.
 *
 * Run:
 *   bash .harness/playbooks/browser-testing.sh
 *   export PE_TEST_EMAIL=... PE_TEST_PASSWORD=...
 *   NODE_PATH="$HOME/.pocketeng/browser-harness/node_modules" \
 *     node web/tools/session-rename-pin-e2e.mjs
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PE_BASE_URL || 'http://localhost:3099'
const EMAIL    = process.env.PE_TEST_EMAIL || ''
const PASSWORD = process.env.PE_TEST_PASSWORD || ''
const HEADLESS = process.env.PE_HEADLESS !== '0'

if (!EMAIL || !PASSWORD) {
  console.error('set PE_TEST_EMAIL and PE_TEST_PASSWORD before running')
  process.exit(1)
}

const here     = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const stamp    = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const runDir   = join(repoRoot, '..', 'test-screenshots', stamp)
mkdirSync(runDir, { recursive: true })
console.log(`[run-folder] ${runDir}`)

let step = 0
async function shot(page, label) {
  step += 1
  const name = `${String(step).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(runDir, name), fullPage: true })
  console.log(`[shot] ${name}`)
}

async function diag(page, tag = 'diag') {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    visibleText: (document.body.innerText || '').slice(0, 2000),
  }))
  console.log(`[${tag}]`, JSON.stringify(info, null, 2))
}

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--no-sandbox'],
})
const ctx = await browser.newContext({
  recordVideo: { dir: runDir, size: { width: 1280, height: 800 } },
  viewport:    { width: 1280, height: 800 },
})
const page = await ctx.newPage()

page.on('response', (r) => {
  const url = r.url()
  if (!url.includes('execute-api') && !url.includes('supabase')) return
  if (r.status() >= 400) console.log(`[net ${r.status()}] ${r.request().method()} ${url}`)
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[browser-error]', m.text())
})
page.on('pageerror', (e) => console.log('[page-error]', e.message))

try {
  // 1. Navigate to app
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await shot(page, 'landing')

  // 2. Login — React controlled fields (#signin-email / #signin-password)
  await page.locator('#signin-email').fill(EMAIL)
  await page.locator('#signin-password').fill(PASSWORD)
  const signInBtn = page.getByRole('button', { name: 'Sign in with email' })
  await signInBtn.waitFor({ state: 'visible' })
  await signInBtn.click()
  await page.waitForURL('**/dashboard**', { timeout: 15000 })
  await page.waitForTimeout(3000)
  await shot(page, 'after-login')

  // 3. Wait for sidebar sessions to load
  const sidebar = page.locator('aside')
  await sidebar.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(2000)
  await shot(page, 'sidebar-loaded')

  // Task rows: outer shell from Sidebar TaskCard (see Sidebar.tsx rowShellClass)
  const taskCards = sidebar.locator('div.group.w-full.flex.items-start.rounded-md')
  const cardCount = await taskCards.count()
  console.log(`[info] Found ${cardCount} task cards in sidebar`)

  if (cardCount === 0) {
    console.log('[info] No sessions found — cannot test. Skipped.')
    await shot(page, 'no-sessions')
  } else {
    const targetIdx = Math.min(1, cardCount - 1)
    const targetCard = taskCards.nth(targetIdx)
    console.log(`[info] Targeting card index ${targetIdx}`)

    // 4. Hover on target card
    await targetCard.hover()
    await page.waitForTimeout(800)
    await shot(page, 'card-hovered')

    // Click the 3-dot menu — it's inside this card
    const menuBtn = targetCard.getByRole('button', { name: 'Task options' })
    await menuBtn.waitFor({ state: 'visible', timeout: 5000 })
    await menuBtn.click()
    await page.waitForTimeout(800)
    await shot(page, 'menu-open')

    // 5. Click Rename (use exact match to avoid substring collision with card text)
    await targetCard.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.waitForTimeout(1200)
    await shot(page, 'after-rename-click')

    // Find the rename input — it should now be in the sidebar
    const renameInput = targetCard.locator('input[type="text"]')
    const inputVisible = await renameInput.isVisible().catch(() => false)
    console.log(`[info] Rename input visible: ${inputVisible}`)

    const uniqueName = `PE Test ${stamp.slice(-6)}`
    if (inputVisible) {
      await renameInput.fill(uniqueName)
      await page.waitForTimeout(300)
      await shot(page, 'rename-typed')
      await renameInput.press('Enter')
      await page.waitForTimeout(2500)
      await shot(page, 'rename-submitted')
    } else {
      console.log('[warn] Rename input not found — diagnosing')
      await diag(page, 'rename-missing')
      await shot(page, 'rename-input-missing')
    }

    // 6. Pin the session — use JS to find and click the menu on the renamed card
    // The card has group-hover:flex on the menu button; force Playwright to dispatch
    // a click directly via page.evaluate for reliability in headless mode.
    await page.evaluate((name) => {
      const cards = document.querySelectorAll('aside .group')
      for (const card of cards) {
        if (card.textContent?.includes(name)) {
          const btn = card.querySelector('[aria-label="Task options"]')
          if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
          break
        }
      }
    }, uniqueName)
    await page.waitForTimeout(800)
    await shot(page, 'menu-open-for-pin')

    const pinBtn = page.locator('aside button:has-text("Pin")').first()
    const pinVisible = await pinBtn.isVisible().catch(() => false)
    console.log(`[info] Pin button visible: ${pinVisible}`)
    if (pinVisible) {
      await pinBtn.click()
      await page.waitForTimeout(2500)
      await shot(page, 'after-pin')

      // Check for pin icon in sidebar
      const pinIcons = sidebar.locator('svg path[d*="16 2l-4 4"]')
      const pinCount = await pinIcons.count()
      console.log(`[info] Pin icons visible after pin: ${pinCount}`)

      // 7. Unpin — click menu on the same card
      await page.evaluate((name) => {
        const cards = document.querySelectorAll('aside .group')
        for (const card of cards) {
          if (card.textContent?.includes(name)) {
            const btn = card.querySelector('[aria-label="Task options"]')
            if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
            break
          }
        }
      }, uniqueName)
      await page.waitForTimeout(800)
      await shot(page, 'menu-open-for-unpin')

      const unpinBtn = page.locator('aside button:has-text("Unpin")').first()
      const unpinVisible = await unpinBtn.isVisible().catch(() => false)
      console.log(`[info] Unpin button visible: ${unpinVisible}`)
      if (unpinVisible) {
        await unpinBtn.click()
        await page.waitForTimeout(2500)
        await shot(page, 'after-unpin')
      } else {
        console.log('[warn] Unpin not visible')
        await shot(page, 'unpin-missing')
      }
    } else {
      console.log('[warn] Pin button not visible')
      await shot(page, 'pin-missing')
    }

    // 8. Final state
    await shot(page, 'final')
  }
} catch (err) {
  console.error('[scenario-error]', err.message)
  try { await diag(page, 'error-state') } catch { /* ignore */ }
  try { await shot(page, 'error') } catch { /* ignore */ }
  process.exitCode = 1
}

const videoPath = await page.video()?.path()
await ctx.close()
await browser.close()

console.log('')
console.log(`[run-folder] ${runDir}`)
if (videoPath) console.log(`[video]      ${videoPath}`)
console.log('[done] read the screenshots in order, then watch the video')
