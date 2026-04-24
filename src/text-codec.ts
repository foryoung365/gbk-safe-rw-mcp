import { TextDecoder } from 'node:util'
import iconv from 'iconv-lite'
import type { LineEndings, TextEncoding } from './config.js'

export type DecodedText = {
  content: string
  encoding: TextEncoding
  lineEndings: LineEndings
  hasUtf8Bom: boolean
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.includes(0)
}

function isAscii(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte > 0x7f) return false
  }
  return true
}

function decodeUtf8Strict(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function detectLineEndings(content: string): LineEndings {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '\n') continue
    if (i > 0 && content[i - 1] === '\r') crlf++
    else lf++
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

export function decodeTextBuffer(buffer: Buffer): DecodedText {
  if (hasNulByte(buffer)) {
    throw new Error('File appears to be binary because it contains NUL bytes.')
  }

  if (buffer.length === 0) {
    return {
      content: '',
      encoding: 'gbk',
      lineEndings: 'LF',
      hasUtf8Bom: false,
    }
  }

  if (hasUtf8Bom(buffer)) {
    const decoded = decodeUtf8Strict(buffer.subarray(3))
    if (decoded === null) {
      throw new Error('File has a UTF-8 BOM but is not valid UTF-8.')
    }
    return {
      content: normalizeLineEndings(decoded),
      encoding: 'utf8',
      lineEndings: detectLineEndings(decoded),
      hasUtf8Bom: true,
    }
  }

  const utf8 = decodeUtf8Strict(buffer)
  if (utf8 !== null && !isAscii(buffer)) {
    return {
      content: normalizeLineEndings(utf8),
      encoding: 'utf8',
      lineEndings: detectLineEndings(utf8),
      hasUtf8Bom: false,
    }
  }

  if (utf8 !== null && isAscii(buffer)) {
    return {
      content: normalizeLineEndings(utf8),
      encoding: 'gbk',
      lineEndings: detectLineEndings(utf8),
      hasUtf8Bom: false,
    }
  }

  const gbk = iconv.decode(buffer, 'gbk')
  const roundTrip = iconv.encode(gbk, 'gbk')
  if (!roundTrip.equals(buffer)) {
    throw new Error('File is neither valid UTF-8 nor losslessly decodable as GBK.')
  }

  return {
    content: normalizeLineEndings(gbk),
    encoding: 'gbk',
    lineEndings: detectLineEndings(gbk),
    hasUtf8Bom: false,
  }
}

export function encodeText(
  content: string,
  encoding: TextEncoding,
  lineEndings: LineEndings,
  hasUtf8Bom: boolean,
): Buffer {
  const normalized = content.replaceAll('\r\n', '\n')
  const withLineEndings =
    lineEndings === 'CRLF' ? normalized.replaceAll('\n', '\r\n') : normalized

  if (encoding === 'utf8') {
    const body = Buffer.from(withLineEndings, 'utf8')
    return hasUtf8Bom ? Buffer.concat([UTF8_BOM, body]) : body
  }

  const encoded = iconv.encode(withLineEndings, 'gbk')
  const decoded = iconv.decode(encoded, 'gbk')
  if (decoded !== withLineEndings) {
    throw new Error(
      'Content contains characters that cannot be represented losslessly in GBK.',
    )
  }
  return encoded
}
