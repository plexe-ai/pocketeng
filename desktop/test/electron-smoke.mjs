import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

function expectedPlatform() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return null
}

async function waitForExit(child, timeoutMs = 5_000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out waiting for Electron process to exit')),
      timeoutMs,
    )
  })
  try {
    await Promise.race([once(child, 'exit'), timeout])
  } catch (err) {
    child.kill()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function startServer() {
  const reports = []
  const waiters = []

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body)
        reports.push(payload)
        for (const waiter of [...waiters]) waiter()
        res.writeHead(204)
        res.end()
      })
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html>
<html>
  <body>
    <script>
      const report = (payload) => fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      window.pocketengDesktop?.onDeepLink((url) => {
        void report({ type: 'deep-link', url })
      })
      void report({
        type: 'ready',
        hasBridge: !!window.pocketengDesktop,
        platform: window.pocketengDesktop?.platform ?? null,
      })
    </script>
  </body>
</html>`)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind smoke test server'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
        waitFor: async (predicate, timeoutMs = 15_000) => {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const found = reports.find(predicate)
            if (found) return found
            await new Promise((done) => {
              const timer = setTimeout(done, 100)
              waiters.push(() => {
                clearTimeout(timer)
                done()
              })
            })
          }
          throw new Error(`Timed out waiting for report. Saw: ${JSON.stringify(reports)}`)
        },
      })
    })
  })
}

test('Electron preload bridge reports platform and receives second-instance deep links', async () => {
  const server = await startServer()
  const env = {
    ...process.env,
    PE_DESKTOP_DEV: '1',
    PE_DEV_URL: server.url,
    PE_DESKTOP_SKIP_DEVTOOLS: '1',
  }

  const app = spawn(electronPath, ['.'], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  app.stdout.on('data', (chunk) => logs.push(String(chunk)))
  app.stderr.on('data', (chunk) => logs.push(String(chunk)))

  try {
    const ready = await server.waitFor((r) => r.type === 'ready')
    assert.equal(ready.hasBridge, true)
    assert.equal(ready.platform, expectedPlatform())

    const deepLink = 'pocketeng-desktop://callback?access_token=smoke'
    const second = spawn(electronPath, ['.', deepLink], {
      cwd: new URL('..', import.meta.url),
      env,
      stdio: 'ignore',
    })
    await waitForExit(second)

    const received = await server.waitFor((r) => r.type === 'deep-link')
    assert.equal(received.url, deepLink)
  } catch (err) {
    throw new Error(`${err.message}\nElectron logs:\n${logs.join('')}`)
  } finally {
    app.kill()
    await Promise.race([
      once(app, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    await server.close()
  }
})
