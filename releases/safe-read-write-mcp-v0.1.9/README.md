# Safe Read/Write/Edit/Search MCP 离线安装包

版本：0.1.9

本发布包用于在 Claude Code 中安全处理 GBK 编码的遗留 C/C++、SQL 与 Proto 文本文件。运行时不需要安装 npm 依赖，也不需要携带 `node_modules`；离线机器只需要安装 Node.js。

`safe_search` 会调用真实 `ripgrep`，以尽量复用 Claude Code 内置 Search/Grep 的正则、glob、上下文和计数语义。当前发布包已内置 Windows x64 版 `rg.exe`：

```text
dist/vendor/ripgrep/win32/x64/rg.exe
```

在 Windows x64 离线环境中，不需要额外安装 `ripgrep`。其他平台运行时需要满足以下任一条件：

- 机器上已安装 `rg`，并且 `rg` 在 `PATH` 中。
- 发布包内包含 `dist/vendor/ripgrep/<platform>/<arch>/rg` 或 `rg.exe`。
- 启动 Claude Code 前设置环境变量 `SAFE_RW_RG_PATH` 指向可执行的 `rg`。

## 包内容

```text
dist/server.js
dist/safe-rw-guard.js
install.mjs
README.md
VERSION
```

## 安装方式

1. 将本目录解压或复制到离线机器任意位置，例如：

```text
D:/tools/safe-read-write-mcp-v0.1.9
```

2. 在需要启用该 MCP 的仓库根目录执行：

```bash
node D:/tools/safe-read-write-mcp-v0.1.9/install.mjs .
```

也可以显式指定目标仓库：

```bash
node D:/tools/safe-read-write-mcp-v0.1.9/install.mjs D:/your/repo
```

安装脚本会把 MCP 运行文件复制到目标仓库内，并写入或更新：

- `.mcp.json`
- `.claude/settings.json`
- `.claude/mcp/gbk-safe-rw-mcp/`

配置中使用仓库相对路径，例如：

```text
.claude/mcp/gbk-safe-rw-mcp/dist/server.js
.claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js
```

因此这些配置文件可以提交到团队仓库，成员之间不会因个人绝对路径不同产生冲突。

3. 团队成员拉取仓库后，应从仓库根目录启动 Claude Code：

```bash
cd D:/your/repo
claude
```

然后在 `/mcp` 中确认 `safe_rw` 已启用。如界面要求批准项目 MCP，请批准 `safe_rw`。

## 工具名称

Claude Code 中会暴露以下 MCP 工具：

```text
mcp__safe_rw__safe_read
mcp__safe_rw__safe_write
mcp__safe_rw__safe_edit
mcp__safe_rw__safe_search
```

## 默认受保护后缀

```text
.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql,.proto
```

如需覆盖后缀，可在运行安装脚本前设置环境变量 `SAFE_RW_EXTS`。

## 注意事项

- 受保护后缀文件必须使用 safe 读写编辑工具，不要使用内置 `Read` / `Write` / `Edit`。
- 内置 Search/Grep 被完全禁用；所有内容搜索都必须使用 `safe_search`。
- `safe_write` 是完整覆盖写入；已有文件写入前必须先完整 `safe_read`。
- `safe_edit` 是精确字符串替换；已有非空文件编辑前必须先 `safe_read`，但可以是局部读取。
- `safe_search` 会搜索全仓库文件；受保护后缀会先将 GBK/UTF-8 文件解码为 UTF-8 临时镜像，其他文件按原样进入镜像，再调用 `ripgrep` 执行搜索。
- 如果需要升级 MCP 版本，请用新发布包重新执行 `install.mjs`，然后提交更新后的 `.claude/mcp/gbk-safe-rw-mcp/`、`.mcp.json` 与 `.claude/settings.json`。
