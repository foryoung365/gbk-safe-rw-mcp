import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getFileExtension,
  parseSafeExts,
  parseSearchExcludeDirs,
  parseSearchExcludeExts,
  parseSearchMirrorCacheMaxFiles,
  parseSearchMirrorConcurrency,
} from './config.js'
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

type SearchMode = NonNullable<SafeSearchArgs['output_mode']>

type CandidateFile = {
  originalAbsolute: string
  originalRelative: string
  originalPortableAbsolute: string
}

type SearchableFile = CandidateFile & {
  searchAbsolute: string
  searchPortableAbsolute: string
  mtimeMs?: number
}

type SearchFileIndex = {
  byPath: Map<string, SearchableFile>
  fallbackFiles: SearchableFile[]
}

type Mirror = {
  files: SearchableFile[]
  tempDir?: string
}

type MappedContentLine = {
  text: string
  sortPath: string
  sortLine: number
  order: number
}

type CountEntry = {
  text: string
  count: number
  sortPath: string
  order: number
}

const DEFAULT_HEAD_LIMIT = 250
const MAX_BUFFER_SIZE = 20_000_000
const RG_TIMEOUT_MS = 20_000
const TARGET_ARGS_MAX_CHARS = 24_000
const UNPARSED_SORT_PATH = '~~~~'
const UNPARSED_SORT_LINE = Number.MAX_SAFE_INTEGER

const SAFE_TYPE_ADDS: Record<string, string[]> = {
  c: ['*.c', '*.h'],
  cc: ['*.cc', '*.cpp', '*.cxx', '*.h', '*.hh', '*.hpp', '*.hxx', '*.inl'],
  cpp: ['*.cc', '*.cpp', '*.cxx', '*.h', '*.hh', '*.hpp', '*.hxx', '*.inl'],
  h: ['*.h', '*.hh', '*.hpp', '*.hxx'],
  hpp: ['*.hh', '*.hpp', '*.hxx'],
  sql: ['*.sql'],
  proto: ['*.proto'],
  protobuf: ['*.proto'],
  patch: ['*.patch', '*.diff'],
  diff: ['*.diff', '*.patch'],
}

const KNOWN_NON_SAFE_TYPES = new Set([
  'js',
  'ts',
  'tsx',
  'jsx',
  'json',
  'jsonl',
  'py',
  'rust',
  'go',
  'java',
  'kotlin',
  'scala',
  'swift',
  'ruby',
  'php',
  'perl',
  'lua',
  'dart',
  'elixir',
  'erlang',
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'xml',
  'yaml',
  'yml',
  'toml',
  'md',
  'markdown',
  'sh',
  'bash',
  'zsh',
  'fish',
  'powershell',
  'ps1',
  'docker',
  'make',
  'cmake',
])

type MirrorCacheEntry = {
  key: string
  searchFile: SearchableFile
  lastUsed: number
}

let mirrorCacheRoot: string | undefined
let mirrorCacheRootPromise: Promise<string> | undefined
let mirrorCacheCleanupRegistered = false
const mirrorCache = new Map<string, MirrorCacheEntry>()
const mirrorCacheInFlight = new Map<string, Promise<SearchableFile>>()

export async function safeSearch(args: SafeSearchArgs): Promise<string> {
  const outputMode = args.output_mode ?? 'files_with_matches'
  const workspaceRoot = path.resolve(process.cwd())
  const targetPath = path.resolve(args.path ?? workspaceRoot)
  const targetStat = await statSearchTarget(workspaceRoot, targetPath)
  const safeExts = parseSafeExts()
  const excludeDirs = parseSearchExcludeDirs()
  const excludeExts = parseSearchExcludeExts()
  const mirrorConcurrency = parseSearchMirrorConcurrency()
  const mirrorCacheMaxFiles = parseSearchMirrorCacheMaxFiles()

  if (
    canUseSingleNonSafeFileFastPath(
      workspaceRoot,
      targetPath,
      targetStat.isFile(),
      safeExts,
      excludeDirs,
      excludeExts,
    ) ||
    canUseNonSafeFilterFastPath(args, targetPath, targetStat.isFile(), safeExts)
  ) {
    return await searchOriginalFastPath({
      args,
      outputMode,
      workspaceRoot,
      targetPath,
      excludeDirs,
      excludeExts,
    })
  }

  const candidates = await listCandidateFiles({
    args,
    workspaceRoot,
    targetPath,
    targetIsDirectory: targetStat.isDirectory(),
    excludeDirs,
    excludeExts,
  })

  if (candidates.length === 0) return formatEmptyResult(outputMode)

  const safeCandidates = candidates.filter(file =>
    isSafeFile(file.originalAbsolute, safeExts),
  )
  const nonSafeCandidates = candidates.filter(
    file => !isSafeFile(file.originalAbsolute, safeExts),
  )

  let tempDir: string | undefined

  try {
    const matchedFiles: SearchableFile[] = []
    const contentLines: MappedContentLine[] = []
    const countEntries: CountEntry[] = []
    let order = 0

    if (safeCandidates.length > 0) {
      const mirror = await createUtf8Mirror(
        workspaceRoot,
        safeCandidates,
        mirrorConcurrency,
        mirrorCacheMaxFiles,
      )
      tempDir = mirror.tempDir
      const rawResults = await runRipgrepForTargetBatches(
        buildRipgrepSearchArgs(args, outputMode),
        mirror.files.map(file => file.searchAbsolute),
      )
      const mapped = mapRawResults(rawResults, mirror.files, outputMode, order)
      matchedFiles.push(...mapped.files)
      contentLines.push(...mapped.content)
      countEntries.push(...mapped.counts)
      order += rawResults.length
    }

    if (nonSafeCandidates.length > 0) {
      const nonSafeFiles = nonSafeCandidates.map(toOriginalSearchableFile)
      const rawResults = await runRipgrepForTargetBatches(
        buildRipgrepSearchArgs(args, outputMode),
        nonSafeFiles.map(file => file.originalAbsolute),
      )
      const mapped = mapRawResults(rawResults, nonSafeFiles, outputMode, order)
      matchedFiles.push(...mapped.files)
      contentLines.push(...mapped.content)
      countEntries.push(...mapped.counts)
    }

    if (outputMode === 'content') {
      return formatContentResult(contentLines, args)
    }
    if (outputMode === 'count') {
      return formatCountResult(countEntries, args)
    }
    return await formatFilesWithMatchesResult(matchedFiles, args)
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function statSearchTarget(
  workspaceRoot: string,
  targetPath: string,
): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  const rootStat = await fs.stat(workspaceRoot)
  if (!rootStat.isDirectory()) {
    throw new Error(`Current working directory is not a directory: ${workspaceRoot}`)
  }
  assertPathInsideWorkspace(workspaceRoot, targetPath)

  const targetStat = await fs.stat(targetPath).catch(error => {
    if (isNotFoundError(error)) {
      throw new Error(`Path does not exist: ${targetPath}`)
    }
    throw error
  })

  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new Error(`Path is not a file or directory: ${targetPath}`)
  }
  return targetStat
}

async function searchOriginalFastPath({
  args,
  outputMode,
  workspaceRoot,
  targetPath,
  excludeDirs,
  excludeExts,
}: {
  args: SafeSearchArgs
  outputMode: SearchMode
  workspaceRoot: string
  targetPath: string
  excludeDirs: string[]
  excludeExts: Set<string>
}): Promise<string> {
  const excludeDirSet = new Set(excludeDirs.map(dir => dir.toLowerCase()))
  const targetStat = await fs.stat(targetPath)
  if (
    targetStat.isFile() &&
    isExcludedByConfig(targetPath, workspaceRoot, excludeDirSet, excludeExts)
  ) {
    return formatEmptyResult(outputMode)
  }

  const rawResults = await runRipgrep(
    buildRipgrepSearchArgs(args, outputMode, { excludeDirs, excludeExts }),
    targetPath,
  )
  const mapped = mapOriginalRawResults(rawResults, outputMode, workspaceRoot, 0)

  if (outputMode === 'content') return formatContentResult(mapped.content, args)
  if (outputMode === 'count') return formatCountResult(mapped.counts, args)
  return await formatFilesWithMatchesResult(mapped.files, args)
}

function canUseSingleNonSafeFileFastPath(
  workspaceRoot: string,
  targetPath: string,
  targetIsFile: boolean,
  safeExts: Set<string>,
  excludeDirs: string[],
  excludeExts: Set<string>,
): boolean {
  if (!targetIsFile) return false
  if (!isPathInside(workspaceRoot, targetPath)) return false
  if (isSafeFile(targetPath, safeExts)) return false

  const excludeDirSet = new Set(excludeDirs.map(dir => dir.toLowerCase()))
  return !isExcludedByConfig(targetPath, workspaceRoot, excludeDirSet, excludeExts)
}

function canUseNonSafeFilterFastPath(
  args: SafeSearchArgs,
  targetPath: string,
  targetIsFile: boolean,
  safeExts: Set<string>,
): boolean {
  if (targetIsFile && isSafeFile(targetPath, safeExts)) return false

  if (args.type) {
    if (isKnownNonSafeType(args.type)) return true
    return false
  }

  return args.glob !== undefined && globOnlyMatchesNonSafeExts(args.glob, safeExts)
}

function isKnownNonSafeType(type: string): boolean {
  const normalized = normalizeRipgrepType(type)
  return !SAFE_TYPE_ADDS[normalized] && KNOWN_NON_SAFE_TYPES.has(normalized)
}

function globOnlyMatchesNonSafeExts(glob: string, safeExts: Set<string>): boolean {
  let sawPositivePattern = false

  for (const pattern of splitGlobPatterns(glob)) {
    const trimmed = pattern.trim()
    if (!trimmed || trimmed.startsWith('!')) continue
    sawPositivePattern = true

    const exts = extractGlobExtensions(trimmed)
    if (exts.size === 0) return false
    for (const ext of exts) {
      if (safeExts.has(ext)) return false
    }
  }

  return sawPositivePattern
}

function extractGlobExtensions(pattern: string): Set<string> {
  const exts = new Set<string>()
  const braceMatches = pattern.matchAll(/\.\{([^}]+)\}/g)
  for (const match of braceMatches) {
    const values = match[1]!.split(',')
    for (const value of values) {
      const normalized = normalizeExtension(value)
      if (normalized) exts.add(normalized)
    }
  }
  if (exts.size > 0) return exts

  const plain = pattern.replace(/\.\{[^}]+\}/g, '')
  const matches = [...plain.matchAll(/\.([A-Za-z0-9_+-]+)/g)]
  const last = matches.at(-1)?.[1]
  const normalized = last ? normalizeExtension(last) : ''
  if (normalized) exts.add(normalized)
  return exts
}

function normalizeExtension(value: string): string {
  const clean = value.trim().replace(/[^A-Za-z0-9_+-].*$/, '').toLowerCase()
  if (!clean) return ''
  return clean.startsWith('.') ? clean : `.${clean}`
}

async function listCandidateFiles({
  args,
  workspaceRoot,
  targetPath,
  targetIsDirectory,
  excludeDirs,
  excludeExts,
}: {
  args: SafeSearchArgs
  workspaceRoot: string
  targetPath: string
  targetIsDirectory: boolean
  excludeDirs: string[]
  excludeExts: Set<string>
}): Promise<CandidateFile[]> {
  const rawFiles = await runRipgrep(
    buildRipgrepFileArgs(args, excludeDirs, excludeExts),
    targetPath,
  )
  const byPath = new Map<string, CandidateFile>()
  const excludeDirSet = new Set(excludeDirs.map(dir => dir.toLowerCase()))

  for (const rawFile of rawFiles) {
    const absolutePath = resolveRipgrepFilePath(rawFile, targetPath, targetIsDirectory)
    if (!isPathInside(workspaceRoot, absolutePath)) continue
    if (isExcludedByConfig(absolutePath, workspaceRoot, excludeDirSet, excludeExts)) {
      continue
    }

    const key = normalizeLookupKey(absolutePath)
    if (!byPath.has(key)) {
      byPath.set(key, {
        originalAbsolute: absolutePath,
        originalRelative: toPortableRelativePath(absolutePath, workspaceRoot),
        originalPortableAbsolute: toPortablePath(absolutePath),
      })
    }
  }

  return [...byPath.values()]
}

async function createUtf8Mirror(
  workspaceRoot: string,
  candidates: CandidateFile[],
  concurrency: number,
  cacheMaxFiles: number,
): Promise<Mirror> {
  const tempDir =
    cacheMaxFiles === 0
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'safe-rw-search-'))
      : undefined
  const mirrorRoot = tempDir ? path.join(tempDir, 'mirror') : undefined
  if (mirrorRoot) await fs.mkdir(mirrorRoot, { recursive: true })

  const files = await mapWithConcurrency(candidates, concurrency, candidate =>
    mirrorFile(workspaceRoot, mirrorRoot, candidate, cacheMaxFiles),
  )

  return {
    files,
    tempDir,
  }
}

async function mirrorFile(
  workspaceRoot: string,
  mirrorRoot: string | undefined,
  candidate: CandidateFile,
  cacheMaxFiles: number,
): Promise<SearchableFile> {
  const stat = await fs.stat(candidate.originalAbsolute)
  if (cacheMaxFiles > 0) {
    return await mirrorFileWithCache(workspaceRoot, candidate, stat, cacheMaxFiles)
  }

  if (!mirrorRoot) {
    throw new Error('Internal error: mirror root is required when cache is disabled.')
  }

  try {
    return await mirrorTextFile(workspaceRoot, mirrorRoot, candidate, stat.mtimeMs)
  } catch {
    return await mirrorRawFile(workspaceRoot, mirrorRoot, candidate, stat.mtimeMs)
  }
}

async function mirrorFileWithCache(
  workspaceRoot: string,
  candidate: CandidateFile,
  stat: Awaited<ReturnType<typeof fs.stat>>,
  cacheMaxFiles: number,
): Promise<SearchableFile> {
  const mtimeMs = Number(stat.mtimeMs)
  const size = Number(stat.size)
  const key = mirrorCacheKey(candidate.originalAbsolute, mtimeMs, size)
  const cached = mirrorCache.get(key)
  if (cached && fileExistsSync(cached.searchFile.searchAbsolute)) {
    cached.lastUsed = Date.now()
    return cached.searchFile
  }
  if (cached) mirrorCache.delete(key)

  const inFlight = mirrorCacheInFlight.get(key)
  if (inFlight) return await inFlight

  const promise = mirrorFileIntoCache(workspaceRoot, candidate, stat, key)
  mirrorCacheInFlight.set(key, promise)
  try {
    const searchFile = await promise
    mirrorCache.set(key, {
      key,
      searchFile,
      lastUsed: Date.now(),
    })
    await trimMirrorCache(cacheMaxFiles)
    return searchFile
  } finally {
    mirrorCacheInFlight.delete(key)
  }
}

async function mirrorFileIntoCache(
  workspaceRoot: string,
  candidate: CandidateFile,
  stat: Awaited<ReturnType<typeof fs.stat>>,
  key: string,
): Promise<SearchableFile> {
  const cacheRoot = await getMirrorCacheRoot()
  const mirrorAbsolute = toCacheMirrorPath(cacheRoot, key, candidate.originalRelative)
  try {
    return await mirrorTextFileAt(candidate, mirrorAbsolute, Number(stat.mtimeMs))
  } catch {
    return await mirrorRawFileAt(candidate, mirrorAbsolute, Number(stat.mtimeMs))
  }
}

async function getMirrorCacheRoot(): Promise<string> {
  if (mirrorCacheRoot) return mirrorCacheRoot
  mirrorCacheRootPromise ??= fs.mkdtemp(
    path.join(os.tmpdir(), 'safe-rw-search-cache-'),
  )
  mirrorCacheRoot = await mirrorCacheRootPromise
  registerMirrorCacheCleanup()
  return mirrorCacheRoot
}

function registerMirrorCacheCleanup(): void {
  if (mirrorCacheCleanupRegistered) return
  mirrorCacheCleanupRegistered = true
  process.once('exit', () => {
    if (!mirrorCacheRoot) return
    try {
      rmSync(mirrorCacheRoot, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup only.
    }
  })
}

async function trimMirrorCache(cacheMaxFiles: number): Promise<void> {
  if (cacheMaxFiles <= 0) return
  if (mirrorCache.size <= cacheMaxFiles) return

  const entries = [...mirrorCache.values()].sort(
    (a, b) => a.lastUsed - b.lastUsed,
  )
  const removeCount = mirrorCache.size - cacheMaxFiles
  for (const entry of entries.slice(0, removeCount)) {
    mirrorCache.delete(entry.key)
    await fs
      .rm(path.dirname(entry.searchFile.searchAbsolute), {
        recursive: true,
        force: true,
      })
      .catch(() => undefined)
  }
}

function mirrorCacheKey(
  originalAbsolute: string,
  mtimeMs: number,
  size: number,
): string {
  return `${normalizeLookupKey(originalAbsolute)}\0${mtimeMs}\0${size}`
}

function toCacheMirrorPath(
  cacheRoot: string,
  key: string,
  originalRelative: string,
): string {
  const hash = createHash('sha1').update(key).digest('hex')
  return path.join(cacheRoot, hash, ...originalRelative.split('/'))
}

async function mirrorTextFile(
  workspaceRoot: string,
  mirrorRoot: string,
  candidate: CandidateFile,
  mtimeMs: number,
): Promise<SearchableFile> {
  const decoded = decodeTextBuffer(await fs.readFile(candidate.originalAbsolute))
  const mirrorAbsolute = toMirrorPath(
    workspaceRoot,
    mirrorRoot,
    candidate.originalAbsolute,
  )
  return await mirrorTextFileAt(candidate, mirrorAbsolute, mtimeMs, decoded.content)
}

async function mirrorTextFileAt(
  candidate: CandidateFile,
  mirrorAbsolute: string,
  mtimeMs: number,
  decodedContent?: string,
): Promise<SearchableFile> {
  const content =
    decodedContent ?? decodeTextBuffer(await fs.readFile(candidate.originalAbsolute)).content
  await fs.mkdir(path.dirname(mirrorAbsolute), { recursive: true })
  await fs.writeFile(mirrorAbsolute, content, 'utf8')
  return {
    ...candidate,
    searchAbsolute: mirrorAbsolute,
    searchPortableAbsolute: toPortablePath(mirrorAbsolute),
    mtimeMs,
  }
}

async function mirrorRawFile(
  workspaceRoot: string,
  mirrorRoot: string,
  candidate: CandidateFile,
  mtimeMs: number,
): Promise<SearchableFile> {
  const mirrorAbsolute = toMirrorPath(
    workspaceRoot,
    mirrorRoot,
    candidate.originalAbsolute,
  )
  return await mirrorRawFileAt(candidate, mirrorAbsolute, mtimeMs)
}

async function mirrorRawFileAt(
  candidate: CandidateFile,
  mirrorAbsolute: string,
  mtimeMs: number,
): Promise<SearchableFile> {
  await fs.mkdir(path.dirname(mirrorAbsolute), { recursive: true })
  await fs.copyFile(candidate.originalAbsolute, mirrorAbsolute)
  return {
    ...candidate,
    searchAbsolute: mirrorAbsolute,
    searchPortableAbsolute: toPortablePath(mirrorAbsolute),
    mtimeMs,
  }
}

function toOriginalSearchableFile(candidate: CandidateFile): SearchableFile {
  return {
    ...candidate,
    searchAbsolute: candidate.originalAbsolute,
    searchPortableAbsolute: candidate.originalPortableAbsolute,
  }
}

function buildRipgrepFileArgs(
  args: SafeSearchArgs,
  excludeDirs: string[],
  excludeExts: Set<string>,
): string[] {
  const rgArgs = ['--files', '--hidden']
  addTypeDefinitions(rgArgs)
  addSearchExcludeArgs(rgArgs, excludeDirs, excludeExts)
  addTypeAndGlobArgs(rgArgs, args)
  return rgArgs
}

function buildRipgrepSearchArgs(
  args: SafeSearchArgs,
  outputMode: SearchMode,
  options: {
    excludeDirs?: string[]
    excludeExts?: Set<string>
    safeExtsToExclude?: Set<string>
  } = {},
): string[] {
  const rgArgs = ['--hidden']

  rgArgs.push('--max-columns', '500')
  rgArgs.push('--with-filename')
  addTypeDefinitions(rgArgs)

  if (options.excludeDirs || options.excludeExts) {
    addSearchExcludeArgs(
      rgArgs,
      options.excludeDirs ?? [],
      options.excludeExts ?? new Set(),
    )
  }

  if (options.safeExtsToExclude) {
    addExtensionExcludeArgs(rgArgs, options.safeExtsToExclude)
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

  addTypeAndGlobArgs(rgArgs, args)
  return rgArgs
}

function addTypeDefinitions(rgArgs: string[]): void {
  for (const [type, globs] of Object.entries(SAFE_TYPE_ADDS)) {
    for (const glob of globs) {
      rgArgs.push('--type-add', `${type}:${glob}`)
    }
  }
}

function addTypeAndGlobArgs(rgArgs: string[], args: SafeSearchArgs): void {
  if (args.type) {
    rgArgs.push('--type', normalizeRipgrepType(args.type))
  }

  if (args.glob) {
    for (const globPattern of splitGlobPatterns(args.glob)) {
      rgArgs.push('--glob', globPattern)
    }
  }
}

function addSearchExcludeArgs(
  rgArgs: string[],
  excludeDirs: string[],
  excludeExts: Set<string>,
): void {
  for (const dir of excludeDirs) {
    const normalized = toPortablePath(dir)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    if (!normalized) continue
    rgArgs.push('--iglob', `!${normalized}`)
    rgArgs.push('--iglob', `!${normalized}/**`)
    rgArgs.push('--iglob', `!**/${normalized}`)
    rgArgs.push('--iglob', `!**/${normalized}/**`)
  }
  addExtensionExcludeArgs(rgArgs, excludeExts)
}

function addExtensionExcludeArgs(rgArgs: string[], excludeExts: Set<string>): void {
  for (const ext of excludeExts) {
    rgArgs.push('--iglob', `!*${ext}`)
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await worker(items[currentIndex]!)
      }
    }),
  )

  return results
}

function normalizeRipgrepType(type: string): string {
  return type === 'c++' ? 'cpp' : type
}

async function runRipgrepForTargetBatches(
  args: string[],
  targets: string[],
): Promise<string[]> {
  if (targets.length === 0) return []

  const results: string[] = []
  for (const batch of chunkTargets(args, targets)) {
    results.push(...await runRipgrep(args, batch))
  }
  return results
}

function chunkTargets(args: string[], targets: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentChars = args.reduce((sum, arg) => sum + arg.length + 1, 0)

  for (const target of targets) {
    const nextChars = target.length + 1
    if (
      current.length > 0 &&
      currentChars + nextChars > TARGET_ARGS_MAX_CHARS
    ) {
      batches.push(current)
      current = []
      currentChars = args.reduce((sum, arg) => sum + arg.length + 1, 0)
    }
    current.push(target)
    currentChars += nextChars
  }

  if (current.length > 0) batches.push(current)
  return batches
}

async function runRipgrep(
  args: string[],
  target: string | string[],
): Promise<string[]> {
  const { command, args: baseArgs } = await resolveRipgrepCommand()
  const targets = Array.isArray(target) ? target : [target]
  const fullArgs = [...baseArgs, ...args, ...targets]
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

function mapRawResults(
  rawResults: string[],
  files: SearchableFile[],
  outputMode: SearchMode,
  orderOffset: number,
): {
  files: SearchableFile[]
  content: MappedContentLine[]
  counts: CountEntry[]
} {
  const index = createSearchFileIndex(files)
  if (outputMode === 'files_with_matches') {
    return {
      files: rawResults
        .map(line => findFileForRipgrepLine(line, index, outputMode)?.file)
        .filter((file): file is SearchableFile => file !== undefined),
      content: [],
      counts: [],
    }
  }
  if (outputMode === 'count') {
    return {
      files: [],
      content: [],
      counts: rawResults
        .map((line, indexInSource) =>
          mapCountLine(line, index, orderOffset + indexInSource),
        )
        .filter((entry): entry is CountEntry => entry !== undefined),
    }
  }

  let lastParsed: { sortPath: string; sortLine: number } | undefined
  const content: MappedContentLine[] = []
  for (const [indexInSource, line] of rawResults.entries()) {
    const mapped = mapContentLine(line, index, orderOffset + indexInSource)
    if (mapped.parsed) {
      lastParsed = {
        sortPath: mapped.line.sortPath,
        sortLine: mapped.line.sortLine,
      }
      content.push(mapped.line)
      continue
    }

    if (line === '--' && lastParsed) {
      content.push({
        text: line,
        sortPath: lastParsed.sortPath,
        sortLine: lastParsed.sortLine + 0.1,
        order: orderOffset + indexInSource,
      })
      continue
    }

    content.push(mapped.line)
  }

  return { files: [], content, counts: [] }
}

function mapOriginalRawResults(
  rawResults: string[],
  outputMode: SearchMode,
  workspaceRoot: string,
  orderOffset: number,
): {
  files: SearchableFile[]
  content: MappedContentLine[]
  counts: CountEntry[]
} {
  if (outputMode === 'files_with_matches') {
    return {
      files: rawResults
        .map(line => originalSearchableFileFromPath(line, workspaceRoot))
        .filter((file): file is SearchableFile => file !== undefined),
      content: [],
      counts: [],
    }
  }

  if (outputMode === 'count') {
    return {
      files: [],
      content: [],
      counts: rawResults
        .map((line, index) =>
          mapOriginalCountLine(line, workspaceRoot, orderOffset + index),
        )
        .filter((entry): entry is CountEntry => entry !== undefined),
    }
  }

  let lastParsed: { sortPath: string; sortLine: number } | undefined
  const content: MappedContentLine[] = []
  for (const [index, line] of rawResults.entries()) {
    const mapped = mapOriginalContentLine(line, workspaceRoot, orderOffset + index)
    if (mapped.parsed) {
      lastParsed = {
        sortPath: mapped.line.sortPath,
        sortLine: mapped.line.sortLine,
      }
      content.push(mapped.line)
      continue
    }

    if (line === '--' && lastParsed) {
      content.push({
        text: line,
        sortPath: lastParsed.sortPath,
        sortLine: lastParsed.sortLine + 0.1,
        order: orderOffset + index,
      })
      continue
    }

    content.push(mapped.line)
  }

  return { files: [], content, counts: [] }
}

function mapOriginalContentLine(
  line: string,
  workspaceRoot: string,
  order: number,
): { line: MappedContentLine; parsed: boolean } {
  const match = /^(.+?)([:-])(\d+)([:-])/.exec(line)
  if (!match) {
    return {
      line: {
        text: line,
        sortPath: UNPARSED_SORT_PATH,
        sortLine: UNPARSED_SORT_LINE,
        order,
      },
      parsed: false,
    }
  }

  const file = originalSearchableFileFromPath(match[1]!, workspaceRoot)
  if (!file) {
    return {
      line: {
        text: line,
        sortPath: UNPARSED_SORT_PATH,
        sortLine: UNPARSED_SORT_LINE,
        order,
      },
      parsed: false,
    }
  }

  return {
    line: {
      text: `${file.originalRelative}${line.slice(match[1]!.length)}`,
      sortPath: file.originalRelative,
      sortLine: Number.parseInt(match[3]!, 10),
      order,
    },
    parsed: true,
  }
}

function mapOriginalCountLine(
  line: string,
  workspaceRoot: string,
  order: number,
): CountEntry | undefined {
  const colonIndex = line.lastIndexOf(':')
  if (colonIndex <= 0) return undefined

  const file = originalSearchableFileFromPath(
    line.slice(0, colonIndex),
    workspaceRoot,
  )
  if (!file) return undefined

  const count = Number.parseInt(line.slice(colonIndex + 1), 10)
  if (Number.isNaN(count)) return undefined

  return {
    text: `${file.originalRelative}:${count}`,
    count,
    sortPath: file.originalRelative,
    order,
  }
}

function originalSearchableFileFromPath(
  rawPath: string,
  workspaceRoot: string,
): SearchableFile | undefined {
  const absolutePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(workspaceRoot, rawPath)
  if (!isPathInside(workspaceRoot, absolutePath)) return undefined
  return toOriginalSearchableFile({
    originalAbsolute: absolutePath,
    originalRelative: toPortableRelativePath(absolutePath, workspaceRoot),
    originalPortableAbsolute: toPortablePath(absolutePath),
  })
}

function createSearchFileIndex(files: SearchableFile[]): SearchFileIndex {
  const byPath = new Map<string, SearchableFile>()
  for (const file of files) {
    byPath.set(normalizeLookupKey(file.searchAbsolute), file)
    byPath.set(normalizeLookupKey(file.searchPortableAbsolute), file)
    byPath.set(normalizeLookupKey(file.originalAbsolute), file)
    byPath.set(normalizeLookupKey(file.originalPortableAbsolute), file)
  }
  return {
    byPath,
    fallbackFiles: [...files].sort(
      (a, b) => b.searchAbsolute.length - a.searchAbsolute.length,
    ),
  }
}

function mapContentLine(
  line: string,
  index: SearchFileIndex,
  order: number,
): { line: MappedContentLine; parsed: boolean } {
  const match = findFileForRipgrepLine(line, index, 'content')
  if (!match) {
    return {
      line: {
        text: line,
        sortPath: UNPARSED_SORT_PATH,
        sortLine: UNPARSED_SORT_LINE,
        order,
      },
      parsed: false,
    }
  }

  return {
    line: {
      text: replaceSearchPath(line, match.file),
      sortPath: match.file.originalRelative,
      sortLine: match.lineNumber ?? UNPARSED_SORT_LINE,
      order,
    },
    parsed: true,
  }
}

function mapCountLine(
  line: string,
  index: SearchFileIndex,
  order: number,
): CountEntry | undefined {
  const match = findFileForRipgrepLine(line, index, 'count')
  if (!match) return undefined
  const count = parseCount(line, match.file)
  if (count === undefined) return undefined
  return {
    text: `${match.file.originalRelative}:${count}`,
    count,
    sortPath: match.file.originalRelative,
    order,
  }
}

function findFileForRipgrepLine(
  line: string,
  index: SearchFileIndex,
  outputMode: SearchMode,
): { file: SearchableFile; lineNumber?: number } | undefined {
  if (outputMode === 'files_with_matches') {
    const exact = lookupSearchPath(line, index)
    return exact ? { file: exact } : undefined
  }

  if (outputMode === 'count') {
    const colonIndex = line.lastIndexOf(':')
    if (colonIndex > 0) {
      const exact = lookupSearchPath(line.slice(0, colonIndex), index)
      if (exact) return { file: exact }
    }
    return findFileByPrefix(line, index)
  }

  const parsed = parseContentPathAndLine(line, index)
  if (parsed) return parsed
  return findFileByPrefix(line, index)
}

function parseContentPathAndLine(
  line: string,
  index: SearchFileIndex,
): { file: SearchableFile; lineNumber?: number } | undefined {
  const match = /^(.+?)([:-])(\d+)([:-])/.exec(line)
  if (!match) return undefined
  const file = lookupSearchPath(match[1]!, index)
  if (!file) return undefined
  return {
    file,
    lineNumber: Number.parseInt(match[3]!, 10),
  }
}

function lookupSearchPath(
  searchPath: string,
  index: SearchFileIndex,
): SearchableFile | undefined {
  return index.byPath.get(normalizeLookupKey(searchPath))
}

function findFileByPrefix(
  line: string,
  index: SearchFileIndex,
): { file: SearchableFile; lineNumber?: number } | undefined {
  for (const file of index.fallbackFiles) {
    const absoluteMatch = matchFilePrefix(line, file.searchAbsolute)
    if (absoluteMatch) {
      return { file, lineNumber: absoluteMatch.lineNumber }
    }
    const portableMatch = matchFilePrefix(line, file.searchPortableAbsolute)
    if (portableMatch) {
      return { file, lineNumber: portableMatch.lineNumber }
    }
  }
  return undefined
}

function matchFilePrefix(
  line: string,
  searchPath: string,
): { lineNumber?: number } | undefined {
  if (line === searchPath) return {}
  if (!line.startsWith(searchPath)) return undefined
  const separator = line[searchPath.length]
  if (separator !== ':' && separator !== '-') return undefined
  const rest = line.slice(searchPath.length + 1)
  const lineMatch = /^(\d+)([:-])/.exec(rest)
  return {
    lineNumber: lineMatch ? Number.parseInt(lineMatch[1]!, 10) : undefined,
  }
}

function replaceSearchPath(line: string, file: SearchableFile): string {
  for (const searchPath of [file.searchAbsolute, file.searchPortableAbsolute]) {
    if (line === searchPath) return file.originalRelative
    if (line.startsWith(`${searchPath}:`)) {
      return `${file.originalRelative}${line.slice(searchPath.length)}`
    }
    if (line.startsWith(`${searchPath}-`)) {
      return `${file.originalRelative}${line.slice(searchPath.length)}`
    }
  }
  return line
}

function parseCount(line: string, file: SearchableFile): number | undefined {
  for (const searchPath of [file.searchAbsolute, file.searchPortableAbsolute]) {
    if (!line.startsWith(`${searchPath}:`)) continue
    const count = Number.parseInt(line.slice(searchPath.length + 1), 10)
    return Number.isNaN(count) ? undefined : count
  }
  return undefined
}

function formatContentResult(
  mappedLines: MappedContentLine[],
  args: SafeSearchArgs,
): string {
  const sorted = [...mappedLines].sort(compareMappedLines)
  const { items, appliedLimit } = applyHeadLimit(
    sorted,
    args.head_limit,
    args.offset ?? 0,
  )
  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  const resultContent = items.map(item => item.text).join('\n') || 'No matches found'
  return limitInfo
    ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
    : resultContent
}

function formatCountResult(countEntries: CountEntry[], args: SafeSearchArgs): string {
  const sorted = [...countEntries].sort((a, b) => {
    const pathComparison = a.sortPath.localeCompare(b.sortPath)
    return pathComparison === 0 ? a.order - b.order : pathComparison
  })
  const { items, appliedLimit } = applyHeadLimit(
    sorted,
    args.head_limit,
    args.offset ?? 0,
  )
  const totalMatches = items.reduce((sum, entry) => sum + entry.count, 0)
  const fileCount = items.length
  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  const rawContent = items.map(item => item.text).join('\n') || 'No matches found'
  const summary =
    `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} ` +
    `across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.` +
    `${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
  return rawContent + summary
}

async function formatFilesWithMatchesResult(
  matchedFiles: SearchableFile[],
  args: SafeSearchArgs,
): Promise<string> {
  const uniqueByPath = new Map<string, SearchableFile>()
  for (const file of matchedFiles) {
    uniqueByPath.set(normalizeLookupKey(file.originalAbsolute), file)
  }

  const files = await Promise.all(
    [...uniqueByPath.values()].map(async file => ({
      file,
      mtimeMs: await getFileMtime(file),
    })),
  )

  const sorted = files
    .sort((a, b) => {
      const timeComparison = b.mtimeMs - a.mtimeMs
      return timeComparison === 0
        ? a.file.originalRelative.localeCompare(b.file.originalRelative)
        : timeComparison
    })
    .map(item => item.file.originalRelative)

  const { items, appliedLimit } = applyHeadLimit(
    sorted,
    args.head_limit,
    args.offset ?? 0,
  )
  if (items.length === 0) return 'No files found'

  const limitInfo = formatLimitInfo(appliedLimit, args.offset)
  return `Found ${items.length} ${items.length === 1 ? 'file' : 'files'}${limitInfo ? ` ${limitInfo}` : ''}\n${items.join('\n')}`
}

async function getFileMtime(file: SearchableFile): Promise<number> {
  if (file.mtimeMs !== undefined) return file.mtimeMs
  try {
    const stat = await fs.stat(file.originalAbsolute)
    return stat.mtimeMs ?? 0
  } catch {
    return 0
  }
}

function compareMappedLines(
  a: MappedContentLine,
  b: MappedContentLine,
): number {
  const pathComparison = a.sortPath.localeCompare(b.sortPath)
  if (pathComparison !== 0) return pathComparison
  const lineComparison = a.sortLine - b.sortLine
  return lineComparison === 0 ? a.order - b.order : lineComparison
}

function formatEmptyResult(outputMode: SearchMode): string {
  if (outputMode === 'files_with_matches') return 'No files found'
  if (outputMode === 'count') {
    return 'No matches found\n\nFound 0 total occurrences across 0 files.'
  }
  return 'No matches found'
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

function isExcludedByConfig(
  filePath: string,
  workspaceRoot: string,
  excludeDirSet: Set<string>,
  excludeExts: Set<string>,
): boolean {
  if (excludeExts.has(getFileExtension(filePath))) return true

  const relative = path.relative(workspaceRoot, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true
  const segments = relative.split(/[\\/]+/)
  for (const segment of segments.slice(0, -1)) {
    if (excludeDirSet.has(segment.toLowerCase())) return true
  }
  return false
}

function resolveRipgrepFilePath(
  rawFile: string,
  targetPath: string,
  targetIsDirectory: boolean,
): string {
  if (path.isAbsolute(rawFile)) return path.normalize(rawFile)
  const base = targetIsDirectory ? targetPath : path.dirname(targetPath)
  return path.resolve(base, rawFile)
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

function assertPathInsideWorkspace(workspaceRoot: string, targetPath: string): void {
  if (!isPathInside(workspaceRoot, targetPath)) {
    throw new Error(`Path is outside the current workspace: ${targetPath}`)
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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

function normalizeLookupKey(filePath: string): string {
  const normalized = path.resolve(path.normalize(filePath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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
