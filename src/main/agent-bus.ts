/**
 * Peer-to-peer messaging between agent sessions.
 *
 * The transport is not new: an agent SENDS by calling an MCP tool (which lands
 * on the bridge's `/tool-call`), and RECEIVES through the response body of its
 * own `Stop` hook (`/hooks`). Both halves already existed — this module is the
 * mailbox in between.
 *
 * Delivery happens at turn boundaries only. When a session's `Stop` hook fires
 * and it has mail, the bridge answers `{decision:'block', reason:<mail>}`, which
 * both Claude Code and Codex honour by continuing the turn with that text as
 * input. That is why there is no PTY writing here: injecting keystrokes into a
 * live TUI races with the agent's own rendering, whereas the hook response is
 * consumed at a point where the agent is definitionally waiting on us.
 *
 * The reply comes back the same way: the recipient's NEXT `Stop` carries
 * `last_assistant_message`, so a peer that never calls `reply` still answers
 * usefully. `stop_hook_active` distinguishes "turn ended on its own" from "turn
 * ended after we injected" — we must not block on the latter or the turn can
 * never finish.
 */
import { randomUUID } from 'crypto'
import type { AgentStatus } from '../shared/ipc-types'

/** A session an agent can address. Mirrors the renderer's session registry. */
export interface Peer {
  terminalId: string
  label: string
  /** 'claude' | 'codex' | … — absent on plain terminals, which can't be peers. */
  provider?: string
  worktreePath: string
  status: AgentStatus | 'unknown'
}

export interface Message {
  id: string
  from: string
  fromLabel: string
  to: string
  text: string
  createdAt: number
  /**
   * Chain length: a reply carries its prompt's hops + 1. Bounded by MAX_HOPS so
   * two agents can't talk each other into an unbounded (and unwatched) spend.
   */
  hops: number
  /** Sender is waiting on a reply — resolve its tool call when one arrives. */
  expectsReply: boolean
  /** Set when this message answers an earlier one. */
  replyTo?: string
}

export interface DeliveryRecord {
  messageId: string
  from: string
  to: string
  expectsReply: boolean
  hops: number
}

/**
 * Cap on a single message; oversized text defeats the purpose (the recipient
 * pays for it in context) and Codex spills hook `additionalContext` to disk past
 * ~2,500 tokens anyway. Chars, not tokens — a crude bound is enough here.
 */
export const MAX_MESSAGE_CHARS = 8000
export const MAX_HOPS = 8
/** Per-sender ceiling, mirroring the gen-UI panel's send_to_agent limiter. */
const SEND_RATE_MAX = 20
const SEND_RATE_WINDOW_MS = 60_000

const peers = new Map<string, Peer>()
const mailboxes = new Map<string, Message[]>()
/** Messages delivered to a session and still awaiting its implicit reply. */
const awaitingImplicitReply = new Map<string, DeliveryRecord[]>()
/** Senders blocked in `send_message(wait_for_reply)`, keyed by message id. */
const waiters = new Map<string, (reply: Message | null) => void>()
/** Routing table for `reply(to_message_id)`: message id → who sent it. */
const sentIndex = new Map<string, { from: string; to: string; hops: number }>()
const sendTimestamps = new Map<string, number[]>()

// -- Peer registry ---------------------------------------------

/**
 * Replace the peer set for a window. The renderer owns labels, provider and
 * status, so it pushes the whole list rather than main trying to derive it.
 */
export function syncPeers(incoming: Peer[]): void {
  const seen = new Set<string>()
  for (const p of incoming) {
    seen.add(p.terminalId)
    peers.set(p.terminalId, p)
  }
  // A session that vanished from the renderer's list is gone for good; release
  // its mail and unblock anyone waiting on it rather than leaking either.
  for (const id of [...peers.keys()]) {
    if (!seen.has(id)) forget(id)
  }
}

export function getPeer(terminalId: string): Peer | null {
  return peers.get(terminalId) ?? null
}

/**
 * Resolve an agent-supplied address. Accepts a terminal id or a label, since
 * the model will naturally reach for the human-readable name it was shown.
 * Label matching is case-insensitive and must be unambiguous.
 */
export function resolvePeer(address: string): { peer: Peer } | { error: string } {
  const trimmed = address.trim()
  if (!trimmed) return { error: 'Empty session address' }

  const byId = peers.get(trimmed)
  if (byId) return { peer: byId }

  const needle = trimmed.toLowerCase()
  const byLabel = [...peers.values()].filter((p) => p.label.toLowerCase() === needle)
  if (byLabel.length === 1) return { peer: byLabel[0] }
  if (byLabel.length > 1) {
    return { error: `Ambiguous label "${trimmed}" — address by session id instead: ${byLabel.map((p) => p.terminalId).join(', ')}` }
  }
  return {
    error: `No session matches "${trimmed}". Known sessions: ${
      [...peers.values()].map((p) => `${p.terminalId} (${p.label})`).join(', ') || 'none'
    }`,
  }
}

export function listPeers(excludeTerminalId?: string): Array<Peer & { unread: number }> {
  return [...peers.values()]
    .filter((p) => p.terminalId !== excludeTerminalId)
    .map((p) => ({ ...p, unread: mailboxes.get(p.terminalId)?.length ?? 0 }))
}

// -- Sending ---------------------------------------------------

function rateLimited(from: string): boolean {
  const now = Date.now()
  const recent = (sendTimestamps.get(from) ?? []).filter((t) => now - t < SEND_RATE_WINDOW_MS)
  if (recent.length >= SEND_RATE_MAX) {
    sendTimestamps.set(from, recent)
    return true
  }
  recent.push(now)
  sendTimestamps.set(from, recent)
  return false
}

export interface EnqueueRequest {
  from: string
  to: string
  text: string
  expectsReply?: boolean
  replyTo?: string
}

export function enqueue(req: EnqueueRequest): { message: Message } | { error: string } {
  const text = req.text.trim()
  if (!text) return { error: 'Message text is empty' }
  if (text.length > MAX_MESSAGE_CHARS) {
    return {
      error: `Message is ${text.length} chars, over the ${MAX_MESSAGE_CHARS} limit. Send pointers (paths, PR numbers, doc names) instead of pasted content.`,
    }
  }

  const resolved = resolvePeer(req.to)
  if ('error' in resolved) return { error: resolved.error }
  const target = resolved.peer
  if (target.terminalId === req.from) return { error: 'A session cannot message itself' }

  // A reply inherits its prompt's chain length; a fresh message starts at 0.
  const priorHops = req.replyTo ? (sentIndex.get(req.replyTo)?.hops ?? 0) : -1
  const hops = priorHops + 1
  if (hops > MAX_HOPS) {
    return { error: `Message chain exceeded ${MAX_HOPS} hops and was stopped. Summarise the outcome for the user instead of continuing the exchange.` }
  }

  if (rateLimited(req.from)) {
    return { error: `Rate limit: more than ${SEND_RATE_MAX} messages/minute from this session.` }
  }

  const message: Message = {
    id: randomUUID(),
    from: req.from,
    fromLabel: peers.get(req.from)?.label ?? req.from,
    to: target.terminalId,
    text,
    createdAt: Date.now(),
    hops,
    expectsReply: req.expectsReply === true,
    ...(req.replyTo ? { replyTo: req.replyTo } : {}),
  }

  const box = mailboxes.get(target.terminalId) ?? []
  box.push(message)
  mailboxes.set(target.terminalId, box)
  sentIndex.set(message.id, { from: message.from, to: message.to, hops })

  // A reply settles whoever was blocked on the message it answers.
  if (message.replyTo) settleWaiter(message.replyTo, message)

  return { message }
}

// -- Delivery --------------------------------------------------

export function pendingCount(terminalId: string): number {
  return mailboxes.get(terminalId)?.length ?? 0
}

/** Who sent `messageId` — the routing target for a `reply` to it. */
export function senderOf(messageId: string): string | null {
  return sentIndex.get(messageId)?.from ?? null
}

/**
 * Take everything queued for a session. Records which of those messages want a
 * reply so the session's *next* `Stop` can be read as the answer.
 */
export function drain(terminalId: string): Message[] {
  const box = mailboxes.get(terminalId)
  if (!box || box.length === 0) return []
  mailboxes.delete(terminalId)

  const wanting = box
    .filter((m) => m.expectsReply)
    .map((m) => ({ messageId: m.id, from: m.from, to: m.to, expectsReply: true, hops: m.hops }))
  if (wanting.length > 0) {
    awaitingImplicitReply.set(terminalId, [...(awaitingImplicitReply.get(terminalId) ?? []), ...wanting])
  }
  return box
}

/**
 * Render queued mail as the text handed back to the agent. Names the sender and
 * how to answer, because the agent has no other cue that this text came from a
 * peer rather than from the user.
 */
export function formatForDelivery(messages: Message[]): string {
  const parts = messages.map((m) => {
    const how = m.expectsReply
      ? `\nThe sender is WAITING for your answer. Reply with the \`reply\` tool: reply(to_message_id: "${m.id}", text: "…").`
      : `\nNo reply is required. If you do want to answer, use reply(to_message_id: "${m.id}", …).`
    return `--- Message from session "${m.fromLabel}" (${m.from}) ---\n${m.text}${how}`
  })
  return [
    `You have ${messages.length} message${messages.length === 1 ? '' : 's'} from another agent session in SimpleEdit.`,
    ...parts,
  ].join('\n\n')
}

/**
 * Consume a session's `last_assistant_message` as the implicit reply to
 * whatever we delivered to it. Returns the reply messages that were routed, so
 * the caller can surface them.
 */
export function captureImplicitReplies(terminalId: string, lastAssistantMessage: string): Message[] {
  const pending = awaitingImplicitReply.get(terminalId)
  if (!pending || pending.length === 0) return []
  awaitingImplicitReply.delete(terminalId)

  const text = lastAssistantMessage.trim()
  if (!text) {
    // Nothing to relay, but the sender must not block forever.
    for (const rec of pending) settleWaiter(rec.messageId, null)
    return []
  }

  const replies: Message[] = []
  for (const rec of pending) {
    const reply: Message = {
      id: randomUUID(),
      from: terminalId,
      fromLabel: peers.get(terminalId)?.label ?? terminalId,
      to: rec.from,
      text,
      createdAt: Date.now(),
      hops: rec.hops + 1,
      expectsReply: false,
      replyTo: rec.messageId,
    }
    sentIndex.set(reply.id, { from: reply.from, to: reply.to, hops: reply.hops })

    // Deliver to the sender's mailbox only if nobody is actively waiting —
    // a settled waiter already returns the text as its tool result, and
    // queueing it too would show the same answer twice.
    if (!settleWaiter(rec.messageId, reply)) {
      const box = mailboxes.get(rec.from) ?? []
      box.push(reply)
      mailboxes.set(rec.from, box)
    }
    replies.push(reply)
  }
  return replies
}

/** Drop a session's mail and pending state when it goes away. */
export function forget(terminalId: string): void {
  mailboxes.delete(terminalId)
  peers.delete(terminalId)
  sendTimestamps.delete(terminalId)
  for (const rec of awaitingImplicitReply.get(terminalId) ?? []) settleWaiter(rec.messageId, null)
  awaitingImplicitReply.delete(terminalId)
}

// -- Blocking waits --------------------------------------------

function settleWaiter(messageId: string, reply: Message | null): boolean {
  const waiter = waiters.get(messageId)
  if (!waiter) return false
  waiters.delete(messageId)
  waiter(reply)
  return true
}

/**
 * Park until `messageId` is answered, or `timeoutMs` elapses. A timeout is not
 * an error: the caller reports that the reply will arrive as a message later,
 * which keeps a slow peer from hanging the sender's tool call.
 */
export function waitForReply(messageId: string, timeoutMs: number): Promise<Message | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(messageId)
      resolve(null)
    }, timeoutMs)

    waiters.set(messageId, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
  })
}

// -- Spawn handles ---------------------------------------------

/**
 * `spawn_session` is handled by the renderer (it owns session creation and mints
 * the terminal id), so the tool call can only return a usable handle by waiting
 * for the renderer to report back. Without this the caller would have to guess
 * or poll `list_sessions` to find what it just started.
 */
const spawnWaiters = new Map<string, (peer: Peer | null) => void>()

export function awaitSpawn(correlationId: string, timeoutMs: number): Promise<Peer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      spawnWaiters.delete(correlationId)
      resolve(null)
    }, timeoutMs)
    spawnWaiters.set(correlationId, (peer) => {
      clearTimeout(timer)
      resolve(peer)
    })
  })
}

export function resolveSpawn(correlationId: string, peer: Peer): void {
  peers.set(peer.terminalId, peer)
  const waiter = spawnWaiters.get(correlationId)
  if (!waiter) return
  spawnWaiters.delete(correlationId)
  waiter(peer)
}

/** Test seam: wipe all state. */
export function resetBus(): void {
  peers.clear()
  mailboxes.clear()
  awaitingImplicitReply.clear()
  for (const [, w] of waiters) w(null)
  waiters.clear()
  for (const [, w] of spawnWaiters) w(null)
  spawnWaiters.clear()
  sentIndex.clear()
  sendTimestamps.clear()
}
