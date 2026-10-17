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
2. `/login` 走 OAuth 对话框；`/model`、`/thinking` 打开选择器；`/help` 列出命令。
3. 发起请求后看到流式文本与工具执行卡片；Esc 停止当前工作，随后可继续发送。
4. 让模型用 todo 工具建任务：面板出现在输入框上方并随状态更新；`/todos` 输出分组列表。
5. `/fork` 后 todo 面板保留分叉点列表；`/new` 后面板清空。
6. `/compact` 后对话继续；`/exit` 或 Ctrl+D 退出，终端状态恢复干净。

## 恢复

1. 对话中途强制关闭终端（或 kill 进程）；`siftory --continue` 重开：历史完整，未完成的运行继续，bash 未重跑。
2. 同一 `--session` 第二次启动被拒绝（owner lock）；kill 掉的进程残留锁可被接管。
3. `--home` 指向临时目录时，不读写 `~/.siftory` 与 `~/.pi`。

## print 模式

```sh
bun run start --print "说明当前工作目录" --home /tmp/siftory-dev
echo "管道输入" | bun run start --home /tmp/siftory-dev
```

无 TTY 输入输出时自动走 print 模式；Ctrl-C 中止并以非零码退出。

## Skills 与模板

`<home>/agent/skills/x/SKILL.md` 与 `<home>/agent/prompts/y.md` 放置后：系统提示含技能索引但不含正文；`/skill:x 参数` 注入正文；`/y 参数` 展开模板。
