# Safe Read/Write/Edit MCP 离线安装包

版本：0.1.2

本发布包用于在 Claude Code 中安全处理 GBK 编码的遗留 C/C++ 与 SQL 文本文件。运行时不需要安装 npm 依赖，也不需要携带 `node_modules`；离线机器只需要安装 Node.js。

## 包内容

```text
dist/server.js
dist/safe-rw-guard.js
install.mjs
README.md
VERSION
```

## 安装方式

1. 将本目录解压或复制到离线机器的固定位置，例如：

```text
D:/tools/safe-read-write-mcp
```

2. 在需要启用该 MCP 的仓库根目录执行：

```bash
node D:/tools/safe-read-write-mcp/install.mjs .
```

也可以显式指定目标仓库：

```bash
node D:/tools/safe-read-write-mcp/install.mjs D:/your/repo
```

安装脚本会写入或更新：

- `.mcp.json`
- `.claude/settings.json`

3. 重启 Claude Code，并在 `/mcp` 中确认 `safe_rw` 已启用。如界面要求批准项目 MCP，请批准 `safe_rw`。

## 工具名称

Claude Code 中会暴露以下 MCP 工具：

```text
mcp__safe_rw__safe_read
mcp__safe_rw__safe_write
mcp__safe_rw__safe_edit
```

## 默认受保护后缀

```text
.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql
```

如需覆盖后缀，可在运行安装脚本前设置环境变量 `SAFE_RW_EXTS`。

## 注意事项

- 受保护后缀文件必须使用 safe 工具，不要使用内置 `Read` / `Write` / `Edit`。
- `safe_write` 是完整覆盖写入；已有文件写入前必须先完整 `safe_read`。
- `safe_edit` 是精确字符串替换；已有非空文件编辑前必须先 `safe_read`，但可以是局部读取。
- 如果移动了本发布包目录，请重新执行 `install.mjs`，使配置中的绝对路径更新到新位置。
