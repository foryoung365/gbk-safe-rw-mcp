#!/usr/bin/env node
import { createRequire as __safeRwCreateRequire } from "node:module"; const require = __safeRwCreateRequire(import.meta.url);

// src/tool-loop-guard.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var DEFAULT_HISTORY_LIMIT = 5;
var DEFAULT_REPEAT_THRESHOLD = 3;
var MAX_HISTORY_LIMIT = 20;
var TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
async function main() {
  const input = readHookInput();
  if ((input.hook_event_name ?? "") !== "PreToolUse") return;
  await handlePreToolUse(input);
}
async function handlePreToolUse(input) {
  const toolName = input.tool_name ?? "";
  if (!toolName) return;
  const repeatThreshold = parseIntegerEnv(
    process.env.SAFE_RW_LOOP_GUARD_REPEAT_THRESHOLD,
    DEFAULT_REPEAT_THRESHOLD,
    2,
    10
  );
  const historyLimit = parseIntegerEnv(
    process.env.SAFE_RW_LOOP_GUARD_HISTORY_LIMIT,
    DEFAULT_HISTORY_LIMIT,
    repeatThreshold,
    MAX_HISTORY_LIMIT
  );
  const inputHash = hashToolInput(input.tool_input);
  const signature = `${toolName}:${inputHash}`;
  const statePath = getStatePath(input);
  const state = await readState(statePath);
  const recent = trimRecords(state.records, historyLimit);
  const trailingMatches = countTrailingSignatureMatches(recent, signature);
  if (trailingMatches >= repeatThreshold - 1) {
    await writeState(statePath, {
      version: 1,
      records: trimRecords(recent, historyLimit)
    });
    deny(
      buildDenyReason({
        input,
        toolName,
        inputHash,
        repeatThreshold,
        recentRecords: recent.slice(-(repeatThreshold - 1))
      })
    );
    return;
  }
  recent.push({
    toolName,
    inputHash,
    signature,
    timestamp: Date.now()
  });
  await writeState(statePath, {
    version: 1,
    records: trimRecords(recent, historyLimit)
  });
}
function buildDenyReason({
  input,
  toolName,
  inputHash,
  repeatThreshold,
  recentRecords
}) {
  const recentTimes = recentRecords.map((record) => new Date(record.timestamp).toISOString()).join(", ");
  return [
    "Tool loop guard blocked this call before execution.",
    `Detected ${repeatThreshold} consecutive identical tool-call signatures.`,
    `Tool: ${toolName}`,
    `Parameter hash: ${inputHash}`,
    `Recent identical call times: ${recentTimes || "unavailable"}`,
    `Context: ${getContextInfo(input)}`,
    "Please inspect the previous tool result, change the parameters or strategy, and explain the adjustment before calling another tool."
  ].join("\n");
}
function getContextInfo(input) {
  const direct = findContextNumbers(input);
  if (direct) return formatContextNumbers(direct);
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : void 0;
  const fromTranscript = transcriptPath ? findContextInfoInTranscript(transcriptPath) : void 0;
  if (fromTranscript) return formatContextNumbers(fromTranscript);
  return "current/limit unavailable; Claude Code did not expose context length in this hook input.";
}
function formatContextNumbers(info) {
  if (info.current !== void 0 && info.total !== void 0) {
    const percent = info.total > 0 ? ` (${Math.round(info.current / info.total * 100)}%)` : "";
    return `${info.current} / ${info.total} tokens${percent}; source=${info.source}`;
  }
  if (info.remaining !== void 0 && info.total !== void 0) {
    return `remaining ${info.remaining} / ${info.total} tokens; source=${info.source}`;
  }
  if (info.current !== void 0) {
    return `${info.current} tokens used; total limit unavailable; source=${info.source}`;
  }
  if (info.total !== void 0) {
    return `current unavailable / ${info.total} tokens; source=${info.source}`;
  }
  return `unavailable; source=${info.source}`;
}
function findContextInfoInTranscript(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return void 0;
    const raw = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        const tokenUsage = findTokenUsageBlock(parsed);
        if (tokenUsage) return { ...tokenUsage, source: "transcript token_usage" };
        const contextNumbers = findContextNumbers(parsed);
        if (contextNumbers) {
          return { ...contextNumbers, source: "transcript usage" };
        }
      } catch {
      }
    }
  } catch {
    return void 0;
  }
  return void 0;
}
function readTail(filePath, maxBytes) {
  const buffer = readFileSync(filePath);
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}
function findTokenUsageBlock(value) {
  const found = findObject(
    value,
    (object) => object.type === "token_usage" && typeof object.total === "number" && typeof object.remaining === "number"
  );
  if (!found) return void 0;
  const total = found.total;
  const remaining = found.remaining;
  return {
    current: Math.max(0, total - remaining),
    total,
    remaining
  };
}
function findContextNumbers(value) {
  const found = findObject(value, (object) => {
    const current = firstNumber(object, [
      "context_length",
      "contextLength",
      "current_context_length",
      "currentContextLength",
      "total_context_size",
      "input_tokens",
      "inputTokens"
    ]);
    const total = firstNumber(object, [
      "context_limit",
      "contextLimit",
      "context_window",
      "contextWindow",
      "max_context_length",
      "maxContextLength",
      "max_tokens",
      "maxTokens"
    ]);
    return current !== void 0 || total !== void 0;
  });
  if (!found) return void 0;
  return {
    current: firstNumber(found, [
      "context_length",
      "contextLength",
      "current_context_length",
      "currentContextLength",
      "total_context_size",
      "input_tokens",
      "inputTokens"
    ]),
    total: firstNumber(found, [
      "context_limit",
      "contextLimit",
      "context_window",
      "contextWindow",
      "max_context_length",
      "maxContextLength",
      "max_tokens",
      "maxTokens"
    ]),
    remaining: firstNumber(found, ["remaining", "remaining_tokens", "remainingTokens"]),
    source: "hook input"
  };
}
function findObject(value, predicate, depth = 0) {
  if (depth > 8) return void 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate, depth + 1);
      if (found) return found;
    }
    return void 0;
  }
  if (typeof value !== "object" || value === null) return void 0;
  const object = value;
  if (predicate(object)) return object;
  for (const child of Object.values(object)) {
    const found = findObject(child, predicate, depth + 1);
    if (found) return found;
  }
  return void 0;
}
function firstNumber(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return void 0;
}
function countTrailingSignatureMatches(records, signature) {
  let count = 0;
  for (let index = records.length - 1; index >= 0; index--) {
    if (records[index]?.signature !== signature) break;
    count++;
  }
  return count;
}
function trimRecords(records, historyLimit) {
  return records.slice(-historyLimit);
}
function hashToolInput(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
function getStatePath(input) {
  const root = process.env.SAFE_RW_LOOP_GUARD_STATE_DIR || path.join(os.tmpdir(), "safe-read-write-mcp", "tool-loop-guard");
  const session = input.session_id || "unknown-session";
  const cwd = input.cwd || process.cwd();
  const agent = input.agent_id || input.agent_type || "main";
  const key = createHash("sha256").update(`${session}\0${cwd}\0${agent}`).digest("hex");
  return path.join(root, `${key}.json`);
}
async function readState(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.records)) {
      return {
        version: 1,
        records: parsed.records.filter(isRecord)
      };
    }
  } catch {
  }
  return { version: 1, records: [] };
}
async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await fs.rename(tempPath, filePath);
}
function isRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return typeof record.toolName === "string" && typeof record.inputHash === "string" && typeof record.signature === "string" && typeof record.timestamp === "number";
}
function parseIntegerEnv(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
main().catch((error) => {
  process.stderr.write(
    error instanceof Error ? `${error.message}
` : `${String(error)}
`
  );
  process.exitCode = 1;
});
