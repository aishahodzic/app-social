import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampLightboxScale, MAX_LIGHTBOX_SCALE, MIN_LIGHTBOX_SCALE,
  pinchLightboxScale, prependedScrollTop, shouldSubmitMessageKey,
  TOUCH_PRIMARY_QUERY, wheelLightboxScale,
} from '../ui/interactionRules.js'

test('message keyboard rules match Möbius Chat across physical and touch keyboards', () => {
  assert.equal(TOUCH_PRIMARY_QUERY, '(hover: none) and (pointer: coarse)')
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, false), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', nativeEvent: {} }, true), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', metaKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, nativeEvent: {} }, true), true)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', shiftKey: true, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey({
    key: 'Enter', metaKey: true, nativeEvent: { isComposing: true },
  }), false)
  assert.equal(shouldSubmitMessageKey({ key: 'Enter', ctrlKey: true, isComposing: true }), false)
  assert.equal(shouldSubmitMessageKey({ key: ' ', shiftKey: false, nativeEvent: {} }), false)
  assert.equal(shouldSubmitMessageKey(undefined), false)
})

test('prepending older messages keeps the message being read at the same viewport position', () => {
  assert.equal(prependedScrollTop(180, 800, 1200), 580)
  assert.equal(prependedScrollTop(0, 800, 1200), 400)
  assert.equal(prependedScrollTop(75, 800, 800), 75)
  assert.equal(prependedScrollTop(75, 800, 700), 75)
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
