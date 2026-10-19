// Typing indicator: started when a message or press is handed to Claude, resent
// every interval until the bot replies to that chat, a cap, or shutdown. The
// server runs as a subprocess, so the clock is shortened through env knobs
// (100 ms interval) instead of faking timers in-process.
import { afterEach, expect, test } from 'bun:test'
import { DM, GROUP, startHarness } from './harness'

type H = Awaited<ReturnType<typeof startHarness>>
let h: H | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const EVERY = 100
const start = (maxMs = 60_000) => startHarness({
  TELEGRAM_PLUS_TYPING_EVERY_MS: String(EVERY), TELEGRAM_PLUS_TYPING_MAX_MS: String(maxMs),
})
let msgId = 5000
function dm(x: H, text = 'hi', chat = DM, extra: Record<string, unknown> = {}) {
  x.push({ message: {
    message_id: msgId++, date: 0, text,
    chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' }, from: { id: DM, is_bot: false, first_name: 'E' }, ...extra,
  } })
}
const typing = (x: H, chat = DM) => x.calls.filter(c => c.method === 'sendChatAction' && String(c.body.chat_id) === String(chat))
const delivered = async (x: H, n: number) => x.waitFor(() => x.notes.length >= n)

test('typing starts on delivery and repeats every interval', async () => {
  const x = h = await start()
  dm(x)
  await delivered(x, 1)
  await x.waitFor(() => typing(x).length >= 4, 3000)
  const at = typing(x).map(c => c.at)
  for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThan(EVERY * 0.6)
  expect(typing(x)[0].body.action).toBe('typing')
})

test('reply to the chat stops it; edit_message and react do not', async () => {
  const x = h = await start()
  dm(x)
  await delivered(x, 1)
  await x.waitFor(() => typing(x).length >= 2)
  const sent = await x.call('reply', { chat_id: String(DM), text: 'working on it' })
  const id = /id: (\d+)/.exec(sent.text)![1]
  // the reply stopped it; a new message starts it again, then progress calls keep it going
  await Bun.sleep(EVERY * 3)
  const afterReply = typing(x).length
  await Bun.sleep(EVERY * 3)
  expect(typing(x).length).toBe(afterReply)

  dm(x, 'next')
  await delivered(x, 2)
  await x.call('edit_message', { chat_id: String(DM), message_id: id, text: 'still working' })
  await x.call('react', { chat_id: String(DM), message_id: id, emoji: '👀' })
  const n = typing(x).length
  await x.waitFor(() => typing(x).length >= n + 2, 2000)
  await x.call('reply', { chat_id: String(DM), text: 'done' })
  await Bun.sleep(EVERY * 2)
  const m = typing(x).length
  await Bun.sleep(EVERY * 3)
  expect(typing(x).length).toBe(m)
})

test('stops at the cap', async () => {
  const x = h = await start(400)
  dm(x)
  await delivered(x, 1)
  await Bun.sleep(700)
  const n = typing(x).length
  expect(n).toBeGreaterThanOrEqual(3)
  expect(n).toBeLessThanOrEqual(7)
  await Bun.sleep(EVERY * 4)
  expect(typing(x).length).toBe(n)
})

test('a new message in the same chat resets the cap, without a second timer', async () => {
  const x = h = await start(500)
  dm(x)
  await delivered(x, 1)
  await Bun.sleep(350)
  dm(x, 'more')
  await delivered(x, 2)
  const t1 = Date.now()
  await Bun.sleep(1000)
  const after = typing(x).filter(c => c.at > t1)
  // still typing past the first message's cap (t1 + ~150 ms) ...
  expect(after.some(c => c.at > t1 + 300)).toBe(true)
  // ... at one loop's rate: two stacked loops would send about twice as many
  expect(after.length).toBeLessThanOrEqual(7)
  const n = typing(x).length
  await Bun.sleep(EVERY * 4)
  expect(typing(x).length).toBe(n)
})

test('429 on sendChatAction: waits retry_after before trying again', async () => {
  const x = h = await start()
  let first = true
  x.knobs.api = m => {
    if (m !== 'sendChatAction' || !first) return undefined
    first = false
    return { code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }
  }
  dm(x)
  await delivered(x, 1)
  await x.waitFor(() => typing(x).length >= 1)
  const t429 = typing(x)[0].at
  await x.waitFor(() => typing(x).length >= 2, 3000)
  expect(typing(x)[1].at - t429).toBeGreaterThanOrEqual(900)
})

test('group: no typing for a message the gate drops, typing once the bot is mentioned', async () => {
  const x = h = await start()
  dm(x, 'chatting among ourselves', GROUP)
  await Bun.sleep(400)
  expect(typing(x, GROUP)).toHaveLength(0)
  expect(x.notes).toHaveLength(0)
  dm(x, '@test_plus_bot ping', GROUP, { entities: [{ type: 'mention', offset: 0, length: 14 }] })
  await delivered(x, 1)
  await x.waitFor(() => typing(x, GROUP).length >= 2)
})

test('button press starts typing; the reply stops it', async () => {
  const x = h = await start()
  x.push({ callback_query: {
    id: 'cq-typing', chat_instance: 'x', data: 'u:go',
    from: { id: DM, is_bot: false, first_name: 'E' },
    message: { message_id: 42, date: 0, chat: { id: DM, type: 'private' }, text: 'Pick' },
  } })
  await delivered(x, 1)
  await x.waitFor(() => typing(x).length >= 2)
  await x.call('reply', { chat_id: String(DM), text: 'ok' })
  await Bun.sleep(EVERY * 2)
  const n = typing(x).length
  await Bun.sleep(EVERY * 3)
  expect(typing(x).length).toBe(n)
})
