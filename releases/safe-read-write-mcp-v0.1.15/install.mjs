#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_EXTS = process.env.SAFE_RW_EXTS ?? '.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql,.proto'
const SEARCH_EXCLUDE_DIRS = process.env.SAFE_RW_SEARCH_EXCLUDE_DIRS ?? '.git,.svn,.hg,.bzr,.jj,.sl,build,build64,bin,obj,out,output,dist,target,Debug,Release,x64,x86,.vs,CMakeFiles,_ReSharper.Caches'
const SEARCH_EXCLUDE_EXTS = process.env.SAFE_RW_SEARCH_EXCLUDE_EXTS ?? '.exe,.dll,.lib,.pdb,.ilk,.obj,.o,.a,.so,.dylib,.pch,.idb,.ipch,.res,.exp,.map,.class,.jar,.zip,.7z,.rar,.png,.jpg,.jpeg,.gif'
const MIRROR_CONCURRENCY = process.env.SAFE_RW_SEARCH_MIRROR_CONCURRENCY ?? '8'
const MIRROR_CACHE_MAX_FILES = process.env.SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES ?? '10000'
const LOOP_GUARD_HISTORY_LIMIT = process.env.SAFE_RW_LOOP_GUARD_HISTORY_LIMIT ?? '5'
const LOOP_GUARD_REPEAT_THRESHOLD = process.env.SAFE_RW_LOOP_GUARD_REPEAT_THRESHOLD ?? '3'
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const targetRepo = path.resolve(process.argv[2] || process.cwd())
const vendorRelativeDir = '.claude/mcp/gbk-safe-rw-mcp'
const vendorDir = path.join(targetRepo, vendorRelativeDir)
const serverPath = vendorRelativeDir + '/dist/server.js'
const guardPath = vendorRelativeDir + '/dist/safe-rw-guard.js'
const loopGuardPath = vendorRelativeDir + '/dist/tool-loop-guard.js'

await installVendorFiles()
await writeMcpJson()
await writeClaudeSettings()

console.log('safe-read-write-mcp installed for: ' + targetRepo)
console.log('Vendored MCP files: ' + toPortablePath(vendorDir))
console.log('MCP server path in .mcp.json: ' + serverPath)
console.log('Restart Claude Code, then check /mcp for safe_rw.')

async function installVendorFiles() {
  await mkdir(vendorDir, { recursive: true })
  await cp(path.join(packageDir, 'dist'), path.join(vendorDir, 'dist'), { recursive: true })
  await cp(path.join(packageDir, 'README.md'), path.join(vendorDir, 'README.md'))
  await cp(path.join(packageDir, 'VERSION'), path.join(vendorDir, 'VERSION'))
}

async function writeMcpJson() {
  const filePath = path.join(targetRepo, '.mcp.json')
  const config = await readJsonIfExists(filePath, { mcpServers: {} })
  config.mcpServers = config.mcpServers || {}
  config.mcpServers.safe_rw = {
    type: 'stdio',
    command: 'node',
    args: [serverPath],
    env: {
      SAFE_RW_EXTS: SAFE_EXTS,
      SAFE_RW_SEARCH_EXCLUDE_DIRS: SEARCH_EXCLUDE_DIRS,
      SAFE_RW_SEARCH_EXCLUDE_EXTS: SEARCH_EXCLUDE_EXTS,
      SAFE_RW_SEARCH_MIRROR_CONCURRENCY: MIRROR_CONCURRENCY,
      SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES: MIRROR_CACHE_MAX_FILES,
    },
  }
  await writeJson(filePath, config)
}

async function writeClaudeSettings() {
  const claudeDir = path.join(targetRepo, '.claude')
  const filePath = path.join(claudeDir, 'settings.json')
  await mkdir(claudeDir, { recursive: true })

  const settings = await readJsonIfExists(filePath, {})
  settings.env = {
    ...(settings.env || {}),
    SAFE_RW_EXTS: SAFE_EXTS,
    SAFE_RW_SEARCH_EXCLUDE_DIRS: SEARCH_EXCLUDE_DIRS,
    SAFE_RW_SEARCH_EXCLUDE_EXTS: SEARCH_EXCLUDE_EXTS,
    SAFE_RW_SEARCH_MIRROR_CONCURRENCY: MIRROR_CONCURRENCY,
    SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES: MIRROR_CACHE_MAX_FILES,
    SAFE_RW_LOOP_GUARD_HISTORY_LIMIT: LOOP_GUARD_HISTORY_LIMIT,
    SAFE_RW_LOOP_GUARD_REPEAT_THRESHOLD: LOOP_GUARD_REPEAT_THRESHOLD,
  }
  settings.enabledMcpjsonServers = unique([
    ...(settings.enabledMcpjsonServers || []),
    'safe_rw',
  ])

  settings.hooks = settings.hooks || {}
  const existingPreToolUse = Array.isArray(settings.hooks.PreToolUse)
    ? settings.hooks.PreToolUse
    : []
  settings.hooks.PreToolUse = [
    ...existingPreToolUse.filter(item => !containsManagedSafeRwHook(item)),
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: 'node ' + loopGuardPath,
          timeout: 5,
          statusMessage: '检查重复工具调用',
        },
      ],
    },
    {
      matcher: 'Read|Write|Edit|Grep|Search|Glob|Bash|PowerShell',
      hooks: [
        {
          type: 'command',
          command: 'node ' + guardPath,
          timeout: 5,
          statusMessage: '检查 GBK 安全读写策略',
        },
      ],
    },
    {
      matcher:
        'mcp__safe_rw__safe_read|mcp__safe_rw__safe_write|mcp__safe_rw__safe_edit|mcp__safe_rw__safe_search',
      hooks: [
        {
          type: 'command',
          command: 'node ' + guardPath,
          timeout: 5,
          statusMessage: '规范化 safe read/write/edit/search 路径',
        },
      ],
    },
  ]

  await writeJson(filePath, settings)
}

function containsManagedSafeRwHook(value) {
  const raw = JSON.stringify(value)
  return raw.includes('safe-rw-guard.js') || raw.includes('tool-loop-guard.js')
}

function unique(values) {
  return [...new Set(values)]
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function toPortablePath(value) {
  return value.replaceAll(path.sep, '/')
}
