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
]

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
