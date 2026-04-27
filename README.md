# Safe Read/Write/Edit MCP 使用说明

本目录提供一个本地 stdio MCP 服务，用于在 Claude Code 中安全读写 GBK 编码的遗留 C/C++ 与 SQL 文本文件。

它提供三个工具：

- `safe_read`：读取目标后缀文件，自动将 GBK 或 UTF-8 解码为 UTF-8 文本返回给 agent。
- `safe_write`：完整覆盖写入目标后缀文件，写入前将 UTF-8 内容转换回目标文件编码。
- `safe_edit`：按精确字符串替换方式局部修改目标后缀文件，并保持原文件编码。

默认受保护后缀为：

```text
.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql
```

## 基本机制

Claude Code 内置 `Read` / `Write` / `Edit` 默认按 UTF-8 处理文本。对于 GBK 编码的遗留源码，直接写入中文注释可能导致乱码或破坏文件编码。

本工具采用以下策略：

- 对受保护后缀，禁止使用内置 `Read` / `Write` / `Edit`。
- 对受保护后缀，要求使用 `safe_read` / `safe_write` / `safe_edit`。
- 对非受保护后缀，禁止使用 `safe_read` / `safe_write` / `safe_edit`，提示改用内置工具。
- 相对路径由 Claude Code hook 根据当前 `cwd` 转换为绝对路径，并限制在当前工作区内。

## 安装与构建

### 在线构建

在 `safe-read-write-mcp/` 目录中执行：

```bash
npm install
npm run build
```

依赖不需要全局安装，`npm install` 会安装到本目录的 `node_modules/`。构建完成后，`dist/` 中的运行脚本会被打包为自包含文件。

本仓库已生成 `dist/` 构建产物，Claude Code 配置会直接调用：

```text
I:/claude-code-source-code/safe-read-write-mcp/dist/server.js
I:/claude-code-source-code/safe-read-write-mcp/dist/safe-rw-guard.js
```

### 离线使用

如果只是使用本工具，不需要在离线机器执行 `npm install`，也不需要全局安装 `@modelcontextprotocol/sdk`、`iconv-lite`、`zod` 或 `esbuild`。请在有网络的机器上先执行：

```bash
cd safe-read-write-mcp
npm install
npm run build
```

然后将整个仓库，至少包括以下文件，复制到离线机器：

```text
.mcp.json
.claude/settings.json
.claude/mcp/gbk-safe-rw-mcp/dist/server.js
.claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js
```

离线机器只需要已安装 Node.js，Claude Code 会通过 `node` 直接运行仓库内 `.claude/mcp/gbk-safe-rw-mcp/` 下的脚本。

如果需要在离线机器重新构建源码，则必须提前准备 npm 依赖。可在联网机器上执行：

```bash
cd safe-read-write-mcp
npm ci
npm cache verify
```

再把 npm 缓存目录和本目录一起带到离线机器，然后执行：

```bash
npm ci --offline
npm run build
```

更简单的离线方案是不要在离线机器重新构建，只复制已经构建好的 `dist/`。

### 制作离线发布包

在联网开发机器上执行：

```bash
cd safe-read-write-mcp
npm run package:offline
```

该命令会自动完成以下操作：

- 将 `package.json` 与 `package-lock.json` 中的补丁版本号递增一位，例如 `0.1.0` 变为 `0.1.1`。
- 重新构建自包含 `dist/server.js` 与 `dist/safe-rw-guard.js`。
- 在 `releases/` 下生成发布目录与 zip 包。
- 在发布包内写入独立的 `README.md`、`install.mjs` 与 `VERSION`。

生成结果示例：

```text
safe-read-write-mcp/releases/safe-read-write-mcp-v0.1.1/
safe-read-write-mcp/releases/safe-read-write-mcp-v0.1.1.zip
```

离线机器拿到 zip 后，解压到任意目录，再在目标仓库根目录执行包内的安装脚本：

```bash
node D:/tools/safe-read-write-mcp-v0.1.1/install.mjs .
```

安装脚本会把 MCP 运行文件复制到目标仓库内的 `.claude/mcp/gbk-safe-rw-mcp/`，并自动写入或更新目标仓库的 `.mcp.json` 与 `.claude/settings.json`。配置使用仓库相对路径，可以提交给团队共享。

如果修改了 `src/` 下的源码，请重新执行：

```bash
npm run build
```

## Claude Code 配置

本仓库使用两个配置文件：

- `.mcp.json`：声明项目级 MCP server。
- `.claude/settings.json`：启用该 MCP server，并配置 Claude Code hook。

注意：不要把项目级 MCP server 只写在 `.claude/settings.json` 的 `mcpServers` 中。当前 Claude Code 对项目级 MCP 的主读取位置是仓库根目录 `.mcp.json`。

团队共享时建议把 MCP 运行文件放进仓库内的 `.claude/mcp/gbk-safe-rw-mcp/`，并使用相对路径配置。团队成员应从仓库根目录启动 Claude Code：

```bash
cd your-repo
claude
```

`.mcp.json`：

```json
{
  "mcpServers": {
    "safe_rw": {
      "type": "stdio",
      "command": "node",
      "args": [
        ".claude/mcp/gbk-safe-rw-mcp/dist/server.js"
      ],
      "env": {
        "SAFE_RW_EXTS": ".c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql"
      }
    }
  }
}
```

`.claude/settings.json`：

```json
{
  "env": {
    "SAFE_RW_EXTS": ".c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql"
  },
  "enabledMcpjsonServers": ["safe_rw"],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js",
            "timeout": 5,
            "statusMessage": "检查 GBK 安全读写策略"
          }
        ]
      },
      {
        "matcher": "mcp__safe_rw__safe_read|mcp__safe_rw__safe_write|mcp__safe_rw__safe_edit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js",
            "timeout": 5,
            "statusMessage": "规范化 safe read/write/edit 路径"
          }
        ]
      }
    ]
  }
}
```

如需调整受保护后缀，请同时修改两个位置的 `SAFE_RW_EXTS`：

- 顶层 `env.SAFE_RW_EXTS`：供 hook 使用。
- `.mcp.json` 中 `mcpServers.safe_rw.env.SAFE_RW_EXTS`：供 MCP 服务使用。

修改配置后，请重新启动 Claude Code；如果 `/mcp` 中仍显示 `safe_rw` 未启用，请在 `/mcp` 中批准该项目 MCP，或确认 `.claude/settings.json` 中存在 `"enabledMcpjsonServers": ["safe_rw"]`。

## 工具使用方式

在 Claude Code 中，MCP 工具通常以完整工具名暴露：

```text
mcp__safe_rw__safe_read
mcp__safe_rw__safe_write
mcp__safe_rw__safe_edit
```

实际使用时只需向 agent 明确要求：

- 读取 `.cpp`、`.h`、`.sql` 等受保护文件时使用 `safe_read`。
- 局部修改这些文件时使用 `safe_edit`。
- 完整覆盖写入这些文件时使用 `safe_write`。
- 不要对这些文件使用内置 `Read` / `Write` / `Edit`。

`safe_read` 参数：

```json
{
  "file_path": "src/example.cpp",
  "offset": 1,
  "limit": 200
}
```

`offset` 与 `limit` 可省略。它们用于只读取文件的指定行范围，适合查看大文件局部内容。

`safe_write` 参数：

```json
{
  "file_path": "src/example.cpp",
  "content": "完整文件内容"
}
```

`safe_write` 是完整覆盖写入，不是局部编辑。对于已有文件，本工具要求先执行一次不带 `offset` / `limit` 的完整 `safe_read`，然后再写入；写入时会检查最近一次完整读取的内容与 mtime，防止覆盖用户或格式化器在中途做出的修改。

说明：Claude Code 内置 `Read` 支持部分读取；内置 `Write` 也是完整覆盖写入，但它的“写前读取”校验并不严格要求完整读取。本工具在 `safe_write` 上采用更保守的完整读取要求，是为了在 GBK/UTF-8 转换场景中避免 agent 未看完整文件就整文件覆盖。

`safe_edit` 参数：

```json
{
  "file_path": "src/example.cpp",
  "old_string": "原文本",
  "new_string": "新文本",
  "replace_all": false
}
```

`safe_edit` 是局部修改工具，语义接近 Claude Code 内置 `Edit`：它会在当前文件中查找 `old_string` 并替换为 `new_string`。默认要求 `old_string` 在文件中唯一；如果需要替换所有匹配项，请设置 `replace_all: true`。

对于已有非空文件，`safe_edit` 要求此前执行过 `safe_read`，但不要求完整读取；可以先使用 `offset` / `limit` 查看相关上下文，然后执行 `safe_edit`。如果文件在读取后被外部修改，且没有可用于确认内容未变化的完整读取快照，`safe_edit` 会拒绝写入并要求重新读取。

## 编码规则

读取时：

- UTF-8 BOM 文件按 UTF-8 读取。
- 合法 UTF-8 非 ASCII 文件按 UTF-8 读取。
- ASCII-only 文件按 GBK 目标文件记录。
- 非 UTF-8 文件尝试按 GBK 无损解码。

写入时：

- 已有文件保持最近一次完整 `safe_read` 检测到的编码。
- 新建受保护后缀文件默认写为 GBK。
- 写 GBK 前会进行无损校验；无法用 GBK 表示的字符会导致写入失败。

`safe_edit` 修改已有文件时，会使用当前文件实际检测到的编码和换行风格写回；新建文件默认写为 GBK + LF。

## 常见提示

如果看到如下提示：

```text
Existing file has not been fully read with safe_read...
```

说明写入已有文件前没有完整读取该文件。请先使用 `safe_read` 读取完整文件，再调用 `safe_write`。

如果看到如下提示：

```text
Existing non-empty file has not been read with safe_read...
```

说明局部修改已有非空文件前尚未读取该文件。请先使用 `safe_read` 读取相关内容，再调用 `safe_edit`。

如果看到如下提示：

```text
File has been modified since safe_read...
```

说明文件在读取后又被外部修改。请重新读取后再写入。

如果内置 `Read` / `Write` / `Edit` 被 hook 阻止，说明目标文件后缀受保护，应改用 `safe_read` / `safe_write` / `safe_edit`。

## 建议加入 CLAUDE.md 的内容

建议将以下内容加入仓库根目录的 `CLAUDE.md`，使 agent 在开始工作前明确遵守 GBK 文件读写规则：

```markdown
## GBK 源码读写规则

本仓库包含 GBK 编码的遗留 C/C++ 与 SQL 文件。为避免中文注释乱码或破坏文件编码，处理以下后缀文件时必须使用 GBK 安全读写工具：

`.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`, `.inl`, `.sql`

规则如下：

- 读取上述后缀文件时，必须使用 `mcp__safe_rw__safe_read`，不要使用内置 `Read`。
- 局部修改上述后缀文件时，必须使用 `mcp__safe_rw__safe_edit`，不要使用内置 `Edit`。
- 完整覆盖写入上述后缀文件时，必须使用 `mcp__safe_rw__safe_write`，不要使用内置 `Write`。
- 可以使用 `offset` / `limit` 局部读取文件以查看上下文。
- 写入已有文件前，必须先使用 `mcp__safe_rw__safe_read` 完整读取该文件，即不要带 `offset` 或 `limit`。
- `mcp__safe_rw__safe_write` 是完整文件覆盖工具；写入时必须提供完整文件内容。
- `mcp__safe_rw__safe_edit` 是精确字符串替换工具；默认要求 `old_string` 唯一，多处匹配时必须设置 `replace_all: true`。
- 对非上述后缀文件，继续使用内置 `Read` / `Write` / `Edit`。
- 如果 hook 阻止某次工具调用，应按错误提示改用对应工具，不要绕过该限制。
```
