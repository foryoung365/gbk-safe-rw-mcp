import type { LineEndings, TextEncoding } from './config.js'

export type ReadState = {
  content: string
  encoding: TextEncoding
  lineEndings: LineEndings
  hasUtf8Bom: boolean
  mtimeMs: number
}

export type FileReadState = {
  lastReadMtimeMs: number
  fullRead?: ReadState
}

const readState = new Map<string, FileReadState>()

export function getReadState(realPath: string): FileReadState | undefined {
  return readState.get(realPath)
}

export function getFullReadState(realPath: string): ReadState | undefined {
  return readState.get(realPath)?.fullRead
}

export function markRead(
  realPath: string,
  mtimeMs: number,
  options: { preserveFullRead?: boolean } = {},
): void {
  const existing = readState.get(realPath)
  const preserveFullRead = options.preserveFullRead ?? true
  readState.set(realPath, {
    lastReadMtimeMs: mtimeMs,
    fullRead:
      preserveFullRead && existing?.fullRead?.mtimeMs === mtimeMs
        ? existing.fullRead
        : undefined,
  })
}

export function setFullReadState(realPath: string, state: ReadState): void {
  readState.set(realPath, {
    lastReadMtimeMs: state.mtimeMs,
    fullRead: state,
  })
}
