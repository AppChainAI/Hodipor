# durable 原生设计与实现审查

日期：2026-10-19。范围：`durable-native-design.md`、全部宿主源码、todo 状态与现有测试；对照本地锁定的 Pi/durable 1.3.0 实现核对接口，未重新核验远端 main。

## 1. 设计判断

方向合理，建议保留当前架构，不再引入 AgentSession 或插件兼容引擎：

- durable 统一管理执行、transcript、任务和文档，避免双主状态。
- 宿主负责 home、互斥锁、资源和 TUI，职责明确。
- 会话组分库允许不同终端并行；cwd 与 home 分离能隔离配置，但不是访问沙箱。
- todo 用事务文档而不是 transcript 重放，并在变更事务内保存回执，方向正确。

需要收紧的是**验收承诺**，不是再做一层框架：原文“第一至三阶段全部落地”超出了证据。真实供应商/OAuth、图片、主题、权限、跨平台和升级恢复不能由 faux 模型测试代替。第四阶段尚未齐备时已经切换默认入口，与原阶段门槛存在偏差；应明确当前是核心实现可用、验收未闭环，而不是宣称完整迁移。

## 2. 实现一致性

| 设计项 | 核查结果 |
|---|---|
| durable 唯一执行引擎 | 一致；没有影子 AgentSession 或双写 transcript |
| home/workspace、独立模型凭证路径 | 一致；补充私密目录创建权限与旧环境变量退出策略 |
| 会话组 SQLite、/new 独立状态 | 一致；修复切换时旧数据库仍活跃的问题 |
| 恢复沿用 cwd | 修复后工具、资源和 TUI 对齐 |
| 事务 todo、分叉继承、崩溃重放 | 主体一致；修正不安全的回执定额淘汰 |
| 快照 + 增量显示 | 主体一致；修复流式消息、工具历史、输出累积及元信息更新 |
| Skills/模板显式调用 | 装载函数存在，但原输入分支不可达；已接通 |
| 用户扩展、settings、自定义主题 | 尚未装配，不应称为完成 |
| MCP、reload、树浏览、HTML 导出 | 尚未接入；旧 Pi 插件兼容本来就不在目标范围 |

## 3. 已修复问题

| 优先级 | 问题与影响 | 修复位置与验证 |
|---|---|---|
| P1 | 补全把 `/login` 再加一个 `/`，实际得到 `//login` | `src/tui/commands.mjs`、`app.mjs`；真实 CombinedAutocompleteProvider 和 PTY Tab 补全 |
| P1 | `/new`、`/resume` 在旧 Harness/SQLite 关闭前释放锁并递归进入新 TUI；旧执行仍可写库，最终还会重复释放 | `src/session.mjs`；改为关闭后循环切换，测试确认旧 Conversation 已关闭、锁释放且新会话有模型 |
| P1 | 死亡锁的“读取、删除、重建”有跨进程竞争；空锁也可能是另一个进程刚创建尚未写完的活锁 | `src/home.mjs`；短时 guard 串行化所有权变更，损坏锁拒绝抢占；8 进程同时接管仅一个成功 |
| P1 | todo 仅按条数删除回执，可能删除尚可重放调用的幂等凭据 | `extensions/todo/state.mjs`；关联任务，仅回收 terminal 任务回执；保留提交后崩溃测试，新增超限未结算保留与已终结回收测试 |
| P1 | 无凭证启动直接退出，却提示用户使用不可到达的交互 `/login` | `src/cli.mjs`；无模型仍允许进入 TTY，非交互维持明确报错；干净临时 home 的真实 PTY 验证 |
| P1 | 流式增量拿 AssistantMessageComponent 当原消息克隆，恢复快照又丢失已完成工具 | `src/tui/transcript.mjs`；单独持有纯消息投影，由 assistant/tool-result 历史重建工具；真实 durable 提交与快照测试 |
| P2 | Skill/模板被通用 slash 分支提前返回 | `src/tui/commands.mjs`；内建命令优先，再展开 Skill/模板；输入分发回归测试 |
| P2 | 恢复时工具沿用保存的 cwd，但资源和 TUI 仍使用默认 workspace | `src/resources.mjs`、`session.mjs`；从真实 agent/env 获取目录；重开后项目上下文与 TUI cwd 测试 |
| P2 | `/model router/vendor/model` 被 split 截断，CLI thinking 被错误放入 model 引用 | `src/models.mjs`；只拆第一个斜杠，共用解析；thinking 独立配置并验证合法后缀 |
| P2 | 登录无条件使用 OAuth，API-key-only provider 无法登录；命令异常可能形成未处理 Promise | `src/tui/commands.mjs`；按 provider 能力选择登录类型，接通选择题与单步取消，命令统一显示错误并 await 异步动作 |
| P2 | 普通提示开头的 `t` 被快捷键吞掉；启动位置参数没有发送 | `src/tui/app.mjs`；只保留 Ctrl+T，接通初始 prompt；PTY 输入以 t 开头的提示并获得答复 |
| P2 | 初始化失败可能泄漏锁或 SQLite；退出路径可能不恢复终端 | `src/session.mjs`、`runtime.mjs`、`tui/app.mjs`；清理放 finally，初始化失败后可重新获取锁 |
| P2 | session ID 可包含路径跳转；私密目录按系统 umask 创建；锁记录包含完整启动提示 | `src/home.mjs`；校验 ID，新目录 0700、锁 0600，不保存 argv |
| P2 | 工具输出 append 覆盖前文，model/thinking/usage footer 只在初始快照更新 | `src/tui/transcript.mjs`；累积输出并消费 agent_changed/usage_changed |
| P2 | 生产代码直接导入包却只依赖传递安装或 devDependency | `package.json`、`bun.lock`；显式固定已使用的 chord/pi-ai/pi-codemode 为 1.3.0，没有引入新库 |

另修复 CLI 参数缺值误吞下一个选项、print 模式正常结束遗留 SIGINT 监听，以及无效具名 `/resume` 先退出再报错的问题。

## 4. 验证与剩余边界

已运行：`bun run check`、`bun run test`（35 个测试通过）；测试使用临时 home 和 faux 模型，含 SQLite 强杀恢复、todo 提交后强杀、会话切换、8 进程锁竞争、真实 durable 增量/快照。额外用真实伪终端验证 Tab login、/new、以 t 开头的输入、模型答复、/exit、锁清理，以及无凭证首次启动可进入 /login。首次审查时未访问用户 `.dev-home` 内的数据；后续用户授权的真实 DeepSeek 终端验收见第 6 节。

尚未验证或刻意未扩展：

- 真实供应商请求、完整 OAuth 浏览器回调/令牌刷新/全流程取消、secret 登录实际体验；选择题 ID 返回与单步 AbortSignal 已有自动化测试，但不代表完整供应商登录链路通过。
- Windows/Linux、网络文件系统、断电恢复、旧版本数据库升级；锁只承诺同机本地文件系统。混用新旧宿主二进制不受互斥协议保证。
- guard 操作中被强杀或锁损坏时会保守拒绝启动，须停止相关进程后核实清理；PID 重用可能造成保守拒绝，不会因此主动抢占活锁。
- 旧目录权限不会被递归修改；新建私密目录使用严格权限。共享或历史 home 的现有权限需另行核查。
- 64 是回执回收目标，不是强制上限。未知旧回执及未终结任务可以超过目标；不能以省空间为由删除重放保护。旧回执清理需另设有证据的迁移策略。
- 用户 durable 扩展发现、settings、自定义主题、完整图片展示尚未实现；`.agents/skills` 自动发现也不是当前 Pi 加载器的行为，文档已更正。
- `--continue` 按会话 ID 的创建时间排序，并非最近活动时间；后续 `/resume` 已加入可搜索选择器。fork 活动分支恢复尚无独立持久化设计。

SQLite ExperimentalWarning 是当前 Node SQLite 的上游提示，不是 `//login` 的原因；没有通过隐藏警告掩盖问题。

## 5. 后续终端交互修复

用户实测进一步暴露了两个宿主接线缺口：`/login` 仅显示名单而没有交互选择器，Ctrl+C 在 raw-mode 输入中不会产生宿主监听的 SIGINT。

- `/login` 改用 Pi 公共 `OAuthSelectorComponent`，支持搜索、方向键、回车和 Esc；同一供应商的 OAuth/API key 是独立选项，选择后保留认证类型。
- Ctrl+C 改在 TUI 全局输入监听器消费，不受编辑器、选择器或登录框焦点影响；取消当前交互后退出。SIGINT 同样走退出清理，Esc 保持取消语义。
- 初始位置参数启动 `/login` 不再阻塞退出事件循环。
- `bun run check`、37 个 Node 测试、`python3 test/tui-pty.py` 的 6 个 Unix PTY 测试及 diff check 通过。PTY 覆盖空/非空编辑器、运行中的 bash 工具、thinking 浮层、供应商搜索与取消、API key 登录输入框、启动登录选择框及锁清理。

额外观测到 `/login openai` 的 OAuth 路径报缺少安装级 device ID；需要单独接入 `LoginOptions.getDeviceId` 及独立 home 内的持久化身份。本次未扩展处理，也未声明完整真实供应商登录已通过。

## 6. 菜单统一与可见终端验收

根据用户截图，将 `/model`、`/thinking` 与登录菜单统一为编辑器位置的内联交互，移除居中浮层；由单一 editor slot 管理焦点、组件清理和过期回调。思考等级按模型能力生成，`/resume` 无参数改为可搜索的实际会话列表。

用户随后授权使用 `.dev-home` 中已配置的 DeepSeek。已打开 Apple Terminal，并在独立 Warp 窗口复测：真实对话、工具/todo、取消后继续、会话新建/恢复/分叉/reset、compact 无操作反馈及退出均通过。实测发现并修复会话切换残留视口、通知到期不重绘及 compact 缺少终结反馈；47 个 Node 测试、9 个 PTY 测试、类型检查和 diff check 通过。

完整矩阵、截图位置、验收存储与未覆盖项见 [TUI 交互验收](tui-interaction-acceptance.md)。
