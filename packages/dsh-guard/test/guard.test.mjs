/**
 * Offline verification of dsh-guard's decision logic: no DSH runtime needed.
 * Run: ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/guard.test.mjs
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'

const HOME = homedir()
import { apply, Config } from '../index.js'

function harness(config) {
  const state = { guard: undefined, gate: undefined }
  const ctx = {
    tools: {
      guard(fn) {
        state.guard = fn
        return () => {
          state.guard = undefined
        }
      },
    },
    on(event, callback) {
      if (event === 'tools/pre-execute') state.gate = callback
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    logger: { info() {} },
  }
  apply(ctx, Config(config))
  return {
    /** string reason = denied, undefined = guard allows */
    guard: (exec) => state.guard(exec),
    /** outcome of the waterfall: {kind:'ask'} or next() = {kind:'allow'} */
    gate: (exec) =>
      state.gate(exec, () => Promise.resolve({ kind: 'allow' })).then((outcome) => outcome.kind),
  }
}

const cases = []
const check = (title, fn) => cases.push({ title, fn })

const PROTECT = { protect: ['~/Games/MyGame', '~/Desktop/Books'], auditFile: '' }

check('denies rm -rf on a protected game directory', () => {
  const h = harness(PROTECT)
  const denial = h.guard({ name: 'bash', arguments: { command: 'rm -rf ~/Games/MyGame/dist' } })
  assert.ok(typeof denial === 'string' && denial.includes('MyGame'), denial)
})

check('leaves reads of protected paths alone', () => {
  const h = harness(PROTECT)
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'cat ~/Games/MyGame/README.md' } }), undefined)
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'ls -la ~/Desktop/Books' } }), undefined)
})

check('denies a write tool call inside a protected path', () => {
  const h = harness(PROTECT)
  const denial = h.guard({ name: 'write', arguments: { file_path: `${HOME}/Desktop/Books/outline.md` } })
  assert.ok(typeof denial === 'string', denial)
})

check('honours allowWrite exceptions', () => {
  const h = harness({ ...PROTECT, allowWrite: ['~/Games/MyGame/web'] })
  assert.equal(
    h.guard({ name: 'write', arguments: { file_path: `${HOME}/Games/MyGame/web/index.html` } }),
    undefined,
  )
})

check('honours allowWrite for shell commands too', () => {
  const h = harness({ ...PROTECT, allowWrite: ['~/Games/MyGame/Library'] })
  assert.equal(
    h.guard({ name: 'bash', arguments: { command: 'touch ~/Games/MyGame/Library/probe' } }),
    undefined,
  )
  assert.ok(
    typeof h.guard({ name: 'bash', arguments: { command: 'touch ~/Games/MyGame/Assets/probe' } }) === 'string',
  )
})

check('denies a mutating command whose cwd is protected (relative targets)', () => {
  const h = harness(PROTECT)
  const denial = h.guard({
    name: 'bash',
    arguments: { command: 'rm -rf node_modules', cwd: `${HOME}/Games/MyGame` },
  })
  assert.ok(typeof denial === 'string', denial)
})

check('blocks catastrophic commands regardless of paths', () => {
  const h = harness({ auditFile: '' })
  assert.ok(typeof h.guard({ name: 'bash', arguments: { command: 'rm -rf /' } }) === 'string')
  assert.ok(typeof h.guard({ name: 'bash', arguments: { command: 'dd if=/dev/zero of=/dev/disk2' } }) === 'string')
})

check('asks before history-rewriting git commands', async () => {
  const h = harness({ auditFile: '' })
  assert.equal(await h.gate({ name: 'bash', arguments: { command: 'git reset --hard HEAD~3' } }), 'ask')
  assert.equal(await h.gate({ name: 'bash', arguments: { command: 'git push --force origin main' } }), 'ask')
  assert.equal(await h.gate({ name: 'bash', arguments: { command: 'git status' } }), 'allow')
})

check('redirect to /dev/null does not count as a write', () => {
  const h = harness(PROTECT)
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'ls ~/Desktop/Books 2>/dev/null' } }), undefined)
})

check('does not touch ordinary workspace writes', () => {
  const h = harness({ auditFile: '' })
  assert.equal(
    h.guard({ name: 'write', arguments: { file_path: '/tmp/dsh-guard-test/a.md' } }),
    undefined,
  )
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'mkdir -p build && touch build/x' } }), undefined)
})

check('protects harness state by default', () => {
  const h = harness({ auditFile: '' })
  assert.ok(typeof h.guard({ name: 'bash', arguments: { command: 'rm -rf ~/.dsh/profiles/desktop' } }) === 'string')
})

check('unknown shell cwd does not invent a protected path', () => {

  // Host process cwd sits inside the protected root here, which used to turn
  // `>> .gitignore` into a write into ~/.dsh and deny harmless commands.
  const h = harness({ protect: [process.cwd()], auditFile: '' })
  assert.equal(h.guard({ name: 'bash', arguments: { command: 'printf x >> .gitignore' } }), undefined)
  assert.ok(typeof h.guard({ name: 'bash', arguments: { command: 'rm -rf ~/.dsh/x' } }) === 'string')
})


check('ignores destructive text inside a heredoc body', () => {
  const h = harness(PROTECT)
  const command = ["cat > /tmp/dsh-guard-note.md <<'EOF'", 'rm -rf ~/Desktop/Books/x', 'EOF'].join('\\n')
  assert.equal(h.guard({ name: 'bash', arguments: { command } }), undefined)
  assert.ok(typeof h.guard({ name: 'bash', arguments: { command: 'rm -rf ~/Desktop/Books/x' } }) === 'string')
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
console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures === 0 ? 0 : 1)
