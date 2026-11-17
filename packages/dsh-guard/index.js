/**
 * dsh-guard — deterministic, zero-token path guard for DeepSeek Harness.
 *
 * Registers a monotonic `ctx.tools.guard()` denial for destructive calls that touch
 * a protected path, plus a `tools/pre-execute` gate that turns history-rewriting
 * git commands into ordinary approval requests. No model calls, no network.
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
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

export const name = 'dsh-guard'
export const inject = ['tools']

/** Paths that hold credentials or Harness state; protected unless `protectSystem` is off. */
const SYSTEM_ROOTS = [
  '~/.dsh',
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/Library/Keychains',
]

/** Genuinely catastrophic commands: denied even when no path matches. */
const DEFAULT_DENY = [
  '\\brm\\s+-[A-Za-z]*(?:rf|fr)[A-Za-z]*\\s+(?:/|~|/\\*|\\$HOME)(?:\\s|$)',
  '\\bmkfs(?:\\.|\\s)',
  '\\bdd\\b[^\\n]*\\bof=/dev/(?:disk|rdisk|sd|nvme|hd)',
  '\\bchmod\\s+-R\\s+[0-7]{3,4}\\s+/(?:\\s|$)',
  '>\\s*/dev/(?:disk|rdisk|sd|nvme)',
  ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:',
]

/** Commands that rewrite history or wipe a tree: ask the human instead of denying. */
const DEFAULT_ASK = [
  '\\bgit\\s+reset\\s+--hard',
  '\\bgit\\s+clean\\s+-[A-Za-z]*[fd]',
  '\\bgit\\s+push\\b[^\\n]*--force',
  '\\bgit\\s+checkout\\s+--\\s+\\.',
  '\\bgit\\s+stash\\s+(?:drop|clear)',
  '\\brm\\s+-[A-Za-z]*r[A-Za-z]*f?\\b',
  '\\bshred\\b',
  '\\btruncate\\s+-s\\s*0',
]

/** Commands that can modify the filesystem. A read-only command is never blocked. */
const MUTATING_BASH =
  /(?:\brm\b|\brmdir\b|\bunlink\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\btruncate\b|\bshred\b|\bdd\b|\btee\b|\brsync\b|\bscp\b|\bsftp\b|\bln\b|\binstall\b|\bsed\s+(?:-i|--in-place)\b|\bperl\s+-[a-z]*i\b|\bpython3?\s+-c\b|\bnode\s+-e\b|>\s*[^\s|&]|\btouch\b|\bmkdir\b|\bgit\s+(?:reset|clean|checkout|restore|rm|stash|filter-branch)\b)/

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace_editor', 'notebook_edit'])
const PATH_KEYS = ['file_path', 'path', 'target_file', 'filePath', 'target']

const PATH_TOKEN = /(?:^|[\s"'`=(:,|;&])((?:~|\.{1,2})?\/[^\s"'`|;&<>()]+)/g

/** `/dev/null` and friends are never worth inspecting. */
const BENIGN_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

export const Config = Schema.object({
  protect: Schema.array(String)
    .default([])
    .description('Extra paths to protect, e.g. ["~/Games/MyGame", "~/Desktop/Books"]. `~` is expanded.'),
  allowWrite: Schema.array(String)
    .default([])
    .description('Protected subtrees where writes stay allowed, e.g. ["~/Games/MyGame/dist"].'),
  protectSystem: Schema.boolean()
    .default(true)
    .description('Protect ~/.dsh, ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh and Apple keychains.'),
  denyPatterns: Schema.array(String)
    .default(DEFAULT_DENY)
    .description('Regular expressions (case-insensitive) denied outright, whatever the path.'),
  askPatterns: Schema.array(String)
    .default(DEFAULT_ASK)
    .description('Regular expressions that turn a call into an approval request instead of running.'),
  auditFile: Schema.string()
    .default('~/.dsh/guard-audit.jsonl')
    .description('Append-only JSONL audit log. Empty string disables logging.'),
  caseInsensitive: Schema.boolean()
    .default(true)
    .description('Compare paths case-insensitively (macOS default); turn off on case-sensitive volumes.'),
})

/** Expand `~`, resolve relative paths, drop trailing separators. */
function toAbs(value, base) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let raw = value
  if (raw === '~') raw = homedir()
  else if (raw.startsWith('~/')) raw = homedir() + raw.slice(1)
  let abs
  if (isAbsolute(raw)) abs = normalize(raw)
  else if (base === undefined) return undefined
  else abs = resolve(base, raw)
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs
}

function makeComparer(caseInsensitive) {
  return (value) => (caseInsensitive ? value.toLowerCase() : value)
}

function inside(child, root, norm) {
  const c = norm(child)
  const r = norm(root)
  return c === r || c.startsWith(r + sep) || c.startsWith(r + '/')
}

/** Candidate absolute paths mentioned by a shell command line. */
function pathsInCommand(command, base) {
  const found = new Set()
  PATH_TOKEN.lastIndex = 0
  let match
  while ((match = PATH_TOKEN.exec(command)) !== null) {
    const token = match[1]
    if (token.length < 2) continue
    if (/^\d/.test(token)) continue
    const abs = toAbs(token, base)
    if (abs && !BENIGN_PATHS.has(abs)) found.add(abs)
  }
  return [...found]
}

/**
 * Heredoc bodies are data, not commands: a script or a document that merely quotes
 * `rm -rf ~/Notes` must not count as a destructive call.
 */
function stripHeredocs(command) {
  let terminator = null
  const kept = []
  for (const line of command.split('\n')) {
    if (terminator === null) {
      kept.push(line)
      const start = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
      if (start) terminator = start[2]
    } else if (line.trim() === terminator) {
      terminator = null
    }
  }
  return kept.join('\n')
}

/** Commands whose arguments are files they modify. */
const DESTRUCTIVE_VERB = /\b(?:rm|rmdir|unlink|mv|cp|chmod|chown|truncate|shred|dd|tee|touch|mkdir|install|rsync|scp|sftp|ln|sed|perl)\b/

/** Paths a shell command actually writes to or deletes. */
function destructiveTargets(command, base) {
  const targets = new Set()
  for (const segment of stripHeredocs(command).split(/[;&\n|]+/)) {
    const redirect = />>?\s*([^\s]+)/g
    let match
    while ((match = redirect.exec(segment)) !== null) {
      const abs = toAbs(match[1], base)
      if (abs && !BENIGN_PATHS.has(abs)) targets.add(abs)
    }
    const verb = DESTRUCTIVE_VERB.exec(segment)
    if (verb) {
      for (const path of pathsInCommand(segment.slice(verb.index), base)) targets.add(path)
    }
  }
  return [...targets]
}

function firstString(args, keys) {
  for (const key of keys) {
    const value = args?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export function apply(ctx, config = {}) {
  const norm = makeComparer(config.caseInsensitive !== false)
  const roots = [
    ...(config.protectSystem === false ? [] : SYSTEM_ROOTS),
    ...(config.protect ?? []),
  ]
    .map((entry) => toAbs(entry))
    .filter(Boolean)
  const allowedWrites = (config.allowWrite ?? []).map((entry) => toAbs(entry)).filter(Boolean)
  // Fall back to the built-in lists: apply() must behave the same when it is handed a
  // raw config object that never went through the schema defaults.
  const denyRes = (config.denyPatterns ?? DEFAULT_DENY).map((pattern) => new RegExp(pattern, 'i'))
  const askRes = (config.askPatterns ?? DEFAULT_ASK).map((pattern) => new RegExp(pattern, 'i'))
  const auditFile = config.auditFile === '' ? undefined : toAbs(config.auditFile ?? '~/.dsh/guard-audit.jsonl')

  function audit(record) {
    if (auditFile === undefined) return
    try {
      mkdirSync(dirname(auditFile), { recursive: true })
      appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
    } catch {
      /* auditing must never break a tool call */
    }
  }

  function protectHit(path) {
    return roots.find((root) => inside(path, root, norm))
  }

  function writeAllowed(path) {
    return allowedWrites.some((allowed) => inside(path, allowed, norm))
  }

  /**
   * Evaluate one tool invocation.
   * @returns {{kind: 'deny'|'ask', reason: string} | undefined}
   */
  function evaluate(exec) {
    const tool = exec?.name ?? ''
    const args = exec?.arguments ?? {}
    const toolCwd = toAbs(firstString(args, ['cwd', 'workdir']), undefined)

    if (tool === 'bash') {
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.length === 0) return undefined
      // The shell's cwd is unknowable without an explicit `cwd` argument. The host
      // process cwd is only a hint — and inside a protected root it is a misleading one,
      // so relative paths stay unresolved there instead of producing false denials.
      const hostCwd = process.cwd()
      const base = toolCwd ?? (protectHit(hostCwd) === undefined ? hostCwd : undefined)

      // Heredoc bodies are data: a document that quotes `rm -rf /` is not a command.
      const catastrophic = denyRes.find((re) => re.test(stripHeredocs(command)))
      if (catastrophic) {
        return {
          kind: 'deny',
          reason: `dsh-guard: command matches a blocked pattern (${catastrophic.source}). Nothing was executed.`,
        }
      }

      // Only paths that a destructive verb actually operates on count; a path merely
      // mentioned inside quoted text or a heredoc must not block the call.
      const targets = destructiveTargets(command, base)
      const hit = targets
        .map((path) => ({ path, root: protectHit(path) }))
        .find((entry) => entry.root !== undefined && !writeAllowed(entry.path))
      if (hit) {
        return {
          kind: 'deny',
          reason: `dsh-guard: "${hit.path}" is inside a protected path (${hit.root}). Nothing was executed. Change dsh-guard's protect/allowWrite config if this write is intentional.`,
        }
      }

      // `2>/dev/null` is a redirect, not a write: ignore it before judging the command.
      const judged = command.replace(/\d?>\s*\/dev\/(?:null|stdout|stderr|tty)/g, ' ')
      const mutating = MUTATING_BASH.test(judged)
      if (mutating && toolCwd !== undefined) {
        const cwdRoot = protectHit(toolCwd)
        if (cwdRoot !== undefined && targets.length === 0) {
          return {
            kind: 'deny',
            reason: `dsh-guard: the command modifies files inside the protected path "${cwdRoot}" (targets are relative to it). Nothing was executed.`,
          }
        }
      }

      const ask = askRes.find((re) => re.test(command))
      if (ask) {
        return {
          kind: 'ask',
          reason: `dsh-guard: this command can rewrite or delete history (${ask.source}). Approve only if you mean it.`,
        }
      }
      return undefined
    }

    if (WRITE_TOOLS.has(tool)) {
      const target = toAbs(firstString(args, PATH_KEYS), toolCwd)
      if (target === undefined) return undefined
      const root = protectHit(target)
      if (root === undefined || writeAllowed(target)) return undefined
      return {
        kind: 'deny',
        reason: `dsh-guard: "${target}" is inside a protected path (${root}). The write was refused. Add the path to dsh-guard's allowWrite config if this write is intentional.`,
      }
    }

    return undefined
  }

  ctx.effect(() => {
    const disposeGuard = ctx.tools.guard((exec) => {
      const verdict = evaluate(exec)
      if (verdict?.kind !== 'deny') return undefined
      audit({ action: 'deny', tool: exec?.name, reason: verdict.reason })
      return verdict.reason
    })

    const disposeGate = ctx.on('tools/pre-execute', async (exec, next) => {
      const verdict = evaluate(exec)
      if (verdict?.kind === 'ask') {
        audit({ action: 'ask', tool: exec?.name, reason: verdict.reason })
        return { kind: 'ask', reason: verdict.reason }
      }
      return next()
    })

    return () => {
      disposeGuard()
      disposeGate()
    }
  })

  ctx.logger?.info?.(
    `dsh-guard active: ${roots.length} protected path(s), ${denyRes.length} deny pattern(s), ${askRes.length} ask pattern(s)`,
  )
}
