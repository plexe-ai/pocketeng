#!/usr/bin/env node
/**
 * Benchmark: time-to-first-message-paint for opening a session URL.
 *
 * Each iteration does a full page navigation to /dashboard/{server}?session={sid}
 * — matches the bookmark / hard-refresh / "deeplink open" path. SPA-internal
 * nav between sessions in an already-warm dashboard is fast for unrelated
 * reasons and isn't where the slow paint shows up.
 *
 * COLD: clear all `pe:cache:` keys before goto.
 * WARM: leave cache in place.
 *
 * After login we do one warmup navigation to the session URL — this proves
 * the auth/session is hydrated and prevents the first iter from racing the
 * supabase token write, which otherwise bites with "Workspace not found".
 *
 * Time = wall-clock ms from `await page.goto` start → fragment of first
 * follow-up prompt visible in DOM. Captures /messages network RTT to
 * rule out network jitter as the source of any cold/warm delta.
 *
 * Output: report.json + per-iter screenshots + video, all under
 * test-screenshots/<ts>-bench-<label>/.
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PE_BASE_URL || 'http://localhost:3000'
const SERVER_ID = process.env.PE_SERVER_ID
const SESSION_ID = process.env.PE_SESSION_ID
const ITERS = parseInt(process.env.PE_ITERATIONS || '5', 10)
const LABEL = process.env.PE_LABEL || 'baseline'
const FRAG = process.env.PE_PAINT_FRAG || 'ls /etc'

if (!process.env.PE_TEST_EMAIL || !process.env.PE_TEST_PASSWORD || !SERVER_ID || !SESSION_ID) {
  console.error('set PE_TEST_EMAIL, PE_TEST_PASSWORD, PE_SERVER_ID, PE_SESSION_ID')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const runDir = join(repoRoot, 'test-screenshots', `${stamp}-bench-${LABEL}`)
mkdirSync(runDir, { recursive: true })
console.log(`[run-folder] ${runDir}`)

const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: runDir, size: { width: 1280, height: 800 } } })
const p = await ctx.newPage()

let netStart = null, netEnd = null, netBytes = 0
p.on('request', r => {
  if (r.url().includes(`/sessions/${SESSION_ID}/messages`) && !r.url().includes('/events') && r.method() === 'GET' && netStart === null) netStart = Date.now()
})
p.on('response', async r => {
  if (r.url().includes(`/sessions/${SESSION_ID}/messages`) && !r.url().includes('/events') && r.request().method() === 'GET' && netEnd === null) {
    netEnd = Date.now()
    try { netBytes = (await r.body()).length } catch {}
  }
})

await p.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
await p.waitForLoadState('networkidle').catch(()=>{})
if (await p.locator('#signin-email').count() > 0) {
  await p.fill('#signin-email', process.env.PE_TEST_EMAIL)
  await p.fill('#signin-password', process.env.PE_TEST_PASSWORD)
  await p.evaluate(() => document.querySelector('#signin-email').closest('form').querySelector('button[type=submit]').click())
}
await p.waitForURL(u => /(dashboard|onboarding)/.test(u.toString()), { timeout: 60000 })
await p.waitForLoadState('networkidle').catch(()=>{})
await p.screenshot({ path: join(runDir, '00-logged-in.png'), fullPage: true })

// Warmup nav: prove auth + session are healthy before we start timing.
// Without this, the first iter can race the supabase token write and the
// dashboard greets us with "Workspace not found".
const sessURL = `${BASE_URL}/dashboard/${SERVER_ID}?session=${SESSION_ID}`
await p.goto(sessURL, { waitUntil: 'domcontentloaded' })
const warmOk = await p.waitForFunction(f => (document.body?.innerText || '').includes(f), FRAG, { timeout: 30000 }).then(() => true).catch(() => false)
console.log(`[warmup] paintFound=${warmOk}`)
await p.screenshot({ path: join(runDir, '00b-warmup-loaded.png'), fullPage: true })
await p.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

const samples = []
for (let i = 0; i < ITERS; i++) {
  for (let mode of ['cold', 'warm']) {
    if (mode === 'cold') {
      await p.evaluate(() => {
        const ks = []
        for (let j = 0; j < localStorage.length; j++) { const k = localStorage.key(j); if (k && k.startsWith('pe:cache:')) ks.push(k) }
        ks.forEach(k => localStorage.removeItem(k))
      })
    }
    netStart = null; netEnd = null; netBytes = 0
    const t0 = Date.now()
    await p.goto(sessURL, { waitUntil: 'domcontentloaded' })
    const found = await p.waitForFunction(f => (document.body?.innerText || '').includes(f), FRAG, { timeout: 20000 }).then(() => true).catch(() => false)
    const dt = Date.now() - t0
    const rtt = (netStart && netEnd) ? (netEnd - netStart) : null
    samples.push({ mode, iter: i, paintMs: dt, kind: found ? 'paint' : 'timeout', netRttMs: rtt, netBytes })
    console.log(`[bench] iter=${i} mode=${mode} paint=${dt}ms found=${found} net=${rtt ?? '?'}ms bytes=${netBytes}`)
    if (i === 0) await p.screenshot({ path: join(runDir, `01-${mode}-iter0-loaded.png`), fullPage: true })
    await p.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  }
}

const stats = (xs) => {
  if (xs.length === 0) return { n: 0 }
  const sorted = xs.slice().sort((a, b) => a - b)
  return {
    n: xs.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))],
    max: sorted[sorted.length - 1],
  }
}

const cold = samples.filter(s => s.mode === 'cold' && s.kind === 'paint').map(s => s.paintMs)
const warm = samples.filter(s => s.mode === 'warm' && s.kind === 'paint').map(s => s.paintMs)
const netCold = samples.filter(s => s.mode === 'cold' && s.netRttMs).map(s => s.netRttMs)
const netWarm = samples.filter(s => s.mode === 'warm' && s.netRttMs).map(s => s.netRttMs)

const report = {
  label: LABEL,
  sessionId: SESSION_ID,
  iterations: ITERS,
  paintMs: { cold: stats(cold), warm: stats(warm) },
  netMs: { cold: stats(netCold), warm: stats(netWarm) },
  payloadBytes: samples.find(s => s.netBytes)?.netBytes ?? null,
  samples,
}
console.log('\n[summary]\n' + JSON.stringify(report, null, 2))
writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2))

const videoPath = await p.video()?.path()
await ctx.close(); await b.close()
console.log(`\n[run-folder] ${runDir}`)
if (videoPath) console.log(`[video]      ${videoPath}`)
