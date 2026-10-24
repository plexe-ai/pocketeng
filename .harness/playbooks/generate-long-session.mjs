#!/usr/bin/env node
/**
 * Generate a real, long chat session as a perf benchmark fixture.
 *
 * Strategy:
 *   1. Log in via Playwright (records video + screenshots, per browser-testing.md).
 *   2. Drive the browser as a real authenticated session.
 *   3. Use the in-page fetch (with the auth token) to call /servers/{id}/chat
 *      directly — same endpoint the UI uses, so messages persist exactly the
 *      same way in DDB. Faster than typing into the textarea + waiting for
 *      stream-paint per turn.
 *   4. Wait for each turn to settle by polling /sessions/{id}/events.
 *
 * Output: prints the generated sessionId at the end. Save it for the
 * benchmark scripts.
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL  = 'http://localhost:3000'
const API_BASE  = process.env.PE_API_BASE   // e.g. https://<api-id>.execute-api.<region>.amazonaws.com/dev
const SERVER_ID = process.env.PE_SERVER_ID
const AGENT     = process.env.PE_AGENT || 'claude'
const EMAIL     = process.env.PE_TEST_EMAIL
const PASSWORD  = process.env.PE_TEST_PASSWORD

if (!EMAIL || !PASSWORD || !API_BASE || !SERVER_ID) {
  console.error('set PE_TEST_EMAIL, PE_TEST_PASSWORD, PE_API_BASE and PE_SERVER_ID'); process.exit(1)
}

// Prompts chosen to produce real tool-using turns: file ops, command output,
// short text answers. Each one should emit some content + tool blocks so the
// resulting message bundle is meaningful in size.
const PROMPTS = [
  'Run `ls /etc | head -20` and tell me what you see.',
  'Now run `cat /etc/os-release` and summarize what OS this is in two sentences.',
  'List the first 10 files under /usr/lib that end with .so. Use ls and head.',
  'Run `df -h` and tell me which mount has the most free space.',
  'Run `free -h` and report total memory.',
  'Run `uname -a` — what kernel is this?',
  'Show the contents of `/proc/cpuinfo | head -30`.',
  'Run `whoami` and `pwd` and tell me both values.',
  'List the running processes via `ps -ef | head -10`.',
  'Run `date` and tell me the current time on this box.',
  'Use `du -sh /tmp` to show /tmp size.',
  'Run `ls /home` and tell me what users exist.',
]

const here     = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const stamp    = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const runDir   = join(repoRoot, 'test-screenshots', `${stamp}-generate`)
mkdirSync(runDir, { recursive: true })
console.log(`[run-folder] ${runDir}`)

let step = 0
const shot = async (page, label) => {
  step += 1
  await page.screenshot({ path: join(runDir, `${String(step).padStart(2,'0')}-${label}.png`), fullPage: true })
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({
  recordVideo: { dir: runDir, size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()
page.on('pageerror', e => console.log('[page-error]', e.message))

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForLoadState('networkidle').catch(() => {})
if (await page.locator('#signin-email').count() > 0) {
  await page.fill('#signin-email', EMAIL)
  await page.fill('#signin-password', PASSWORD)
  await page.evaluate(() => document.querySelector('#signin-email').closest('form').querySelector('button[type=submit]').click())
}
await page.waitForURL(u => /(dashboard|onboarding)/.test(u.toString()), { timeout: 60000 })
await page.waitForLoadState('networkidle').catch(() => {})
await shot(page, 'logged-in')
console.log('[ok] logged in')

const result = await page.evaluate(async ({ apiBase, serverId, agent, prompts }) => {
  const sb = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
  const tk = JSON.parse(localStorage.getItem(sb)).access_token
  const auth = { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }
  const log = []

  // Start session
  const startRes = await fetch(`${apiBase}/servers/${serverId}/chat`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'start-session', prompt: prompts[0], agent }),
  })
  if (!startRes.ok) return { error: `start-session failed: ${startRes.status} ${await startRes.text()}` }
  const session = await startRes.json()
  const sessionId = session.sessionId
  log.push({ turn: 0, sessionId, prompt: prompts[0] })

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const waitForSettle = async (lastUserSeq) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await sleep(2000)
      const r = await fetch(`${apiBase}/sessions/${sessionId}/events?afterSeq=0`, { headers: auth })
      if (!r.ok) continue
      const j = await r.json()
      const ev = j.events || []
      // Find a run.finished or run.error AFTER the user message we just sent.
      const finished = ev.find(e => /run\.(finished|errored)/.test(e.kind || e.type || '') || /turn\.completed/.test(e.kind || e.type || ''))
      if (finished) return { settled: true, evCount: ev.length }
    }
    return { settled: false, timedOut: true }
  }

  await waitForSettle()

  for (let i = 1; i < prompts.length; i++) {
    const sendRes = await fetch(`${apiBase}/servers/${serverId}/chat`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ action: 'send-message', sessionId, prompt: prompts[i], agent }),
    })
    if (!sendRes.ok) { log.push({ turn: i, error: sendRes.status }); break }
    log.push({ turn: i, prompt: prompts[i] })
    await waitForSettle()
  }

  // Final message-bundle measurement
  const mr = await fetch(`${apiBase}/sessions/${sessionId}/messages`, { headers: auth })
  const mj = await mr.json()
  return {
    sessionId,
    log,
    finalMessageCount: (mj.messages || []).length,
    finalTranscriptCount: (mj.transcript || []).length,
    finalPayloadBytes: JSON.stringify(mj).length,
  }
}, { apiBase: API_BASE, serverId: SERVER_ID, agent: AGENT, prompts: PROMPTS })

console.log('[result]', JSON.stringify(result, null, 2))
writeFileSync(join(runDir, 'session.json'), JSON.stringify(result, null, 2))
await shot(page, 'final')

const videoPath = await page.video()?.path()
await ctx.close(); await browser.close()
console.log(`[run-folder] ${runDir}`)
if (videoPath) console.log(`[video]      ${videoPath}`)
console.log(`[sessionId]  ${result.sessionId}`)
