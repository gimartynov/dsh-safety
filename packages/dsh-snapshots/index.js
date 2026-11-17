/**
 * dsh-snapshots — local, zero-token restore points for a working tree.
 *
 * Keeps a shadow git repository (GIT_DIR under ~/.dsh/snapshots, work tree = your project),
 * so snapshots never pollute the project's own .git and never leave the machine.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
// Schemastery ships with DeepSeek Harness; the tiny fallback keeps `Config` usable
// (and the offline tests runnable) when the package is installed standalone.
let Schema
try {
  ;({ default: Schema } = await import('@deepseek-ai/schemastery'))
} catch {
  // Chainable no-op schema: every builder/validator call keeps chaining, and calling
  // the result returns the value it was given. Enough for offline tests.
  const chain = () => {
    const build = (value) => (value === undefined ? {} : value)
    return new Proxy(build, { get: () => () => chain() })
  }
  Schema = new Proxy({}, { get: () => () => chain() })
}

export const name = 'dsh-snapshots'
export const inject = ['tools', 'commands']

const DEFAULT_EXCLUDE = ['.git/', 'node_modules/', '.DS_Store', '*.log', '.dsh-snapshots/']

const NO_ROOTS =
  'dsh-snapshots: no project is configured yet. Add the directories to snapshot under `roots` in the plugin config (profile cordis.patch.yml, key redacted here), e.g. roots: ["~/MyGame"].'

const MUTATING_BASH =
  /(?:\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\btruncate\b|\bshred\b|\bdd\b|\btee\b|\brsync\b|\bsed\s+(?:-i|--in-place)\b|\bgit\s+(?:reset|clean|checkout|restore|stash|filter-branch|merge|rebase|am|cherry-pick)\b|>\s*[^\s|&])/

const DESTRUCTIVE =
  /(?:\brm\s+-[A-Za-z]*[rf]|\bgit\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*[fd]|stash\s+(?:drop|clear))|\btruncate\b|\bshred\b)/

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace_editor', 'notebook_edit'])
const PATH_KEYS = ['file_path', 'path', 'target_file', 'filePath', 'target']
const PATH_TOKEN = /(?:^|[\s"'`=(:,|;&])((?:~|\.{1,2})?\/[^\s"'`|;&<>()]+)/g

export const Config = Schema.object({
  roots: Schema.array(String)
    .default([])
    .description('Project directories to snapshot. Empty means the session workspace (process.cwd()).'),
  storeDir: Schema.string()
    .default('~/.dsh/snapshots')
    .description('Where shadow git repositories live.'),
  keep: Schema.number()
    .default(30)
    .description('How many snapshots to retain per project.'),
  autoSnapshot: Schema.boolean()
    .default(true)
    .description('Take a snapshot before the first mutating tool call of a burst.'),
  cooldownSeconds: Schema.number()
    .default(45)
    .description('Minimum gap between automatic snapshots of the same project.'),
  exclude: Schema.array(String)
    .default(DEFAULT_EXCLUDE)
    .description('Extra ignore patterns appended to the shadow repository exclude file.'),
})

function toAbs(value, base) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let raw = value
  if (raw === '~') raw = homedir()
  else if (raw.startsWith('~/')) raw = homedir() + raw.slice(1)
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(base || process.cwd(), raw)
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs
}

function inside(child, root) {
  return child === root || child.startsWith(root + sep) || child.startsWith(root + '/')
}

/** Refuse to treat a volume root, the home directory or a shallow path as a project. */
function isSaneRoot(root) {
  if (root === '/' || root === homedir()) return false
  return root.split(sep).filter(Boolean).length >= 2
}

function gitEnv(gitDir, workTree) {
  return {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_AUTHOR_NAME: 'dsh-snapshots',
    GIT_AUTHOR_EMAIL: 'snapshots@localhost',
    GIT_COMMITTER_NAME: 'dsh-snapshots',
    GIT_COMMITTER_EMAIL: 'snapshots@localhost',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

export function apply(ctx, config = {}) {
  const storeDir = toAbs(config.storeDir ?? '~/.dsh/snapshots')
  const keep = Math.max(1, config.keep ?? 30)
  const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 45) * 1000)
  const autoSnapshot = config.autoSnapshot !== false
  const exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])]
  const roots = (config.roots ?? []).map((entry) => toAbs(entry)).filter((root) => root && isSaneRoot(root))
  const defaultRoot = roots.length > 0 ? roots[0] : undefined
  const lastAuto = new Map()

  function rootDir(root) {
    const digest = createHash('sha1').update(root).digest('hex').slice(0, 16)
    return join(storeDir, `${basename(root) || 'root'}-${digest}`)
  }

  function git(dir, root, args, options = {}) {
    return execFileSync('git', args, {
      cwd: root,
      env: gitEnv(dir, root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
      ...options,
    })
  }

  function ensureRepo(root) {
    const dir = rootDir(root)
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(join(dir, 'info'), { recursive: true })
      git(dir, root, ['init', '--quiet'])
      writeFileSync(join(dir, 'info', 'exclude'), exclude.join('\n') + '\n')
    }
    return dir
  }

  /** refs/snapshots/* newest first */
  function listRefs(root) {
    const dir = rootDir(root)
    if (!existsSync(join(dir, 'HEAD'))) return []
    let raw = ''
    try {
      raw = git(dir, root, [
        'for-each-ref',
        '--sort=-creatordate',
        '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)',
        'refs/snapshots',
      ])
    } catch {
      return []
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [ref, commit, date, subject] = line.split('\t')
        return { ref, commit, date, subject: subject ?? '' }
      })
  }

  function snapshot(root, label) {
    const dir = ensureRepo(root)
    git(dir, root, ['add', '-A', '--', '.'])

    // Nothing tracked and nothing changed since the last snapshot => skip.
    let staged = ''
    try {
      staged = git(dir, root, ['diff', '--cached', '--name-only'])
    } catch {
      staged = git(dir, root, ['ls-files']).trim()
    }
    const previous = listRefs(root)[0]
    const tree = git(dir, root, ['write-tree']).trim()
    if (previous) {
      let previousTree = ''
      try {
        previousTree = git(dir, root, ['rev-parse', `${previous.ref}^{tree}`]).trim()
      } catch {
        previousTree = ''
      }
      if (previousTree === tree) {
        return { skipped: true, ref: previous.ref, commit: previous.commit, files: 0 }
      }
    }
    const args = ['commit-tree', tree, '-m', label || `snapshot ${new Date().toISOString()}`]
    if (previous) args.push('-p', previous.commit)
    const commit = git(dir, root, args).trim()
    const stamp = Date.now()
    const ref = `refs/snapshots/s${stamp}`
    git(dir, root, ['update-ref', ref, commit])
    prune(root)
    const filesRaw = git(dir, root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit])
    return { skipped: false, ref, commit, files: filesRaw.split('\n').filter(Boolean).length }
  }

  function prune(root) {
    const refs = listRefs(root)
    const dir = rootDir(root)
    for (const stale of refs.slice(keep)) {
      try {
        git(dir, root, ['update-ref', '-d', stale.ref])
      } catch {
        /* pruning is best effort */
      }
    }
  }

  function changedSince(dir, root, ref) {
    try {
      const raw = git(dir, root, ['diff', '--name-status', ref, '--', '.'])
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status, ...rest] = line.split('\t')
          return { status: status[0], path: rest.join('\t') }
        })
    } catch {
      return []
    }
  }

  function restore(root, target, clean) {
    const dir = ensureRepo(root)
    const refs = listRefs(root)
    if (refs.length === 0) throw new Error(`no snapshots for ${root}`)

    const entry = /^\d+$/.test(target)
      ? refs[Number(target) - 1]
      : refs.find(
          (candidate) =>
            candidate.ref === target ||
            candidate.ref === `refs/snapshots/${target}` ||
            candidate.ref.endsWith(`/${target}`) ||
            candidate.commit.startsWith(target),
        )
    if (!entry) throw new Error(`snapshot ${target} not found (have ${refs.length})`)
    const ref = entry.ref

    const safety = snapshot(root, `pre-rollback ${new Date().toISOString()}`)
    const changed = changedSince(dir, root, ref)
    git(dir, root, ['checkout', ref, '--', '.'])

    let removed = 0
    if (clean) {
      for (const entry of changed) {
        if (entry.status !== 'A') continue
        const file = join(root, entry.path)
        try {
          if (statSync(file).isFile()) {
            unlinkSync(file)
            removed += 1
          }
        } catch {
          /* already gone */
        }
      }
    }
    return { ref, changed: changed.length, removed, safety: safety.skipped ? undefined : safety.ref }
  }

  function resolveRootFor(exec, command) {
    const args = exec?.arguments ?? {}
    const cwd = toAbs(typeof args.cwd === 'string' ? args.cwd : args.workdir, undefined)
    const explicit = PATH_KEYS.map((key) => args[key]).find((value) => typeof value === 'string')

    const candidates = new Set()
    if (cwd) candidates.add(cwd)
    if (explicit) {
      const abs = toAbs(explicit, cwd ?? defaultRoot)
      if (abs) candidates.add(abs)
    }
    if (typeof command === 'string') {
      PATH_TOKEN.lastIndex = 0
      let match
      while ((match = PATH_TOKEN.exec(command)) !== null) {
        const abs = toAbs(match[1], cwd ?? defaultRoot)
        if (abs) candidates.add(abs)
      }
    }
    for (const root of roots) {
      for (const candidate of candidates) {
        if (inside(candidate, root)) return root
      }
    }
    return undefined
  }

  function autoSnapshotBefore(exec) {
    if (!autoSnapshot || roots.length === 0) return
    const args = exec?.arguments ?? {}
    const tool = exec?.name ?? ''
    const isBash = tool === 'bash'
    const isWrite = WRITE_TOOLS.has(tool)
    if (!isBash && !isWrite) return

    const command = isBash && typeof args.command === 'string' ? args.command : ''
    if (isBash && !MUTATING_BASH.test(command)) return

    const root = resolveRootFor(exec, command)
    if (!root) return
    const now = Date.now()
    const last = lastAuto.get(root) ?? 0
    const forced = isBash && DESTRUCTIVE.test(command)
    if (!forced && now - last < cooldownMs) return
    lastAuto.set(root, now)
    try {
      snapshot(root, `auto: ${tool}${command ? ` — ${command.slice(0, 80)}` : ''}`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-snapshots: automatic snapshot failed for ${root}: ${error.message}`)
    }
  }

  function renderList(root, limit) {
    const refs = listRefs(root)
    if (refs.length === 0) return `No snapshots for ${root} yet. Take one with /snap.`
    const rows = refs.slice(0, limit).map((entry, index) => {
      const when = entry.date.replace('T', ' ').replace(/\.[0-9]+/, '').slice(0, 19)
      return `${String(index + 1).padStart(2, ' ')}  ${when}  ${entry.subject}`
    })
    return [`Snapshots for ${root} (${refs.length} total):`, ...rows, '', 'Restore: /rollback <number> [--clean]'].join('\n')
  }

  ctx.effect(() => {
    const disposeGate = ctx.on('tools/pre-execute', async (exec, next) => {
      autoSnapshotBefore(exec)
      return next()
    })

    const disposeCommands = [
      ctx.commands.register({
        name: 'snap',
        description: 'Take a restore point of the project before trying something risky.',
        input: { hint: '[label]' },
        handler: ({ rawInput }) => {
          if (roots.length === 0) return { kind: 'error', text: NO_ROOTS }
          const rootsToSnap = roots
          const results = rootsToSnap.map((root) => {
            const result = snapshot(root, rawInput?.trim() || undefined)
            return result.skipped
              ? `${root}: no changes since last snapshot (${result.ref})`
              : `${root}: snapshot ${result.ref} (${result.files} files)`
          })
          return { kind: 'success', text: results.join('\n') }
        },
      }),
      ctx.commands.register({
        name: 'snapshots',
        description: 'List recent restore points.',
        input: { hint: '[count]' },
        handler: ({ rawInput }) => {
          if (roots.length === 0) return { kind: 'error', text: NO_ROOTS }
          const limit = Math.max(1, Math.min(50, Number(rawInput?.trim() || 10) || 10))
          const rootsToList = roots
          return { kind: 'success', text: rootsToList.map((root) => renderList(root, limit)).join('\n\n') }
        },
      }),
      ctx.commands.register({
        name: 'rollback',
        description: 'Restore files from a snapshot. Add --clean to delete files created after it.',
        input: { hint: '<number|ref> [--clean]' },
        handler: ({ rawInput }) => {
          const tokens = (rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const target = tokens.find((token) => !token.startsWith('--'))
          const clean = tokens.includes('--clean')
          if (roots.length === 0) return { kind: 'error', text: NO_ROOTS }
          if (!target) return { kind: 'error', text: 'Usage: /rollback <number|ref> [--clean]' }
          const rootsToRestore = roots
          const notes = []
          for (const root of rootsToRestore) {
            try {
              const result = restore(root, target, clean)
              notes.push(
                `${root}: restored ${result.changed} path(s)` +
                  (result.removed > 0 ? `, removed ${result.removed} new file(s)` : '') +
                  (result.safety ? `; safety snapshot ${result.safety}` : ''),
              )
            } catch (error) {
              notes.push(`${root}: ${error.message}`)
            }
          }
          return { kind: 'success', text: notes.join('\n') }
        },
      }),
    ]

    return () => {
      disposeGate()
      for (const dispose of disposeCommands) dispose()
    }
  })

  ctx.logger?.info?.(
    roots.length === 0
      ? `dsh-snapshots loaded but idle: no roots configured (store ${storeDir})`
      : `dsh-snapshots active: store ${storeDir}, roots ${roots.join(', ')}, keep ${keep}`,
  )
}
