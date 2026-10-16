// Manual smoke test against the REAL Telegram API with a SEPARATE TEST BOT.
// Never point this at the main bot's state dir.
//
//   TELEGRAM_STATE_DIR=~/.claude/channels/telegram-test \
//     bun scripts/smoke-real.ts <your_user_id> [test_group_id]
//
// The state dir must hold the test bot's .env and an access.json allowlisting
// <your_user_id> (and test_group_id under "groups" if given). For the group
// ephemeral check the test bot must be an admin of that test group.
// Watch your phone; button presses and Stop presses are printed for 60s.
//
// Welcome check (new group members), bot WITHOUT admin rights, privacy mode on:
//   TELEGRAM_STATE_DIR=~/.claude/channels/telegram-test \
//     bun scripts/smoke-real.ts <your_user_id> <test_group_id> --welcome
// Writes a test welcome.json into the TEST state dir if none exists, skips the
// other steps, then waits 90s: add someone (a second account) to the test group.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const welcomeOnly = process.argv.includes('--welcome')
const [user, group] = process.argv.slice(2).filter(a => a !== '--welcome')
const state = process.env.TELEGRAM_STATE_DIR
if (!user || !state) {
  console.error('usage: TELEGRAM_STATE_DIR=<test bot state dir> bun scripts/smoke-real.ts <user_id> [group_id]')
  process.exit(2)
}
if (state.replace(/\/+$/, '') === join(homedir(), '.claude', 'channels', 'telegram')) {
  console.error('refusing: that is the main bot state dir; use a separate test bot')
  process.exit(2)
}
// A live poller on this state dir means a real session owns this bot: never test on it.
try {
  const pid = parseInt(readFileSync(join(state, 'bot.pid'), 'utf8'), 10)
  if (pid > 1) { process.kill(pid, 0); console.error(`refusing: bot.pid ${pid} is alive, a session is using this bot`); process.exit(2) }
} catch {}
if (welcomeOnly) {
  if (!group) { console.error('--welcome needs <test_group_id>'); process.exit(2) }
  const f = join(state, 'welcome.json')
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ [group]: '🧪 Smoke welcome: chào {name}!' }, null, 2) + '\n')
  console.log(`welcome.json: ${readFileSync(f, 'utf8').trim()}`)
}

const client = new Client({ name: 'smoke-real', version: '0' })
client.fallbackNotificationHandler = async n => { console.log('inbound:', JSON.stringify(n.params)) }
await client.connect(new StdioClientTransport({
  command: 'bun',
  args: ['server.ts'],
  cwd: join(import.meta.dir, '..'),
  env: { PATH: process.env.PATH ?? '', HOME: homedir(), TELEGRAM_STATE_DIR: state },
  stderr: 'inherit',
}))

async function step(name: string, tool: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name: tool, arguments: args })
  console.log(`${r.isError ? 'FAIL' : 'ok  '} ${name}: ${r.content?.[0]?.text}`)
  return r
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

if (welcomeOnly) {
  console.log('now add a member to the test group; expect one welcome message within ~3s (waiting 90s)')
  await sleep(90000)
  await client.close()
  process.exit(0)
}
await step('plain reply (upstream path)', 'reply', { chat_id: user, text: 'telegram-plus smoke: plain text' })
await step('draft thinking', 'stream_draft', { chat_id: user, draft_id: '42', text: '', can_stop: true })
await sleep(2000)
await step('draft text', 'stream_draft', { chat_id: user, draft_id: '42', text: 'Đang chạy bước 1/2...', can_stop: true })
await sleep(2000)
await step('rich reply', 'reply', {
  chat_id: user, format: 'rich',
  text: '## Smoke test\n- [x] rich message\n- [ ] buttons\n\n| Mục | Kết quả |\n|:--|:--:|\n| draft | ok |\n\n```bash\necho copy me\n```',
})
const withButtons = await step('buttons + silent', 'reply', {
  chat_id: user, text: 'Bấm thử một nút:', silent: true,
  buttons: [[{ text: 'Đồng ý', callback_data: 'smoke:yes', style: 'success' }, { text: 'Huỷ', callback_data: 'smoke:no', style: 'danger' }], [{ text: 'Copy lệnh', copy_text: 'echo hello' }]],
})
const id = /id: (\d+)/.exec(withButtons.content?.[0]?.text ?? '')?.[1]
if (id) await step('react big', 'react', { chat_id: user, message_id: id, emoji: '🔥', big: true })
await step('effect (community id, unverified)', 'reply', { chat_id: user, text: 'effect test', effect_id: '5104841245755180586' })
const tmp = await step('temp message', 'reply', { chat_id: user, text: 'tin này sẽ bị xoá sau 3 giây' })
const tmpId = /id: (\d+)/.exec(tmp.content?.[0]?.text ?? '')?.[1]
await sleep(3000)
if (tmpId) await step('delete_message', 'delete_message', { chat_id: user, message_id: tmpId })
if (group) {
  const e = await step('ephemeral in group (bot must be admin)', 'reply', { chat_id: group, text: 'chỉ mình anh thấy tin này', ephemeral_for: user })
  const eid = /id: (\d+)/.exec(e.content?.[0]?.text ?? '')?.[1]
  if (eid) {
    await sleep(2000)
    await step('edit ephemeral', 'edit_message', { chat_id: group, message_id: eid, text: 'đã sửa (vẫn chỉ mình anh thấy)', ephemeral_for: user })
  }
}
console.log('waiting 60s for button / Stop presses...')
await sleep(60000)
await client.close()
