#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { isSafeExtension } from './config.js'
import {
  getFullReadState,
  getReadState,
  markRead,
  setFullReadState,
} from './file-state.js'
import { decodeTextBuffer, encodeText } from './text-codec.js'

declare const SAFE_RW_VERSION: string | undefined

const SERVER_VERSION =
  typeof SAFE_RW_VERSION === 'string' ? SAFE_RW_VERSION : '0.1.0'

type SafeReadArgs = {
  file_path: string
  offset?: number
  limit?: number
}

type SafeWriteArgs = {
  file_path: string
  content: string
}

type SafeEditArgs = {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

const SAFE_READ_TOOL: Tool = {
  name: 'safe_read',
  description:
    'Read a configured GBK-safe text file. Decodes GBK or UTF-8 into UTF-8 text and returns numbered lines. Use this instead of Read for configured C/C++/SQL extensions.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file. Relative paths are normalized by the Claude Code hook before this tool runs.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Optional 1-based line number to start reading from.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Optional number of lines to return.',
      },
    },
    required: ['file_path'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
}

const SAFE_WRITE_TOOL: Tool = {
  name: 'safe_write',
  description:
    'Overwrite a configured GBK-safe text file. Existing files must be fully read with safe_read first. Writes back using the file encoding detected by safe_read; new files default to GBK.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file. Relative paths are normalized by the Claude Code hook before this tool runs.',
      },
      content: {
        type: 'string',
        description: 'Full UTF-8 text content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
}

const SAFE_EDIT_TOOL: Tool = {
  name: 'safe_edit',
  description:
    'Edit a configured GBK-safe text file by exact string replacement. Decodes GBK or UTF-8, applies old_string/new_string replacement, and writes back using the detected encoding.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file. Relative paths are normalized by the Claude Code hook before this tool runs.',
      },
      old_string: {
        type: 'string',
        description: 'Exact UTF-8 text to replace. Use an empty string only to create a new file or fill an empty file.',
      },
      new_string: {
        type: 'string',
        description: 'UTF-8 replacement text. Must differ from old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence of old_string. Defaults to false.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
}

const server = new Server(
  {
    name: 'safe-read-write-mcp',
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SAFE_READ_TOOL, SAFE_WRITE_TOOL, SAFE_EDIT_TOOL],
}))

server.setRequestHandler(
  CallToolRequestSchema,
  async ({ params }): Promise<CallToolResult> => {
    try {
      switch (params.name) {
        case 'safe_read':
          return textResult(await safeRead(parseSafeReadArgs(params.arguments)))
        case 'safe_write':
          return textResult(await safeWrite(parseSafeWriteArgs(params.arguments)))
        case 'safe_edit':
          return textResult(await safeEdit(parseSafeEditArgs(params.arguments)))
        default:
          throw new Error(`Unknown tool: ${params.name}`)
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  },
)

async function safeRead(args: SafeReadArgs): Promise<string> {
  assertSafeTarget(args.file_path)
  const realPath = await realpathExistingFile(args.file_path)
  const stat = await fs.stat(realPath)
  if (stat.isDirectory()) {
    throw new Error(`Cannot read a directory: ${args.file_path}`)
  }

  const decoded = decodeTextBuffer(await fs.readFile(realPath))
  const readMtimeMs = Math.floor(stat.mtimeMs)
  const offset = args.offset ?? 1
  const limit = args.limit
  const startIndex = offset <= 1 ? 0 : offset - 1
  const lines = decoded.content.length === 0 ? [] : decoded.content.split('\n')
  const selectedLines =
    limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit)
  const selectedContent = selectedLines.join('\n')

  if (isFullRead(offset, limit)) {
    setFullReadState(realPath, {
      content: decoded.content,
      encoding: decoded.encoding,
      lineEndings: decoded.lineEndings,
      hasUtf8Bom: decoded.hasUtf8Bom,
      mtimeMs: readMtimeMs,
    })
  } else {
    markRead(realPath, readMtimeMs)
  }

  const header =
    `Read ${selectedLines.length} of ${lines.length} lines from ${realPath}` +
    ` (encoding: ${decoded.encoding}, line endings: ${decoded.lineEndings})`
  const numbered = addLineNumbers(selectedContent, startIndex + 1)
  if (numbered.length === 0) {
    return `${header}\n<system-reminder>Warning: the file exists but no lines were returned.</system-reminder>`
  }
  return `${header}\n${numbered}`
}

async function safeWrite(args: SafeWriteArgs): Promise<string> {
  assertSafeTarget(args.file_path)
  const targetPath = path.resolve(args.file_path)
  const parent = path.dirname(targetPath)

  let existing = false
  let realPath = targetPath
  try {
    realPath = await realpathExistingFile(targetPath)
    const stat = await fs.stat(realPath)
    if (stat.isDirectory()) {
      throw new Error(`Cannot write a directory: ${args.file_path}`)
    }
    existing = true
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  if (existing) {
    const state = getFullReadState(realPath)
    if (!state) {
      throw new Error(
        'Existing file has not been fully read with safe_read in this MCP session. Use safe_read first before safe_write.',
      )
    }

    const currentStat = await fs.stat(realPath)
    const current = decodeTextBuffer(await fs.readFile(realPath))
    if (
      Math.floor(currentStat.mtimeMs) > state.mtimeMs &&
      current.content !== state.content
    ) {
      throw new Error(
        'File has been modified since safe_read. Read it again before writing.',
      )
    }
    if (current.content !== state.content) {
      throw new Error(
        'File content no longer matches the last safe_read result. Read it again before writing.',
      )
    }

    const buffer = encodeText(
      args.content,
      state.encoding,
      state.lineEndings,
      state.hasUtf8Bom,
    )
    await atomicWrite(realPath, buffer)
    const writtenStat = await fs.stat(realPath)
    setFullReadState(realPath, {
      content: args.content.replaceAll('\r\n', '\n'),
      encoding: state.encoding,
      lineEndings: state.lineEndings,
      hasUtf8Bom: state.hasUtf8Bom,
      mtimeMs: Math.floor(writtenStat.mtimeMs),
    })
    return `The file ${realPath} has been updated successfully using ${state.encoding} encoding.`
  }

  await fs.mkdir(parent, { recursive: true })
  const buffer = encodeText(args.content, 'gbk', 'LF', false)
  await atomicWrite(targetPath, buffer)
  realPath = await fs.realpath(targetPath)
  const writtenStat = await fs.stat(realPath)
  setFullReadState(realPath, {
    content: args.content.replaceAll('\r\n', '\n'),
    encoding: 'gbk',
    lineEndings: 'LF',
    hasUtf8Bom: false,
    mtimeMs: Math.floor(writtenStat.mtimeMs),
  })
  return `File created successfully at: ${realPath} using gbk encoding.`
}

async function safeEdit(args: SafeEditArgs): Promise<string> {
  assertSafeTarget(args.file_path)
  if (args.old_string === args.new_string) {
    throw new Error(
      'No changes to make: old_string and new_string are exactly the same.',
    )
  }

  const targetPath = path.resolve(args.file_path)
  const parent = path.dirname(targetPath)
  const replaceAll = args.replace_all ?? false

  let existing = false
  let realPath = targetPath
  try {
    realPath = await realpathExistingFile(targetPath)
    const stat = await fs.stat(realPath)
    if (stat.isDirectory()) {
      throw new Error(`Cannot edit a directory: ${args.file_path}`)
    }
    existing = true
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  if (!existing) {
    if (args.old_string !== '') {
      throw new Error(`File does not exist: ${args.file_path}`)
    }

    await fs.mkdir(parent, { recursive: true })
    const buffer = encodeText(args.new_string, 'gbk', 'LF', false)
    await atomicWrite(targetPath, buffer)
    realPath = await fs.realpath(targetPath)
    const writtenStat = await fs.stat(realPath)
    markRead(realPath, Math.floor(writtenStat.mtimeMs), {
      preserveFullRead: false,
    })
    return `File created successfully at: ${realPath} using gbk encoding.`
  }

  const currentStat = await fs.stat(realPath)
  const current = decodeTextBuffer(await fs.readFile(realPath))

  if (current.content.length > 0) {
    const state = getReadState(realPath)
    if (!state) {
      throw new Error(
        'Existing non-empty file has not been read with safe_read in this MCP session. Use safe_read before safe_edit.',
      )
    }

    if (Math.floor(currentStat.mtimeMs) > state.lastReadMtimeMs) {
      const fullRead = state.fullRead
      if (!fullRead || current.content !== fullRead.content) {
        throw new Error(
          'File has been modified since safe_read. Read it again before editing.',
        )
      }
    }
  }

  let updatedContent: string
  if (args.old_string === '') {
    if (current.content.length !== 0) {
      throw new Error('Cannot create new file - file already exists.')
    }
    updatedContent = args.new_string
  } else {
    const matches = countOccurrences(current.content, args.old_string)
    if (matches === 0) {
      throw new Error(`String to replace not found in file.\nString: ${args.old_string}`)
    }
    if (matches > 1 && !replaceAll) {
      throw new Error(
        `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more context to uniquely identify the instance.\nString: ${args.old_string}`,
      )
    }

    updatedContent = replaceAll
      ? current.content.split(args.old_string).join(args.new_string)
      : current.content.replace(args.old_string, args.new_string)
  }

  const buffer = encodeText(
    updatedContent,
    current.encoding,
    current.lineEndings,
    current.hasUtf8Bom,
  )
  await atomicWrite(realPath, buffer)
  const writtenStat = await fs.stat(realPath)
  markRead(realPath, Math.floor(writtenStat.mtimeMs), {
    preserveFullRead: false,
  })

  return replaceAll
    ? `The file ${realPath} has been updated successfully using ${current.encoding} encoding. All occurrences were replaced.`
    : `The file ${realPath} has been updated successfully using ${current.encoding} encoding.`
}

function parseSafeReadArgs(value: unknown): SafeReadArgs {
  const input = assertObject(value)
  const filePath = input.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('safe_read requires file_path.')
  }
  const args: SafeReadArgs = { file_path: filePath }
  const offset = input.offset
  if (offset !== undefined) {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new Error('safe_read offset must be a nonnegative integer.')
    }
    args.offset = offset
  }
  const limit = input.limit
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      throw new Error('safe_read limit must be a positive integer.')
    }
    args.limit = limit
  }
  return args
}

function parseSafeWriteArgs(value: unknown): SafeWriteArgs {
  const input = assertObject(value)
  const filePath = input.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('safe_write requires file_path.')
  }
  if (typeof input.content !== 'string') {
    throw new Error('safe_write requires string content.')
  }
  return { file_path: filePath, content: input.content }
}

function parseSafeEditArgs(value: unknown): SafeEditArgs {
  const input = assertObject(value)
  const filePath = input.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('safe_edit requires file_path.')
  }
  if (typeof input.old_string !== 'string') {
    throw new Error('safe_edit requires string old_string.')
  }
  if (typeof input.new_string !== 'string') {
    throw new Error('safe_edit requires string new_string.')
  }
  if (
    input.replace_all !== undefined &&
    typeof input.replace_all !== 'boolean'
  ) {
    throw new Error('safe_edit replace_all must be a boolean when provided.')
  }

  return {
    file_path: filePath,
    old_string: input.old_string,
    new_string: input.new_string,
    replace_all: input.replace_all,
  }
}

function assertObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.')
  }
  return value as Record<string, unknown>
}

function assertSafeTarget(filePath: string): void {
  if (!isSafeExtension(filePath)) {
    throw new Error(
      `safe_read/safe_write/safe_edit only handle configured GBK-safe extensions. Use built-in Read/Write/Edit for this file: ${filePath}`,
    )
  }
}

async function realpathExistingFile(filePath: string): Promise<string> {
  return fs.realpath(path.resolve(filePath))
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isFullRead(offset: number, limit: number | undefined): boolean {
  return offset <= 1 && limit === undefined
}

function addLineNumbers(content: string, startLine: number): string {
  if (content.length === 0) return ''
  return content
    .split('\n')
    .map((line, index) => `${index + startLine}\t${line}`)
    .join('\n')
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0
  return content.split(search).length - 1
}

async function atomicWrite(filePath: string, buffer: Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  try {
    await fs.writeFile(tempPath, buffer)
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function textResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
