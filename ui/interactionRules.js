export const MIN_LIGHTBOX_SCALE = 1
export const MAX_LIGHTBOX_SCALE = 4
export const LIGHTBOX_ZOOM_STEP = 0.25

export function shouldSubmitMessageKey(event) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.nativeEvent?.isComposing
}

export function clampLightboxScale(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return MIN_LIGHTBOX_SCALE
  return Math.min(MAX_LIGHTBOX_SCALE, Math.max(MIN_LIGHTBOX_SCALE, numeric))
}

export function wheelLightboxScale(current, deltaY) {
  const direction = Number(deltaY) < 0 ? 1 : -1
  return clampLightboxScale(Number(current) + direction * LIGHTBOX_ZOOM_STEP)
}

export function pinchLightboxScale(startScale, startDistance, currentDistance) {
  const initial = Number(startDistance)
  if (!Number.isFinite(initial) || initial <= 0) return clampLightboxScale(startScale)
  return clampLightboxScale(Number(startScale) * (Number(currentDistance) / initial))
}
