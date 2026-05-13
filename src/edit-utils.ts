export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

type NormalizedEditInput = {
  oldString: string
  newString: string
}

const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

export function normalizeEditInput({
  filePath,
  fileContent,
  oldString,
  newString,
}: {
  filePath: string
  fileContent: string
  oldString: string
  newString: string
}): NormalizedEditInput {
  const normalizedNewString = isMarkdown(filePath)
    ? newString
    : stripTrailingWhitespace(newString)

  if (fileContent.includes(oldString)) {
    return {
      oldString,
      newString: normalizedNewString,
    }
  }

  const { result: desanitizedOldString, appliedReplacements } =
    desanitizeMatchString(oldString)
  if (fileContent.includes(desanitizedOldString)) {
    let desanitizedNewString = normalizedNewString
    for (const { from, to } of appliedReplacements) {
      desanitizedNewString = desanitizedNewString.replaceAll(from, to)
    }
    return {
      oldString: desanitizedOldString,
      newString: desanitizedNewString,
    }
  }

  return {
    oldString,
    newString: normalizedNewString,
  }
}

export function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex === -1) return null

  return fileContent.substring(searchIndex, searchIndex + searchString.length)
}

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString
  }

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }
  return result
}

export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  const replace = replaceAll
    ? (content: string, search: string, replacement: string) =>
        content.replaceAll(search, () => replacement)
    : (content: string, search: string, replacement: string) =>
        content.replace(search, () => replacement)

  if (newString !== '') {
    return replace(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(`${oldString}\n`)
  return stripTrailingNewline
    ? replace(originalContent, `${oldString}\n`, newString)
    : replace(originalContent, oldString, newString)
}

function stripTrailingWhitespace(value: string): string {
  const parts = value.split(/(\r\n|\n|\r)/)
  let result = ''
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined) continue
    result += index % 2 === 0 ? part.replace(/\s+$/, '') : part
  }
  return result
}

function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)
    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

function isMarkdown(filePath: string): boolean {
  return /\.(md|mdx)$/i.test(filePath)
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const previous = chars[index - 1]
  return (
    previous === ' ' ||
    previous === '\t' ||
    previous === '\n' ||
    previous === '\r' ||
    previous === '(' ||
    previous === '[' ||
    previous === '{' ||
    previous === '\u2014' ||
    previous === '\u2013'
  )
}

function applyCurlyDoubleQuotes(value: string): string {
  const chars = [...value]
  const result: string[] = []
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] === '"') {
      result.push(
        isOpeningContext(chars, index)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[index]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(value: string): string {
  const chars = [...value]
  const result: string[] = []
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] !== "'") {
      result.push(chars[index]!)
      continue
    }

    const previous = index > 0 ? chars[index - 1] : undefined
    const next = index < chars.length - 1 ? chars[index + 1] : undefined
    const previousIsLetter = previous !== undefined && /\p{L}/u.test(previous)
    const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
    if (previousIsLetter && nextIsLetter) {
      result.push(RIGHT_SINGLE_CURLY_QUOTE)
      continue
    }

    result.push(
      isOpeningContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE,
    )
  }
  return result.join('')
}
