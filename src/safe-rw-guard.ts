#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseSafeExts, isSafeExtension } from './config.js'
import { resolveHookPathInsideCwd } from './path-utils.js'

type HookInput = {
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: {
    file_path?: unknown
    path?: unknown
    [key: string]: unknown
  }
}

const BUILTIN_FILE_TOOLS = new Set(['Read', 'Write', 'Edit'])
const BUILTIN_SEARCH_TOOLS = new Set(['Grep', 'Search'])
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
      'Built-in Search/Grep is disabled in this repository. Use mcp__safe_rw__safe_search for all content searches.',
    )
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
