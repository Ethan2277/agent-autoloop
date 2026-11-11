# 参与贡献

欢迎提交可复现的问题、文档修正、插件和通用能力改进，中文或英文都可以。

## 去哪里交流

- [Issues](https://github.com/KKKKhazix/agent-autoloop/issues/new/choose)：可以复现的故障和有明确场景的功能建议。能做的由维护者修复，修复提交会署上报告者。
- [使用问答](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/q-a)：安装、规则、Agent 和通道配置。
- [想法交流](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/ideas)：讨论还没形成开发任务的想法。
- [实践分享](https://github.com/KKKKhazix/agent-autoloop/discussions/categories/show-and-tell)：分享插件、场景模板和使用经验。
- 安全问题按 [安全说明](SECURITY.md) 联系维护者，不在公开讨论中披露利用细节。

## 贡献范围

新 Agent、事件插件和通道接在插件层；完整业务流程可以做成场景模板。先看 [插件开发说明](docs/plugins.md) 和 [现有场景](README.md#拿来即用的场景模板)，避免重复实现。

内核保持零运行时依赖，不连接外部产品。总览页、工作流画布和其他界面属于独立客户端，不放进这个仓库。改协议或核心流程前，先说明具体场景和兼容影响；维护约定见 [AGENTS.md](AGENTS.md)，协议见 [docs/protocol.md](docs/protocol.md)。

## 提交改动

1. 从最新的 `main` 创建分支；外部贡献者使用 Fork。本仓库里的分支只能以 `claude/`、`codex/` 或 `dependabot/` 开头，tag 只用于发布（`v1.2.3`）。Agent 在独立工作树里开发，主目录保留在 `main`。
2. 使用 Node.js 24 或更新版本，运行 `npm ci`。一次 PR 解决一个问题，同步更新受影响的中英文说明、示例和配置。
3. 修 bug 先写能复现它的失败测试，测试文件开头说明防止什么失败。纯文档、模板或小范围可逆改动，不补照着实现抄的测试。
4. 提交前运行 `npm run test:quick`、`npm run typecheck`、`npm run format:check`。改了 `kernel/`、`protocol/`、`sim/` 时用 `npm test`，它多跑完整模拟和穷举。涉及日志、到期表或并发时，再运行 `npm run test:nightly`。Windows 原生检查用 `npm run test:windows`。各平台的 CI 与安装冒烟检查见 [检查范围](AGENTS.md#怎么改)。
5. 向 `main` 提交 PR，说明问题、改后的行为、验证结果和兼容影响。未完成的工作使用草稿；合并前确认最终提交的 Ubuntu、macOS 和 Windows 检查都已通过，维护者把独立审查和必要的真机验证记在 PR。请勾选“Allow edits by maintainers”：要调整的地方维护者通常直接在你的分支上改好再合并。Fork 的 CI 跑在 GitHub 的机器上，自动运行；GitHub 新注册账号的首次 PR 要维护者批准后才运行。

测试使用临时 `AGENT_AUTOLOOP_HOME`、随机端口、本地假 HTTP 和假通知命令。不要连接真实业务数据库、发送消息，或给已在线的飞书应用再开事件监听。真实交付脚本会创建和删除指定测试仓库，只在用户明确要求时运行。

不要提交密钥、带权限的卡片链接、完整配置、数据库、运行输出或同事资料。问题中的日志和截图也要先脱敏。代码按 [MIT 许可证](LICENSE) 提交。

用户装的是最新的 Release，不是 `main`：合进 `main` 的改动等下一个 Release 才到用户手上，安装和更新方式见 [INSTALL.md](INSTALL.md)，版本号的规则见[协议](docs/protocol.md#版本与兼容)；目前没有长期支持分支。本仓库由维护者按上面的流程核对审查和三平台检查，随后合并。
