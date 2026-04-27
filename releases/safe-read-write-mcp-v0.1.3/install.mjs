#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_EXTS = process.env.SAFE_RW_EXTS || '.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql'
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const targetRepo = path.resolve(process.argv[2] || process.cwd())
const vendorRelativeDir = '.claude/mcp/gbk-safe-rw-mcp'
const vendorDir = path.join(targetRepo, vendorRelativeDir)
const serverPath = vendorRelativeDir + '/dist/server.js'
const guardPath = vendorRelativeDir + '/dist/safe-rw-guard.js'

await installVendorFiles()
await writeMcpJson()
await writeClaudeSettings()

console.log('safe-read-write-mcp installed for: ' + targetRepo)
console.log('Vendored MCP files: ' + toPortablePath(vendorDir))
console.log('MCP server path in .mcp.json: ' + serverPath)
console.log('Restart Claude Code, then check /mcp for safe_rw.')

async function installVendorFiles() {
  await mkdir(path.join(vendorDir, 'dist'), { recursive: true })
  await cp(path.join(packageDir, 'dist', 'server.js'), path.join(vendorDir, 'dist', 'server.js'))
  await cp(path.join(packageDir, 'dist', 'safe-rw-guard.js'), path.join(vendorDir, 'dist', 'safe-rw-guard.js'))
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
    },
  }
  await writeJson(filePath, config)
}

async function writeClaudeSettings() {
  const claudeDir = path.join(targetRepo, '.claude')
  const filePath = path.join(claudeDir, 'settings.json')
  await mkdir(claudeDir, { recursive: true })

  const settings = await readJsonIfExists(filePath, {})
  settings.env = { ...(settings.env || {}), SAFE_RW_EXTS: SAFE_EXTS }
  settings.enabledMcpjsonServers = unique([
    ...(settings.enabledMcpjsonServers || []),
    'safe_rw',
  ])

  settings.hooks = settings.hooks || {}
  const existingPreToolUse = Array.isArray(settings.hooks.PreToolUse)
    ? settings.hooks.PreToolUse
    : []
  settings.hooks.PreToolUse = [
    ...existingPreToolUse.filter(item => !containsSafeRwGuard(item)),
    {
      matcher: 'Read|Write|Edit',
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
        'mcp__safe_rw__safe_read|mcp__safe_rw__safe_write|mcp__safe_rw__safe_edit',
      hooks: [
        {
          type: 'command',
          command: 'node ' + guardPath,
          timeout: 5,
          statusMessage: '规范化 safe read/write/edit 路径',
        },
      ],
    },
  ]

  await writeJson(filePath, settings)
}

function containsSafeRwGuard(value) {
  return JSON.stringify(value).includes('safe-rw-guard.js')
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
