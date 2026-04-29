#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseSafeExts, isSafeExtension } from './config.js'
import { resolveHookPathInsideCwd } from './path-utils.js'

type HookInput = {
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: {
    command?: unknown
    file_path?: unknown
    path?: unknown
    [key: string]: unknown
  }
}

const BUILTIN_FILE_TOOLS = new Set(['Read', 'Write', 'Edit'])
const BUILTIN_SEARCH_TOOLS = new Set(['Grep', 'Search', 'Glob'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CONTENT_SEARCH_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ripgrep',
  'ag',
  'ack',
  'ugrep',
  'findstr',
  'select-string',
  'sls',
])
const FILE_SEARCH_COMMANDS = new Set(['find', 'fd', 'fdfind', 'bfs'])
const POWERSHELL_GLOB_COMMANDS = new Set([
  'get-childitem',
  'gci',
  'dir',
])
const SHELL_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'time',
  'builtin',
  'nice',
  'nohup',
])
const SAFE_READ_TOOL_NAMES = new Set([
  'mcp__safe_rw__safe_read',
  'safe_read',
])
const SAFE_WRITE_TOOL_NAMES = new Set([
  'mcp__safe_rw__safe_write',
  'safe_write',
])
const SAFE_EDIT_TOOL_NAMES = new Set([
  'mcp__safe_rw__safe_edit',
  'safe_edit',
])
const SAFE_SEARCH_TOOL_NAMES = new Set([
  'mcp__safe_rw__safe_search',
  'safe_search',
])

function main(): void {
  const input = readHookInput()
  if (input.hook_event_name !== 'PreToolUse') return

  const toolName = input.tool_name ?? ''
  const toolInput = input.tool_input ?? {}

  const safeExts = parseSafeExts()
  const filePath = toolInput.file_path

  if (BUILTIN_FILE_TOOLS.has(toolName)) {
    if (typeof filePath !== 'string' || filePath.length === 0) return
    if (isSafeExtension(filePath, safeExts)) {
      deny(
        `Files with this extension must use safe GBK-aware tools. Use ${getSafeToolName(toolName)} instead: ${filePath}`,
      )
    }
    return
  }

  if (BUILTIN_SEARCH_TOOLS.has(toolName)) {
    deny(
      'Built-in Search/Grep/Glob is disabled in this repository. Use mcp__safe_rw__safe_search for searches.',
    )
    return
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput.command
    if (typeof command !== 'string' || command.trim().length === 0) return
    const detected = detectShellSearch(command)
    if (detected) {
      deny(
        `Shell search command "${detected}" is disabled in this repository. Use mcp__safe_rw__safe_search instead.`,
      )
    }
    return
  }

  if (isSafeFileToolName(toolName)) {
    if (typeof filePath !== 'string' || filePath.length === 0) return
    if (!isSafeExtension(filePath, safeExts)) {
      deny(
        `safe_read/safe_write/safe_edit only handle configured GBK-safe extensions. Use built-in Read/Write/Edit for this file: ${filePath}`,
      )
      return
    }

    try {
      const cwd = input.cwd ?? process.cwd()
      const absolutePath = resolveHookPathInsideCwd(cwd, filePath)
      updateInput({ ...input.tool_input, file_path: absolutePath })
    } catch (error) {
      deny(error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (isSafeSearchToolName(toolName)) {
    if (typeof toolInput.path !== 'string' || toolInput.path.length === 0) return

    try {
      const cwd = input.cwd ?? process.cwd()
      const absolutePath = resolveHookPathInsideCwd(cwd, toolInput.path)
      updateInput({ ...toolInput, path: absolutePath })
    } catch (error) {
      deny(error instanceof Error ? error.message : String(error))
    }
  }
}

function isSafeFileToolName(toolName: string): boolean {
  return (
    SAFE_READ_TOOL_NAMES.has(toolName) ||
    SAFE_WRITE_TOOL_NAMES.has(toolName) ||
    SAFE_EDIT_TOOL_NAMES.has(toolName)
  )
}

function isSafeSearchToolName(toolName: string): boolean {
  return SAFE_SEARCH_TOOL_NAMES.has(toolName)
}

function getSafeToolName(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return 'mcp__safe_rw__safe_read'
    case 'Write':
      return 'mcp__safe_rw__safe_write'
    case 'Edit':
      return 'mcp__safe_rw__safe_edit'
    default:
      return 'the corresponding safe tool'
  }
}

type ShellToken = {
  value: string
  quoted: boolean
}

function detectShellSearch(command: string): string | undefined {
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShellSegment(segment)
    if (tokens.length === 0) continue

    const commandName = getShellCommandName(tokens)
    if (!commandName) continue

    if (CONTENT_SEARCH_COMMANDS.has(commandName)) return commandName
    if (FILE_SEARCH_COMMANDS.has(commandName)) return commandName
    if (isGitGrep(commandName, tokens)) return 'git grep'
    if (isPowerShellRecursiveGlob(commandName, tokens)) return commandName
    if (containsExecutableSearchToken(commandName, tokens)) {
      return 'search command'
    }
    if (tokens.some(token => isRecursiveGlobToken(token.value))) {
      return 'recursive glob'
    }
  }
  return undefined
}

function splitShellSegments(command: string): string[] {
  return command
    .replace(/\r?\n/g, ';')
    .split(/&&|\|\||[;|]/)
    .map(segment => segment.trim())
    .filter(Boolean)
}

function tokenizeShellSegment(segment: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|[^\s()<>]+/g
  for (const match of segment.matchAll(tokenPattern)) {
    const raw = match[0]
    const quoted = raw.startsWith('"') || raw.startsWith("'")
    tokens.push({
      value: quoted ? raw.slice(1, -1) : raw,
      quoted,
    })
  }
  return tokens
}

function getShellCommandName(tokens: ShellToken[]): string | undefined {
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]!.value
    const name = normalizeCommandToken(token)
    if (!name || isEnvAssignment(token)) {
      index++
      continue
    }

    if (SHELL_WRAPPERS.has(name)) {
      index++
      while (index < tokens.length) {
        const next = tokens[index]!.value
        if (isEnvAssignment(next) || next.startsWith('-')) {
          index++
          continue
        }
        break
      }
      continue
    }

    return name
  }

  return undefined
}

function containsExecutableSearchToken(
  commandName: string,
  tokens: ShellToken[],
): boolean {
  if (commandName === 'echo' || commandName === 'printf') return false

  return tokens.some(token => {
    if (token.quoted) return false
    const name = normalizeCommandToken(token.value)
    return (
      CONTENT_SEARCH_COMMANDS.has(name) ||
      FILE_SEARCH_COMMANDS.has(name)
    )
  })
}

function isGitGrep(commandName: string, tokens: ShellToken[]): boolean {
  return (
    commandName === 'git' &&
    tokens.some(token => normalizeCommandToken(token.value) === 'grep')
  )
}

function isPowerShellRecursiveGlob(
  commandName: string,
  tokens: ShellToken[],
): boolean {
  if (!POWERSHELL_GLOB_COMMANDS.has(commandName)) return false
  return tokens.some(token => {
    const lower = token.value.toLowerCase()
    return (
      lower === '-recurse' ||
      lower === '-r' ||
      lower === '-filter' ||
      lower === '-include' ||
      lower === '-exclude'
    )
  })
}

function isRecursiveGlobToken(value: string): boolean {
  return value.includes('**/') || value.includes('**\\')
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}

function normalizeCommandToken(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '')
  if (!trimmed || trimmed.startsWith('-')) return ''

  const base = trimmed.split(/[\\/]/).pop() ?? trimmed
  return base
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()
}

function readHookInput(): HookInput {
  const raw = readFileSync(0, 'utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw) as HookInput
}

function deny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

function updateInput(updatedInput: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput,
      },
    }),
  )
}

main()
