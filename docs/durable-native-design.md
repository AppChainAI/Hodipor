# Hodipor durable 原生产品设计

更新日期：2026-10-19。

**状态：核心架构已实施，第一至三阶段的验收尚未全部闭环，第四阶段部分接入。** 当前程序为 durable 原生实现，实际行为见 [当前架构](architecture.md)，本次核查与修复见 [设计审查](durable-native-review.md)。本文保留目标设计与取舍记录，不以“有实现”代替真实供应商、OAuth、跨平台和升级恢复验收。

## 1. 目标与范围

Hodipor 重构为 durable 原生产品，尽量复用 Pi 已有的核心模块。需要的 Pi 插件移植为 durable 原生扩展，不建设通用 Pi 插件兼容层。

- durable 唯一拥有主会话、输入队列、模型执行、工具任务、压缩和业务文档。
- Hodipor 拥有 CLI/TUI、资源装配、扩展装配、路径与存储生命周期。
- Pi 提供模型与认证、资源加载、终端渲染及可复用显示组件，不再作为整套运行中的宿主。
- 保持通用 Agent 定位，不预设研究、视频等业务管线。
- 支持指定独立运行根目录，开发配置、凭证和数据不污染日常环境。

不保留第二个 `AgentSession` / `SessionManager` 作为影子主会话，不双写两套 transcript，不模拟整个 `ExtensionAPI`。不承诺旧插件即装即用或旧会话无损转换。

## 2. 运行架构

```text
Hodipor CLI / TUI 宿主
  ├─ Pi ModelRuntime → 模型、凭证、OAuth、模型配置
  ├─ Pi 资源模块 → Skills、项目上下文、提示词、主题
  ├─ pi-tui + Pi 显示组件 → 输入、消息、工具结果、面板
  └─ durable Harness（唯一执行引擎）
       ├─ Conversation / inbox / compaction / task scheduler
       ├─ CodingTools + NodeExecutionEnv
       ├─ durable 原生扩展 → 会话文档
       └─ SQLite storage
```

TUI 只持有布局、焦点、选择、折叠等显示状态。对话、执行状态和 todo 的权威数据在 durable；UI 从已提交快照初始化，再消费增量，重连或慢消费触发快照时重建投影。

## 3. Pi 模块复用

| 模块 | 使用方式与宿主职责 |
|---|---|
| Pi `ModelRuntime` | 实现 pi-ai `Models`，符合 `HarnessOptions.models` 接口，作为首选模型接入点；显式传入独立配置路径，装配登录、模型选择和刷新 |
| durable `CodingTools` / `NodeExecutionEnv` | 直接采用原生文件与进程工具，不包装旧工具执行循环；处理绝对 cwd、图片、输出限制和取消 |
| Pi `loadSkills` / `formatSkillsForPrompt` / `loadProjectContextFiles` | 复用发现、描述索引和项目上下文加载；内容进入 durable prompt sections，Skill 全文仍按需读取 |
| Pi `DefaultResourceLoader` | 优先验证关闭旧扩展加载后的复用；若耦合过重，使用较小的公共函数，不复制整个加载器 |
| `pi-tui` | 复用终端渲染、布局和基础控件；宿主管理输入、焦点、退出和恢复 |
| Pi 消息组件、`CustomEditor`、主题 | 优先复用公共导出，逐个验证初始化与依赖，不从零重写消息显示和编辑器 |
| Pi `ToolExecutionComponent` | 复用显示能力；只在显示入口将 durable 的 `output` 映射为组件需要的 `content` |
| 完整 `InteractiveMode` / `AgentSession` / `SessionManager` | 不作为新运行时复用，交互控制层重新装配 |
| durable codemode / tool-search | 使用 durable 原生实现，不引入第二套执行循环 |
| MCP | 单独接入客户端与传输能力，处理配置、认证、连接、取消和 replay 策略；旧 Pi `createMcpExtension` 不能直接注册到 durable |

继续依赖 coding-agent 包以使用公共模块没有问题，不为“durable 原生”复制上游源码或强行移除依赖。

接口匹配不等于运行兼容：ModelRuntime 的真实供应商调用、OAuth 和自定义模型配置须验证。虚拟模型路由涉及额外宿主逻辑，不能默认继承。`/skill:name`、模板展开、资源刷新、模型切换等操作都需要新宿主接线。

## 4. 源码仓库目录

扩展在仓库根目录独立组织，不放在宿主 `src/` 内。

```text
Hodipor/
├─ src/
│  ├─ cli.mjs                 启动、参数解析、退出处理
│  ├─ home.mjs                路径解析、目录初始化、存储独占
│  ├─ models.mjs              Pi ModelRuntime 装配
│  ├─ resources.mjs           Skills、项目上下文、提示词加载
│  ├─ runtime.mjs             durable、存储、环境与扩展装配
│  └─ tui/
│     ├─ app.mjs              布局、输入、交互生命周期
│     ├─ transcript.mjs       快照与增量投影、消息和工具展示
│     └─ commands.mjs         登录、模型选择、会话与压缩命令
│
├─ extensions/
│  └─ todo/
│     ├─ package.json
│     ├─ index.mjs            durable 扩展入口
│     ├─ state.mjs            文档、事务与调用去重
│     ├─ reducer.mjs          任务规则与状态变更
│     ├─ view.mjs             任务面板与结果格式化
│     ├─ test/
│     └─ LICENSE
│
├─ test/                      宿主、集成与恢复测试
├─ docs/
├─ package.json
├─ bun.lock
├─ README.md
└─ LICENSE
```

这是职责划分，不要求提前建立所有文件；按实际复杂度拆分。遵循现有 `.mjs` 结构，不把本次迁移扩大为语言或构建链迁移。

- `runtime.mjs` 是装配入口，不是第二套 Agent 引擎。
- 不新建一套基础文件工具，不预建空 MCP、服务或通用适配器目录。
- 每个扩展拥有自己的依赖声明、测试和许可证，保留独立发布的可能，但不提前增加发布管线。
- 核心通过扩展入口装配，不直接导入扩展内部状态或 reducer。
- 工具、文档、hooks、tasks 使用 durable 原生接口；面板、命令和快捷键使用宿主装配。先由 todo 的实际需求确定最小 UI 接入契约，不预先设计通用框架。

## 5. 应用 home 与 Agent workspace

### 命名与参数

区分两个概念：

- **Hodipor home**：配置、凭证和运行数据的独立根目录，默认 `~/.hodipor`。
- **Agent workspace**：默认文件工作目录，位于 `<home>/workspace/`，不是应用状态根目录。

`--home` 指定应用根目录，`--cwd` 指定工具工作目录；默认工作子目录使用 `workspace/`，不再使用早期草案中的 `work/`。早期将根目录称为 `--workspace` 的草案不再与此并列；上述参数已实现。

```sh
hodipor
# home = ~/.hodipor
# cwd  = ~/.hodipor/workspace

hodipor --home /path/to/dev-hodipor
# home = /path/to/dev-hodipor
# cwd  = /path/to/dev-hodipor/workspace

hodipor --home /path/to/dev-hodipor --cwd /path/to/project
# 配置、凭证和数据库仍归 dev-hodipor，工具操作 project
```

不指定参数时不再默认采用启动 shell 的 cwd，这是相对于当前产品行为的明确变更。

### 运行目录

```text
<hodipor-home>/
├─ agent/
│  ├─ auth.json                API key / OAuth 凭证
│  ├─ models.json              自定义模型配置
│  ├─ settings.json            用户偏好与资源配置
│  ├─ skills/
│  ├─ prompts/
│  ├─ themes/
│  └─ extensions/              用户安装或编写的 durable 原生扩展
├─ sessions/
│  └─ <session-id>/
│     ├─ state.sqlite          durable 数据库
│     └─ owner.lock            宿主独占记录，具体机制待实现验证
├─ logs/                       宿主日志
├─ tmp/                        宿主临时产物
└─ workspace/                  默认工具 cwd
```

仓库 `extensions/` 保存随项目开发分发的扩展源码；`<home>/agent/extensions/` 保存用户扩展。二者使用相同的 durable 执行接口，不加载旧 Pi 插件工厂来伪装兼容。

### 路径与隔离规则

- 相对 `--home`、`--cwd` 均以启动时的 cwd 解析，在入口转成绝对路径，避免二次拼接。
- `--cwd` 只影响工具工作目录和项目资源发现位置，不改变凭证、数据库或日志归属。
- 新会话持久化解析后的 cwd；恢复默认沿用原 cwd，显式覆盖作为会话配置变更处理。
- 模块使用显式配置路径，不修改全局 HOME；目录按需创建，凭证和私密数据使用严格权限。
- 多个 home 不自动共享会话或凭证，不自动继承个人 Pi 配置，不自动复制密钥。
- 保留 `agent/` 配置布局以减少迁移；`HODIPOR_AGENT_DIR` 已退出。若只设置该变量，入口报错要求改用 `--home`；显式 `--home` 优先，不静默改读默认凭证。
- 宿主配置、数据、临时产物和日志尽量集中到 home。共享 Skills 等外部发现路径必须明确；严格开发隔离时显式限制发现范围。
- home/workspace 不是访问沙箱，工具仍可能访问外部路径；第三方工具、包管理器和供应商可能另有缓存。
- home 含凭证和私密会话，不应默认提交到项目仓库。

### 开发与测试

源码和开发运行数据分开：

```sh
bun run start --home /Volumes/UWorks/Projects/Test/hodipor-dev
bun run start --home /Volumes/UWorks/Projects/Test/hodipor-dev --cwd /path/to/project
```

以上命令已生效。自动化测试必须使用临时 home，不能默认打开真实 `~/.hodipor`。

## 6. SQLite 与会话生命周期

数据库路径为 `<home>/sessions/<session-id>/state.sqlite`。这里的 session-id 标识一组独立 durable 存储，不是项目目录 ID，也不是某个子 Agent 的 Conversation ID。

每份数据库保存本会话组的：

- transcript 与模型/agent 配置；
- 输入队列、执行 task、检查点及恢复状态；
- token 与费用统计；
- todo 等扩展文档。

同一 Harness 内的分叉、子会话共用数据库，不为每个子 Agent 建库。`/new` 创建独立的新会话组和存储，扩展状态从初始值开始；组内分叉使用 durable fork，并按文档策略继承状态。会话发现与切换由宿主管理，切换前关闭或释放旧存储所有者，不丢弃其已提交工作。

采用会话组分库，而不是全局单一 `state.db`，以允许多个终端打开不同存储。同一份存储只能由一个进程拥有，durable 不提供跨进程锁；宿主必须实现独占、重复打开拒绝及崩溃后的安全恢复。仅创建一个锁文件不足以证明独占正确。

多个会话即使数据库不同，仍可能通过工具操作相同工作文件；存储独占不等于文件操作隔离。

SQLite WAL 模式会在旁边产生 `state.sqlite-wal` 和 `state.sqlite-shm`。备份使用 SQLite 一致性备份，或正常关闭数据库后备份；不能运行时只复制主文件。

## 7. durable 原生扩展与 todo 移植

首个移植对象为项目当前使用的 `@juicesharp/rpiv-todo@2.13.8`。其 MIT 许可证、版权说明、来源和基线版本必须保留，不修改 `.pi/npm/node_modules` 中的安装产物。

### 复用与替换

复用 schema、任务类型、迁移校验、依赖环检测、selectors、纯 reducer `applyTaskMutation()`，以及适用的格式化和面板布局逻辑。

替换：

| 原实现 | durable 原生实现 |
|---|---|
| `pi.registerTool` | durable `defineTool` |
| 工具 guidance | prompt section |
| 内存 store + `appendEntry` + 分支 replay | 会话作用域事务文档 |
| Pi 生命周期事件 | durable 文档订阅与宿主 UI 生命周期 |
| `ctx.ui.setWidget` | 宿主任务面板挂载点 |
| Pi 命令和快捷键注册 | 宿主注册 `/todos` 与快捷键 |

```text
工具参数 → schema 校验
        → api.commit：读 todo 文档 → reducer 校验和变更 → 写文档与回执
        → 返回 output/details
        → UI 订阅已提交文档，刷新面板
```

不把模块级内存 store 当第二份权威状态。TUI 面板和显示组件只消费已提交状态。

### 分叉、压缩与恢复

- 压缩保留 todo 文档，不依赖旧 transcript 重建列表。
- 采用 `history: "rewindable"` + `fork: "asOf"`，继承分叉位置的列表，须实测验证。
- 新会话使用空列表；`reset()` 不自动清文档，不能把它当作新会话的替代。
- `create` 不是天然幂等。状态已提交、工具结果未提交时崩溃，盲目重跑会重复创建。
- 在同一状态事务中按稳定调用身份保存变更回执；重试返回原结果，不再次执行 reducer。回执不能无限累积，也不能在可能重放时过早删除。
- 完成崩溃注入验证后才允许声明 `replay: "safe"`，不能仅凭工具是本地操作就开启安全重放。

用户看到的 todo 是规划清单，durable task 是执行任务，二者保持独立；todo 标记完成不代表执行任务已完成。

## 8. 恢复承诺与限制

根据上游契约：

- 输入、任务、状态和输出先提交，再向观察者展示；持久存储重开后可恢复未完成工作。
- `requestId` 去重输入接纳，不替外部 API 实现幂等。
- 中断工具仅在声明安全重放时自动重跑；其他工具返回 interrupted。外部效果与本地提交不是同一个事务，不承诺任意 bash、发信或支付恰好执行一次。
- 部分输出默认约每 100ms 提交，不是恢复原网络连接或进程内存。
- 首版退出即暂停、重开恢复，不引入后台服务。关终端后持续运行需要以后另设 worker。
- SQLite 默认 WAL + synchronous NORMAL 可抵御进程崩溃，不保证断电不丢最新提交。
- durable 仍为 Experimental。锁定整组兼容依赖，恢复时校验任务定义和版本，升级须验证旧存储恢复。

## 9. 迁移阶段与验收

### 第一阶段：执行与恢复基线

装配 ModelRuntime、durable、SQLite、CodingTools 和独立 home；完成 print 模式、输入提交、取消、退出、重开、存储独占和故障处理。

### 第二阶段：可日用 TUI

复用 pi-tui 与消息/工具显示组件；完成输入、流式、工具进度、登录、模型切换、Esc、新会话、恢复、分叉和压缩。验证快照初始化与增量显示一致。

### 第三阶段：资源与 todo

接入 Skills、项目提示词和显式 Skill 调用；移植 todo 事务状态、回执、工具、面板、命令和快捷键。todo 是首版默认入口切换门槛，不是上线后补齐项。

### 第四阶段：外围能力与切换

逐项接入 MCP、codemode、模板、reload 及其他确认必需能力，不静默丢失原有功能。能力清单通过后再切换默认入口、删除旧 main 调用并同步文档。

开发阶段可以并存入口，但不能用两个引擎管理同一份会话。旧 Pi JSONL 留在原处，不自动转换、不主动删除；如需迁移，另行设计显式导入。

### 测试要求

- 临时 home 的默认/自定义路径、相对路径、cwd 覆盖、权限与开发隔离。
- 模型真实调用、自定义配置、认证、OAuth token 刷新与独立凭证路径。
- Skills 描述索引、按需加载、项目优先级、信任检查；旧 `.pi/settings.json` 不意外执行 Pi 插件。
- TUI 初始化、流式、工具与图片展示、主题、恢复快照和退出清理。
- 强杀后恢复；已完成工具不重复；不安全工具 interrupted；todo 变更提交与结果提交之间崩溃不重复创建。
- todo 规则、依赖校验、并发更新、压缩、分叉、新会话隔离及回执保留/清理。
- 存储双开拒绝、锁所有者崩溃、不同存储并发打开与安全备份。
- Windows/macOS/Linux、Node SQLite 支持以及版本升级后的存储恢复。

宿主测试放根 `test/`；todo 规则和局部状态测试放 `extensions/todo/test/`，跨宿主链路在根集成测试覆盖。沿用 faux 模型做默认无密钥测试，真实供应商验证单独执行。

## 10. 设计依据

Pi 接口核对基于本地 1.3.0；上游阅读基线为 main SHA `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`，不是对未来 main 的兼容承诺。

- [durable README](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/durable/README.md)：持久任务、工具重放、存储、观察、分叉、压缩与实验性声明。
- [durable HarnessOptions](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/durable/src/harness/types.ts)：模型接入与工具契约。
- [Pi 公共导出](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/index.ts)、[ModelRuntime](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/model-runtime.ts)：资源、显示与模型模块的复用接口。
- [Pi SDK](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/sdk.ts)、[InteractiveMode](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/modes/interactive/interactive-mode.ts)：当前宿主与 AgentSession 耦合，不直接作为 durable 引擎插槽。
- [durable coding-agent 示例](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/durable/test/examples/26-coding-agent.ts)：工具、cwd 和 settings 装配，不是完整 Pi CLI。
- 本项目安装的 `@juicesharp/rpiv-todo@2.13.8` 源码：工具注册、reducer、分支 replay、内存 store 与面板生命周期。

同类产品目录参考：

- [OpenClaw Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)：默认 `~/.openclaw/workspace`，配置与运行数据库置于工作目录之外、应用根之内。
- [Hermes Configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)：配置集中在 Hermes home；CLI 默认 cwd 是启动目录，Hodipor 不采用这个默认值。
- [Hermes Session Storage](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md)：home 下的 `state.db` 与单写 gateway；不能据此认为多个 durable CLI 可共享同一存储。

上述接口是设计时核对基线。当前 faux 模型、SQLite 崩溃恢复、todo 提交后崩溃重放、TUI 投影与终端补全/切换已有实测；真实供应商、完整 OAuth、跨平台及旧版本存储升级仍待验收，详见设计审查。
