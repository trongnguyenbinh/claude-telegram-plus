// Lifecycle: server.log, bot.heartbeat, who may replace a poller in bot.pid,
// the in-process stall watchdog and the 409 backoff. Each case gets its own
// server (own state dir, own env).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DM, FAKE_TOKEN, startHarness } from './harness'

type H = Awaited<ReturnType<typeof startHarness>>
let h: H | undefined
const spawned: number[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const pid of spawned.splice(0)) try { process.kill(pid, 'SIGKILL') } catch {}
})

const log = (x: H) => existsSync(join(x.stateDir, 'server.log')) ? readFileSync(join(x.stateDir, 'server.log'), 'utf8') : ''
const heartbeat = (x: H) => JSON.parse(readFileSync(join(x.stateDir, 'bot.heartbeat'), 'utf8'))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
let msgId = 9000
function dm(x: H, text: string) {
  x.push({ message: { message_id: msgId++, date: 0, chat: { id: DM, type: 'private' }, from: { id: DM, is_bot: false, first_name: 'E' }, text } })
}

// A process whose args contain "server.ts", like a real poller. `parent`:
// 'other' = child of a live bash that is not our MCP client (another session),
// 'us' = child of the test runner, which is also our server's client,
// 'orphan' = its parent exits at once, so it is reparented to init.
function fakePoller(dir: string, parent: 'other' | 'us' | 'orphan'): number {
  const script = join(dir, 'holder.sh')
  const pidFile = join(dir, 'holder.pid')
  if (parent === 'orphan') {
    writeFileSync(script, `(exec -a "bun server.ts" sleep 60) &\necho $! > "${pidFile}"\n`)
    Bun.spawnSync(['bash', script])
  } else if (parent === 'other') {
    writeFileSync(script, `(exec -a "bun server.ts" sleep 60) &\necho $! > "${pidFile}"\nwait\n`)
    const sh = Bun.spawn(['bash', script])
    spawned.push(sh.pid)
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) Bun.sleepSync(10)
  } else {
    const p = Bun.spawn(['bash', '-c', 'exec -a "bun server.ts" sleep 60'])
    Bun.sleepSync(100)
    writeFileSync(pidFile, String(p.pid))
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  spawned.push(pid)
  writeFileSync(join(dir, 'bot.pid'), String(pid))
  return pid
}

test('server.log: start line with version and mode, polling line, shutdown reason; no token', async () => {
  const x = h = await startHarness()
  await x.waitFor(() => log(x).includes('polling as @test_plus_bot'))
  const version = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version
  expect(log(x)).toContain(`start v${version} `)
  expect(log(x)).toContain('mode=poll')
  await x.client.close()
  await x.waitFor(() => log(x).includes('shutting down: stdin'))
  expect(log(x)).not.toContain(FAKE_TOKEN)
  expect(existsSync(join(x.stateDir, 'bot.pid'))).toBe(false)
})

test('server.log rotates past 1MB', async () => {
  const x = h = await startHarness({}, { setup: dir => writeFileSync(join(dir, 'server.log'), 'x'.repeat(1024 * 1024 + 10)) })
  await x.waitFor(() => log(x).includes('polling as'))
  expect(statSync(join(x.stateDir, 'server.log.1')).size).toBeGreaterThan(1024 * 1024)
  expect(statSync(join(x.stateDir, 'server.log')).size).toBeLessThan(10_000)
})

test('heartbeat: written after getUpdates with pid and state polling, refreshed', async () => {
  const x = h = await startHarness()
  await x.waitFor(() => existsSync(join(x.stateDir, 'bot.heartbeat')))
  const hb = heartbeat(x)
  expect(hb.state).toBe('polling')
  expect(String(hb.pid)).toBe(readFileSync(join(x.stateDir, 'bot.pid'), 'utf8').trim())
  const t0 = statSync(join(x.stateDir, 'bot.heartbeat')).mtimeMs
  await x.waitFor(() => statSync(join(x.stateDir, 'bot.heartbeat')).mtimeMs > t0, 4000)
})

test('a poller that belongs to another live session is not killed: send-only, no polling', async () => {
  let holder = 0
  const x = h = await startHarness({}, { ready: 'connected', setup: dir => { holder = fakePoller(dir, 'other') } })
  await x.waitFor(() => log(x).includes('send-only'))
  expect(log(x)).toContain(`bot already polled by pid=${holder}`)
  await Bun.sleep(300)
  expect(alive(holder)).toBe(true)
  expect(x.polls()).toBe(0)
  expect(readFileSync(join(x.stateDir, 'bot.pid'), 'utf8').trim()).toBe(String(holder))
  // tools still send
  const r = await x.call('reply', { chat_id: String(DM), text: 'still here' })
  expect(r.isError).toBe(false)
  // and shutting down leaves the owner's bot.pid alone
  await x.client.close()
  await x.waitFor(() => log(x).includes('shutting down'))
  await Bun.sleep(100)
  expect(readFileSync(join(x.stateDir, 'bot.pid'), 'utf8').trim()).toBe(String(holder))
})

test('an orphaned poller (parent gone) is replaced', async () => {
  let holder = 0
  const x = h = await startHarness({}, { setup: dir => { holder = fakePoller(dir, 'orphan') } })
  await x.waitFor(() => log(x).includes(`replacing orphaned poller pid=${holder}`))
  await x.waitFor(() => !alive(holder))
  expect(log(x)).toContain('mode=poll')
})

test('our own predecessor (same MCP client, e.g. /mcp Reconnect) is replaced', async () => {
  let holder = 0
  const x = h = await startHarness({}, { setup: dir => { holder = fakePoller(dir, 'us') } })
  await x.waitFor(() => log(x).includes(`replacing previous poller pid=${holder}`))
  await x.waitFor(() => !alive(holder))
})

test('stall watchdog: getUpdates hangs → poll loop restarted, messages flow again', async () => {
  const x = h = await startHarness({
    TELEGRAM_PLUS_STALL_MS: '600', TELEGRAM_PLUS_STALL_CHECK_MS: '150', TELEGRAM_PLUS_GET_UPDATES_TIMEOUT_MS: '400',
  })
  x.knobs.updates = () => 'hang'
  await x.waitFor(() => log(x).includes('stall: no completed getUpdates'), 5000)
  x.knobs.updates = undefined
  await x.waitFor(() => log(x).includes('poll loop restarted'), 8000)
  const before = x.notes.length
  dm(x, 'after the stall')
  await x.waitFor(() => x.notes.length > before, 8000)
  expect(x.notes[x.notes.length - 1].params.content).toBe('after the stall')
  expect(heartbeat(x).state).toBe('polling')
}, 30_000)

test('409 never gives up: backoff keeps retrying past 8, heartbeat says conflict, then recovers', async () => {
  const x = h = await startHarness({ TELEGRAM_PLUS_CONFLICT_BACKOFF_MS: '20', TELEGRAM_PLUS_CONFLICT_BACKOFF_MAX_MS: '80' })
  x.knobs.updates = () => 'conflict'
  await x.waitFor(() => log(x).includes('409 Conflict #10:'), 10_000)
  expect(heartbeat(x).state).toBe('conflict')
  expect(log(x)).toMatch(/409 Conflict #1: another poller holds this bot token.*retrying in 0s/)
  x.knobs.updates = undefined
  await x.waitFor(() => heartbeat(x).state === 'polling', 5000)
  const before = x.notes.length
  dm(x, 'after the conflict')
  await x.waitFor(() => x.notes.length > before, 5000)
}, 30_000)
