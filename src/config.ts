import path from 'node:path'

export const DEFAULT_SAFE_EXTS = [
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.inl',
  '.sql',
  '.proto',
]

export const DEFAULT_SEARCH_EXCLUDE_DIRS = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
  'build',
  'build64',
  'bin',
  'obj',
  'out',
  'output',
  'dist',
  'target',
  'Debug',
  'Release',
  'x64',
  'x86',
  '.vs',
  'CMakeFiles',
  '_ReSharper.Caches',
]

export const DEFAULT_SEARCH_EXCLUDE_EXTS = [
  '.exe',
  '.dll',
  '.lib',
  '.pdb',
  '.ilk',
  '.obj',
  '.o',
  '.a',
  '.so',
  '.dylib',
  '.pch',
  '.idb',
  '.ipch',
  '.res',
  '.exp',
  '.map',
  '.class',
  '.jar',
  '.zip',
  '.7z',
  '.rar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
]

export const DEFAULT_SEARCH_MIRROR_CONCURRENCY = 8
export const DEFAULT_SEARCH_MIRROR_CACHE_MAX_FILES = 10000

export type TextEncoding = 'utf8' | 'gbk'
export type LineEndings = 'LF' | 'CRLF'

export function parseSafeExts(raw = process.env.SAFE_RW_EXTS): Set<string> {
  const values =
    raw
      ?.split(/[,\s;]+/)
      .map(item => item.trim())
      .filter(Boolean) ?? DEFAULT_SAFE_EXTS

  const normalized = values.map(item => {
    const lower = item.toLowerCase()
    return lower.startsWith('.') ? lower : `.${lower}`
  })

  return new Set(normalized.length > 0 ? normalized : DEFAULT_SAFE_EXTS)
}

export function getFileExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase()
}

export function isSafeExtension(
  filePath: string,
  safeExts = parseSafeExts(),
): boolean {
  return safeExts.has(getFileExtension(filePath))
}

export function parseSearchExcludeDirs(
  raw = process.env.SAFE_RW_SEARCH_EXCLUDE_DIRS,
): string[] {
  if (raw === undefined) return DEFAULT_SEARCH_EXCLUDE_DIRS
  if (raw.trim() === '') return []
  return parseList(raw)
    .map(item => item.replace(/[\\/]+$/g, '').replace(/^[\\/]+/g, ''))
    .filter(Boolean)
}

export function parseSearchExcludeExts(
  raw = process.env.SAFE_RW_SEARCH_EXCLUDE_EXTS,
): Set<string> {
  if (raw === undefined) return new Set(DEFAULT_SEARCH_EXCLUDE_EXTS)
  if (raw.trim() === '') return new Set()
  return new Set(
    parseList(raw).map(item => {
      const lower = item.toLowerCase()
      return lower.startsWith('.') ? lower : `.${lower}`
    }),
  )
}

export function parseSearchMirrorConcurrency(
  raw = process.env.SAFE_RW_SEARCH_MIRROR_CONCURRENCY,
): number {
  return clampInteger(raw, DEFAULT_SEARCH_MIRROR_CONCURRENCY, 1, 64)
}

export function parseSearchMirrorCacheMaxFiles(
  raw = process.env.SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES,
): number {
  return clampInteger(raw, DEFAULT_SEARCH_MIRROR_CACHE_MAX_FILES, 0, 1000000)
}

function parseList(raw: string): string[] {
  return raw
    .split(/[,\s;]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function clampInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
