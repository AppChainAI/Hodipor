# Siftory 架构

本文描述当前实现（durable 原生）。目标设计的完整论述见 [durable 原生产品设计](durable-native-design.md)。

## 定位

Siftory 是通用 Agent 底座，不预设业务场景。durable 唯一拥有主会话、输入队列、模型执行、工具任务、压缩和业务文档；Siftory 拥有 CLI/TUI、资源装配、扩展装配、路径与存储生命周期；Pi 提供模型认证、资源加载与终端组件。

```text
siftory / node src/cli.mjs
  ├─ cli.mjs / session.mjs     参数解析、模型装配、会话组生命周期、锁
  ├─ runtime.mjs               durable Harness + SQLite + CodingTools + persona 装配
  ├─ home.mjs                  --home/--cwd 解析、目录初始化、存储独占锁
  ├─ models.mjs                Pi ModelRuntime（显式 auth/models 路径）
  ├─ resources.mjs             Skills、项目上下文、提示词模板（Pi 加载器 → durable sections）
  ├─ print.mjs                 print 模式（事件流渲染）
  └─ tui/                      pi-tui + Pi 显示组件装配
      ├─ app.mjs               布局、输入、命令、面板挂载、会话切换
      ├─ transcript.mjs        watchEvents 快照 + 增量投影
      └─ commands.mjs          /login /model /thinking /new /resume /fork /compact /reset /todos /exit
extensions/todo/               durable 原生 todo 扩展（工具 + 事务文档 + 回执）
```

## 执行与状态

- `Harness.open(openNodeSqliteStorage(...), { models, registry, env, conversationCreated })` 是唯一引擎入口；无第二套 AgentSession。
- 模型接入：`ModelRuntime.create({ authPath, modelsPath })` 实现 pi-ai `Models`，显式指向 `<home>/agent/`，不读写个人 `~/.pi`。
- 工具：durable `CodingTools`（read/write/edit/bash）+ durable codemode/tool-search 扩展 + todo 扩展，经 `createRegistry()` 安装。
- 环境：`NodeExecutionEnv({ cwd })`；宿主只传绝对 cwd（durable 会把 agent cwd 回传给 env.exec，相对路径会被二次拼接）。
- UI 投影：TUI 从 `watchEvents` 快照初始化，消费每提交一批的增量事件；todo 面板订阅 `watchDoc(TodoDoc)`；宿主在 `conversationCreated` 中物化 todo 文档使 watch 恒可挂载。
- 显示组件复用 Pi 公共导出：`CustomEditor`、`UserMessageComponent`、`AssistantMessageComponent`、`ToolExecutionComponent`、登录与选择器；主题经 `initTheme()` 全局初始化。

## 会话与恢复

- 会话组 = `<home>/sessions/<session-id>/state.sqlite`；`--continue` 取最近，`--session` 指定，默认新建。`/new`、`/resume` 在进程内完成存储切换（旧锁释放、新锁获取）。
- 独占：`owner.lock`（O_EXCL 创建 + PID 存活检查）；存活所有者拒绝二次打开，死亡所有者被接管。durable 不提供跨进程锁，这是宿主责任。
- 恢复：`resume()` 后未完成任务继续；不安全重放的工具崩溃后返回 interrupted；todo 工具声明 `replay: "safe"`——变更与调用回执同事务提交，重跑读回执返回原结果（崩溃注入测试守护）。

## todo 扩展（extensions/todo/）

移植自 `@juicesharp/rpiv-todo@2.13.8`（MIT，版权保留）。reducer、校验、环检测、selectors 原样保留；替换为 durable 原生接口：`defineTool`、会话作用域 `rewindable`/fork-asOf 文档（`app.todo`）、宿主面板挂载、`/todos` 分组列表命令与 Ctrl+T 快捷键。回执按 callId 保存、上限 64 条。

## 测试布局

- 根 `test/`：宿主与集成（print、锁、崩溃注入、todo 崩溃重放、资源装载、CLI 启动、TUI 投影）。
- `extensions/todo/test/`：todo 规则与事务文档局部测试。
- faux 模型做默认无密钥测试；真实供应商验证手动执行。

## 尚未接入

MCP、会话树浏览（`/tree`）、HTML 导出、旧 Pi 插件兼容、虚拟模型路由、`/reload`。按设计文档第四阶段逐项评估接入，不静默承诺。
