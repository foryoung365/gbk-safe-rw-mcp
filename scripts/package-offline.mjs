import {
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  readdir,
} from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'safe-read-write-mcp'
const SAFE_EXTS = '.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(root, 'package.json')
const packageLockPath = path.join(root, 'package-lock.json')
const releasesDir = path.join(root, 'releases')
let crcTable

const packageJson = await readJson(packageJsonPath)
const nextVersion = incrementPatchVersion(packageJson.version)
packageJson.version = nextVersion
await writeJson(packageJsonPath, packageJson)

const packageLock = await readJson(packageLockPath)
packageLock.version = nextVersion
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = nextVersion
}
await writeJson(packageLockPath, packageLock)

run('npm', ['run', 'build'])

const releaseName = `${PACKAGE_NAME}-v${nextVersion}`
const releaseDir = path.join(releasesDir, releaseName)
const archivePath = path.join(releasesDir, `${releaseName}.zip`)

await rm(releaseDir, { recursive: true, force: true })
await rm(archivePath, { force: true })
await mkdir(path.join(releaseDir, 'dist'), { recursive: true })

await cp(path.join(root, 'dist', 'server.js'), path.join(releaseDir, 'dist', 'server.js'))
await cp(
  path.join(root, 'dist', 'safe-rw-guard.js'),
  path.join(releaseDir, 'dist', 'safe-rw-guard.js'),
)
await writeFile(path.join(releaseDir, 'VERSION'), `${nextVersion}\n`, 'utf8')
await writeFile(path.join(releaseDir, 'install.mjs'), installScript(), 'utf8')
await writeFile(path.join(releaseDir, 'README.md'), releaseReadme(nextVersion), 'utf8')

await createZipFromDirectory(releaseDir, archivePath, releaseName)

console.log(`Offline package created: ${archivePath}`)
console.log(`Release directory: ${releaseDir}`)
console.log(`Version: ${nextVersion}`)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function incrementPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Version must be in x.y.z format: ${version}`)
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function installScript() {
  return String.raw`#!/usr/bin/env node
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
`
}

function releaseReadme(version) {
  return `# Safe Read/Write/Edit MCP 离线安装包

版本：${version}

本发布包用于在 Claude Code 中安全处理 GBK 编码的遗留 C/C++ 与 SQL 文本文件。运行时不需要安装 npm 依赖，也不需要携带 \`node_modules\`；离线机器只需要安装 Node.js。

## 包内容

\`\`\`text
dist/server.js
dist/safe-rw-guard.js
install.mjs
README.md
VERSION
\`\`\`

## 安装方式

1. 将本目录解压或复制到离线机器任意位置，例如：

\`\`\`text
D:/tools/safe-read-write-mcp-v${version}
\`\`\`

2. 在需要启用该 MCP 的仓库根目录执行：

\`\`\`bash
node D:/tools/safe-read-write-mcp-v${version}/install.mjs .
\`\`\`

也可以显式指定目标仓库：

\`\`\`bash
node D:/tools/safe-read-write-mcp-v${version}/install.mjs D:/your/repo
\`\`\`

安装脚本会把 MCP 运行文件复制到目标仓库内，并写入或更新：

- \`.mcp.json\`
- \`.claude/settings.json\`
- \`.claude/mcp/gbk-safe-rw-mcp/\`

配置中使用仓库相对路径，例如：

\`\`\`text
.claude/mcp/gbk-safe-rw-mcp/dist/server.js
.claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js
\`\`\`

因此这些配置文件可以提交到团队仓库，成员之间不会因个人绝对路径不同产生冲突。

3. 团队成员拉取仓库后，应从仓库根目录启动 Claude Code：

\`\`\`bash
cd D:/your/repo
claude
\`\`\`

然后在 \`/mcp\` 中确认 \`safe_rw\` 已启用。如界面要求批准项目 MCP，请批准 \`safe_rw\`。

## 工具名称

Claude Code 中会暴露以下 MCP 工具：

\`\`\`text
mcp__safe_rw__safe_read
mcp__safe_rw__safe_write
mcp__safe_rw__safe_edit
\`\`\`

## 默认受保护后缀

\`\`\`text
${SAFE_EXTS}
\`\`\`

如需覆盖后缀，可在运行安装脚本前设置环境变量 \`SAFE_RW_EXTS\`。

## 注意事项

- 受保护后缀文件必须使用 safe 工具，不要使用内置 \`Read\` / \`Write\` / \`Edit\`。
- \`safe_write\` 是完整覆盖写入；已有文件写入前必须先完整 \`safe_read\`。
- \`safe_edit\` 是精确字符串替换；已有非空文件编辑前必须先 \`safe_read\`，但可以是局部读取。
- 如果需要升级 MCP 版本，请用新发布包重新执行 \`install.mjs\`，然后提交更新后的 \`.claude/mcp/gbk-safe-rw-mcp/\`、\`.mcp.json\` 与 \`.claude/settings.json\`。
`
}

async function createZipFromDirectory(sourceDir, targetZip, rootName) {
  const files = await listFiles(sourceDir)
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const filePath of files) {
    const relative = toZipPath(path.relative(sourceDir, filePath))
    const zipName = `${rootName}/${relative}`
    const nameBuffer = Buffer.from(zipName, 'utf8')
    const data = await readFile(filePath)
    const crc = crc32(data)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuffer, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuffer)

    offset += localHeader.length + nameBuffer.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const centralOffset = offset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  await mkdir(path.dirname(targetZip), { recursive: true })
  await writeFile(targetZip, Buffer.concat([...localParts, ...centralParts, end]))
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await listFiles(entryPath)))
    } else if (entry.isFile()) {
      await stat(entryPath)
      result.push(entryPath)
    }
  }
  return result.sort()
}

function toZipPath(value) {
  return value.split(path.sep).join('/')
}

function crc32(buffer) {
  crcTable ??= makeCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeCrcTable() {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[i] = crc >>> 0
  }
  return table
}
