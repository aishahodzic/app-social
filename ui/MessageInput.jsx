import { useLayoutEffect } from 'react'
import { shouldSubmitMessageKey } from './interactionRules.js'

// Matches the service limit for direct and group messages.
const MAX_MESSAGE_CHARS = 40000

// Phones close the keyboard whenever the message box loses focus, so the box
// stays enabled while a message sends and the send button never takes focus.
// Put this on the send button's onMouseDown: the tap still submits the form.
export function keepMessageFocus(event) {
  event.preventDefault()
}

// A multi-line message box that grows with its text. Enter sends, Shift+Enter
// adds a line, and IME composition is never interrupted.
export default function MessageInput({ inputRef, value, onChange, disabled }) {
  useLayoutEffect(() => {
    const el = inputRef.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, inputRef])

  function onKeyDown(event) {
    if (!shouldSubmitMessageKey(event)) return
    event.preventDefault()
    event.currentTarget.form.requestSubmit()
  }

  return (
    <textarea ref={inputRef} rows={1} value={value} maxLength={MAX_MESSAGE_CHARS}
              onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown}
              disabled={disabled} placeholder="Message" autoComplete="off" aria-label="Message" />
  )
}
