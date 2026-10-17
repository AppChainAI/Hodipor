# Siftory

通用、可扩展的终端 Agent 底座，基于完整 Pi 1.2.0。没有预设研究、视频或其他业务场景。

复用 Pi 的原生 TUI、模型认证与调用、工具执行、skills、会话、压缩、扩展和 MCP；Siftory 只提供独立配置目录、通用默认身份与启动入口。

## 开始使用

需要 **Node.js ≥22.19.0**；使用 Bun 1.4.2 安装依赖。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start
```

进入后用 `/login` 配置供应商，`/model` 选择模型。也可使用供应商环境变量，如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。

Siftory 的工作目录是启动时所在目录。要在任意目录使用命令：

```sh
bun link
cd /path/to/project
bunx siftory
```

`bun link` 把包注册到 Bun 全局目录，`bunx` 从那里解析命令，不依赖 `~/.bun/bin` 是否在 PATH。若它已在 PATH，也可以直接运行 `siftory`。

不链接也可以直接运行：

```sh
node /path/to/Siftory/src/cli.mjs
```

## 基础能力

| 能力 | 使用方式 |
|---|---|
| 对话和流式输出 | 直接输入；Esc 停止当前执行 |
| 模型与思考级别 | `/model`、`/settings`、`--model provider/model:high` |
| 会话 | `/new`、`/resume`、`--continue`；默认保存 JSONL |
| 分支 | `/tree`、`/fork` |
| 上下文压缩 | 自动压缩或 `/compact` |
| 基础工具 | 默认 read、bash、edit、write；grep、find、ls 等可按需启用 |
| Skills | 标准 SKILL.md 发现、描述索引、按需读取；`/skill:name` 显式加载 |
| 扩展 | Pi 原生工具、命令、事件、UI、模型供应商接口 |
| MCP | Pi 内置 MCP 支持；按配置连接服务器 |

所有 Pi CLI 参数原样传递，不维护第二套参数或会话实现：

```sh
siftory --help
siftory --continue
siftory --resume
siftory --model anthropic/claude-sonnet-4-6
siftory --tools read,grep,find,ls --print "分析当前目录"
siftory --mode json "解释这个项目"
siftory --tui-mode regular
```

`--help`、`--version` 和部分内置文案仍显示上游 Pi 名称/版本，未 fork 上游。非 TTY 输入或输出默认使用 print 模式。

## 配置与扩展

默认用户目录是 **`~/.siftory/agent/`**，不会复用或迁移旧 SQLite 数据，也不默认使用 `~/.pi/agent/` 的认证和配置。

设置 `SIFTORY_AGENT_DIR` 可选择其他用户目录。启动入口会将它交给 Pi 的 `PI_CODING_AGENT_DIR`；不使用继承的 `PI_CODING_AGENT_DIR` 作为 Siftory 默认目录。

```text
~/.siftory/agent/
├─ auth.json              密钥 / OAuth
├─ models.json            自定义供应商与模型
├─ settings.json          偏好、资源路径、扩展包
├─ sessions/              按工作目录分组的会话
├─ extensions/            .ts / .js 扩展
├─ skills/<name>/SKILL.md  标准技能
├─ prompts/               Markdown 命令模板
└─ themes/                主题
```

目录由使用相应功能时创建，不预建空目录。项目仍使用 Pi 标准 `.pi/` 配置与资源目录；项目代码加载保留 Pi 的信任机制。标准 `~/.agents/skills/`、项目 `.agents/skills/` 也可被发现，独立配置目录不是资源沙箱。

安装社区包：

```sh
siftory install npm:@scope/pi-package
siftory install git:github.com/owner/pi-package@v1
siftory list
siftory config
siftory update --extensions
```

直接试用资源：

```sh
siftory --extension /path/to/extension.ts
siftory --skill /path/to/skill
```

Siftory 的薄内建扩展名为 `builtin:siftory`，可以通过 `--no-extensions` 或 Pi 配置禁用。`SYSTEM.md`、`--system-prompt` 等显式提示词优先于 Siftory 默认身份。

扩展开发示例与兼容边界见 [扩展指南](docs/extensions.md)，实现边界见 [架构](docs/architecture.md)。

升级依赖使用包管理器并运行检查；`siftory update` 是上游 Pi 自更新命令，不负责更新本仓库的锁定依赖。

## 验证

```sh
bun run check
bun run test
```

测试使用官方 faux 模型，不需要密钥，不发送真实模型请求。覆盖标准资源发现、技能与模板展开、扩展工具执行、文件工具、流式输出、取消、模型选择、会话重开/分叉，以及真实 CLI 启动、配置隔离和 HTML 导出。

## 边界

- 保存会话不等于崩溃后自动续跑；重新打开后手动继续。
- 关闭终端不会留下后台 Agent 服务。
- 第三方扩展运行在进程权限下，需审查来源、版本与依赖；没有额外沙箱或审批层。
- 旧桌面、HTTP/WS、durable、选题/产物库及其构建链已删除；旧私有数据未迁移、未主动清除，新程序不会读取它们。
