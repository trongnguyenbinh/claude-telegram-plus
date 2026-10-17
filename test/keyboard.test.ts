// Reply keyboard / remove / force_reply on reply, and the inbound messages that
// keyboard request buttons produce (contact, location, poll, users/chat shared, web app).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { DM, GROUP, STRANGER, startHarness } from './harness'

let h: Awaited<ReturnType<typeof startHarness>>
beforeAll(async () => { h = await startHarness() })
afterAll(async () => { await h.stop() })

const send = (r: { sent: { method: string; body: any }[] }) => r.sent.filter(s => s.method.startsWith('send'))
let msgId = 3000

test('keyboard: rows of strings and request buttons + options -> ReplyKeyboardMarkup', async () => {
  const r = await h.call('reply', {
    chat_id: String(DM), text: 'Chọn việc',
    keyboard: [['Trạng thái', 'Log'], [{ text: 'Gửi số', request_contact: true }, { text: 'Vị trí', request_location: true, style: 'primary' }],
      [{ text: 'Poll', request_poll: { type: 'quiz' } }, { text: 'Người', request_users: { request_id: 7, max_quantity: 2 } }],
      [{ text: 'Nhóm', request_chat: { request_id: 8, chat_is_channel: false } }, { text: 'App', web_app: 'https://example.com/app' }]],
    keyboard_options: { resize: true, one_time: true, persistent: true, placeholder: 'Chọn một mục' },
  })
  expect(r.isError).toBe(false)
  expect(send(r)).toHaveLength(1)
  expect(send(r)[0].body.reply_markup).toEqual({
    keyboard: [
      [{ text: 'Trạng thái' }, { text: 'Log' }],
      [{ text: 'Gửi số', request_contact: true }, { text: 'Vị trí', style: 'primary', request_location: true }],
      [{ text: 'Poll', request_poll: { type: 'quiz' } }, { text: 'Người', request_users: { request_id: 7, max_quantity: 2 } }],
      [{ text: 'Nhóm', request_chat: { request_id: 8, chat_is_channel: false } }, { text: 'App', web_app: { url: 'https://example.com/app' } }],
    ],
    resize_keyboard: true, one_time_keyboard: true, is_persistent: true, input_field_placeholder: 'Chọn một mục',
  })
})

test('keyboard goes on the last chunk only; rich messages carry it too', async () => {
  const r = await h.call('reply', { chat_id: String(DM), text: 'k'.repeat(5000), keyboard: [['ok']] })
  const s = send(r)
  expect(s).toHaveLength(2)
  expect(s[0].body.reply_markup).toBeUndefined()
  expect(s[1].body.reply_markup).toEqual({ keyboard: [[{ text: 'ok' }]] })
  const rich = await h.call('reply', { chat_id: String(DM), text: '# Menu', format: 'rich', keyboard: [['A']] })
  expect(send(rich)[0]).toMatchObject({ method: 'sendRichMessage', body: { reply_markup: { keyboard: [[{ text: 'A' }]] } } })
})

test('remove_keyboard and force_reply, with selective / placeholder', async () => {
  const rm = await h.call('reply', { chat_id: String(GROUP), text: 'xong', reply_to: '5', remove_keyboard: true, keyboard_options: { selective: true } })
  expect(send(rm)[0].body.reply_markup).toEqual({ remove_keyboard: true, selective: true })
  const fr = await h.call('reply', { chat_id: String(DM), text: 'Tên?', force_reply: true, keyboard_options: { placeholder: 'Nhập tên', resize: true } })
  expect(send(fr)[0].body.reply_markup).toEqual({ force_reply: true, input_field_placeholder: 'Nhập tên' })
})

test('group: plain selective keyboard is fine, request buttons are refused before sending', async () => {
  const ok = await h.call('reply', { chat_id: String(GROUP), text: 'Chọn', reply_to: '9', keyboard: [['Có', 'Không']], keyboard_options: { selective: true } })
  expect(send(ok)[0].body.reply_markup).toEqual({ keyboard: [[{ text: 'Có' }, { text: 'Không' }]], selective: true })
  const bad = await h.call('reply', { chat_id: String(GROUP), text: 'x', keyboard: [[{ text: 'Vị trí', request_location: true }]] })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('private chats only')
  expect(bad.sent).toHaveLength(0)
})

test('only one reply_markup kind per message: clear error, nothing sent', async () => {
  for (const extra of [
    { buttons: [[{ text: 'a' }]], keyboard: [['b']] },
    { buttons: [[{ text: 'a' }]], remove_keyboard: true },
    { keyboard: [['b']], force_reply: true },
  ]) {
    const r = await h.call('reply', { chat_id: String(DM), text: 'x', ...extra })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Telegram allows one reply_markup')
    expect(r.sent).toHaveLength(0)
  }
  // false flags do not count
  const r = await h.call('reply', { chat_id: String(DM), text: 'x', buttons: [[{ text: 'a' }]], remove_keyboard: false, force_reply: false })
  expect(r.isError).toBe(false)
  expect(send(r)[0].body.reply_markup.inline_keyboard).toBeDefined()
})

test('bad keyboards are rejected before anything is sent', async () => {
  for (const extra of [
    { keyboard: [] },
    { keyboard: 'nope' },
    { keyboard: [[{ text: '' }]] },
    { keyboard: [[{ text: 'x', request_contact: true, request_location: true }]] },
    { keyboard: [[{ text: 'x', request_users: { max_quantity: 2 } }]] },
    { keyboard: [[{ text: 'x', style: 'pink' }]] },
    { keyboard: [['x']], keyboard_options: { placeholder: 'p'.repeat(65) } },
  ]) {
    const r = await h.call('reply', { chat_id: String(DM), text: 'x', ...extra })
    expect(r.isError).toBe(true)
    expect(r.sent).toHaveLength(0)
  }
})

// ---- inbound
function dm(fields: Record<string, unknown>, from = DM) {
  h.push({ message: { message_id: msgId++, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'E' }, ...fields } })
}
async function lastNote(before: number) {
  await h.waitFor(() => h.notes.length > before)
  return h.notes[h.notes.length - 1].params
}

test('a plain keyboard press is an ordinary text message', async () => {
  const before = h.notes.length
  dm({ text: 'Trạng thái' })
  expect((await lastNote(before)).content).toBe('Trạng thái')
})

test('contact, location, venue, poll, users_shared, chat_shared, web_app_data become one-line text', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ contact: { phone_number: '+84900000000', first_name: 'An', last_name: 'Ng\nuyen', user_id: DM } }, `(contact) An Ng uyen +84900000000 user_id=${DM}`],
    [{ location: { latitude: 10.77, longitude: 106.7 } }, '(location) 10.77,106.7'],
    [{ location: { latitude: 1, longitude: 2 }, venue: { location: { latitude: 1, longitude: 2 }, title: 'Quán', address: 'Q1' } }, '(location) 1,2 Quán, Q1'],
    [{ poll: { id: 'p', question: 'Ăn gì?', options: [{ text: 'Phở', voter_count: 0 }, { text: 'Bún', voter_count: 0 }], total_voter_count: 0, is_closed: false, is_anonymous: true, type: 'regular', allows_multiple_answers: false } }, '(poll) Ăn gì?: Phở | Bún'],
    [{ users_shared: { request_id: 7, users: [{ user_id: 5, username: 'lan' }, { user_id: 6, first_name: 'Bình' }] } }, '(users_shared request_id=7) 5 @lan, 6 Bình'],
    [{ chat_shared: { request_id: 8, chat_id: -100123, title: 'Nhóm' } }, '(chat_shared request_id=8) -100123 Nhóm'],
    [{ web_app_data: { button_text: 'App', data: '{"a":1}' } }, '(web_app_data App) {"a":1}'],
  ]
  for (const [fields, want] of cases) {
    const before = h.notes.length
    dm(fields)
    const p = await lastNote(before)
    expect(p.content).toBe(want)
    expect(p.meta.user_id).toBe(String(DM))
  }
})

test('contact from a non-allowlisted sender, or in a group without mention, is dropped', async () => {
  const before = h.notes.length
  dm({ contact: { phone_number: '+1', first_name: 'X' } }, STRANGER)
  h.push({ message: { message_id: msgId++, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'g' }, from: { id: DM, is_bot: false, first_name: 'E' }, location: { latitude: 1, longitude: 2 } } })
  await Bun.sleep(400)
  expect(h.notes.length).toBe(before)
})
