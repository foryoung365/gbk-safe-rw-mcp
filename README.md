# Safe Read/Write/Edit/Search MCP 使用说明

本目录提供一个本地 stdio MCP 服务，用于在 Claude Code 中安全读写和搜索 GBK 编码的遗留 C/C++、SQL 与 Proto 文本文件。

它提供四个工具：

- `safe_read`：读取目标后缀文件，自动将 GBK 或 UTF-8 解码为 UTF-8 文本返回给 agent。
- `safe_write`：完整覆盖写入目标后缀文件，写入前将 UTF-8 内容转换回目标文件编码。
- `safe_edit`：按接近 Claude Code 内置 `Edit` 的字符串替换语义局部修改目标后缀文件，并保持原文件编码。
- `safe_search`：替代内置 Search/Grep 执行全仓库搜索；受保护后缀会先将 GBK 或 UTF-8 解码为 UTF-8 临时镜像，非受保护文件直接在原仓库中调用 `ripgrep` 匹配。

默认受保护后缀为：

```text
.c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql,.proto
```

## 基本机制

Claude Code 内置 `Read` / `Write` / `Edit` 默认按 UTF-8 处理文本；内置 Search/Grep 对 GBK 中文内容也不能按 UTF-8 文本语义稳定匹配。对于 GBK 编码的遗留源码，直接读写或搜索中文内容可能导致乱码、误判或破坏文件编码。

本工具采用以下策略：

- 对受保护后缀，禁止使用内置 `Read` / `Write` / `Edit`，要求使用 `safe_read` / `safe_write` / `safe_edit`。
- 完全禁止使用内置 Search/Grep/Glob，并禁止通过 shell 调用常见搜索命令；所有搜索都必须使用 `safe_search`。
- `safe_search` 可搜索全仓库文件；受保护后缀会做编码转换，非受保护文件直接在原仓库中搜索。
- 对非受保护后缀，禁止使用 `safe_read` / `safe_write` / `safe_edit`，提示改用内置读写编辑工具。
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
I:/claude-code-source-code/safe-read-write-mcp/dist/tool-loop-guard.js
```

`safe_search` 依赖真实 `ripgrep` 来对齐 Claude Code 内置 Search/Grep 的行为。当前发布包已内置 Windows x64 版 `rg.exe`：

```text
dist/vendor/ripgrep/win32/x64/rg.exe
```

在 Windows x64 离线环境中，不需要额外安装 `ripgrep`。其他平台运行时需要满足以下任一条件：

- 已安装 `rg`，并且 `rg` 位于 `PATH` 中。
- 在 `dist/vendor/ripgrep/<platform>/<arch>/` 下提供 `rg` 或 `rg.exe`。
- 启动 Claude Code 前设置 `SAFE_RW_RG_PATH`，指向可执行的 `rg`。

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
.claude/mcp/gbk-safe-rw-mcp/dist/tool-loop-guard.js
.claude/mcp/gbk-safe-rw-mcp/dist/vendor/ripgrep/win32/x64/rg.exe
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
        "SAFE_RW_EXTS": ".c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql,.proto",
        "SAFE_RW_SEARCH_EXCLUDE_DIRS": ".git,.svn,.hg,.bzr,.jj,.sl,build,build64,bin,obj,out,output,dist,target,Debug,Release,x64,x86,.vs,CMakeFiles,_ReSharper.Caches",
        "SAFE_RW_SEARCH_EXCLUDE_EXTS": ".exe,.dll,.lib,.pdb,.ilk,.obj,.o,.a,.so,.dylib,.pch,.idb,.ipch,.res,.exp,.map,.class,.jar,.zip,.7z,.rar,.png,.jpg,.jpeg,.gif",
        "SAFE_RW_SEARCH_MIRROR_CONCURRENCY": "8",
        "SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES": "10000"
      }
    }
  }
}
```

`.claude/settings.json`：

```json
{
  "env": {
    "SAFE_RW_EXTS": ".c,.cc,.cpp,.cxx,.h,.hh,.hpp,.hxx,.inl,.sql,.proto",
    "SAFE_RW_SEARCH_EXCLUDE_DIRS": ".git,.svn,.hg,.bzr,.jj,.sl,build,build64,bin,obj,out,output,dist,target,Debug,Release,x64,x86,.vs,CMakeFiles,_ReSharper.Caches",
    "SAFE_RW_SEARCH_EXCLUDE_EXTS": ".exe,.dll,.lib,.pdb,.ilk,.obj,.o,.a,.so,.dylib,.pch,.idb,.ipch,.res,.exp,.map,.class,.jar,.zip,.7z,.rar,.png,.jpg,.jpeg,.gif",
    "SAFE_RW_SEARCH_MIRROR_CONCURRENCY": "8",
    "SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES": "10000",
    "SAFE_RW_LOOP_GUARD_HISTORY_LIMIT": "5",
    "SAFE_RW_LOOP_GUARD_REPEAT_THRESHOLD": "3"
  },
  "enabledMcpjsonServers": ["safe_rw"],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/mcp/gbk-safe-rw-mcp/dist/tool-loop-guard.js",
            "timeout": 5,
            "statusMessage": "检查重复工具调用"
          }
        ]
      },
      {
        "matcher": "Read|Write|Edit|Grep|Search|Glob|Bash|PowerShell",
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
        "matcher": "mcp__safe_rw__safe_read|mcp__safe_rw__safe_write|mcp__safe_rw__safe_edit|mcp__safe_rw__safe_search",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/mcp/gbk-safe-rw-mcp/dist/safe-rw-guard.js",
            "timeout": 5,
            "statusMessage": "规范化 safe read/write/edit/search 路径"
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

如需调整 `safe_search` 的默认排除策略，请修改 `.mcp.json` 中的以下环境变量；仓库级 `.claude/settings.json` 可以同步保留同样配置，便于团队查看：

- `SAFE_RW_SEARCH_EXCLUDE_DIRS`：默认排除目录。设置为空字符串表示不启用额外目录排除。
- `SAFE_RW_SEARCH_EXCLUDE_EXTS`：默认排除后缀。设置为空字符串表示不启用额外后缀排除。

默认排除目录：

```text
.git,.svn,.hg,.bzr,.jj,.sl,build,build64,bin,obj,out,output,dist,target,Debug,Release,x64,x86,.vs,CMakeFiles,_ReSharper.Caches
```

默认排除后缀：

```text
.exe,.dll,.lib,.pdb,.ilk,.obj,.o,.a,.so,.dylib,.pch,.idb,.ipch,.res,.exp,.map,.class,.jar,.zip,.7z,.rar,.png,.jpg,.jpeg,.gif
```

`.pdf` 不在默认排除后缀中；PDF 是否能被搜索到取决于 `ripgrep` 对该文件的文本/二进制判断，本工具不会额外提取 PDF 文本。

`safe_search` 还支持以下性能配置：

- `SAFE_RW_SEARCH_MIRROR_CONCURRENCY`：受保护文件转码镜像并发数，默认 `8`，有效范围 1 到 64。
- `SAFE_RW_SEARCH_MIRROR_CACHE_MAX_FILES`：MCP 进程内最多缓存的 UTF-8 镜像文件数，默认 `10000`；设置为 `0` 可关闭缓存。

镜像缓存使用系统临时目录保存 UTF-8 临时文件，内存中只保存路径、mtime、size 等索引信息。MCP 进程退出时会尽力清理缓存目录。

## 重复工具调用保护

本工具还提供一个独立的 `PreToolUse` Hook：

```text
.claude/mcp/gbk-safe-rw-mcp/dist/tool-loop-guard.js
```

该 Hook 会按 Claude Code 会话、当前工作目录以及 agent 标识分别记录最近工具调用的“工具名称 + 参数哈希”。它不会保存完整参数内容，只保存短哈希与时间戳。

当同一个 agent 连续第 3 次准备执行完全相同的工具调用时，Hook 会在执行前拒绝本次调用，并提示 agent 查看前一次工具结果、调整参数或更换处理策略。提示中会尽力输出当前上下文长度与总长度限制；如果 Claude Code 的 Hook 输入或 transcript 中没有暴露该信息，则会明确说明不可用。

可通过 `.claude/settings.json` 中的环境变量调整：

- `SAFE_RW_LOOP_GUARD_HISTORY_LIMIT`：保留最近调用数量，默认 `5`。
- `SAFE_RW_LOOP_GUARD_REPEAT_THRESHOLD`：连续相同调用拒绝阈值，默认 `3`。

修改配置后，请重新启动 Claude Code；如果 `/mcp` 中仍显示 `safe_rw` 未启用，请在 `/mcp` 中批准该项目 MCP，或确认 `.claude/settings.json` 中存在 `"enabledMcpjsonServers": ["safe_rw"]`。

## 工具使用方式

在 Claude Code 中，MCP 工具通常以完整工具名暴露：

```text
mcp__safe_rw__safe_read
mcp__safe_rw__safe_write
mcp__safe_rw__safe_edit
mcp__safe_rw__safe_search
```

实际使用时只需向 agent 明确要求：

- 读取 `.cpp`、`.h`、`.sql`、`.proto` 等受保护文件时使用 `safe_read`。
- 局部修改这些文件时使用 `safe_edit`。
- 完整覆盖写入这些文件时使用 `safe_write`。
- 搜索任何文件内容或文件列表时使用 `safe_search`。
- 不要对这些文件使用内置 `Read` / `Write` / `Edit` / `Search` / `Grep` / `Glob`，也不要通过 `Bash` 或 `PowerShell` 调用 `grep`、`rg`、`find`、`findstr`、`Select-String` 等搜索命令。

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

`safe_edit` 是局部修改工具，语义接近 Claude Code 内置 `Edit`：它会在当前文件中查找 `old_string` 并替换为 `new_string`。默认要求 `old_string` 在文件中唯一；如果需要替换所有匹配项，请设置 `replace_all: true`。匹配时会兼容直引号/弯引号差异、Claude Code 常见脱敏字符串还原，并在删除整行文本时按内置 `Edit` 的方式处理尾随换行。

对于已有非空文件，`safe_edit` 要求此前执行过 `safe_read`，但不要求完整读取；可以先使用 `offset` / `limit` 查看相关上下文，然后执行 `safe_edit`。如果文件在读取后被外部修改，且没有可用于确认内容未变化的完整读取快照，`safe_edit` 会拒绝写入并要求重新读取。

`safe_search` 参数对标 Claude Code 内置 Search/Grep：

```json
{
  "pattern": "中文注释|TODO",
  "path": "src",
  "glob": "*.{cpp,h,proto}",
  "output_mode": "content",
  "-C": 2,
  "-n": true,
  "-i": false,
  "type": "cpp",
  "head_limit": 100,
  "offset": 0,
  "multiline": false
}
```

只有 `pattern` 必填，其他参数均可省略。`safe_search` 会搜索全仓库文件，默认输出 `files_with_matches`；`output_mode: "content"` 返回匹配行，`output_mode: "count"` 返回各文件匹配计数。`glob`、`type`、`head_limit`、`offset`、上下文参数 `-A` / `-B` / `-C` / `context` 直接映射到 `ripgrep`，与内置 Search/Grep 保持同类语义。

说明：`safe_search` 会优先走非 GBK 快速路径；无法明确排除受保护后缀时，会先用 `rg --files` 枚举候选文件，并按受保护后缀拆分为两路搜索。`.c/.cpp/.h/.sql/.proto` 等受保护文件会被解码为 UTF-8 临时镜像后再搜索；`.md/.json/.ts/.py/.pdf` 等非受保护文件不会复制到临时镜像，而是直接在原仓库中调用 `ripgrep` 搜索。候选文件已确定时，`safe_search` 会把文件列表分批传给 `ripgrep`，避免重复遍历整个仓库。受保护文件镜像支持有限并发与进程内磁盘缓存。最终两路结果会合并、排序、分页，并统一映射为仓库相对路径。

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

如果内置 `Read` / `Write` / `Edit` / `Search` / `Grep` / `Glob` 或 shell 搜索命令被 hook 阻止，说明目标文件后缀受保护或搜索可能触达受保护后缀，应改用 `safe_read` / `safe_write` / `safe_edit` / `safe_search`。

## 建议加入 CLAUDE.md 的内容

建议将以下内容加入仓库根目录的 `CLAUDE.md`，使 agent 在开始工作前明确遵守 GBK 文件读写规则：

```markdown
## GBK 源码读写规则

本仓库包含 GBK 编码的遗留 C/C++、SQL 与 Proto 文件。为避免中文注释乱码、搜索误判或破坏文件编码，处理以下后缀文件时必须使用 GBK 安全读写与搜索工具：

`.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`, `.inl`, `.sql`, `.proto`

规则如下：

- 读取上述后缀文件时，必须使用 `mcp__safe_rw__safe_read`，不要使用内置 `Read`。
- 局部修改上述后缀文件时，必须使用 `mcp__safe_rw__safe_edit`，不要使用内置 `Edit`。
- 完整覆盖写入上述后缀文件时，必须使用 `mcp__safe_rw__safe_write`，不要使用内置 `Write`。
- 搜索任何文件内容或文件列表时，必须使用 `mcp__safe_rw__safe_search`，不要使用内置 Search/Grep/Glob，也不要通过 `Bash` 或 `PowerShell` 调用 `grep`、`rg`、`find`、`findstr`、`Select-String` 等搜索命令。
- 可以使用 `offset` / `limit` 局部读取文件以查看上下文。
- 写入已有文件前，必须先使用 `mcp__safe_rw__safe_read` 完整读取该文件，即不要带 `offset` 或 `limit`。
- `mcp__safe_rw__safe_write` 是完整文件覆盖工具；写入时必须提供完整文件内容。
- `mcp__safe_rw__safe_edit` 是接近内置 `Edit` 的字符串替换工具；默认要求 `old_string` 唯一，多处匹配时必须设置 `replace_all: true`。
- `mcp__safe_rw__safe_search` 对标内置 Search/Grep 参数，可搜索全仓库文件；受保护后缀会自动进行 GBK/UTF-8 转换。
- 对非上述后缀文件，继续使用内置 `Read` / `Write` / `Edit`，但搜索仍必须使用 `mcp__safe_rw__safe_search`。
- 如果 hook 阻止某次工具调用，应按错误提示改用对应工具，不要绕过该限制。
- 如果重复工具调用保护阻止某次调用，说明最近连续多次使用了完全相同的工具名称与参数；必须先查看上一轮结果，调整参数或更换策略后再继续。
```
