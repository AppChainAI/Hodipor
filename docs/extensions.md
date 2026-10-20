# 扩展 Hodipor

Hodipor 使用 durable 原生扩展接口（`defineExtension` / `defineTool` / `section`），没有通用 Pi 插件兼容层。仓库内 `extensions/todo/` 是参考实现。

## Skills

在 `~/.hodipor/agent/skills/example/SKILL.md` 创建：

```markdown
---
name: example
description: 在需要整理输入内容时使用。
---

先明确用户要整理的内容与输出格式，再完成任务。
```

启动时只索引名称、描述和文件路径，模型按需读全文；`/skill:example` 显式加载。项目技能可放到 `<cwd>/.pi/skills/` 或通用 `.agents/skills/`（从工作目录向祖先目录发现，遇含 `.git` 的仓库根停止）；同名冲突时先发现者优先，即 `.pi/skills` 优先于 `.agents/skills`。通用用户级目录 `~/.agents/skills/`（与 Codex/OpenCode 共享）也会加载，优先级最低；Hodipor 专属的 `<home>/agent/skills/` 优先级最高。

## 提示词模板

`~/.hodipor/agent/prompts/brief.md`：

```markdown
---
description: 一段说明
---
要点：$ARGUMENTS
```

输入 `/brief 主题` 即以展开后的文本发送。

## durable 扩展

一个扩展是工具、prompt sections、hooks 与任务的命名束，装进宿主 registry：

```js
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export const echo = defineExtension({
  name: "echo",
  sections: [section("echo-intro", () => "Echo back what you are given.")],
  tools: [
    defineTool({
      name: "echo",
      description: "Echo text",
      parameters: Type.Object({ text: Type.String() }),
      async execute(args, api, context) {
        return { output: [{ type: "text", text: args.text }] };
      },
    }),
  ],
});
```

要点：

- 工具结果用 `output`（给模型）、`details`（给 UI）；不要返回 `content`。
- 会话状态用 `defineDoc` 事务文档，不用模块级内存 store；需要崩溃恢复幂等时在同一事务里保存按 `api.callId` 的调用回执并关联 `api.taskId`；只有确认任务终结后才可回收回执（见 `extensions/todo/state.mjs`）。
- 需要崩溃后自动重跑才声明 `replay: "safe"`，并以崩溃注入测试证明。
- UI 面板由宿主挂载：宿主用 `harness.watchDoc` 订阅已提交状态；todo 的独立 UI 入口 `extensions/todo/ui.mjs` 提供工具 renderers 与只读面板，不参与执行/权威状态。
- 目前扩展在 `src/session.mjs` 装配；`~/.hodipor/agent/extensions/` 用户扩展目录尚未实现自动发现。

## todo 扩展

`extensions/todo/` 移植自 `@juicesharp/rpiv-todo@2.13.8`（MIT）。`todo` 工具维护任务清单（pending → in_progress → completed，支持 blockedBy 依赖），面板实时显示在输入框上方，Ctrl+Shift+T 折叠面板，`/todos` 输出全量列表。Ctrl+O 展开工具和完整任务，Ctrl+T 保留给思考折叠。面板保留原版树形布局、依赖编号、12 行内容预算和下一轮隐藏完成项的行为；隐藏/折叠不修改文档。原 rpiv-config/rpiv-i18n 的个人配置未接入，此处使用原版默认值。任务清单按会话存储，fork 继承分叉点状态，新会话从空列表开始。
