# Siftory

通用、可扩展的终端 Agent，durable 原生执行引擎。没有预设研究、视频或其他业务场景。

对话、执行、恢复和 todo 状态全部由 durable 引擎持久化在本地 SQLite；Siftory 提供 CLI/TUI、独立配置目录、资源装配和扩展。复用 Pi 的模型认证、Skills 发现和终端组件。

## 开始使用

需要 **Node.js ≥22.19.0**（内置 SQLite）；使用 Bun 1.4.2 安装依赖。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start
```

进入后用 `/login` 配置供应商，`/model` 选择模型。也可使用供应商环境变量，如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。

不指定参数时，工具工作目录是 `~/.siftory/workspace`（不再是启动时所在目录）：

```sh
siftory                                  # home = ~/.siftory，工作目录 = ~/.siftory/workspace
siftory --home /path/to/dev-siftory      # 独立开发 home
siftory --cwd /path/to/project           # 配置凭证归 home，工具操作 project
siftory --print "总结这个目录"            # 打印模式：回答一次即退出（无 TTY 时默认）
siftory --continue                       # 继续最近一次会话
```

## 基础能力

| 能力 | 使用方式 |
|---|---|
| 快捷键 | Esc 停止；Ctrl+C 退出；Ctrl+D 退出（空输入框）；Ctrl+T 折叠思考 |
| 主题 | `/theme` 选择当前 home 的主题，默认随终端配色 |
| 模型与思考级别 | `/model`、`/thinking`、`--model provider/model:high` |
| 会话 | `/new`（新会话组）、`/resume`（切换）、`--continue`、`--session <id>`；按会话组存 SQLite |
| 分支 | `/fork` 在最新条目处分叉，继承分叉点的 todo 列表 |
| 上下文压缩 | 自动压缩或 `/compact`；`/reset` 开新上下文 |
| 恢复 | 崩溃或退出后重开同一存储，未完成的工作从中断点继续 |
| 基础工具 | read、write、edit、bash |
| Skills | 标准 SKILL.md 发现、描述索引、按需读取；`/skill:name` 显式加载 |
| 提示词模板 | `~/.siftory/agent/prompts/<name>.md`，`/name 参数` 展开 `$ARGUMENTS` |
| Todo | 模型用 `todo` 工具维护任务清单；面板实时显示；Ctrl+Shift+T 折叠；Ctrl+O 展开全部任务；`/todos` 查看分组列表 |
| codemode / tool-search | durable 原生实现，默认装配 |
| 扩展 | durable 原生扩展（见 [扩展指南](docs/extensions.md)） |

## 恢复承诺

- 输入、任务、状态和输出先提交存储，再显示；重开后可恢复未完成的工作。
- 同一会话存储一次只允许一个进程打开；崩溃残留的锁由存活的进程安全接管。
- 工具默认不自动重跑；已验证可安全重跑的工具（如 todo）崩溃后自动恢复且不重复生效。
- 外部效果（bash、发信、支付）与本地提交不是同一个事务，不承诺恰好执行一次。
- 退出即暂停、重开恢复；不提供后台常驻服务。
- durable 仍是 Experimental：升级版本后须验证旧存储可恢复。

## 配置与目录

```text
~/.siftory/
├─ agent/
│  ├─ auth.json              密钥 / OAuth
│  ├─ models.json            自定义供应商与模型
│  ├─ skills/<name>/SKILL.md
│  ├─ prompts/<name>.md
│  └─ extensions/            durable 原生扩展（预留）
├─ sessions/<session-id>/
│  ├─ state.sqlite           durable 数据库（WAL）
│  └─ owner.lock             进程独占记录
├─ logs/
├─ tmp/
└─ workspace/                默认工具工作目录
```

`--home`、`--cwd` 相对路径按启动时所在目录解析。多个 home 之间不共享会话或凭证，也不自动继承个人 `~/.pi` 配置。备份会话请在关闭程序后复制整个 `sessions/<id>/` 目录，或使用 SQLite 一致性备份；运行中只复制主文件会丢 WAL 内容。

## 开发

```sh
bun run start --home /path/to/dev-siftory
bun run check
bun run test
```

测试使用官方 faux 模型，不需要密钥，不发送真实模型请求。覆盖：路径与锁、print 模式、流式与工具执行、会话重开、崩溃后恢复（bash 工具不重复执行）、todo 规则与回执重放、fork 隔离、Skills/项目上下文装载和真实 CLI 启动。

## 边界

- MCP、`/tree` 会话树浏览、HTML 导出、旧 Pi 插件尚未接入 durable 宿主；需要时按 [设计文档](docs/durable-native-design.md) 第四阶段逐项补齐。
- 保存会话不等于终端关闭后继续运行；重新打开后恢复。
- 第三方扩展运行在进程权限下，没有额外沙箱或审批层。
- 旧 Pi JSONL 会话留在原处，不自动转换；如需迁移另行设计显式导入。
