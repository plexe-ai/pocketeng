import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopPlatformFromNodePlatform } from './platform'

test('maps darwin to macos', () => {
  assert.equal(desktopPlatformFromNodePlatform('darwin'), 'macos')
})

test('maps win32 to windows', () => {
  assert.equal(desktopPlatformFromNodePlatform('win32'), 'windows')
})

test('returns null for unsupported desktop platforms', () => {
  assert.equal(desktopPlatformFromNodePlatform('linux'), null)
})
