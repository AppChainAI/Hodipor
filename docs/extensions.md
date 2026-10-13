# 扩展 Siftory

Siftory 使用 Pi 原生扩展接口，没有自己的插件协议。

## Skills

在 `~/.siftory/agent/skills/example/SKILL.md` 创建：

```markdown
---
name: example
description: 在需要整理输入内容时使用。
---

先明确用户要整理的内容与输出格式，再完成任务。
```

启动时只索引名称、描述和文件路径，模型按需读全文；`/skill:example` 显式加载。修改后使用 `/reload`。项目可放到 `.pi/skills/` 或标准 `.agents/skills/`。

## 扩展工具与命令

以下示例文件可以放到 `~/.siftory/agent/extensions/echo.ts`；也可以通过 `siftory --extension ./echo.ts` 临时加载。

```ts
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "返回输入文本",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args) {
      return {
        content: [{ type: "text", text: args.text }],
        details: undefined,
      };
    },
  });

  pi.registerCommand("hello", {
    description: "显示问候",
    async handler(_args, ctx) {
      if (ctx.hasUI) ctx.ui.notify("Hello from Siftory", "info");
    },
  });
}
```

扩展自动发现支持 `.ts` / `.js` 文件或目录下的 `index.ts` / `index.js`。需要自定义 TUI 时使用 `ctx.ui.custom()`、widgets、header/footer 等，不创建第二个终端渲染器。

## 扩展包

使用官方 Pi manifest 分发能力：

```json
{
  "name": "example-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

只列实际存在的资源路径。扩展运行时依赖写进包的 `dependencies`；Pi 提供的 pi-ai / pi-agent-core / pi-coding-agent / pi-tui / typebox 放在 `peerDependencies`，不要重复打包宿主。

```sh
siftory install ./example-pi-package
siftory install npm:@scope/example-pi-package@1.0.0
siftory config
```

项目级安装使用 `--local`；项目配置仍需信任后加载。

## MCP

```sh
siftory mcp add example -- node /path/to/server.js
siftory mcp list
```

CLI 已装配 Pi 内置 MCP 支持，无需 Siftory 再写桥接。服务器可以暴露直接工具、codemode 或 deferred 工具；由 Pi 配置决定启用方式。

## 兼容与安全

- 原生 Pi 扩展最接近 Siftory 的宿主环境，但仍需核对支持的 Pi 版本、工具名、系统程序和凭证要求。
- TUI 专属行为应判断 `ctx.mode === "tui"`；可用于 RPC 的标准对话判断 `ctx.hasUI`。print/JSON 模式没有交互 UI。
- 长期资源在 `session_start` 或命令中启动，在 `session_shutdown` 清理，不在工厂加载时启动后台工作。
- 会话数据使用 Pi session entries 或工具 details，分支敏感状态从当前 branch 重建。跨会话业务数据由扩展自己拥有，不加入底座。
- 扩展、技能中的脚本可以读写文件、运行进程和访问网络；信任检查不是执行沙箱。不要自动安装未审核的社区包。

完整接口以 [官方扩展文档](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[Skills](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/skills.md)、[Packages](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md) 和 [TUI](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/tui.md) 为准。
