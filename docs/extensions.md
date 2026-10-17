# 扩展 Siftory

Siftory 使用 durable 原生扩展接口（`defineExtension` / `defineTool` / `section`），没有通用 Pi 插件兼容层。仓库内 `extensions/todo/` 是完整参考实现。

## Skills

在 `~/.siftory/agent/skills/example/SKILL.md` 创建：

```markdown
---
name: example
description: 在需要整理输入内容时使用。
---

先明确用户要整理的内容与输出格式，再完成任务。
```

启动时只索引名称、描述和文件路径，模型按需读全文；`/skill:example` 显式加载。项目可放到 `.pi/skills/` 或标准 `.agents/skills/`（经 Pi 的 `loadSkills` 发现）。

## 提示词模板

`~/.siftory/agent/prompts/brief.md`：

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
- 会话状态用 `defineDoc` 事务文档，不用模块级内存 store；需要崩溃恢复幂等时在同一事务里保存按 `api.callId` 的调用回执（见 `extensions/todo/state.mjs`）。
- 需要崩溃后自动重跑才声明 `replay: "safe"`，并以崩溃注入测试证明。
- UI 面板由宿主挂载：扩展导出纯渲染函数，宿主用 `harness.watchDoc` 订阅已提交状态（见 `src/tui/app.mjs` 的 todo 面板）。
- 目前扩展在 `src/session.mjs` 装配；`~/.siftory/agent/extensions/` 用户扩展目录尚未实现自动发现。

## todo 扩展

`extensions/todo/` 移植自 `@juicesharp/rpiv-todo@2.13.8`（MIT）。`todo` 工具维护任务清单（pending → in_progress → completed，支持 blockedBy 依赖），面板实时显示在输入框上方，`/todos` 输出全量列表。任务清单按会话存储，fork 继承分叉点状态，新会话从空列表开始。
