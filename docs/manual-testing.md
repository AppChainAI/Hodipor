# 手动验收

自动检查：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test
```

模型链路测试使用官方 faux provider，不发送真实付费请求。真实模型验证手动执行。

## 交互终端

使用支持的终端启动 `bun run start`：

1. 输入框可输入中文、多行和粘贴文本；缩窄终端后输入框可用。
2. `/login` 打开可搜索的供应商选择框，OAuth/API key 分别列出；输入关键字、上下选择、回车确认，Esc 返回编辑器。`/model`、`/thinking`、`/resume` 同样在编辑器位置显示，不保留第二个输入区域；思考等级按当前模型能力显示。`/login <provider>` 仍可直接登录；`/help` 列出命令。
3. 发起请求后看到流式文本、工具执行卡片和编辑器边框上的原生工作动画；打开菜单时动画移到菜单上方，结束后清除。选择不同思考等级后边框颜色随活动主题变化，Ctrl+T 折叠思考。Esc 停止当前工作，随后可继续发送。
4. 让模型直接或经 codemode 用 todo 建任务：面板使用状态色，完成项划线；子调用成功不能显示 interrupted。面板按原顺序显示树形行，只有有依赖时显示编号；Ctrl+O 展开工具和完整任务，Ctrl+Shift+T 折叠面板，`/todos` 输出分组列表。完成项本轮保留、下轮隐藏，重开后重新显示。
5. `/fork` 后 todo 面板保留分叉点列表；`/new` 后面板清空，启动标题和两行目录/统计/模型页脚完整显示，统计不继承旧会话。尤其在 Warp 中检查真实像素，不能只确认原始输出有标题。
6. `/compact` 区分压缩完成、无须压缩和失败；临时提示到期后消失。切换 `/new`、`/resume` 后视口不残留上一会话。`/exit`、Ctrl+C 或空编辑器上的 Ctrl+D 退出，终端状态恢复干净。Ctrl+C 在选择框/登录输入框中也应退出，Esc 只取消当前交互。

macOS/Linux 可额外运行真实伪终端回归（需要 Python 3，不使用真实凭证）：

```sh
python3 test/tui-pty.py
```

覆盖空/非空编辑器、运行中的 bash 工具及原生动画、首次启动无凭证自动打开供应商选择、内联菜单连续打开/搜索/确认/取消、窗口缩放、会话切换清屏及不跳绝对原点、主题与新会话页脚、供应商选择与登录输入框、Ctrl+C 退出及锁清理。

2026-10-19 的 Apple Terminal/Warp + 真实 DeepSeek 验收结果见 [交互验收记录](tui-interaction-acceptance.md) 和后续 [展示层样式验收](tui-display.md)。

`/theme` 可选择当前 home 的主题；`/theme light/dark` 随终端亮暗配色，默认 `system`。自定义主题放在 `<home>/agent/themes/*.json`，修改后重启生效。

## 恢复

1. 对话中途强制关闭终端（或 kill 进程）；`hodipor --continue` 重开：历史完整，未完成的运行继续，bash 未重跑。
2. 同一 `--session` 第二次启动被拒绝（owner lock）；kill 掉的进程留下有效死亡 PID 锁时可自动接管。若报 owner.guard 或锁损坏，先确认所有相关进程已停止再核实清理，不能直接删除活锁。
3. `--home` 指向临时目录时，不读写 `~/.hodipor` 与 `~/.pi`。

## print 模式

```sh
bun run start --print "说明当前工作目录" --home /tmp/hodipor-dev
echo "管道输入" | bun run start --home /tmp/hodipor-dev
```

无 TTY 输入输出时自动走 print 模式；Ctrl-C 中止并以非零码退出。

## Skills 与模板

`<home>/agent/skills/x/SKILL.md` 与 `<home>/agent/prompts/y.md` 放置后：系统提示含技能索引但不含正文；`/skill:x 参数` 注入正文；`/y 参数` 展开模板。
