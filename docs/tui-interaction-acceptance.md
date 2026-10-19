# TUI 交互修复与真实终端验收

日期：2026-10-19。

## 修复范围

- `/login`、`/model`、`/thinking`、`/resume` 都在编辑器位置显示，取消 60% 宽的居中浮层，不再同时保留两个输入区域。
- `src/tui/editor-slot.mjs` 统一输入焦点、替换与清理；按组件身份忽略过期回调，关闭模型菜单时取消后台目录刷新。
- 原生菜单与主编辑器使用同一份按键配置。Esc 取消，Ctrl+C 退出，不再出现菜单提示 Ctrl+C 取消但实际退出的冲突。
- `/thinking` 根据当前模型能力列出等级，使用有界、可搜索的 Pi TUI 选择列表；不展示宿主尚未实现的保存默认值/循环切换快捷键。
- `/resume` 无参数时真正打开可搜索的会话列表，不再悄悄打开最新存储；当前会话有标记，确认当前项不重启。
- `/new`、`/resume` 清理当前视口后绘制新会话；历史数据库及终端滚动历史不删除。
- `/compact` 等待持久任务终结，区分完成、没有可压缩内容和失败；压缩期间的 busy 状态由已提交事件更新。
- 临时通知到期清空后主动重绘；退出后不再接收迟到通知创建计时器。

## 自动回归

```sh
bun run check
bun run test
python3 test/tui-pty.py
git diff --check
```

最终结果：类型检查通过，47 个 Node 测试通过，9 个 Unix PTY 测试通过，diff check 通过。

覆盖单焦点/单光标、组件过期回调、清理、模型刷新取消、思考能力、会话搜索、长列表限高、窄窗口、连续打开与取消菜单、选择后继续输入、会话切换清屏、工具运行中退出及锁释放。

## 可见终端实测

用户授权使用已配置的 DeepSeek API key；没有读取、复制、显示或更改密钥内容。使用 `.dev-home` 下新建的验收会话，不接管用户原有会话。

环境：macOS、Node 22.23.3，Apple Terminal 120×34 与 54×28；另在用户截图所用 Warp 的独立测试窗口中复测。

| 项目 | 实测结果 |
|---|---|
| `/model` | 搜索 DeepSeek、确认当前模型、Esc 返回；全宽内联、只有一个搜索光标；窄窗口不产生中央悬浮框 |
| `/thinking` | DeepSeek Flash 实际能力为 off/low/high/max；过滤 low、回车后 footer 更新，重启后保留；Esc 不改变选择 |
| `/login` | 搜索 DeepSeek，显示已有 API key 配置；Esc 返回，不提交新凭证 |
| `/resume` | 搜索并选中本次验收存储；恢复 transcript、工具结果、todo 与模型配置 |
| `/new` | 创建独立会话，当前视口清空，todo 面板从空状态开始 |
| `/fork` | 分叉继承历史与 todo 面板；当前数据库组保持不变 |
| `/todos` | 显示真实 todo 工具提交的任务，与面板一致 |
| 中文输入/模型请求 | DeepSeek 返回 `SIFTORY_UI_OK`，文本显示与用量更新正常 |
| 工具调用 | 实际创建「终端验收任务」，bash 执行 printf，输出 `SIFTORY_TOOL_OK` |
| Esc 中断 | 在真实 bash `sleep 20` 执行期间取消，显示 aborted；随后能获得 `CANCEL_RECOVER_OK` |
| `/compact` | 该验收上下文无需压缩，显示 `nothing to compact`；不再停留在 compacting；确认持久任务已终结 |
| `/reset` | 显示 new context，现有 todo 按设计保留 |
| 退出 | Ctrl+C、空输入 Ctrl+D、`/exit` 都返回 shell；验收存储的 owner.lock/owner.guard 全部释放 |
| Warp 复测 | `/model`、`/thinking`、`/resume` 均内联，Esc 返回可继续输入，Ctrl+C 返回 Warp shell |

截图保存在本地 `output/tui-acceptance-2026-10-19/`：`terminal-model.png`、`terminal-model-narrow.png`、`new-session.png`、`deepseek-tools.png`、`warp-model.png`、`warp-resume.png`。截图只含验收内容，不含密钥。

## 验收数据与清理

保留本次生成的三个独立验收存储，方便复查，没有删除或覆盖用户旧会话：

- `20261019-09-23-40-qkyxul`：主验收会话，含真实工具结果和一次分叉。
- `20261019-09-25-37-kd7e04`、`20261019-09-29-33-q67368`：`/new` 隔离与恢复验收。

所有本次启动的 Siftory 进程已正常退出，三个存储均无遗留锁。关闭额外 Warp 测试窗口，保留用户原 Warp 窗口；Apple Terminal 验收窗口停在 shell。

## 后续样式补齐

用户随后指出原生工具卡片和主题仍未完整接线。已补齐专用 renderer、codemode 嵌套成功/失败摘要、todo 状态样式、工具/面板折叠和 home 主题设置，并重开原问题会话验证；详见 [展示层样式验收](tui-display.md)。后续逐项对照又修正了简化 todo、运行指示与 Warp /new 原点问题；当前 Ctrl+T 折叠思考，Ctrl+Shift+T 折叠 todo。本页上方的测试计数与截图描述保留为菜单修复阶段的历史记录。

## 未覆盖边界

- 没有执行真实 `/logout`、覆盖现有凭证或发送有破坏性的文件工具请求。
- 真实 DeepSeek 链路已通过；其他供应商完整 OAuth、Windows/Linux 桌面仍未验收。此前记录的 OpenAI OAuth 安装 device ID 缺失未在本轮扩展处理。
- 真实 `/compact` 本次只覆盖无操作路径；生成压缩摘要的完整模型链路未以大上下文强行触发。
- 会话选择器当前展示存储 ID，没有生成会话标题；fork 活动分支跨进程恢复仍未设计为独立的宿主持久状态。
