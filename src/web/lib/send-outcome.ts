/**
 * What a composer's `onsend` resolves to. A `warning` means the text was
 * delivered but something after it was not: the field clears, since sending
 * again would deliver the text twice, and the warning says what is left to do.
 */
export type SendOutcome = void | { warning: string }
