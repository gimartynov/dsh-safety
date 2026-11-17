/**
 * End-to-end verification of dsh-snapshots against a real temporary git work tree.
 * Run: ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/snapshots.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../index.js'

function harness(config) {
  const state = { gate: undefined, commands: new Map() }
  const ctx = {
    on(event, callback) {
      if (event === 'tools/pre-execute') state.gate = callback
      return () => {}
    },
    commands: {
      register(definition) {
        state.commands.set(definition.name, definition.handler)
        return () => state.commands.delete(definition.name)
      },
    },
    effect(fn) {
      return fn()
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, Config(config))
  return {
    run: (name, rawInput) => state.commands.get(name)({ agent: {}, rawInput }),
    before: (exec) => state.gate(exec, () => Promise.resolve({ kind: 'allow' })),
  }
}

const base = mkdtempSync(join(tmpdir(), 'dsh-snap-'))
const project = join(base, 'project')
const store = join(base, 'store')
mkdirSync(join(project, 'sub'), { recursive: true })
writeFileSync(join(project, 'a.txt'), 'v1\n')
writeFileSync(join(project, 'sub', 'b.txt'), 'b1\n')

const cases = []
const check = (title, fn) => cases.push({ title, fn })
const h = harness({ roots: [project], storeDir: store, autoSnapshot: false })

check('/snap creates a restore point', () => {
  const out = h.run('snap', 'baseline')
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /snapshot refs\/snapshots\/s\d+/)
})

check('/snap skips when nothing changed', () => {
  const out = h.run('snap', 'again')
  assert.match(out.text, /no changes/, out.text)
})

check('/snapshots lists the restore point with its label', () => {
  const out = h.run('snapshots', '5')
  assert.match(out.text, /baseline/, out.text)
  assert.match(out.text, /Snapshots for/, out.text)
})

check('/rollback restores modified and deleted files and removes new ones', () => {
  writeFileSync(join(project, 'a.txt'), 'v2-modified\n')
  rmSync(join(project, 'sub', 'b.txt'))
  writeFileSync(join(project, 'c-new.txt'), 'should disappear\n')

  const out = h.run('rollback', '1 --clean')
  assert.equal(out.kind, 'success', out.text)
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf8'), 'v1\n')
  assert.equal(readFileSync(join(project, 'sub', 'b.txt'), 'utf8'), 'b1\n')
  assert.equal(existsSync(join(project, 'c-new.txt')), false)
})

check('/rollback without --clean keeps new files', () => {
  writeFileSync(join(project, 'a.txt'), 'v3\n')
  writeFileSync(join(project, 'keep.txt'), 'stays\n')
  h.run('snap', 'before-plain-rollback')
  const out = h.run('rollback', '1')
  assert.equal(out.kind, 'success', out.text)
  assert.equal(existsSync(join(project, 'keep.txt')), true)
})

check('/rollback rejects an unknown snapshot instead of guessing', () => {
  const out = h.run('rollback', '999')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /not found/, out.text)
})

check('automatic snapshot fires before a mutating call and not before a read', async () => {
  const auto = harness({ roots: [project], storeDir: store, autoSnapshot: true, cooldownSeconds: 0 })
  const beforeRead = auto.run('snapshots', '50').text
  await auto.before({ name: 'bash', arguments: { command: 'ls -la', cwd: project } })
  assert.equal(auto.run('snapshots', '50').text, beforeRead, 'a read must not create a snapshot')

  writeFileSync(join(project, 'a.txt'), 'v4-forced\n')
  await auto.before({ name: 'bash', arguments: { command: 'rm -rf dist', cwd: project } })
  const after = auto.run('snapshots', '50').text
  assert.match(after, /auto: bash/, after)
})

check('stays idle and explains itself when no roots are configured', () => {
  const bare = harness({ roots: [], storeDir: join(base, 'store-unconfigured') })
  const out = bare.run('snap', 'x')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /no project is configured/i)
  assert.equal(existsSync(join(base, 'store-unconfigured')), false)
})

check('shadow repository lives in storeDir, not inside the project', () => {
  assert.equal(existsSync(join(project, '.git')), false)
  assert.equal(existsSync(store), true)
})

let failures = 0
for (const { title, fn } of cases) {
  try {
    await fn()
    console.log(`ok   ${title}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${title}\n     ${error.message}`)
  }
}
rmSync(base, { recursive: true, force: true })
console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures === 0 ? 0 : 1)
