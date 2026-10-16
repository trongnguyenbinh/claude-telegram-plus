// Welcome-new-members tests. Short debounce/cooldown via env so the suite stays fast.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DM, GROUP, startHarness } from './harness'

const DEBOUNCE = 150
const COOLDOWN = 1200
const OTHER_GROUP = -1002 // not in access.json

let h: Awaited<ReturnType<typeof startHarness>>
let msgId = 1000
let uid = 5000

beforeAll(async () => {
  h = await startHarness({
    TELEGRAM_PLUS_WELCOME_DEBOUNCE_MS: String(DEBOUNCE),
    TELEGRAM_PLUS_WELCOME_COOLDOWN_MS: String(COOLDOWN),
  })
})
afterAll(async () => { await h.stop() })
beforeEach(async () => {
  setWelcome({ [String(GROUP)]: 'Chào {name} đến với nhóm!' })
  await Bun.sleep(COOLDOWN + 50) // every test starts outside the cooldown window
})

function setWelcome(map: Record<string, string> | null) {
  const f = join(h.stateDir, 'welcome.json')
  if (map) writeFileSync(f, JSON.stringify(map))
  else rmSync(f, { force: true })
}

function user(first_name: string, extra: Record<string, unknown> = {}) {
  return { id: uid++, is_bot: false, first_name, ...extra }
}

function join_(chat: number, members: Record<string, unknown>[]) {
  h.push({ message: {
    message_id: msgId++, date: 0, chat: { id: chat, type: 'supergroup', title: 'g' },
    from: members[0], new_chat_members: members,
  } })
}

const welcomes = (since: number, chat = GROUP) =>
  h.calls.slice(since).filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === chat)

async function settle(ms = DEBOUNCE + 400) { await Bun.sleep(ms) }

test('one joiner: one message, name as text_mention, plain text (no parse_mode)', async () => {
  const n = h.calls.length
  const notes = h.notes.length
  const u = user('Lan', { username: 'lan_dev' })
  join_(GROUP, [u])
  await settle()
  const w = welcomes(n)
  expect(w).toHaveLength(1)
  expect(w[0].body.text).toBe('Chào @lan_dev đến với nhóm!')
  expect(w[0].body.parse_mode).toBeUndefined()
  expect(w[0].body.entities).toEqual([{ type: 'text_mention', offset: 5, length: 8, user: { id: u.id, is_bot: false, first_name: 'Lan' } }])
  expect(h.notes.length).toBe(notes) // Claude is not involved
})

test('no username: first_name; unicode offsets are UTF-16', async () => {
  const n = h.calls.length
  setWelcome({ [String(GROUP)]: '👋 Xin chào {name}!' })
  join_(GROUP, [user('Đức 🚀')])
  await settle()
  const w = welcomes(n)[0]
  expect(w.body.text).toBe('👋 Xin chào Đức 🚀!')
  const e = w.body.entities[0]
  expect(w.body.text.slice(e.offset, e.offset + e.length)).toBe('Đức 🚀')
})

test('hostile names stay literal text', async () => {
  const n = h.calls.length
  join_(GROUP, [user('<b>x</b> & "y" *z* [a](tg://user?id=1)\nline2')])
  await settle()
  const w = welcomes(n)[0]
  expect(w.body.text).toBe('Chào <b>x</b> & "y" *z* [a](tg://user?id=1) line2 đến với nhóm!')
  expect(w.body.parse_mode).toBeUndefined()
})

test('several joiners in one event and in a burst: one message', async () => {
  const n = h.calls.length
  join_(GROUP, [user('An'), user('Bình')])
  await Bun.sleep(30)
  join_(GROUP, [user('Chi')])
  await settle()
  const w = welcomes(n)
  expect(w).toHaveLength(1)
  expect(w[0].body.text).toBe('Chào An, Bình và Chi đến với nhóm!')
  expect(w[0].body.entities).toHaveLength(3)
})

test('cooldown: a second join right after a welcome waits, then is sent once', async () => {
  const n = h.calls.length
  join_(GROUP, [user('Một')])
  await settle()
  expect(welcomes(n)).toHaveLength(1)
  join_(GROUP, [user('Hai')])
  join_(GROUP, [user('Ba')])
  await settle()
  expect(welcomes(n)).toHaveLength(1) // still inside the cooldown
  await Bun.sleep(COOLDOWN)
  const w = welcomes(n)
  expect(w).toHaveLength(2)
  expect(w[1].body.text).toBe('Chào Hai và Ba đến với nhóm!')
  expect(w[1].at - w[0].at).toBeGreaterThanOrEqual(COOLDOWN - 50)
})

test('bots are skipped; a bots-only join sends nothing', async () => {
  const n = h.calls.length
  join_(GROUP, [{ id: 999, is_bot: true, first_name: 'Test', username: 'test_plus_bot' }, { id: 77, is_bot: true, first_name: 'OtherBot' }])
  await settle()
  expect(welcomes(n)).toHaveLength(0)
  join_(GROUP, [{ id: 78, is_bot: true, first_name: 'B' }, user('Người')])
  await settle()
  const w = welcomes(n)
  expect(w).toHaveLength(1)
  expect(w[0].body.text).toBe('Chào Người đến với nhóm!')
})

test('group not in access.json: nothing, even with a welcome text', async () => {
  const n = h.calls.length
  setWelcome({ [String(GROUP)]: 'x {name}', [String(OTHER_GROUP)]: 'Chào {name}' })
  join_(OTHER_GROUP, [user('Lạ')])
  await settle()
  expect(welcomes(n, OTHER_GROUP)).toHaveLength(0)
})

test('no welcome.json, or no key for the group: nothing', async () => {
  const n = h.calls.length
  setWelcome(null)
  join_(GROUP, [user('A')])
  await settle()
  setWelcome({ '-1009': 'Chào {name}' })
  join_(GROUP, [user('B')])
  await settle()
  setWelcome({ [String(GROUP)]: '   ' })
  join_(GROUP, [user('C')])
  await settle()
  expect(welcomes(n)).toHaveLength(0)
})

test('welcome.json is re-read: an edit applies to the next join', async () => {
  const n = h.calls.length
  setWelcome({ [String(GROUP)]: 'Bản mới: {name}' })
  join_(GROUP, [user('X')])
  await settle()
  expect(welcomes(n)[0].body.text).toBe('Bản mới: X')
})

test('more than 10 joiners: 10 names + "và N người khác"', async () => {
  const n = h.calls.length
  join_(GROUP, Array.from({ length: 12 }, (_, i) => user(`U${i + 1}`)))
  await settle()
  const w = welcomes(n)[0]
  expect(w.body.text).toBe('Chào U1, U2, U3, U4, U5, U6, U7, U8, U9, U10 và 2 người khác đến với nhóm!')
  expect(w.body.entities).toHaveLength(10)
})

test('template without {name} is sent as is; {name} twice gets two mentions each', async () => {
  const n = h.calls.length
  setWelcome({ [String(GROUP)]: 'Chào mừng thành viên mới!' })
  join_(GROUP, [user('P')])
  await settle()
  expect(welcomes(n)[0].body).toMatchObject({ text: 'Chào mừng thành viên mới!', entities: [] })
  await Bun.sleep(COOLDOWN)
  setWelcome({ [String(GROUP)]: '{name}: chào {name}' })
  join_(GROUP, [user('Q')])
  await settle()
  const w = welcomes(n)[1]
  expect(w.body.text).toBe('Q: chào Q')
  expect(w.body.entities.map((e: any) => e.offset)).toEqual([0, 8])
})

test('join messages in a DM-like or private chat are ignored', async () => {
  const n = h.calls.length
  join_(DM, [user('Z')])
  await settle()
  expect(welcomes(n, DM)).toHaveLength(0)
})
