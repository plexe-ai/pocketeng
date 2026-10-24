import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDeepLinkFromArgv } from './deep-link-url'

test('extracts a direct desktop deep link argument', () => {
  assert.equal(
    extractDeepLinkFromArgv(
      ['pocketeng-desktop://callback?access_token=abc'],
      'pocketeng-desktop',
    ),
    'pocketeng-desktop://callback?access_token=abc',
  )
})

test('extracts a Windows second-instance deep link from argv', () => {
  assert.equal(
    extractDeepLinkFromArgv(
      [
        'C:\\Program Files\\Pocket Eng\\Pocket Eng.exe',
        '--some-electron-flag',
        'pocketeng-desktop://callback?refresh_token=def',
      ],
      'pocketeng-desktop',
    ),
    'pocketeng-desktop://callback?refresh_token=def',
  )
})

test('ignores other schemes and returns null when no desktop link is present', () => {
  assert.equal(
    extractDeepLinkFromArgv(
      ['com.pocketengineer.coder://callback?access_token=abc'],
      'pocketeng-desktop',
    ),
    null,
  )
})
