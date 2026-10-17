# Siftory 架构

本文描述当前实现。后续 durable 原生产品的目标架构、目录、扩展移植与迁移计划见 [durable 原生产品设计](durable-native-design.md)，尚未实施。

## 定位

Siftory 是通用 Agent 底座，不预设业务场景。优先复用完整 Pi 的深模块，不重复实现会话、工具循环、模型协议或扩展宿主。

```text
siftory / node src/cli.mjs
  ├─ 设置独立 agentDir 与进程标记
  └─ pi-coding-agent.main(args)
      ├─ Pi CLI 参数、认证、配置、包管理
      ├─ Pi 原生交互 TUI（底层 pi-tui）
      ├─ AgentSession / SessionManager
      ├─ pi-agent-core / pi-ai
      ├─ 标准资源加载器与扩展运行时
      └─ builtin:siftory
          ├─ 默认通用身份（显式用户提示词优先）
          └─ Siftory TUI header
```

## 代码边界

- `src/cli.mjs`：启动前设置 `PI_CODING_AGENT_DIR`，再动态导入 Pi。使用公共 `main()` 接口，不访问包内私有路径，不启动子进程，不复制交互模式的装配代码。
- `src/foundation.mjs`：Pi 原生内建扩展。在 `before_agent_start` 中只补缺省 `customPrompt`，保留标准技能和项目上下文组装；交互模式设置 header。不添加工具、任务状态或业务管线。
- `test/`：真实 Pi SDK 与 CLI 链路，官方 faux provider 替代付费模型。测试使用临时目录，不改用户凭证。

Siftory 自有运行时代码只有启动入口和身份扩展。没有通用插件桥接、第二套状态容器或自定义扩展协议。

## 状态与生命周期

- Pi 拥有模型选择、认证、消息队列、工具执行、会话树、上下文压缩与退出处理。
- 会话保存为 Pi 原生 JSONL，默认按工作目录分组。
- `SIFTORY_AGENT_DIR` 覆盖默认 `~/.siftory/agent/`；项目仍采用 `.pi/`，保留 Pi 的信任配置。
- 标准 skills、prompts、themes 和 extensions 都交给官方加载器；不把技能全文常驻拼入 system prompt。
- 不引入 durable：持久会话可恢复，进行中的执行不承诺崩溃自动续跑，也不承诺终端关闭后继续运行。

## 可扩展性

通用能力通过原生 Pi 包/扩展/MCP 接入。工作法使用 skills；重复文本使用 prompts；模型或外部系统接入使用扩展工具；交互使用宿主 `ctx.ui` 与 pi-tui。

基础层不预注册研究、视频、产物、计划工具，也不预建对应目录。需要场景时新增独立扩展包，而不是改宿主或增加另一套 Agent 循环。

## 重构范围

旧 Tauri/React 桌面端、Bun sidecar、HTTP/WS、durable/SQLite 适配、自定义供应商 CRUD、todo 状态机、选题/产物索引、协议包、桌面图标与构建脚本已删除；相关依赖、测试、CI、旧产品/设计文档也已移除。

旧磁盘私有数据不迁移、不主动删除，不作为新程序输入。原仓库提交历史可用于查看旧实现，但不保留可启动的兼容层。

Node.js 是运行时；Bun 仅用于安装和脚本调度。依赖固定 Pi 1.2.0；上游 API/社区扩展升级须按锁定版本验证。三平台 CI 不再安装 Rust/WebKit 或打包 sidecar。
