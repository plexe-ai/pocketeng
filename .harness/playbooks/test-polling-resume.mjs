#!/usr/bin/env node
/**
 * Real-browser regression for the chat-polling-stuck-after-background bug.
 *
 * What the bug looked like:
 *   - User sends a message, backgrounds the app mid-response.
 *   - iOS WKWebView / throttled Chromium suspends the in-flight
 *     getSessionEvents fetch — promise never resolves, `finally` never
 *     runs, `pollInFlightRef.current` stuck at `true`.
 *   - Every subsequent poll returns early at the single-flight guard.
 *   - User sees the assistant-message header with an empty body until
 *     they manually reload.
 *
 * What this test validates:
 *   We can't truly simulate WebView network suspension in Playwright, but
 *   we can reproduce the exact flag-stuck condition via route interception:
 *   hold the first /sessions/:id/events request open forever, fire a
 *   visibilitychange cycle, and assert that a SECOND request is attempted
 *   after the resume. Pre-fix, the second request never fires because the
 *   guard blocks it. Post-fix, the resume handler aborts the pending
 *   controller + resets the flag before calling pollNowRef.
 *
 * Paired doc: .harness/playbooks/browser-testing.md
 * Paired learning: .harness/learnings/2026-04-session-polling-single-flight-stuck.md
 *
 * Run:
 *   bash .harness/playbooks/browser-testing.sh
 *   export PE_TEST_EMAIL=... PE_TEST_PASSWORD=...
 *   cd web && npm run dev &      # dev server on :3000
 *   NODE_PATH="$HOME/.pocketeng/browser-harness/node_modules" \
 *     node .harness/playbooks/test-polling-resume.mjs
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PE_BASE_URL || 'http://localhost:3000'
const EMAIL = process.env.PE_TEST_EMAIL || ''
const PASSWORD = process.env.PE_TEST_PASSWORD || ''
const HEADLESS = process.env.PE_HEADLESS !== '0'

if (!EMAIL || !PASSWORD) {
  console.error('set PE_TEST_EMAIL and PE_TEST_PASSWORD')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const runDir = join(repoRoot, 'test-screenshots', `polling-resume-${stamp}`)
mkdirSync(runDir, { recursive: true })
console.log(`[run-folder] ${runDir}`)

let step = 0
async function shot(page, label) {
  step += 1
  const name = `${String(step).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(runDir, name), fullPage: true })
  console.log(`[shot] ${name}`)
}

const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] })
const ctx = await browser.newContext({
  recordVideo: { dir: runDir, size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

// Network + console hooks so failures are visible
const eventsRequests = [] // every /sessions/{id}/events hit, in order
page.on('request', (req) => {
  const url = req.url()
  if (/\/sessions\/[^/]+\/events(\?|$)/.test(url)) {
    eventsRequests.push({ url, at: Date.now() })
    console.log(`[events-req #${eventsRequests.length}] ${url}`)
  }
})
page.on('console', (m) => { if (m.type() === 'error') console.log('[browser-error]', m.text()) })
page.on('pageerror', (e) => console.log('[page-error]', e.message))

let exitCode = 0
try {
  // ── Step 1: land + sign in ───────────────────────────────────────────
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await shot(page, 'landing')

  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASSWORD)
  // Must target the email-submit button specifically — the landing page
  // also has "Sign in with Apple" which matches `button:has-text("Sign in")`
  // and hijacks the flow to Apple OAuth.
  await page.click('button:has-text("Sign in with email")')

  // Wait for the Supabase auth token to land in localStorage — that's the
  // signal that signInWithPassword resolved. networkidle returns too
  // early because the Supabase onAuthStateChange -> router.replace chain
  // hasn't fired yet.
  try {
    await page.waitForFunction(
      () => Object.keys(localStorage).some(
        (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
      ),
      { timeout: 15_000 },
    )
    console.log('[auth] Supabase token in localStorage')
  } catch {
    console.error('[FAIL] Supabase auth token never appeared — signin failed')
    await shot(page, 'signin-failed')
    exitCode = 1
    throw new Error('signin failed')
  }

  // Then wait for the post-login redirect to take us away from the
  // landing page. Dashboard (with or without session id) or onboarding
  // both count as "signed in".
  try {
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 15_000 })
  } catch {
    console.log(`[landed-at] ${page.url()} (no redirect within 15s)`)
  }
  await shot(page, 'after-login')

  // If we're not already on a session (dashboard with a session id),
  // we can't exercise the polling path. The test is still informative —
  // it'll assert no baseline errors — but the resume-specific assertion
  // is skipped.
  let url = page.url()
  console.log(`[landed-at] ${url}`)

  // Sidebar nav routes live under /dashboard/* too — exclude them when
  // checking "are we on a workspace/session page?"
  const SIDEBAR_ROUTES = /^\/dashboard\/(agents|integrations|settings|skills|sessions)\/?$/
  const onSessionPage = (u) => {
    if (!u) return false
    const path = new URL(u, BASE_URL).pathname
    return /^\/dashboard\/[^/?#]+/.test(path) && !SIDEBAR_ROUTES.test(path)
  }

  // Polling only runs against a *live* session. A 2h-old "recent" task
  // is terminal — ChatWindow's polling effect bails (`if (running &&
  // session && workspaceRunning) ...`). So we always start a fresh
  // session via the "+ New task" flow and type a prompt.
  if (!onSessionPage(url)) {
    console.log('[nav] on /dashboard — opening a new draft via "New task"')
    const newTaskLink = page.locator('aside a[href*="new=1"]').first()
    try {
      await newTaskLink.waitFor({ state: 'visible', timeout: 20_000 })
      await newTaskLink.click()
      try {
        await page.waitForURL(
          (u) => onSessionPage(u.toString()),
          { timeout: 10_000 },
        )
      } catch {}
      url = page.url()
      console.log(`[nav] after clicking "New task": ${url}`)
    } catch {
      console.log('[nav] no "New task" link in sidebar — no ready workspace')
      await shot(page, 'dashboard-no-new-task')
    }
  }

  if (!onSessionPage(url)) {
    console.log('[skip] not on a session page — polling test skipped')
    console.log('[skip] manual-test fallback: sign in, open a session, then')
    console.log('[skip] Cmd+Tab away while an agent responds — response should')
    console.log('[skip] fill in when you return, without needing a reload.')
    exitCode = 0
    process.exit(0)
  }

  // ── Kick off a live session ──────────────────────────────────────────
  // A just-clicked /dashboard/SERVER_ID?new=1 URL renders the ChatWindow
  // in draft mode — no session yet, so no polling. Polling only starts
  // after a real session exists (ChatWindow mounts, sessionRef is set,
  // doOnePoll runs on the 4s interval). To get there, type + send a
  // message. We deliberately send a short prompt so the agent stays
  // "running" through our assertions.
  const parsedUrl = new URL(url)
  if (parsedUrl.searchParams.get('new') === '1') {
    console.log('[nav] draft page — sending a short prompt to start a session')
    const composer = page.locator('textarea').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.fill('polling-resume-test: just say hi and stop')
    // The send button is the last press-able button in the composer row.
    // Pressing Enter is more reliable than clicking an ambiguous icon.
    await composer.press('Enter')
    console.log('[nav] prompt sent — waiting for session id in URL')
    try {
      await page.waitForURL(
        (u) => {
          const pu = new URL(u.toString())
          return onSessionPage(u.toString()) && pu.searchParams.get('session')
        },
        { timeout: 30_000 },
      )
      url = page.url()
      console.log(`[nav] session created: ${url}`)
    } catch {
      console.log('[nav] session never materialized in URL — will still try polling assertion')
    }
  }

  // ── Step 2: give polling time to warm up, then intercept ─────────────
  // Wait until the page has issued at least 2 events requests — that
  // confirms polling is running steadily before we try to freeze it.
  const waitStart = Date.now()
  while (eventsRequests.length < 2 && Date.now() - waitStart < 10_000) {
    await page.waitForTimeout(300)
  }
  if (eventsRequests.length < 2) {
    console.error(`[FAIL] polling never started — only ${eventsRequests.length} events requests in 10s`)
    exitCode = 1
    throw new Error('polling never started')
  }
  console.log(`[baseline] ${eventsRequests.length} events requests before intervention`)
  await shot(page, 'polling-baseline')

  // ── Step 3: install a route that holds EVERY events request forever ──
  // This simulates WKWebView network suspension: once a fetch enters
  // the interceptor, the Promise never settles. The first poll to hit
  // the route sets `pollInFlightRef.current = true` and gets stuck.
  //
  // Important: we must NOT call page.unroute() before the assertion.
  // Unrouting releases held requests (Playwright continues them to the
  // network), which resolves the fetch, runs `finally`, and clears the
  // flag — even on pre-fix code. That'd make the pre-fix test pass
  // artificially. Keep the route active through the whole cycle: the
  // post-fix behavior we're measuring is "does the resume handler
  // initiate a NEW fetch?", which we can count via page.on('request')
  // even though the fetch itself will be intercepted too.
  let intercepts = 0
  await page.route('**/sessions/*/events*', async () => {
    intercepts += 1
    console.log(`[intercepted #${intercepts}] held forever`)
    await new Promise(() => {}) // never settles
  })

  // Wait for the first poll to get caught. After this, in pre-fix,
  // every subsequent poll tick bails at the single-flight guard and
  // issues NO new request; in post-fix, same (until visibility=visible).
  const holdWaitStart = Date.now()
  while (intercepts < 1 && Date.now() - holdWaitStart < 5_000) {
    await page.waitForTimeout(100)
  }
  if (intercepts < 1) {
    console.error('[FAIL] route never intercepted a request — polling may have stopped')
    exitCode = 1
    throw new Error('no intercept')
  }
  // Extra settle time so the single-flight guard is visibly holding
  // (subsequent polls should be silent on the wire).
  await page.waitForTimeout(1_500)

  // ── Step 4: simulate background ──────────────────────────────────────
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  console.log('[visibility] dispatched hidden')
  await page.waitForTimeout(500)
  await shot(page, 'backgrounded')

  // ── Step 5: simulate foreground, WITHOUT unrouting ───────────────────
  // The pre-fix visibility handler calls `pollNowRef.current()` which
  // hits `if (pollInFlightRef.current) return` and no-ops. The post-fix
  // handler aborts the pending controller + resets the flag + pokes the
  // poll. Either way, the next fetch (if any) is also intercepted and
  // held — but page.on('request') still fires for it, which is the
  // signal we measure.
  const beforeResume = eventsRequests.length
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  console.log('[visibility] dispatched visible')

  // Give the resume handler time to chain abort → reset → pollNow →
  // fetch → request-event. Generous 5s (actual window is <200ms).
  await page.waitForTimeout(5_000)
  await shot(page, 'resumed')

  const afterResume = eventsRequests.length
  const resumePolls = afterResume - beforeResume
  console.log(`[post-resume] ${resumePolls} new events requests after visibility=visible (intercepts=${intercepts})`)

  // Release the interceptor before teardown so the context can close.
  await page.unroute('**/sessions/*/events*')

  // ── Assertion ────────────────────────────────────────────────────────
  // Pre-fix: 0 new requests (single-flight flag stuck).
  // Post-fix: ≥1 request (visibility handler aborts + resets + pokes).
  if (resumePolls < 1) {
    console.error('[FAIL] no post-resume poll fired — single-flight flag stuck')
    exitCode = 1
  } else {
    console.log(`[PASS] ${resumePolls} polls fired after resume (expected ≥1)`)
  }
} catch (err) {
  console.error('[ERROR]', err?.message ?? err)
  exitCode = 1
} finally {
  await ctx.close()
  await browser.close()
  console.log(`\n[run-folder] ${runDir}`)
  console.log(`[events-log] ${eventsRequests.length} total /sessions/:id/events requests`)
  process.exit(exitCode)
}
