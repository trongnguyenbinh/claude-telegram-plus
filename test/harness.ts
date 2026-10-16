// Shared offline harness: a mock Bot API (Bun.serve) + the real server.ts
// driven over MCP stdio. No real token, no network, no real state dir.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const FAKE_TOKEN = '123456:FAKE-offline-test-token'
export const DM = 111 // allowlisted DM user
export const STRANGER = 222
export const GROUP = -1001

export type Call = { method: string; body: Record<string, any>; at: number }

// Per-test knob for draft methods: return {fail:true} to answer HTTP 400,
// {delayMs} to answer late.
export type DraftBehaviour = (body: Record<string, any>) => { fail?: boolean; delayMs?: number } | undefined

export async function startHarness(extraEnv: Record<string, string> = {}) {
  const calls: Call[] = []
  const updates: any[] = []
  const notes: any[] = []
  let nextId = 100
  let updateId = 1
  const knobs: { draft?: DraftBehaviour } = {}

  const reply = (result: unknown) => Response.json({ ok: true, result })

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
      calls.push({ method, body, at: Date.now() })
      switch (method) {
        case 'getMe':
          return reply({ id: 999, is_bot: true, first_name: 'Test', username: 'test_plus_bot' })
        case 'sendMessageDraft': case 'sendRichMessageDraft': {
          const k = knobs.draft?.(body)
          if (k?.delayMs) await Bun.sleep(k.delayMs)
          if (k?.fail) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
          return reply(true)
        }
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

  async function waitFor(cond: () => boolean, ms = 3000) {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await Bun.sleep(20)
    }
  }

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
      ...extraEnv,
    },
    stderr: 'ignore',
  }))
  // Startup is done once polling began and commands were registered.
  await waitFor(() => calls.some(c => c.method === 'setMyCommands'))

  return {
    calls, notes, knobs, client, waitFor, stateDir,
    async call(name: string, args: Record<string, unknown>) {
      const before = calls.length
      const t0 = Date.now()
      const res: any = await client.callTool({ name, arguments: args })
      const raw = calls.slice(before)
      return {
        text: res.content?.[0]?.text as string, isError: !!res.isError, ms: Date.now() - t0,
        sent: raw.map(({ method, body }) => ({ method, body })), at: raw.map(c => c.at - t0),
      }
    },
    push(update: Record<string, unknown>) {
      updates.push({ update_id: updateId++, ...update })
    },
    async stop() {
      await client.close().catch(() => {})
      server.stop(true)
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
