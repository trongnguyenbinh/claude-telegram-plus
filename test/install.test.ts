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
  mkdirSync(join(plugin, 'skills', 'access'), { recursive: true })
  writeFileSync(join(plugin, 'skills', 'access', 'SKILL.md'), 'upstream access skill')
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
const EXTRAS = ['hooks/hooks.json', 'hooks/telegram-progress.py', 'skills/telegram-plus/SKILL.md']
const extrasInstalled = () => EXTRAS.map(f => existsSync(join(plugin, f))
  && readFileSync(join(plugin, f), 'utf8') === readFileSync(join(REPO, f), 'utf8'))
const overlay = (...args: string[]) => spawnSync('sh', [join(REPO, 'scripts', 'install-overlay.sh'), ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_CONFIG_DIR: cfg },
})
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
  expect(extrasInstalled()).toEqual([true, true, true])
  expect(readFileSync(join(plugin, 'skills', 'access', 'SKILL.md'), 'utf8')).toBe('upstream access skill')
  expect(readFileSync(join(plugin, '.telegram-plus'), 'utf8')).toContain(`version=${JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version}`)
  expect(backups()).toHaveLength(1)
  expect(r.out).toContain(`rollback:      ${REPO}/scripts/install-overlay.sh --rollback`)
  expect(r.out).toContain('claude --channels plugin:telegram@claude-plugins-official')

  const again = run()
  expect(again.code).toBe(0)
  expect(again.out).toContain("already the fork's server.ts")
  expect(backups()).toHaveLength(1)

  const dir = join(cfg, 'plugins', 'telegram-plus-backups', backups()[0])
  const rb = overlay('--rollback', dir)
  expect(rb.status).toBe(0)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(UPSTREAM)
  expect(extrasInstalled()).toEqual([false, false, false])
  expect(existsSync(join(plugin, 'hooks'))).toBe(false)
  expect(existsSync(join(plugin, 'skills', 'telegram-plus'))).toBe(false)
  expect(readFileSync(join(plugin, 'skills', 'access', 'SKILL.md'), 'utf8')).toBe('upstream access skill')
})

test('install-overlay.sh: server.ts current but skill/hooks missing or stale: adds them, rollback puts back the old ones', () => {
  writeFileSync(join(plugin, 'server.ts'), FORK)
  mkdirSync(join(plugin, 'hooks'))
  writeFileSync(join(plugin, 'hooks', 'telegram-progress.py'), '# old hook')
  const dry = overlay()
  expect(dry.status).toBe(0)
  expect(dry.stdout).toContain('server.ts is current, skill/hook files differ: hooks/hooks.json hooks/telegram-progress.py skills/telegram-plus/SKILL.md')
  expect(dry.stdout).not.toContain('nothing to do')
  expect(readFileSync(join(plugin, 'hooks', 'telegram-progress.py'), 'utf8')).toBe('# old hook')

  expect(overlay('--apply').status).toBe(0)
  expect(extrasInstalled()).toEqual([true, true, true])
  expect(overlay().stdout).toContain('nothing to do')

  const rb = overlay('--rollback', join(cfg, 'plugins', 'telegram-plus-backups', backups()[0]))
  expect(rb.status).toBe(0)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(FORK)
  expect(readFileSync(join(plugin, 'hooks', 'telegram-progress.py'), 'utf8')).toBe('# old hook')
  expect(existsSync(join(plugin, 'hooks', 'hooks.json'))).toBe(false)
  expect(existsSync(join(plugin, 'skills', 'telegram-plus'))).toBe(false)
})

test('install.sh: edited plugin server.ts is not overwritten', () => {
  writeFileSync(join(plugin, 'server.ts'), UPSTREAM + '\n// local edit\n')
  const r = run()
  expect(r.code).toBe(3)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toContain('// local edit')
  expect(extrasInstalled()).toEqual([false, false, false])
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
  expect(read().hooks).toBeUndefined()  // the progress hook ships in the plugin now

  writeFileSync(f, JSON.stringify({ ...read(), permissions: { allow: ['Bash(ls)'] } }))
  expect(run('--project', proj, '--state-dir', join(cfg, 'state')).code).toBe(0)
  expect(read().env.TELEGRAM_PLUS_TYPEWRITER).toBe('1')
  expect(read().permissions.allow).toEqual(['Bash(ls)'])
  expect(existsSync(f + '.bak-plus')).toBe(true)
})

test('install.sh: bad args exit 2 before touching anything', () => {
  expect(run('--state-dir', '/x').code).toBe(2)
  expect(run('--bogus').code).toBe(2)
  expect(readFileSync(join(plugin, 'server.ts'), 'utf8')).toBe(UPSTREAM)
})
