// scripts/install.sh in a sandbox: fake CLAUDE_CONFIG_DIR + HOME with a pristine
// upstream plugin. Never touches the real ~/.claude.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REPO = join(import.meta.dir, '..')
const UPSTREAM = execSync('git show upstream-0.0.7:server.ts', { cwd: REPO, encoding: 'utf8' })
const FORK = readFileSync(join(REPO, 'server.ts'), 'utf8')
const root = mkdtempSync(join(tmpdir(), 'tg-plus-install-'))
let cfg: string, plugin: string, n = 0

afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  cfg = join(root, `cfg${n++}`)
  plugin = join(cfg, 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, 'server.ts'), UPSTREAM)
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'telegram', version: '0.0.7' }))
  writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'telegram@claude-plugins-official': [{ scope: 'user', installPath: plugin, version: '0.0.7' }] },
  }))
})

function run(...args: string[]) {
  const r = spawnSync('sh', [join(REPO, 'scripts', 'install.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_CONFIG_DIR: cfg },
  })
  return { code: r.status, out: r.stdout + r.stderr }
}
const backups = () => existsSync(join(cfg, 'plugins', 'telegram-plus-backups'))
  ? readdirSync(join(cfg, 'plugins', 'telegram-plus-backups')) : []

test('install.sh: plugin missing prints the /plugin install command and changes nothing', () => {
  rmSync(join(cfg, 'plugins', 'installed_plugins.json'))
  const r = run()
  expect(r.code).toBe(1)
  expect(r.out).toContain('/plugin install telegram@claude-plugins-official')
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(UPSTREAM)
})

test('install.sh: overlays, prints backup + rollback + restart, re-run is a no-op', () => {
  const r = run()
  expect(r.code).toBe(0)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(FORK)
  expect(readFileSync(join(plugin, '.telegram-plus'), 'utf8')).toContain(`version=${JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version}`)
  expect(backups()).toHaveLength(1)
  expect(r.out).toContain(`rollback:      ${REPO}/scripts/install-overlay.sh --rollback`)
  expect(r.out).toContain('claude --channels plugin:telegram@claude-plugins-official')

  const again = run()
  expect(again.code).toBe(0)
  expect(again.out).toContain("already the fork's server.ts")
  expect(backups()).toHaveLength(1)

  const dir = join(cfg, 'plugins', 'telegram-plus-backups', backups()[0])
  const rb = spawnSync('sh', [join(REPO, 'scripts', 'install-overlay.sh'), '--rollback', dir], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_CONFIG_DIR: cfg },
  })
  expect(rb.status).toBe(0)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(UPSTREAM)
})

test('install.sh: edited plugin server.ts is not overwritten', () => {
  writeFileSync(join(plugin, 'server.ts'), UPSTREAM + '\n// local edit\n')
  const r = run()
  expect(r.code).toBe(3)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toContain('// local edit')
  expect(backups()).toHaveLength(0)
})

test('install.sh --project: creates settings.local.json when missing, idempotent', () => {
  const proj = join(cfg, 'proj')
  mkdirSync(proj)
  const r = run('--project', proj, '--state-dir', join(cfg, 'state'))
  expect(r.code).toBe(0)
  const f = join(proj, '.claude', 'settings.local.json')
  const read = () => JSON.parse(readFileSync(f, 'utf8'))
  expect(read().env.TELEGRAM_PLUS_TYPEWRITER).toBe('1')
  expect(read().hooks.PreToolUse).toHaveLength(1)
  expect(read().hooks.PreToolUse[0].hooks[0].command).toContain(`TELEGRAM_STATE_DIR=${join(cfg, 'state')} python3 `)

  writeFileSync(f, JSON.stringify({ ...read(), permissions: { allow: ['Bash(ls)'] } }))
  expect(run('--project', proj, '--state-dir', join(cfg, 'state')).code).toBe(0)
  expect(read().hooks.PreToolUse).toHaveLength(1)
  expect(read().permissions.allow).toEqual(['Bash(ls)'])
  expect(existsSync(f + '.bak-plus')).toBe(true)
})

test('install.sh: bad args exit 2 before touching anything', () => {
  expect(run('--state-dir', '/x').code).toBe(2)
  expect(run('--bogus').code).toBe(2)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(UPSTREAM)
})
