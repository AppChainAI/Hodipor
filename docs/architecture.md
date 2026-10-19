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
      ├─ editor-slot.mjs       单个内联交互区域、焦点、过期回调与清理
      ├─ choice-selector.mjs   有界可搜索的思考等级/会话列表（Pi TUI 控件）
      ├─ transcript.mjs        watchEvents 快照 + 增量投影、工具详情折叠
      ├─ pi-display.mjs        固定 Pi 版本的专用 renderers/主题模块接入点
      ├─ theme.mjs             home 主题配置、终端颜色协商与 /theme
      ├─ run-status.mjs        原生工作/压缩/重试动画及菜单间迁移
      ├─ footer.mjs            durable 用量/上下文的两行主题页脚
      └─ commands.mjs          /login /model /thinking /new /resume /fork /compact /reset /todos /exit
extensions/todo/               durable 原生 todo 扩展（工具 + 事务文档 + 回执）
```

## 执行与状态

- `Harness.open(openNodeSqliteStorage(...), { models, registry, env, conversationCreated })` 是唯一引擎入口；无第二套 AgentSession。直接使用的 Pi/chord 依赖均固定为 1.3.0。
- 模型接入：`ModelRuntime.create({ authPath, modelsPath })` 实现 pi-ai `Models`，显式指向 `<home>/agent/`，不读写个人 `~/.pi`。
- 工具：durable `CodingTools`（read/write/edit/bash）+ durable codemode/tool-search 扩展 + todo 扩展，经 `createRegistry()` 安装。
- 环境：`NodeExecutionEnv({ cwd })`；宿主只传绝对 cwd（durable 会把 agent cwd 回传给 env.exec，相对路径会被二次拼接）。
- UI 投影：TUI 从 `watchEvents` 快照初始化，消费每提交一批的增量事件；todo 面板订阅 `watchDoc(TodoDoc)`；宿主在 `conversationCreated` 中物化 todo 文档使 watch 恒可挂载。
- 显示组件复用 Pi 公共导出：`CustomEditor`、`UserMessageComponent`、`AssistantMessageComponent`、`ToolExecutionComponent`、登录与模型选择器；思考等级/会话菜单由 Pi TUI Input/SelectList 组成。所有命令菜单替换编辑器，不使用居中 overlay；单一挂载点统一焦点和 dispose。主编辑器与菜单共用按键配置。工具专用 renderer、codemode 嵌套摘要和终端主题协商见 [展示层验收](tui-display.md)；Ctrl+O 展开工具和完整任务，Ctrl+T 折叠思考，Ctrl+Shift+T 折叠 todo 面板。编辑器边框随思考等级/活动主题更新，工作动画嵌入边框；/new 只清视口而不跳到绝对行零，避免 Warp 命令栏遮挡标题。

## 会话与恢复

- 会话组 = `<home>/sessions/<session-id>/state.sqlite`；`--continue` 取 ID 时间戳最新的存储，`--session` 指定，默认新建。`/new`、`/resume` 由宿主循环切换，先关闭旧 Harness/SQLite，再释放旧锁、打开新存储，不递归挂起旧运行时。
- `/resume` 无参数打开可搜索的存储列表，标记当前项；具名参数直接恢复。切换完成后清理视口，不删除数据库或终端滚动历史。
- 恢复默认沿用 agent 文档中的 cwd，工具、资源和 TUI 使用同一目录；显式 `--cwd` 持久化覆盖。
- 独占：`owner.lock`（O_EXCL + PID 检查）及短时 `owner.guard` 目录串行化创建/死亡锁接管/释放；损坏锁不自动抢占，释放可重复调用。正常执行期间崩溃留下的有效死亡 PID 锁可自动接管；若恰在更换所有权期间崩溃，遗留 guard 或损坏锁需停止所有相关进程后人工核实清理，不能盲目删除。仅针对同机本地文件系统，不承诺跨机器共享存储互斥。
- 恢复：`resume()` 后未完成任务继续；不安全重放的工具崩溃后返回 interrupted；todo 工具声明 `replay: "safe"`——变更与调用回执同事务提交，重跑读回执返回原结果（崩溃注入测试守护）。

## todo 扩展（extensions/todo/）

移植自 `@juicesharp/rpiv-todo@2.13.8`（MIT，版权保留）。reducer、校验、环检测、selectors 原样保留；替换为 durable 原生接口：`defineTool`、会话作用域 `rewindable`/fork-asOf 文档（`app.todo`）、宿主面板挂载、`/todos` 分组列表命令与 Ctrl+Shift+T 面板折叠快捷键；原始任务顺序、树形行、条件编号、12 行内容预算、跨轮完成隐藏和可重置的纯展示状态位于独立 UI 入口 `extensions/todo/ui.mjs`。回执按 callId 保存，记录 durable taskId；64 条是回收目标，仅淘汰已确认 terminal 的任务回执。未终结任务和缺少 taskId 的旧回执不会为满足条数而被删除。

## 测试布局

- 根 `test/`：宿主与集成（print、锁、崩溃注入、todo 崩溃重放、资源装载、CLI 启动、TUI 投影）。
- `extensions/todo/test/`：todo 规则与事务文档局部测试。
- faux 模型做默认无密钥测试；真实供应商验证手动执行。

## 尚未接入

MCP、会话树浏览（`/tree`）、HTML 导出、旧 Pi 插件兼容、虚拟模型路由、`/reload`、用户 durable 扩展自动发现、除主题之外的 settings 装配、项目主题与自定义主题热重载。当前 home 的 theme 设置和自定义主题已接通，支持 `/theme` 及终端自动配色。当前 Skill 发现为 `<home>/agent/skills` 与 `<cwd>/.pi/skills`；不自动扫描 `.agents/skills`。图片未做完整终端展示适配。真实 DeepSeek 对话/工具与 Apple Terminal、Warp 交互已验收，见 [终端验收记录](tui-interaction-acceptance.md)。其他供应商完整 OAuth、Windows/Linux、旧版本存储升级仍待验收；不以默认自动化测试通过代表上述能力已验证。
