// Offline tests: a mock Bot API (Bun.serve) + the real server.ts driven over
// MCP stdio. No real token, no network, no real state dir.
//   bun test
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const FAKE_TOKEN = '123456:FAKE-offline-test-token'
const DM = 111 // allowlisted DM user
const STRANGER = 222
const GROUP = -1001

type Call = { method: string; body: Record<string, any> }
const calls: Call[] = []
const updates: any[] = []
const notes: any[] = []
let nextId = 100
let updateId = 1

function reply(result: unknown) {
  return Response.json({ ok: true, result })
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/)
    if (!m || m[1] !== FAKE_TOKEN) return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 })
    const method = m[2]
    let body: Record<string, any> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) body = await req.json()
    else if (ct.includes('multipart')) {
      for (const [k, v] of (await req.formData()).entries()) {
        body[k] = typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return v } })() : '<file>'
      }
    }
    if (method === 'getUpdates') {
      for (let i = 0; i < 20 && updates.length === 0; i++) await Bun.sleep(25)
      return reply(updates.splice(0))
    }
    calls.push({ method, body })
    switch (method) {
      case 'getMe':
        return reply({ id: 999, is_bot: true, first_name: 'Test', username: 'test_plus_bot' })
      case 'sendMessage': case 'sendRichMessage': case 'sendPhoto': case 'sendDocument': {
        const id = nextId++
        const eph = body.ephemeral_message_parameters
        return reply({
          message_id: eph ? 0 : id,
          ...(eph ? { ephemeral_message_id: id } : {}),
          date: 0,
          chat: { id: Number(body.chat_id), type: Number(body.chat_id) < 0 ? 'supergroup' : 'private' },
          text: body.text ?? '',
        })
      }
      case 'editMessageText':
        return reply({ message_id: Number(body.message_id), date: 0, chat: { id: Number(body.chat_id), type: 'private' } })
      default:
        return reply(true)
    }
  },
})

const stateDir = mkdtempSync(join(tmpdir(), 'tg-plus-test-'))
writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist',
  allowFrom: [String(DM)],
  groups: { [String(GROUP)]: { requireMention: true, allowFrom: [] } },
  pending: {},
}))

const client = new Client({ name: 'offline-test', version: '0' })
client.fallbackNotificationHandler = async n => { notes.push(n) }

beforeAll(async () => {
  await client.connect(new StdioClientTransport({
    command: 'bun',
    args: [process.env.TG_SERVER ?? 'server.ts'],
    cwd: join(import.meta.dir, '..'),
    // Minimal env on purpose: no inherited TELEGRAM_* from the developer's shell.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: stateDir,
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${server.port}`,
    },
    stderr: 'ignore',
  }))
  await waitFor(() => calls.some(c => c.method === 'getMe'))
})

afterAll(async () => {
  await client.close().catch(() => {})
  server.stop(true)
  rmSync(stateDir, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(20)
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const before = calls.length
  const res: any = await client.callTool({ name, arguments: args })
  return { text: res.content?.[0]?.text as string, isError: !!res.isError, sent: calls.slice(before) }
}

function push(update: Record<string, unknown>) {
  updates.push({ update_id: updateId++, ...update })
}

test('lists upstream tools plus the new ones', async () => {
  const { tools } = await client.listTools()
  const names = tools.map(t => t.name).sort()
  expect(names).toEqual(['delete_message', 'download_attachment', 'edit_message', 'react', 'reply', 'stream_draft'])
  const reply = tools.find(t => t.name === 'reply')!
  expect((reply.inputSchema as any).required).toEqual(['chat_id', 'text'])
  expect((reply.inputSchema as any).properties.format.enum).toEqual(['text', 'markdownv2', 'rich'])
})

test('default reply is byte-for-byte the upstream request', async () => {
  const r = await call('reply', { chat_id: String(DM), text: 'hi' })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent \(id: \d+\)$/)
  const send = r.sent.filter(c => c.method === 'sendMessage')
  expect(send).toHaveLength(1)
  expect(send[0].body).toEqual({ chat_id: String(DM), text: 'hi' })
})

test('upstream reply options keep their shape (reply_to + markdownv2)', async () => {
  const r = await call('reply', { chat_id: String(DM), text: '*b*', reply_to: '5', format: 'markdownv2' })
  const body = r.sent.find(c => c.method === 'sendMessage')!.body
  expect(body).toEqual({ chat_id: String(DM), text: '*b*', reply_parameters: { message_id: 5 }, parse_mode: 'MarkdownV2' })
})

test('format rich goes through sendRichMessage', async () => {
  const md = '## Plan\n- [ ] a\n| x | y |\n|--|--|\n| 1 | 2 |'
  const r = await call('reply', { chat_id: String(DM), text: md, format: 'rich' })
  expect(r.isError).toBe(false)
  expect(r.sent.map(c => c.method)).toEqual(['sendRichMessage'])
  expect(r.sent[0].body).toEqual({ chat_id: String(DM), rich_message: { markdown: md } })
})

test('rich text is chunked at 32768, plain text at 4096', async () => {
  const long = 'a'.repeat(5000)
  const plain = await call('reply', { chat_id: String(DM), text: long })
  expect(plain.sent.filter(c => c.method === 'sendMessage')).toHaveLength(2)
  const rich = await call('reply', { chat_id: String(DM), text: long, format: 'rich' })
  expect(rich.sent.filter(c => c.method === 'sendRichMessage')).toHaveLength(1)
})

test('buttons, effect and silent', async () => {
  const r = await call('reply', {
    chat_id: String(DM),
    text: 'Deploy?',
    buttons: [[{ text: 'Yes', callback_data: 'deploy:yes', style: 'success' }, { text: 'No', style: 'danger' }], [{ text: 'Docs', url: 'https://example.com' }, { text: 'Copy', copy_text: 'make deploy' }]],
    effect_id: '5104841245755180586',
    silent: true,
  })
  expect(r.isError).toBe(false)
  const body = r.sent[0].body
  expect(body.message_effect_id).toBe('5104841245755180586')
  expect(body.disable_notification).toBe(true)
  expect(body.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: 'Yes', style: 'success', callback_data: 'u:deploy:yes' }, { text: 'No', style: 'danger', callback_data: 'u:No' }],
      [{ text: 'Docs', url: 'https://example.com' }, { text: 'Copy', copy_text: { text: 'make deploy' } }],
    ],
  })
})

test('buttons go on the last chunk, effect on the first', async () => {
  const r = await call('reply', { chat_id: String(DM), text: 'b'.repeat(5000), buttons: [[{ text: 'ok' }]], effect_id: 'E' })
  const sends = r.sent.filter(c => c.method === 'sendMessage')
  expect(sends[0].body.message_effect_id).toBe('E')
  expect(sends[0].body.reply_markup).toBeUndefined()
  expect(sends[1].body.reply_markup).toBeDefined()
  expect(sends[1].body.message_effect_id).toBeUndefined()
})

test('bad buttons are rejected before anything is sent', async () => {
  for (const buttons of [[[{ text: 'x', callback_data: 'z'.repeat(63) }]], [[{ text: '' }]], [[{ text: 'x', style: 'pink' }]], 'nope']) {
    const r = await call('reply', { chat_id: String(DM), text: 'x', buttons })
    expect(r.isError).toBe(true)
    expect(r.sent.filter(c => c.method.startsWith('send'))).toHaveLength(0)
  }
})

test('ephemeral reply in a group', async () => {
  const r = await call('reply', {
    chat_id: String(GROUP), text: 'only you', ephemeral_for: String(DM),
    callback_query_id: 'cq1', replace_callback_message: true,
  })
  expect(r.isError).toBe(false)
  expect(r.text).toMatch(/^sent ephemeral \(id: \d+\)$/)
  expect(r.sent[0].body.ephemeral_message_parameters).toEqual({
    receiver_user_id: DM, callback_query_id: 'cq1', replace_callback_query_message: true,
  })
})

test('ephemeral reply to an incoming ephemeral message', async () => {
  const r = await call('reply', { chat_id: String(GROUP), text: 'pong', ephemeral_for: String(DM), reply_to_ephemeral: '7' })
  expect(r.sent[0].body.reply_parameters).toEqual({ ephemeral_message_id: 7 })
  expect(r.sent[0].body.ephemeral_message_parameters).toEqual({ receiver_user_id: DM })
})

test('outbound gate still blocks non-allowlisted chats', async () => {
  const r = await call('reply', { chat_id: String(STRANGER), text: 'x', format: 'rich' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('not allowlisted')
  expect(r.sent).toHaveLength(0)
  const d = await call('stream_draft', { chat_id: String(STRANGER), draft_id: '1' })
  expect(d.isError).toBe(true)
  const del = await call('delete_message', { chat_id: String(STRANGER), message_id: '1' })
  expect(del.isError).toBe(true)
})

test('default edit_message is the upstream request', async () => {
  const plain = await call('edit_message', { chat_id: String(DM), message_id: '42', text: 'v2' })
  expect(plain.sent[0]).toEqual({ method: 'editMessageText', body: { chat_id: String(DM), message_id: 42, text: 'v2' } })
})

test('edit_message: rich, buttons, ephemeral', async () => {
  const rich = await call('edit_message', { chat_id: String(DM), message_id: '42', text: '# v3', format: 'rich', buttons: [[{ text: 'ok' }]] })
  expect(rich.sent[0].body).toEqual({
    chat_id: String(DM), message_id: 42, rich_message: { markdown: '# v3' },
    reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'u:ok' }]] },
  })

  const eph = await call('edit_message', { chat_id: String(GROUP), message_id: '9', text: 'e2', ephemeral_for: String(DM) })
  expect(eph.text).toBe('edited ephemeral (id: 9)')
  expect(eph.sent[0]).toEqual({
    method: 'editEphemeralMessageText',
    body: { chat_id: String(GROUP), text: 'e2', receiver_user_id: DM, ephemeral_message_id: 9 },
  })
})

test('delete_message: normal and ephemeral', async () => {
  const a = await call('delete_message', { chat_id: String(DM), message_id: '42' })
  expect(a.sent[0]).toEqual({ method: 'deleteMessage', body: { chat_id: String(DM), message_id: 42 } })
  const b = await call('delete_message', { chat_id: String(GROUP), message_id: '9', ephemeral_for: String(DM) })
  expect(b.sent[0]).toEqual({ method: 'deleteEphemeralMessage', body: { chat_id: String(GROUP), receiver_user_id: DM, ephemeral_message_id: 9 } })
})

test('stream_draft: thinking placeholder, text, rich, validation', async () => {
  const think = await call('stream_draft', { chat_id: String(DM), draft_id: '7', can_stop: true })
  expect(think.sent[0]).toEqual({ method: 'sendMessageDraft', body: { chat_id: DM, draft_id: 7, can_stop: true, text: '' } })
  const t = await call('stream_draft', { chat_id: String(DM), draft_id: '7', text: 'Đang làm…', keep_on_stop: true })
  expect(t.sent[0].body).toEqual({ chat_id: DM, draft_id: 7, keep_on_stop: true, text: 'Đang làm…' })
  const r = await call('stream_draft', { chat_id: String(DM), draft_id: '7', text: '## 50%', format: 'rich' })
  expect(r.sent[0]).toEqual({ method: 'sendRichMessageDraft', body: { chat_id: DM, draft_id: 7, rich_message: { markdown: '## 50%' } } })
  const bad = await call('stream_draft', { chat_id: String(DM), draft_id: '0' })
  expect(bad.isError).toBe(true)
  expect(bad.sent).toHaveLength(0)
})

test('default react is the upstream request', async () => {
  const a = await call('react', { chat_id: String(DM), message_id: '5', emoji: '👍' })
  expect(a.sent[0].body).toEqual({ chat_id: String(DM), message_id: 5, reaction: [{ type: 'emoji', emoji: '👍' }] })
})

test('react: big optional', async () => {
  const b = await call('react', { chat_id: String(DM), message_id: '5', emoji: '🔥', big: true })
  expect(b.sent[0].body.is_big).toBe(true)
})

test('button press from an allowlisted user reaches Claude', async () => {
  const before = notes.length
  push({ callback_query: {
    id: 'cqA', from: { id: DM, is_bot: false, first_name: 'E', username: 'edward' }, chat_instance: 'x',
    message: { message_id: 55, date: 0, chat: { id: DM, type: 'private' }, text: 'Deploy?' },
    data: 'u:deploy:yes',
  } })
  await waitFor(() => notes.length > before)
  const n = notes[notes.length - 1]
  expect(n.method).toBe('notifications/claude/channel')
  expect(n.params.content).toBe('(button) deploy:yes')
  expect(n.params.meta).toMatchObject({ chat_id: String(DM), message_id: '55', user_id: String(DM), callback_data: 'deploy:yes', callback_query_id: 'cqA' })
  await waitFor(() => calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cqA'))
})

test('button press from a stranger is refused and not delivered', async () => {
  const before = notes.length
  push({ callback_query: {
    id: 'cqB', from: { id: STRANGER, is_bot: false, first_name: 'X' }, chat_instance: 'x',
    message: { message_id: 56, date: 0, chat: { id: STRANGER, type: 'private' }, text: 'x' },
    data: 'u:evil',
  } })
  await waitFor(() => calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cqB'))
  const ans = calls.find(c => c.body.callback_query_id === 'cqB')!
  expect(ans.body.text).toBe('Not authorized.')
  await Bun.sleep(150)
  expect(notes.length).toBe(before)
})

test('forged callback_data cannot break out of meta', async () => {
  const before = notes.length
  push({ callback_query: {
    id: 'cqC', from: { id: DM, is_bot: false, first_name: 'E' }, chat_instance: 'x',
    message: { message_id: 57, date: 0, chat: { id: DM, type: 'private' }, text: 'x' },
    data: 'u:a"><x>;\n[y]',
  } })
  await waitFor(() => notes.length > before)
  expect(notes[notes.length - 1].params.meta.callback_data).toBe('a___x____y_')
})

test('permission-relay buttons still work', async () => {
  const before = notes.length
  push({ callback_query: {
    id: 'cqP', from: { id: DM, is_bot: false, first_name: 'E' }, chat_instance: 'x',
    message: { message_id: 58, date: 0, chat: { id: DM, type: 'private' }, text: '🔐 Permission: Bash' },
    data: 'perm:allow:abcde',
  } })
  await waitFor(() => notes.length > before)
  const n = notes[notes.length - 1]
  expect(n.method).toBe('notifications/claude/channel/permission')
  expect(n.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
})

test('Stop on a draft reaches Claude (allowlisted chat only)', async () => {
  const before = notes.length
  push({ stopped_message_generation: { chat: { id: STRANGER, type: 'private' }, draft_id: 7 } })
  push({ stopped_message_generation: { chat: { id: DM, type: 'private' }, draft_id: 7 } })
  await waitFor(() => notes.length > before)
  await Bun.sleep(100)
  const got = notes.slice(before)
  expect(got).toHaveLength(1)
  expect(got[0].params.content).toBe('(stopped generation)')
  expect(got[0].params.meta).toMatchObject({ chat_id: String(DM), draft_id: '7' })
})

test('incoming ephemeral group message is delivered without a mention and without message_id 0', async () => {
  const before = notes.length
  push({ message: {
    message_id: 0, ephemeral_message_id: 7, date: 0,
    chat: { id: GROUP, type: 'supergroup', title: 'g' }, from: { id: DM, is_bot: false, first_name: 'E' },
    receiver_user: { id: 999, is_bot: true, first_name: 'Test' }, text: '/ask hi',
    entities: [{ type: 'bot_command', offset: 0, length: 4 }],
  } })
  await waitFor(() => notes.length > before)
  const meta = notes[notes.length - 1].params.meta
  expect(meta.ephemeral_message_id).toBe('7')
  expect(meta.message_id).toBeUndefined()
  expect(meta.chat_id).toBe(String(GROUP))
})

test('normal group message without mention is still dropped', async () => {
  const before = notes.length
  push({ message: {
    message_id: 60, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'g' },
    from: { id: DM, is_bot: false, first_name: 'E' }, text: 'chatting',
  } })
  await Bun.sleep(300)
  expect(notes.length).toBe(before)
})
