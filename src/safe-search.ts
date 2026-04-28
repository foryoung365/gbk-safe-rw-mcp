import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFileExtension, parseSafeExts } from './config.js'
import { decodeTextBuffer } from './text-codec.js'

export type SafeSearchArgs = {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-B'?: number
  '-A'?: number
  '-C'?: number
  context?: number
  '-n'?: boolean
  '-i'?: boolean
  type?: string
  head_limit?: number
  offset?: number
  multiline?: boolean
}

type MirroredFile = {
  originalAbsolute: string
  originalRelative: string
  mirrorAbsolute: string
  mirrorPortableAbsolute: string
  mtimeMs: number
}

type Mirror = {
  root: string
  target: string
  files: MirroredFile[]
}

const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const
const VCS_DIRECTORY_SET = new Set<string>(VCS_DIRECTORIES_TO_EXCLUDE)

const IGNORE_FILENAMES = new Set(['.gitignore', '.ignore', '.rgignore'])
const DEFAULT_HEAD_LIMIT = 250
const MAX_BUFFER_SIZE = 20_000_000
const RG_TIMEOUT_MS = 20_000

const SAFE_TYPE_ADDS: Record<string, string[]> = {
  c: ['*.c', '*.h'],
  cc: ['*.cc', '*.cpp', '*.cxx', '*.h', '*.hh', '*.hpp', '*.hxx', '*.inl'],
  cpp: ['*.cc', '*.cpp', '*.cxx', '*.h', '*.hh', '*.hpp', '*.hxx', '*.inl'],
  h: ['*.h', '*.hh', '*.hpp', '*.hxx'],
  hpp: ['*.hh', '*.hpp', '*.hxx'],
  sql: ['*.sql'],
  proto: ['*.proto'],
  protobuf: ['*.proto'],
}

export async function safeSearch(args: SafeSearchArgs): Promise<string> {
  const outputMode = args.output_mode ?? 'files_with_matches'
  const workspaceRoot = path.resolve(process.cwd())
  const targetPath = path.resolve(args.path ?? workspaceRoot)
  const safeExts = parseSafeExts()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-rw-search-'))

  try {
    const mirror = await createUtf8Mirror(workspaceRoot, targetPath, safeExts, tempDir)
    if (mirror.files.length === 0) {
      return formatEmptyResult(outputMode)
    }

    const rgArgs = buildRipgrepArgs(args, outputMode)
    const rawResults = await runRipgrep(rgArgs, mirror.target)

    if (outputMode === 'content') {
      return formatContentResult(rawResults, mirror.files, args)
    }
    if (outputMode === 'count') {
      return formatCountResult(rawResults, mirror.files, args)
    }
    return formatFilesWithMatchesResult(rawResults, mirror.files, args)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function createUtf8Mirror(
  workspaceRoot: string,
  targetPath: string,
  safeExts: Set<string>,
  tempDir: string,
): Promise<Mirror> {
  const rootStat = await fs.stat(workspaceRoot)
  if (!rootStat.isDirectory()) {
    throw new Error(`Current working directory is not a directory: ${workspaceRoot}`)
  }

  const targetStat = await fs.stat(targetPath).catch(error => {
    if (isNotFoundError(error)) {
      throw new Error(`Path does not exist: ${targetPath}`)
    }
    throw error
  })

  const mirrorRoot = path.join(tempDir, 'mirror')
  await fs.mkdir(mirrorRoot, { recursive: true })
  await fs.mkdir(path.join(mirrorRoot, '.git'), { recursive: true })

  const targetDir = targetStat.isDirectory()
    ? targetPath
    : path.dirname(targetPath)
  await copyAncestorIgnoreFiles(workspaceRoot, targetDir, mirrorRoot)

  const files: MirroredFile[] = []
  if (targetStat.isFile()) {
    files.push(await mirrorFile(workspaceRoot, mirrorRoot, targetPath, targetStat.mtimeMs, safeExts))
  } else if (targetStat.isDirectory()) {
    await mirrorDirectory(workspaceRoot, mirrorRoot, targetPath, safeExts, files)
  } else {
    throw new Error(`Path is not a file or directory: ${targetPath}`)
  }

  return {
    root: mirrorRoot,
    target: toMirrorPath(workspaceRoot, mirrorRoot, targetPath),
    files,
  }
}

async function mirrorDirectory(
  workspaceRoot: string,
  mirrorRoot: string,
  dir: string,
  safeExts: Set<string>,
  files: MirroredFile[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (VCS_DIRECTORY_SET.has(entry.name)) continue
      await mirrorDirectory(workspaceRoot, mirrorRoot, absolutePath, safeExts, files)
      continue
    }

    if (!entry.isFile()) continue
    if (IGNORE_FILENAMES.has(entry.name)) {
      const stat = await fs.stat(absolutePath)
      files.push(await mirrorRawFile(workspaceRoot, mirrorRoot, absolutePath, stat.mtimeMs))
      continue
    }

    const stat = await fs.stat(absolutePath)
    files.push(await mirrorFile(workspaceRoot, mirrorRoot, absolutePath, stat.mtimeMs, safeExts))
  }
}

async function mirrorFile(
  workspaceRoot: string,
  mirrorRoot: string,
  originalAbsolute: string,
  mtimeMs: number,
  safeExts: Set<string>,
): Promise<MirroredFile> {
  if (!isSafeFile(originalAbsolute, safeExts)) {
    return mirrorRawFile(workspaceRoot, mirrorRoot, originalAbsolute, mtimeMs)
  }

  try {
    return await mirrorTextFile(workspaceRoot, mirrorRoot, originalAbsolute, mtimeMs)
  } catch {
    return mirrorRawFile(workspaceRoot, mirrorRoot, originalAbsolute, mtimeMs)
  }
}

async function mirrorTextFile(
  workspaceRoot: string,
  mirrorRoot: string,
  originalAbsolute: string,
  mtimeMs: number,
): Promise<MirroredFile> {
  const decoded = decodeTextBuffer(await fs.readFile(originalAbsolute))
  const mirrorAbsolute = toMirrorPath(workspaceRoot, mirrorRoot, originalAbsolute)
  await fs.mkdir(path.dirname(mirrorAbsolute), { recursive: true })
  await fs.writeFile(mirrorAbsolute, decoded.content, 'utf8')
  return {
    originalAbsolute,
    originalRelative: toPortableRelativePath(originalAbsolute, workspaceRoot),
    mirrorAbsolute,
    mirrorPortableAbsolute: toPortablePath(mirrorAbsolute),
    mtimeMs,
  }
}

async function copyAncestorIgnoreFiles(
  workspaceRoot: string,
  targetDir: string,
  mirrorRoot: string,
): Promise<void> {
  const relative = path.relative(workspaceRoot, targetDir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return

  const segments = relative === '' ? [] : relative.split(path.sep)
  let current = workspaceRoot
  await copyIgnoreFilesInDirectory(workspaceRoot, mirrorRoot, current)
  for (const segment of segments) {
    current = path.join(current, segment)
    await copyIgnoreFilesInDirectory(workspaceRoot, mirrorRoot, current)
  }
}

async function copyIgnoreFilesInDirectory(
  workspaceRoot: string,
  mirrorRoot: string,
  dir: string,
): Promise<void> {
  for (const name of IGNORE_FILENAMES) {
    const filePath = path.join(dir, name)
    try {
      const stat = await fs.stat(filePath)
      if (stat.isFile()) await copyRawFile(workspaceRoot, mirrorRoot, filePath)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

async function copyRawFile(
  workspaceRoot: string,
  mirrorRoot: string,
  originalAbsolute: string,
): Promise<void> {
  const mirrorAbsolute = toMirrorPath(workspaceRoot, mirrorRoot, originalAbsolute)
  await fs.mkdir(path.dirname(mirrorAbsolute), { recursive: true })
  await fs.copyFile(originalAbsolute, mirrorAbsolute)
}

async function mirrorRawFile(
  workspaceRoot: string,
  mirrorRoot: string,
  originalAbsolute: string,
  mtimeMs: number,
): Promise<MirroredFile> {
  await copyRawFile(workspaceRoot, mirrorRoot, originalAbsolute)
  const mirrorAbsolute = toMirrorPath(workspaceRoot, mirrorRoot, originalAbsolute)
  return {
    originalAbsolute,
    originalRelative: toPortableRelativePath(originalAbsolute, workspaceRoot),
    mirrorAbsolute,
    mirrorPortableAbsolute: toPortablePath(mirrorAbsolute),
    mtimeMs,
  }
}

function buildRipgrepArgs(
  args: SafeSearchArgs,
  outputMode: 'content' | 'files_with_matches' | 'count',
): string[] {
  const rgArgs = ['--hidden']

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    rgArgs.push('--glob', `!${dir}`)
  }

  rgArgs.push('--max-columns', '500')
  for (const [type, globs] of Object.entries(SAFE_TYPE_ADDS)) {
    for (const glob of globs) {
      rgArgs.push('--type-add', `${type}:${glob}`)
    }
  }

  if (args.multiline) {
    rgArgs.push('-U', '--multiline-dotall')
  }
  if (args['-i']) {
    rgArgs.push('-i')
  }
  if (outputMode === 'files_with_matches') {
    rgArgs.push('-l')
  } else if (outputMode === 'count') {
    rgArgs.push('-c')
  }
  if ((args['-n'] ?? true) && outputMode === 'content') {
    rgArgs.push('-n')
  }

  if (outputMode === 'content') {
    if (args.context !== undefined) {
      rgArgs.push('-C', String(args.context))
    } else if (args['-C'] !== undefined) {
      rgArgs.push('-C', String(args['-C']))
    } else {
      if (args['-B'] !== undefined) rgArgs.push('-B', String(args['-B']))
      if (args['-A'] !== undefined) rgArgs.push('-A', String(args['-A']))
    }
  }

  if (args.pattern.startsWith('-')) {
    rgArgs.push('-e', args.pattern)
  } else {
    rgArgs.push(args.pattern)
  }

  if (args.type) {
    rgArgs.push('--type', args.type === 'c++' ? 'cpp' : args.type)
  }

  if (args.glob) {
    for (const globPattern of splitGlobPatterns(args.glob)) {
      rgArgs.push('--glob', globPattern)
    }
  }

  return rgArgs
}

async function runRipgrep(args: string[], target: string): Promise<string[]> {
  const { command, args: baseArgs } = await resolveRipgrepCommand()
  const fullArgs = [...baseArgs, ...args, target]
  return new Promise((resolve, reject) => {
    execFile(
      command,
      fullArgs,
      {
        maxBuffer: MAX_BUFFER_SIZE,
        timeout: RG_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = splitRipgrepOutput(stdout)
        if (!error) {
          resolve(output)
          return
        }

        const code = (error as { code?: string | number }).code
        if (code === 1) {
          resolve([])
          return
        }

        if (output.length > 0 && code !== 2) {
          resolve(output)
          return
        }

        const detail = stderr.trim() || error.message
        reject(new Error(`ripgrep failed: ${detail}`))
      },
    )
  })
}

async function resolveRipgrepCommand(): Promise<{ command: string; args: string[] }> {
  const configured = process.env.SAFE_RW_RG_PATH
  if (configured) {
    await assertExecutable(configured)
    return {
      command: configured,
      args: parseExtraRipgrepArgs(process.env.SAFE_RW_RG_ARGS),
    }
  }

  const bundled = bundledRipgrepPath()
  if (bundled) return { command: bundled, args: [] }

  return { command: 'rg', args: [] }
}

function parseExtraRipgrepArgs(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed
    }
  } catch {
    // Fall through to whitespace splitting for simple local test wrappers.
  }
  return raw.split(/\s+/).filter(Boolean)
}

function bundledRipgrepPath(): string | null {
  const platform =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux'
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'vendor',
    'ripgrep',
    platform,
    process.arch,
    executable,
  )
  return fileExistsSync(candidate) ? candidate : null
}

async function assertExecutable(filePath: string): Promise<void> {
  try {
    await fs.access(filePath)
  } catch {
    throw new Error(`SAFE_RW_RG_PATH does not exist or is not accessible: ${filePath}`)
  }
}

function formatContentResult(
  rawResults: string[],
  files: MirroredFile[],
  args: SafeSearchArgs,
): string {
  const { items, appliedLimit } = applyHeadLimit(
    rawResults,
    args.head_limit,
    args.offset ?? 0,
  )
  const finalLines = items.map(line => mapRipgrepLine(line, files))
  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  const resultContent = finalLines.join('\n') || 'No matches found'
  return limitInfo
    ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
    : resultContent
}

function formatCountResult(
  rawResults: string[],
  files: MirroredFile[],
  args: SafeSearchArgs,
): string {
  const { items, appliedLimit } = applyHeadLimit(
    rawResults,
    args.head_limit,
    args.offset ?? 0,
  )
  const finalCountLines = items.map(line => mapRipgrepLine(line, files))
  let totalMatches = 0
  let fileCount = 0
  for (const line of finalCountLines) {
    const colonIndex = line.lastIndexOf(':')
    if (colonIndex <= 0) continue
    const count = Number.parseInt(line.substring(colonIndex + 1), 10)
    if (!Number.isNaN(count)) {
      totalMatches += count
      fileCount += 1
    }
  }

  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  const rawContent = finalCountLines.join('\n') || 'No matches found'
  const summary =
    `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} ` +
    `across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.` +
    `${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
  return rawContent + summary
}

function formatFilesWithMatchesResult(
  rawResults: string[],
  files: MirroredFile[],
  args: SafeSearchArgs,
): string {
  const matched = rawResults
    .map(line => findFileForRipgrepPath(line, files))
    .filter((file): file is MirroredFile => file !== undefined)
  const uniqueByPath = new Map<string, MirroredFile>()
  for (const file of matched) {
    uniqueByPath.set(file.mirrorAbsolute, file)
  }

  const sorted = [...uniqueByPath.values()]
    .sort((a, b) => {
      const timeComparison = b.mtimeMs - a.mtimeMs
      return timeComparison === 0
        ? a.originalRelative.localeCompare(b.originalRelative)
        : timeComparison
    })
    .map(file => file.originalRelative)

  const { items, appliedLimit } = applyHeadLimit(
    sorted,
    args.head_limit,
    args.offset ?? 0,
  )
  if (items.length === 0) return 'No files found'

  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  return `Found ${items.length} ${items.length === 1 ? 'file' : 'files'}${limitInfo ? ` ${limitInfo}` : ''}\n${items.join('\n')}`
}

function formatEmptyResult(
  outputMode: 'content' | 'files_with_matches' | 'count',
): string {
  if (outputMode === 'files_with_matches') return 'No files found'
  if (outputMode === 'count') {
    return 'No matches found\n\nFound 0 total occurrences across 0 files.'
  }
  return 'No matches found'
}

function mapRipgrepLine(line: string, files: MirroredFile[]): string {
  const file = findFileForRipgrepPath(line, files)
  if (!file) return line

  if (line === file.mirrorAbsolute || line === file.mirrorPortableAbsolute) {
    return file.originalRelative
  }
  if (line.startsWith(`${file.mirrorAbsolute}:`)) {
    return `${file.originalRelative}${line.slice(file.mirrorAbsolute.length)}`
  }
  if (line.startsWith(`${file.mirrorAbsolute}-`)) {
    return `${file.originalRelative}${line.slice(file.mirrorAbsolute.length)}`
  }
  if (line.startsWith(`${file.mirrorPortableAbsolute}:`)) {
    return `${file.originalRelative}${line.slice(file.mirrorPortableAbsolute.length)}`
  }
  if (line.startsWith(`${file.mirrorPortableAbsolute}-`)) {
    return `${file.originalRelative}${line.slice(file.mirrorPortableAbsolute.length)}`
  }
  return line
}

function findFileForRipgrepPath(
  line: string,
  files: MirroredFile[],
): MirroredFile | undefined {
  return files.find(file =>
    line === file.mirrorAbsolute ||
    line === file.mirrorPortableAbsolute ||
    line.startsWith(`${file.mirrorAbsolute}:`) ||
    line.startsWith(`${file.mirrorAbsolute}-`) ||
    line.startsWith(`${file.mirrorPortableAbsolute}:`) ||
    line.startsWith(`${file.mirrorPortableAbsolute}-`),
  )
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  return {
    items: items.slice(offset, offset + effectiveLimit),
    appliedLimit: items.length - offset > effectiveLimit ? effectiveLimit : undefined,
  }
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  offset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (offset) parts.push(`offset: ${offset}`)
  return parts.join(', ')
}

function splitRipgrepOutput(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(Boolean)
}

function splitGlobPatterns(glob: string): string[] {
  const patterns: string[] = []
  for (const rawPattern of glob.split(/\s+/)) {
    if (!rawPattern) continue
    if (rawPattern.includes('{') && rawPattern.includes('}')) {
      patterns.push(rawPattern)
    } else {
      patterns.push(...rawPattern.split(',').filter(Boolean))
    }
  }
  return patterns
}

function isSafeFile(filePath: string, safeExts: Set<string>): boolean {
  return safeExts.has(getFileExtension(filePath))
}

function toMirrorPath(
  workspaceRoot: string,
  mirrorRoot: string,
  originalAbsolute: string,
): string {
  const relative = path.relative(workspaceRoot, originalAbsolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the current workspace: ${originalAbsolute}`)
  }
  return path.join(mirrorRoot, relative)
}

function toPortableRelativePath(filePath: string, root: string): string {
  const relative = path.relative(root, filePath)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return toPortablePath(relative)
  }
  return toPortablePath(filePath)
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function fileExistsSync(filePath: string): boolean {
  return existsSync(filePath)
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
