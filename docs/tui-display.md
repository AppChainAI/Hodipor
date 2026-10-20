# TUI 展示层与样式验收

2026-10-19，第二次逐项对照后的结果。本页以当前实现为准，取代此前将简化 todo 展示称为“已迁移”的描述。durable 仍是唯一执行与业务状态来源。

## 原版对照结果

对照 `rpiv-todo@2.13.8` 的 `view/format.ts`、`state/selectors.ts`、`todo-overlay.ts` 及 Pi 1.3.0 的编辑器、状态指示器、页脚和主题实现：

| 区域 | 当前结果 |
|---|---|
| todo 工具标题 | 创建显示弱化标题；更新/读取/删除解析真实任务标题，不再只有 `#id`；列表可显示筛选状态 |
| todo 工具结果 | 原动作/状态符号、颜色和英文默认标签；completed 使用 `●`，区别于面板中的 `✓`；查询/清空保持紧凑 `✓`，错误内容始终可见 |
| todo 面板 | `●/○ Todos (done/total)`、`├─/└─`、原始任务顺序、上下留白；只有存在依赖时显示编号；保留 activeForm 和依赖引用 |
| 完成态 | 弱化并划线；使用 Pi `theme.style({ strikethrough: true })`，不再受 Chalk 是否启用颜色影响；回归断言真实 SGR 9，而非只验证方法被调用 |
| 溢出 | 原默认 12 个内容行，含标题/汇总，不含上下留白；优先隐藏较新的完成项，再裁剪未完成尾部；Ctrl+O 展开全部任务 |
| 面板生命周期 | 本轮展示过的完成项到下一轮才隐藏；折叠时不标记为已展示；重开/压缩后重置展示追踪；不修改 todo 文档 |
| 快捷键 | Ctrl+O 展开工具和任务；Ctrl+T 折叠思考；Ctrl+Shift+T 折叠 todo 面板。修正了此前用 Ctrl+T 占用 todo 的实现 |
| 工作状态 | 原生动画嵌入编辑器上边框；菜单替换编辑器时移到菜单上方，返回后恢复；结束/退出清理计时器 |
| 其他运行阶段 | 区分工作、压缩/溢出压缩、重试倒计时和供应商延迟等待；消费 durable 已提交事件及重开快照，不猜测重试上限；终端进度和 Program Status 同步工作/空闲 |
| 编辑器 | 使用活动主题的 thinking-level 边框，不再捕获启动时的旧主题对象；off 使用弱化边框，high 等等级使用相应主题色 |
| 空会话首屏 | 启动标题和仅包含已实现交互的快捷提示；首次启动、/new、恢复共用组件 |
| 页脚 | 两行目录/会话、用量/缓存/费用/上下文及右对齐模型/思考等级；用 durable 的模型上下文计算展示统计；压缩后尚无新回复时占比显示未知，不沿用旧占比 |
| 自建菜单/分隔线 | 思考、会话和主题菜单标题/提示及历史分隔线使用可重绘的主题文本；`/todos` 的只读分组快照也随主题重绘 |
| 常规消息/工具 | 继续复用 Pi 用户/助手消息、专用工具和 codemode renderer；实时与恢复一致 |

### `/new` 的 Warp 遮挡问题

真实 Warp 验收发现：旧实现的 `clearScreen()` 同时发送绝对 cursor-home，新的标题画在 Warp 固定命令栏后面。AX 树和原始输出都有标题，实际像素却看不到，不能仅凭文本存在判断通过。

切换存储时现在只清可见屏幕，保持当前光标原点，再由新的 TUI 相对绘制；不主动清除滚动历史。PTY 回归检查切换不发送绝对 home，并在 Warp 中重新实测标题、编辑器和页脚均可见。

## 保持的展示契约

- read/write/edit/bash 使用 Pi 专用 renderer，保留路径、代码、diff、命令及有界输出预览。
- codemode 实时嵌套调用汇总到父卡片；结束后使用已提交的 `details.calls`，不重复堆放子卡片。
- 普通嵌套结果按 `structuredOutput/details/isError/diagnostics` 处理；缺少回执显示 `result unavailable`，不捏造成功或中断。
- 历史 edit 只显示 durable 保存的真实 diff，不根据当前磁盘重算历史预览。
- 终端颜色查询、亮暗通知、迟到回复和退出清理继续生效。`/theme` 支持 system、dark、light、亮暗配对和当前 home 的自定义主题，保存时保留其他设置。
- 中文句号/空白结尾不会再触发空前缀文件补全劫持第一次回车，显式 Tab 补全保留。

## 自动验证

```sh
bun run check
bun run test
python3 test/tui-pty.py
git diff --check
```

类型检查、75 个 Node 测试、13 个 Unix PTY 测试及 diff check 通过。新增覆盖原版 todo 布局/溢出/隐藏生命周期、真实划线控制码、持久化任务标题、思考折叠、运行阶段/快照恢复、原生动画及计时器清理、主题重绘、两行页脚和 `/new` 的 Warp 原点回归。

## 可见终端验收

本轮使用独立 home `/tmp/hodipor-style-v2-20261019`，模型运行时仅复用 `.dev-home/agent` 已配置的 DeepSeek。没有复制/显示密钥，没有对用户会话发送提示，也不修改其主题设置或工作文件。

可重复启动相同的手动验收入口（会产生真实模型费用）：

```sh
node test/helper-real-cli.mjs .dev-home/agent \
  --home /tmp/hodipor-style-v2-20261019 \
  --model deepseek/deepseek-flash
```

此入口必须传独立 `--home`，不要在其中执行 `/login` 或 `/logout`，因为模型认证仍来自提供的 credential agent-dir。

- Apple Terminal 浅色系统配色：真实 DeepSeek 一轮 codemode 创建三个有依赖的任务，完成第一项、推进第二项并执行 `sleep 12`。观察到实时树形面板、嵌套进度、边框动画及用量统计。
- 第二轮只直接调用 todo，完成余下任务；卡片显示实际标题及 `● completed`/`◐ in progress`。面板不再显示前一轮已完成的第一项，证明下一轮隐藏生效。
- Warp 深色终端：重开同一验收存储，显示三个完成项和真实划线；实际 Ctrl+Shift+T 可折叠，展开提示正确。
- Warp：`/theme light/dark`、`/new`、`/thinking` 选择 high、`/theme` 选择 system、`/resume`。确认 `/new` 标题不被遮挡，空列表/零上下文/无旧费用；high 边框变色；恢复后全部任务重新显示。
- 本轮旧验收会话 `20261019-15-18-53-50b4kv` 三项任务均完成；另两个空存储仅用于 `/new`。测试进程已退出，三个存储均无 owner lock/guard；验收 home 未创建 auth.json，workspace 仍为空。

截图目录：`output/tui-acceptance-2026-10-19/style-v2/`。

- `terminal-working.png`：实时任务树、codemode 子状态和工作动画。
- `terminal-todo-direct.png`：直接 todo 卡片与跨轮隐藏。
- `warp-todo-restored.png`：深色恢复、实际标题、完成划线和两行页脚。
- `warp-todo-collapsed.png`：真实 Ctrl+Shift+T 折叠。
- `warp-new-before-origin-fix.png` / `warp-new-session.png`：实际遮挡与修复后的空会话。
- `warp-thinking-high.png` / `warp-theme-selector.png`：思考边框与主题菜单。

此前 14 时段验收记录和截图保留为历史证据；其六行 todo 简化布局和 Ctrl+T 绑定已由本次对照修正，不再代表当前实现。

## 仍未迁移或未验收

- todo 使用原版英文默认文案、12 行预算和 Ctrl+Shift+T；没有读取个人 rpiv-config/rpiv-i18n 配置，也没有接入其自定义行数/快捷键配置及运行时语言切换。
- 页脚没有接入 Git 分支监听、第三方扩展状态、虚拟模型路由、订阅和缓存预热标记；不构造旧 AgentSession 来伪装这些数据。
- 自定义主题热重载、项目主题信任、图片终端适配尚未实现。本轮没有实现新的全屏模式或旧插件运行时。
- 重试/压缩状态由真实 durable 提交事件的回归和原生指示器测试覆盖；没有为了截图强迫付费供应商失败，或填满上下文触发真实压缩。
- Windows/Linux 桌面、其他供应商 OAuth 未做视觉验收；OpenAI OAuth 的安装 device ID 仍是独立待办。

## 维护约束

`src/tui/pi-display.mjs` 是唯一的 Pi 内部展示模块接入点，包含独立 renderers、原生状态/主题文本组件及展示计算辅助函数。Pi 未公开导出全部这些接口，依赖固定为 1.3.0；升级必须重跑展示与终端回归。

没有借用旧工具执行函数、AgentSession 或插件宿主。所有折叠、完成项隐藏、动画和页脚统计都是可丢弃的只读投影，不成为新的业务状态来源。
