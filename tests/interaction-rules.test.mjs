import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampLightboxScale, MAX_LIGHTBOX_SCALE, MIN_LIGHTBOX_SCALE,
  pinchLightboxScale, shouldSubmitMessageKey, wheelLightboxScale,
} from '../ui/interactionRules.js'

test('message keyboard rules send only a plain Enter press', () => {
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', shiftKey: false, nativeEvent: {} }), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', shiftKey: true, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey({
    key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true },
  }), false)
  assert.equal(shouldSubmitMessageKey({ key: ' ', shiftKey: false, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey(undefined), false)
})

test('photo zoom stays within its supported range', () => {
  assert.equal(clampLightboxScale(-10), MIN_LIGHTBOX_SCALE)
  assert.equal(clampLightboxScale(2.5), 2.5)
  assert.equal(clampLightboxScale(99), MAX_LIGHTBOX_SCALE)
  assert.equal(clampLightboxScale(Number.NaN), MIN_LIGHTBOX_SCALE)
})

test('wheel and pinch zoom move predictably and clamp at both limits', () => {
  assert.equal(wheelLightboxScale(1, -1), 1.25)
  assert.equal(wheelLightboxScale(1, 1), 1)
  assert.equal(wheelLightboxScale(4, -1), 4)
  assert.equal(pinchLightboxScale(1.5, 100, 200), 3)
  assert.equal(pinchLightboxScale(3, 100, 20), 1)
  assert.equal(pinchLightboxScale(2, 0, 300), 2)
})
