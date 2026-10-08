/**
 * Put `text` on the clipboard. `navigator.clipboard` exists only in a secure
 * context, and a phone reaching the Mac over plain LAN http is not one, so
 * there it falls back to selecting a hidden field and `execCommand('copy')`,
 * which still works inside the tap's gesture.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  try {
    field.select()
    if (!document.execCommand('copy')) throw new Error('Copying is not allowed here')
  } finally {
    field.remove()
  }
}
