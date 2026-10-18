// Button-press feedback: toast after the press reached Claude, keyboard collapses
// to the chosen button, repeat presses are not delivered twice, keep_buttons opts out.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { DM, GROUP, STRANGER, startHarness } from './harness'

let h: Awaited<ReturnType<typeof startHarness>>
beforeAll(async () => { h = await startHarness() })
afterAll(async () => { await h.stop() })

let cqId = 0
let msgId = 7000
const kb = (...rows: [string, string][][]) => ({ inline_keyboard: rows.map(r => r.map(([text, data]) => ({ text, callback_data: data }))) })

function press(data: string, opts: { from?: number; chat?: number; message_id?: number; markup?: unknown; lang?: string } = {}) {
  const id = `cq${cqId++}`
  const chat = opts.chat ?? DM
  h.push({ callback_query: {
    id, chat_instance: 'x', data,
    from: { id: opts.from ?? DM, is_bot: false, first_name: 'E', username: 'alice', ...(opts.lang ? { language_code: opts.lang } : {}) },
    message: {
      message_id: opts.message_id ?? msgId, date: 0,
      chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' }, text: 'Pick one',
      ...(opts.markup ? { reply_markup: opts.markup } : {}),
    },
  } })
  return id
}
const answerOf = async (id: string) => {
  await h.waitFor(() => h.calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id))
  return h.calls.find(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === id)!
}
const callsAfter = (i: number, method: string) => h.calls.slice(i).filter(c => c.method === method)

test('press: delivered to Claude before the toast, keyboard collapses to ✅ label, typing sent', async () => {
  const mid = ++msgId
  const before = h.notes.length
  const c0 = h.calls.length
  const id = press('u:deploy:yes', { message_id: mid, markup: kb([['Deploy', 'u:deploy:yes'], ['Cancel', 'u:deploy:no']]) })
  const ans = await answerOf(id)
  expect(ans.body.text).toBe('✓ Deploy')
  expect(h.notes.length).toBe(before + 1) // the toast only goes out once the press reached Claude
  expect(h.notes[before].params.content).toBe('(button) deploy:yes')
  await h.waitFor(() => callsAfter(c0, 'sendChatAction').length > 0)
  const edit = callsAfter(c0, 'editMessageReplyMarkup')
  expect(edit).toHaveLength(1)
  expect(edit[0].body).toMatchObject({ chat_id: DM, message_id: mid, reply_markup: { inline_keyboard: [[{ text: '✅ Deploy', callback_data: 'u!' }]] } })
  expect(callsAfter(c0, 'sendChatAction')[0].body).toMatchObject({ chat_id: String(DM), action: 'typing' })
})

test('label is found in any row; a long label is cut to the 200-char toast limit', async () => {
  const long = 'L'.repeat(300)
  const id = press('u:b', { message_id: ++msgId, markup: kb([['A', 'u:a']], [['x', 'u:x'], [long, 'u:b']]) })
  const ans = await answerOf(id)
  expect(ans.body.text).toBe(`✓ ${long}`.slice(0, 200))
  // no reply_markup on the message: the callback value is the label
  const id2 = press('u:plain', { message_id: ++msgId })
  expect((await answerOf(id2)).body.text).toBe('✓ plain')
})

test('fast double tap on the same message: delivered once, second press gets "Already received"', async () => {
  const mid = ++msgId
  const before = h.notes.length
  const a = press('u:go', { message_id: mid, markup: kb([['Go', 'u:go']]) })
  const b = press('u:go', { message_id: mid, markup: kb([['Go', 'u:go']]) })
  const [ra, rb] = [await answerOf(a), await answerOf(b)]
  expect([ra.body.text, rb.body.text].sort()).toEqual(['Already received', '✓ Go'])
  await Bun.sleep(150)
  expect(h.notes.length).toBe(before + 1)
})

test('pressing the collapsed ✅ button: toast in the presser language, nothing delivered, no edit', async () => {
  const before = h.notes.length
  const c0 = h.calls.length
  expect((await answerOf(press('u!', { message_id: ++msgId }))).body.text).toBe('Already chosen')
  expect((await answerOf(press('u!', { message_id: msgId, lang: 'vi' }))).body.text).toBe('Đã chọn rồi')
  await Bun.sleep(100)
  expect(h.notes.length).toBe(before)
  expect(callsAfter(c0, 'editMessageReplyMarkup')).toHaveLength(0)
})

test('keep_buttons: every press is delivered, toast shown, keyboard left alone', async () => {
  const r = await h.call('reply', { chat_id: String(DM), text: 'Menu', buttons: [[{ text: 'Next', callback_data: 'page:2' }]], keep_buttons: true })
  const mid = Number(/id: (\d+)/.exec(r.text)![1])
  const before = h.notes.length
  const c0 = h.calls.length
  const markup = kb([['Next', 'u:page:2']])
  expect((await answerOf(press('u:page:2', { message_id: mid, markup }))).body.text).toBe('✓ Next')
  expect((await answerOf(press('u:page:2', { message_id: mid, markup }))).body.text).toBe('✓ Next')
  expect(h.notes.length).toBe(before + 2)
  expect(callsAfter(c0, 'editMessageReplyMarkup')).toHaveLength(0)

  // edit_message with buttons and no keep_buttons turns collapsing back on
  await h.call('edit_message', { chat_id: String(DM), message_id: String(mid), text: 'Menu', buttons: [[{ text: 'Next', callback_data: 'page:2' }]] })
  const c1 = h.calls.length
  await answerOf(press('u:page:2', { message_id: mid, markup }))
  await h.waitFor(() => callsAfter(c1, 'editMessageReplyMarkup').length === 1)
})

test('collapsing fails (message too old to edit): press still delivered once, toast still sent', async () => {
  h.knobs.api = m => m === 'editMessageReplyMarkup' ? { code: 400, description: "Bad Request: message can't be edited" } : undefined
  try {
    const before = h.notes.length
    const c0 = h.calls.length
    const ans = await answerOf(press('u:old', { message_id: ++msgId, markup: kb([['Old', 'u:old']]) }))
    expect(ans.body.text).toBe('✓ Old')
    await h.waitFor(() => callsAfter(c0, 'editMessageReplyMarkup').length === 1) // attempted, answered 400
    await h.waitFor(() => callsAfter(c0, 'sendChatAction').length === 1) // and the handler carried on
    expect(h.notes.length).toBe(before + 1)
  } finally {
    h.knobs.api = undefined
  }
})

test('stranger press: "Not authorized.", no edit, nothing delivered', async () => {
  const before = h.notes.length
  const c0 = h.calls.length
  expect((await answerOf(press('u:evil', { from: STRANGER, chat: STRANGER, message_id: ++msgId }))).body.text).toBe('Not authorized.')
  await Bun.sleep(100)
  expect(h.notes.length).toBe(before)
  expect(callsAfter(c0, 'editMessageReplyMarkup')).toHaveLength(0)
})

test('group press from an allowed member collapses the keyboard in the group too', async () => {
  const c0 = h.calls.length
  const ans = await answerOf(press('u:ok', { chat: GROUP, message_id: ++msgId, markup: kb([['OK', 'u:ok']]) }))
  expect(ans.body.text).toBe('✓ OK')
  await h.waitFor(() => callsAfter(c0, 'editMessageReplyMarkup').length === 1)
  expect(callsAfter(c0, 'editMessageReplyMarkup')[0].body.chat_id).toBe(GROUP)
})

test('guideline tells Claude about the toast, the collapse and keep_buttons', () => {
  const s = h.client.getInstructions() ?? ''
  for (const key of ["'✓ <label>' toast", 'collapsed to the chosen button', 'keep_buttons:true']) expect(s).toContain(key)
})
