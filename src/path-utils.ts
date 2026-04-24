import fs from 'node:fs'
import path from 'node:path'

export function resolveHookPathInsideCwd(
  cwd: string,
  inputPath: string,
): string {
  const rootReal = fs.realpathSync.native(path.resolve(cwd))
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootReal, inputPath)

  const ancestor = findExistingAncestor(candidate)
  const ancestorReal = fs.realpathSync.native(ancestor)
  if (!isInsidePath(ancestorReal, rootReal)) {
    throw new Error(`Path is outside the current workspace: ${inputPath}`)
  }

  const suffix = path.relative(ancestor, candidate)
  const resolved = path.resolve(ancestorReal, suffix)
  if (!isInsidePath(resolved, rootReal)) {
    throw new Error(`Path escapes the current workspace: ${inputPath}`)
  }

  return resolved
}

function findExistingAncestor(candidate: string): string {
  let current = candidate
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`No existing parent directory for path: ${candidate}`)
    }
    current = parent
  }
  return current
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
