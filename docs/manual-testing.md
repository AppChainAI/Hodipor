# 手动验收

自动检查：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run test
```

模型链路测试使用官方 faux provider，不发送真实付费请求。新底座不复用旧桌面测试。

## 交互终端

使用支持的终端启动 `siftory`，分别检查默认 fullscreen 和 `--tui-mode regular`：

1. 显示 Siftory header、原生输入框和模型状态。
2. `/login`、`/model`、`/settings` 可打开；默认认证目录是 `~/.siftory/agent/`。
3. 输入中文、多行和粘贴文本；缩窄终端、改变高度后输入框可用，IME 候选位置正确。
4. 发起请求后可看到流式文本；Esc 停止当前工作，随后可继续发送。
5. `/new`、`/resume`、`/tree`、`/fork` 可用；退出重开后能恢复会话。
6. 在空输入框中按两次 Ctrl+C，或 Ctrl+D，正常退出，终端恢复可用。

真实模型调用、OAuth 和网络 MCP 验收可能产生费用或访问外部服务，应由操作者明确选择凭证和请求。

## 扩展

在临时用户目录中加载 [扩展指南](extensions.md) 的示例：

```sh
SIFTORY_AGENT_DIR=/path/to/temp-agent siftory --extension /path/to/echo.ts
```

确认 `/hello`、echo 工具、标准技能 `/skill:example` 可用；修改资源后 `/reload` 生效。社区包需单独检查版本、依赖与交互行为，不能由一个样例推断所有社区包兼容。

## 本次已验证（2026-10-13）

本机 Node 22.23.2 / macOS arm64：

- 严格 JS 类型检查通过。
- 8 项 Node 测试通过：SDK 实际资源/工具/会话链路，CLI 实际启动/会话/配置隔离/导出链路。
- 通过真实 PTY 启动原生 regular 与 fullscreen TUI：Siftory header、faux 模型回答和 Ctrl+C 正常退出均通过；临时进程与测试目录已清理。
- 测试凭证、会话与文件均为临时数据，未调用真实模型。

未验证：真实模型/OAuth/网络 MCP、具体社区包、真实中文 IME、其他操作系统的终端。三平台自动检查已配置，未在本机代替 CI 执行。
