#!/usr/bin/env node
import { createRequire as __safeRwCreateRequire } from "node:module"; const require = __safeRwCreateRequire(import.meta.url);

// src/safe-rw-guard.ts
import { readFileSync } from "node:fs";

// src/config.ts
import path from "node:path";
var DEFAULT_SAFE_EXTS = [
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".inl",
  ".sql",
  ".proto",
  ".patch",
  ".diff"
];
function parseSafeExts(raw = process.env.SAFE_RW_EXTS) {
  const values = raw?.split(/[,\s;]+/).map((item) => item.trim()).filter(Boolean) ?? DEFAULT_SAFE_EXTS;
  const normalized = values.map((item) => {
    const lower = item.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
  return new Set(normalized.length > 0 ? normalized : DEFAULT_SAFE_EXTS);
}
function getFileExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}
function isSafeExtension(filePath, safeExts = parseSafeExts()) {
  return safeExts.has(getFileExtension(filePath));
}

// src/path-utils.ts
import fs from "node:fs";
import path2 from "node:path";
function resolveHookPathInsideCwd(cwd, inputPath) {
  const rootReal = fs.realpathSync.native(path2.resolve(cwd));
  const candidate = path2.isAbsolute(inputPath) ? path2.resolve(inputPath) : path2.resolve(rootReal, inputPath);
  const ancestor = findExistingAncestor(candidate);
  const ancestorReal = fs.realpathSync.native(ancestor);
  if (!isInsidePath(ancestorReal, rootReal)) {
    throw new Error(`Path is outside the current workspace: ${inputPath}`);
  }
  const suffix = path2.relative(ancestor, candidate);
  const resolved = path2.resolve(ancestorReal, suffix);
  if (!isInsidePath(resolved, rootReal)) {
    throw new Error(`Path escapes the current workspace: ${inputPath}`);
  }
  return resolved;
}
function findExistingAncestor(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path2.dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent directory for path: ${candidate}`);
    }
    current = parent;
  }
  return current;
}
function isInsidePath(child, parent) {
  const relative = path2.relative(parent, child);
  return relative === "" || !relative.startsWith("..") && !path2.isAbsolute(relative);
}

// src/safe-rw-guard.ts
var BUILTIN_FILE_TOOLS = /* @__PURE__ */ new Set(["Read", "Write", "Edit"]);
var BUILTIN_SEARCH_TOOLS = /* @__PURE__ */ new Set(["Grep", "Search", "Glob"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var CONTENT_SEARCH_COMMANDS = /* @__PURE__ */ new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "ag",
  "ack",
  "ugrep",
  "findstr",
  "select-string",
  "sls"
]);
var FILE_SEARCH_COMMANDS = /* @__PURE__ */ new Set(["find", "fd", "fdfind", "bfs"]);
var POWERSHELL_GLOB_COMMANDS = /* @__PURE__ */ new Set([
  "get-childitem",
  "gci",
  "dir"
]);
var SHELL_WRAPPERS = /* @__PURE__ */ new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "time",
  "builtin",
  "nice",
  "nohup"
]);
var SAFE_READ_TOOL_NAMES = /* @__PURE__ */ new Set([
  "mcp__safe_rw__safe_read",
  "safe_read"
]);
var SAFE_WRITE_TOOL_NAMES = /* @__PURE__ */ new Set([
  "mcp__safe_rw__safe_write",
  "safe_write"
]);
var SAFE_EDIT_TOOL_NAMES = /* @__PURE__ */ new Set([
  "mcp__safe_rw__safe_edit",
  "safe_edit"
]);
var SAFE_SEARCH_TOOL_NAMES = /* @__PURE__ */ new Set([
  "mcp__safe_rw__safe_search",
  "safe_search"
]);
function main() {
  const input = readHookInput();
  if (input.hook_event_name !== "PreToolUse") return;
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const safeExts = parseSafeExts();
  const filePath = toolInput.file_path;
  if (BUILTIN_FILE_TOOLS.has(toolName)) {
    if (typeof filePath !== "string" || filePath.length === 0) return;
    if (isSafeExtension(filePath, safeExts)) {
      deny(
        `Files with this extension must use safe GBK-aware tools. Use ${getSafeToolName(toolName)} instead: ${filePath}`
      );
    }
    return;
  }
  if (BUILTIN_SEARCH_TOOLS.has(toolName)) {
    deny(
      "Built-in Search/Grep/Glob is disabled in this repository. Use mcp__safe_rw__safe_search for searches."
    );
    return;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = toolInput.command;
    if (typeof command !== "string" || command.trim().length === 0) return;
    const detected = detectShellSearch(command);
    if (detected) {
      deny(
        `Shell search command "${detected}" is disabled in this repository. Use mcp__safe_rw__safe_search instead.`
      );
    }
    return;
  }
  if (isSafeFileToolName(toolName)) {
    if (typeof filePath !== "string" || filePath.length === 0) return;
    if (!isSafeExtension(filePath, safeExts)) {
      deny(
        `safe_read/safe_write/safe_edit only handle configured GBK-safe extensions. Use built-in Read/Write/Edit for this file: ${filePath}`
      );
      return;
    }
    try {
      const cwd = input.cwd ?? process.cwd();
      const absolutePath = resolveHookPathInsideCwd(cwd, filePath);
      updateInput({ ...input.tool_input, file_path: absolutePath });
    } catch (error) {
      deny(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (isSafeSearchToolName(toolName)) {
    if (typeof toolInput.path !== "string" || toolInput.path.length === 0) return;
    try {
      const cwd = input.cwd ?? process.cwd();
      const absolutePath = resolveHookPathInsideCwd(cwd, toolInput.path);
      updateInput({ ...toolInput, path: absolutePath });
    } catch (error) {
      deny(error instanceof Error ? error.message : String(error));
    }
  }
}
function isSafeFileToolName(toolName) {
  return SAFE_READ_TOOL_NAMES.has(toolName) || SAFE_WRITE_TOOL_NAMES.has(toolName) || SAFE_EDIT_TOOL_NAMES.has(toolName);
}
function isSafeSearchToolName(toolName) {
  return SAFE_SEARCH_TOOL_NAMES.has(toolName);
}
function getSafeToolName(toolName) {
  switch (toolName) {
    case "Read":
      return "mcp__safe_rw__safe_read";
    case "Write":
      return "mcp__safe_rw__safe_write";
    case "Edit":
      return "mcp__safe_rw__safe_edit";
    default:
      return "the corresponding safe tool";
  }
}
function detectShellSearch(command) {
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShellSegment(segment);
    if (tokens.length === 0) continue;
    const commandName = getShellCommandName(tokens);
    if (!commandName) continue;
    if (CONTENT_SEARCH_COMMANDS.has(commandName)) return commandName;
    if (FILE_SEARCH_COMMANDS.has(commandName)) return commandName;
    if (isGitGrep(commandName, tokens)) return "git grep";
    if (isPowerShellRecursiveGlob(commandName, tokens)) return commandName;
    if (containsExecutableSearchToken(commandName, tokens)) {
      return "search command";
    }
    if (tokens.some((token) => isRecursiveGlobToken(token.value))) {
      return "recursive glob";
    }
  }
  return void 0;
}
function splitShellSegments(command) {
  return command.replace(/\r?\n/g, ";").split(/&&|\|\||[;|]/).map((segment) => segment.trim()).filter(Boolean);
}
function tokenizeShellSegment(segment) {
  const tokens = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|[^\s()<>]+/g;
  for (const match of segment.matchAll(tokenPattern)) {
    const raw = match[0];
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    tokens.push({
      value: quoted ? raw.slice(1, -1) : raw,
      quoted
    });
  }
  return tokens;
}
function getShellCommandName(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].value;
    const name = normalizeCommandToken(token);
    if (!name || isEnvAssignment(token)) {
      index++;
      continue;
    }
    if (SHELL_WRAPPERS.has(name)) {
      index++;
      while (index < tokens.length) {
        const next = tokens[index].value;
        if (isEnvAssignment(next) || next.startsWith("-")) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    return name;
  }
  return void 0;
}
function containsExecutableSearchToken(commandName, tokens) {
  if (commandName === "echo" || commandName === "printf") return false;
  return tokens.some((token) => {
    if (token.quoted) return false;
    const name = normalizeCommandToken(token.value);
    return CONTENT_SEARCH_COMMANDS.has(name) || FILE_SEARCH_COMMANDS.has(name);
  });
}
function isGitGrep(commandName, tokens) {
  return commandName === "git" && tokens.some((token) => normalizeCommandToken(token.value) === "grep");
}
function isPowerShellRecursiveGlob(commandName, tokens) {
  if (!POWERSHELL_GLOB_COMMANDS.has(commandName)) return false;
  return tokens.some((token) => {
    const lower = token.value.toLowerCase();
    return lower === "-recurse" || lower === "-r" || lower === "-filter" || lower === "-include" || lower === "-exclude";
  });
}
function isRecursiveGlobToken(value) {
  return value.includes("**/") || value.includes("**\\");
}
function isEnvAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}
function normalizeCommandToken(value) {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed.startsWith("-")) return "";
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}
function readHookInput() {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })
  );
}
function updateInput(updatedInput) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput
      }
    })
  );
}
main();
