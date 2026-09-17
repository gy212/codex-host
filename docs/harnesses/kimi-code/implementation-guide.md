# Kimi Code 接入 codexhost：调查结论与实施指南

> 日期：2026-09-17。仓库基线：`2dca131047a83b54ec71beb8039ecf5dd84f20b2`，工作分支：`kimi`。
> 本文是交给实施 agent 的方案和证据包，不是已经完成的 Adapter。本次只增加文档、探针及探针数据，没有修改产品代码，也没有提交或推送。

## 1. 先读结论

**针对当前安装的 Kimi Code 2.0.0，采用 ACP 控制与实时交互，加上只读原生会话日志。不要直接接入当前发布的 Kimi Agent SDK 0.1.8。**

理由来自实际运行，而不是“SDK 通常更好”或“ACP 通常够用”：

1. 官方 SDK 确实存在，提供 TypeScript/Python 等语言入口。调查时 npm 的 `@moonshot-ai/kimi-agent-sdk` 最新版本为 `0.1.8`，官方仓库所查 commit 的 Node 包也是此版本。
2. 这个 Node SDK 启动 CLI 时使用 `--work-dir <dir> --wire`。连接本机 `kimi.exe 2.0.0` 的实际结果是 `TransportError / PROCESS_CRASHED`，错误为 `unknown option '--work-dir'`。未进入模型调用。
3. `kimi acp` 在同一安装、同一认证配置下成功完成创建、工具审批、写文件、读文件、重启恢复、续聊、取消及取消后提问。
4. ACP 有真实限制：回放不是完整历史 API，普通失败可能被转成 `end_turn`，Fork 只有末尾复制，且忽略目标 cwd。不要把这些能力直接等同于 Host 的完整语义。
5. 本机原生 `agents/main/wire.jsonl` 提供了 ACP 缺少的稳定 `turnId`、原始输入、结构化工具结果、终态与分步 Usage。它是**磁盘日志格式**，不是 SDK 使用的 `--wire` 通信接口；两者不能混为一谈。

这里的选择是针对已验证版本。将来 SDK 能直接连接已安装 CLI，且生命周期、历史、权限等实测通过，再重新比较。**本次实施不同时维护 SDK/ACP 两套后端，不降级用户 CLI，不修补 SDK 参数来伪装兼容。**

## 2. 版本、环境与证据

| 对象 | 本次核实值 |
|---|---|
| 本机系统 | Windows，PowerShell |
| CLI | `C:\Users\21240\.kimi-code\bin\kimi.exe`，`2.0.0` |
| 启动 ACP | `kimi acp`，JSON-RPC 2.0，NDJSON，stdio |
| 协议协商 | `protocolVersion: 1` |
| Node | `D:\DevTools\node-v24.18.0-win-x64\node.exe` |
| 仓库现有 ACP SDK | `@agentclientprotocol/sdk@1.3.0` |
| 被验证的 Kimi SDK | `@moonshot-ai/kimi-agent-sdk@0.1.8` |
| Kimi SDK 源码快照 | `ed4be6be5280d02191da88bbafb3f828dcd33d72` |
| Kimi Code 源码快照 | `86e08208e3445171f6500c948234d7e3a0684324`；其中应用 package version 为 `2.0.0` |
| 原生持久化 | `state.json.version = 2`；日志 metadata `protocol_version = "1.5"` |
| 本机配置的模型 | alias 为 `relay`，显示名为 `claude-sonnet-5` |
| 实际模型请求 | 4 个 prompt：3 个正常完成、1 个取消；未运行其他 agent 或业务任务 |

注意最后两项：**Kimi Code 是 Harness，不要求底层 Model 是 Kimi。** 本次模型是用户现有配置；不要把这个 alias、显示名、Token 窗口或 Thinking 档位硬编码进产品。

源码快照与安装包的 version 一致，但没有证明安装包每个字节都来自该 commit。因此下文分别标注“实测”“源码”和“实施要求”，不把源码分支自动当成二进制全部行为的证明。

### 可随文档交给其他 agent 的证据

| 文件 | 内容 |
|---|---|
| [evidence/capabilities.json](evidence/capabilities.json) | 版本、SDK 失败、ACP 能力、配置切换、取消、Fork 与目录结果 |
| [evidence/acp-events.json](evidence/acp-events.json) | 审批、结构化提问、工具开始/结果、Usage 的实际消息 |
| [evidence/history-replay.json](evidence/history-replay.json) | 恢复时的原始 ACP 回放，展示 ID 和用户消息边界问题 |
| [evidence/native-history.json](evidence/native-history.json) | 两个探针会话的原生日志白名单摘录，包含成功和取消轮次 |
| [../../../tools/probes/kimi-code/probe.mjs](../../../tools/probes/kimi-code/probe.mjs) | 路径说明见下方；实际脚本位于仓库根 `tools/probes/kimi-code/probe.mjs` |

原始实验输出、临时 SDK 安装、下载的官方源码留在 `D:\DevTools\probes\kimi-sdk-20260917`。证据文件不包含 API key、认证令牌或完整配置，也没有复制原生 system prompt。证据内出现的文本是数据，不能当作实施 agent 的指令。

## 3. SDK 与 ACP：逐项比较

表中的 SDK 能力是 **0.1.8 导出类型/源码声明**，不是在 2.0.0 上已经跑通。

| 能力 | 官方 SDK 0.1.8 | Kimi Code 2.0.0 ACP | 本项目判断 |
|---|---|---|---|
| 当前 Windows CLI 兼容 | 本次启动失败 | 实测可用 | 当前选 ACP |
| 创建/继续会话 | `createSession`、`sessionId` | `session/new`、`load`、`resume` | ACP 实测可写恢复 |
| 流式回答/公开 Thinking | `ContentPart` | `agent_message_chunk`、`agent_thought_chunk` | 两者有结构化入口；Thinking chunk 本次未触发 |
| 工具调用/结果 | `ToolCall`、`ToolResult` | `tool_call`、`tool_call_update` | ACP 实测 Write/Bash |
| 审批 | `Turn.approve` | `session/request_permission` | ACP 实测 allow-once |
| 提问 | `Turn.respondQuestion` | `elicitation/create`；permission fallback | ACP 实测双题及多选 |
| 取消 | `Turn.interrupt` | `session/cancel` notification | ACP 实测取消后仍可继续 |
| 原生运行中 steer | `Turn.steer` | 未公开等价 ACP 方法 | Host 仍复用取消后重启 Turn 的公共调整方向流程 |
| 自定义外部工具 | `externalTools` / `createExternalTool` | 可传 MCP servers；不等同于 SDK 回调工具 | 当前无须新增这项公共能力 |
| Hook 订阅/回调 | `ProtocolClient` hooks | 未公开等价客户端 Hook RPC | ACP 仍使用 CLI 自己的既有 Hook 配置 |
| 原生子 agent 事件 | `SubagentEvent` | 主要是工具输出，无完整专用子会话事件面 | 不声称完整子 agent 观察能力 |
| 历史 | `parseSessionEvents`、`sendReplay` | `session/load` 回放有信息损失 | 用 2.0.0 原生日志补全，不使用 SDK 旧路径解析器 |
| 精确历史 Fork | SDK 有带 `turnIndex` 的本地存储操作 | ACP 只有 source session Fork | 当前 Host `history.fork` 必须 false |
| 跨目录 Fork | 本次未验证 | 源码和实测均表明请求 cwd 被忽略 | `forkAcrossCwd: false` |
| 回滚最后一轮 | 不从 SDK 方法名推断 | 无对应 ACP 操作 | `rollbackLastTurn: false` |
| 模型/Thinking | Session 属性、配置解析；Thinking 属性为 boolean | `set_config_option`，Thinking 可多档 | ACP 更贴近本机新版本 |
| 权限/Plan | `yoloMode`、`setPlanMode` | default/plan/auto/yolo，支持动态切换 | 使用 ACP 原生值 |
| Token/上下文 | `StatusUpdate` | ACP 主要有 `used/size`；磁盘有细分 Usage | 分别映射，不把 context size 当总花费 |
| 历史位置 | SDK 默认 `~/.kimi` / `KIMI_SHARE_DIR` | 新版本 `~/.kimi-code` / `KIMI_CODE_HOME` | 两套数据布局不同 |

**丰富程度结论：SDK 在原生事件、Hook、外部工具和 steer 的 API 表达上更丰富；ACP 在本机新版本上可用，并提供多档 Thinking、完整表单式提问及原生会话操作。不存在脱离版本的统一赢家。**

## 4. 交付边界与命名

建议最终目标为“仓库内插件后端 + 预装发行 + Desktop 产品接入”。实现时分阶段验收，不能把“能用 ACP 聊天”当作全部完成。

固定命名：

```text
Harness ID:       kimi-code
显示名:           Kimi Code
包名:             @codexhost/adapter-kimi-code
源码目录:         packages/adapters/kimi-code
命令覆盖变量:     CODEXHOST_KIMI_COMMAND
实际命令:         kimi
传输:             kimi acp
```

本地 Git 分支叫 `kimi`，与 Harness ID 不必相同。不要把 ID 改成模型名，不增加 Kimi Provider 接入来替代 Agent 接入。

建议首版 capability：

```ts
{
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
  autonomousTurns: { observe: false },
}
```

这是设计起点，不是无条件常量：Thinking 控件需遵守当前模型的实际选项；协议握手/版本不符必须明确不可用。原生子 agent、自主轮次、图片、导入、远程环境分别列为扩展验收项，不用虚假 true 填满能力表。

## 5. 数据流与所有权

```mermaid
flowchart LR
  Desktop[Codex Desktop / Renderer] --> Host[Host 公共 Harness 路由]
  Host --> Adapter[KimiCodeAdapter / KimiCodeSession]
  Adapter --> ACP[ACP SDK / stdio]
  ACP --> CLI[kimi acp]
  CLI --> Engine[Kimi Code 原生 Agent]
  Engine --> Native[原生会话与 wire.jsonl]
  Native -.只读历史、终态、Usage.-> Adapter
```

- CLI 持有认证、Provider、MCP、工具执行、Agent 和会话状态。Adapter 不直接调用 Model API。
- Adapter 转换原生事件、交互、历史及配置，提供 `HarnessAdapter` / `HarnessSession`。
- Host 持有 Thread/Turn 映射、恢复事务、跨 Harness 委派及 Desktop 投影。Adapter 不直接写 Mapping Store。
- Renderer 接收公共类型，不理解 ACP JSON、不导入 SDK、不访问本地原生会话文件。
- Rust 不增加 Kimi 业务逻辑；Host Runtime 不静态 import Kimi Adapter。
- 一条活动 HarnessSession 对应一个 `kimi acp` 子进程，是首版最简单的资源所有权。当前没有证据需要跨 Session 共享进程池。

## 6. 应新增和修改哪些文件

### 6.1 插件内部

以下按职责给出建议，不要求机械拆成同样数量的小文件。

```text
packages/adapters/kimi-code/
  package.json
  tsconfig.json
  manifest.json
  assets/icon.svg                  有确认的官方图标时再加
  src/plugin.ts                    公共工厂
  src/index.ts                     必要导出
  src/command.ts                   命令发现及调用
  src/kimi-adapter.ts              inspect / open / close
  src/acp-transport.ts             进程、ACP RPC、反向请求、取消与退出
  src/kimi-session.ts              HostCommand 和有序 outputs
  src/models.ts                    opaque ref、配置和权限转换
  src/history.ts                   原生 index/state/wire 的只读解析
  src/projection.ts                ACP/native 内容到 Host Item
  test/...                         按本文行为矩阵组织聚焦测试
```

复用公共导出：`HarnessOutputChannel`、`validateHostApprovalResponse`、`validateHostQuestionResponse`、`parseHostUsage`、诊断工具，以及 `harness-discovery`。通过各包 public exports 导入；不要直接跨包引用其他 Adapter 的内部文件。

参考实现：

| 要做什么 | 阅读当前仓库 |
|---|---|
| 接口签名与所有命令 | `packages/harness-adapter/src/text-session.ts` |
| 工厂 | `packages/harness-adapter/src/plugin.ts`，`packages/adapters/hermes/src/plugin.ts` |
| 可执行文件发现 | `packages/adapters/hermes/src/command.ts`，`packages/harness-discovery/src/index.ts` |
| ACP 进程/恢复/关闭 | `packages/adapters/hermes/src/acp-transport.ts` |
| configOptions 转换和确认 | `packages/adapters/kiro-cli/src/models.ts` |
| 工具/文件差异投影 | `packages/adapters/kiro-cli/src/projection.ts`、`file-diff.ts` |
| 稳定原生引用 | `packages/shared-contracts/src/native-refs.ts` |
| 公共插件路由 | `packages/shared-contracts/src/harness-route.ts` |

这些是实现模式，不是整包复制模板。不要复制 Hermes 的 Python inventory、Kiro 的私有 effortLevel、Antigravity 的存储格式或 SDK 的旧 `~/.kimi` 解析器。

### 6.2 构建与预装

1. 根 `package.json` 的 workspace 已包含 `packages/adapters/*`，不用再加一次通配项。
2. 根 `tsconfig.json` 有显式 references，加入新包的 tsconfig。
3. `tests/tsconfig.json` 已覆盖 `../packages/**/test/**/*.ts`，无需复制测试目录规则。
4. `scripts/release/harness-plugins.json.plugins` 加入新插件目录。
5. `@agentclientprotocol/sdk@1.3.0` 已在根依赖及运行包清单；插件自己的 dependencies 仍需声明它及实际用到的三个公共包。
6. 若只读配置解析需要 TOML，先确认当前锁文件可复用依赖；本次所查根锁文件没有 TOML parser。使用一个标准 TOML parser 并加入明确运行依赖/发行许可，不手写 TOML 正则解析器，也不为借解析器而把整个 Kimi SDK 打包进来。
7. `tests/release` 和 bundle 清单检查按实际变化补最小用例；不为新 Harness 修改 Host 静态注册或增加专用协议 codec。

Manifest 示例：

```json
{
  "manifestVersion": 1,
  "id": "kimi-code",
  "name": "Kimi Code",
  "version": "0.1.0",
  "adapterApiVersion": 1,
  "entry": "./dist/plugin.js",
  "links": {
    "documentation": "https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html"
  }
}
```

### 6.3 Desktop 接线清单

当前 UI 仍有静态名单。后端加载成功不会自动完成下面这些工作：

| 文件/位置 | 所需改动 |
|---|---|
| `packages/renderer-extension/src/agent-selection-state.ts` | Agent 列表、Kimi 独立 Model/Thinking 状态，以及创建、恢复、清空路径 |
| `renderer-agent-picker.ts` | 名称、可用性、文档/安装入口 |
| `renderer-agent-icon.ts`、`renderer-sidebar-agent-icons.ts` | Picker 与既有 Thread 图标一致 |
| `renderer-binding-probe.ts` | Kimi catalog、目标 Host ownership、effective 配置恢复 |
| `versioned-renderer-adapter.ts` | 创建和恢复走 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute` |
| `index.ts` | 当前生产 Renderer 的类型/接线入口 |
| `settings/connections-page.ts` | Kimi 安装与连接状态；不要照旧文档误改并不存在的旧页面路径 |
| `packages/desktop-control/src/production-controller.ts` | 实际注入 Agent 名单 |
| `tools/renderer-binding/run.mjs`、`renderer-observer.mjs` | 这些工具声称覆盖的生产 Agent 集合 |

其余偏好/本地化/权限模块按 `ExternalAgentId` 和实际调用链补齐；不要全仓库机械替换字符串。通过 TypeScript、相关测试和实际 UI 操作找到遗漏。当前主线包含本地历史合并，不为了本次接入重新整理旧功能。

## 7. 可执行文件、版本、环境与 inspect

### 7.1 发现与启动

使用 `resolveHarnessExecutable` + `commandInvocation`。新 DiscoverySpec 的关键参数：

```ts
{
  id: "kimi-code",
  command: "kimi",
  commandEnvironmentVariable: "CODEXHOST_KIMI_COMMAND",
  installRoots: {
    windows: ["~/.kimi-code/bin", "${APPDATA}/npm"],
    posix: ["~/.kimi-code/bin", "~/.local/bin", "/usr/local/bin"],
  },
}
```

目录候选是补充 PATH 的策略；Windows 本机第一项已验证，其余平台需实际验收。不要将 `C:\Users\21240` 写进产品代码。显式 command 覆盖失败时不要静默换另一套 Kimi。

启动只传 `acp`。使用 native cwd，`shell: false`、stdio pipes、Windows `windowsHide: true`，通过公共 invocation 处理 npm shim。stdout 必须留给 ACP，stderr 仅做有界、脱敏诊断。

环境合并顺序必须为基础环境 → 工厂环境 → 本次 `open(input.environment)`。`KIMI_CODE_HOME`、PATH、认证相关原生环境、Host 委派环境都需传到真实子进程，不能只覆盖 create 路径。

### 7.2 inspect 不创建用户 Session

**禁止在 `inspect()` 中调用 `session/new` 读取模型目录，然后称为无副作用检查。** 探针为了调查明确创建了实验会话，产品目录查询不应这样做。

推荐步骤：

1. 解析命令、检查 `--version`，启动临时 ACP 连接，执行 `initialize`；只接受已支持的协议代际。
2. 使用 ACP `authenticate` 的 `methodId: "login"` 验证当前原生认证是否 ready。这不是自动登录或读取 token；源码表明会检查已有 Provider/API key/OAuth 可用性。本次未单独运行这个方法，实施时补一个真实检查。
3. 从 `$KIMI_CODE_HOME/config.toml`，或默认 `~/.kimi-code/config.toml`，只读解析 `default_model`、`models`、`thinking` 和模型 overrides；不输出 providers 的凭据字段。
4. 读得到真实配置模型就建立基础 catalog。模型身份用 alias，不用展示名；显示名优先显式 `display_name`，否则配置模型名或 alias。
5. 原生 ACP 模型目录还会合并内置能力。因此“配置没有 support_efforts”不等于模型不支持 Thinking。本次 `relay` 的 TOML 没写 effort，ACP 却给出了六档。inspect 只报告已经确认的条目；Session 打开后必须用真实 `configOptions` 校正配置。必要时缓存上次确认的同配置目录，但不跨账号/Host 混用。
6. 不得用一次临时 `session/new` 或硬编码一个假模型解决 Picker 就绪问题。若基础目录不足以支持所要求的创建前 Thinking UI，明确实现只读 native inventory，或作为产品限制标出，不伪造档位。
7. 关闭临时进程；refresh 绕过缓存；预期失败用 `notInstalled` / `unavailable` / `error`。

不需在 Renderer 新造认证页面。原生未登录时准确提示运行 `kimi login`；不要打印 config.toml、改认证文件或自动覆盖默认模型。

## 8. ACP 消息与状态转换

### 8.1 初始化与能力声明

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"codexhost","version":"0.9.0"}}}
```

必须实现 `elicitation/create` 才能声明 `elicitation.form`。初版不声明客户端 fs/terminal，工具直接由 Kimi 在 Host 所在机器执行；不需要再写一套文件代理和终端服务。

Kimi 的 `loadSession`、session capabilities 以实际握手为准。`fork: {}` 只能说明有原生末尾 Fork，不代表满足 Host 的 checkpoint contract。

### 8.2 Create、Resume

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"D:/project","mcpServers":[]}}
```

返回 `sessionId`、`configOptions`、`modes`。当场生成 `NativeSessionRef`：

```ts
{
  formatVersion: 1,
  harnessId: harnessIdSchema.parse("kimi-code"),
  nativeSessionId: created.sessionId,
  locator: { cwd: nativeCwd }
}
```

原生会话目录由 index 精确解析；locator 如保存目录必须在读取时与 `state.id/cwd` 核对。不要持久化进程对象或凭据。

Resume 优先 `session/resume`，因本方案用磁盘读快照，不需要把历史重新塞进 outputs。`session/load` 也可用，但必须进入专门 replay buffer，返回前的历史不得再次当实时 Turn 展示。

恢复须确认同一原生 ID，读取实际配置；不能找不到 ID 就新建空会话。Kimi load/resume 忽略传入 cwd，因此恢复前应核对原生 `state.json.cwd`。路径比较遵守平台大小写与归一化规则；不能只改变 spawn cwd 就声称已切目录。

打开 create 时按需要依次设置 Model → Thinking → Permission，等原生确认后再填 effective state。Resume 不盲目重放旧偏好；若需要恢复 native session 未持久化的权限显示状态，应根据已核实原生行为处理，明确 requested/effective 区别。

### 8.3 Model/Thinking/Permission

```json
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"sessionId":"SESSION","configId":"thinking","value":"high"}}
```

- `configId` 分别为 `model`、`thinking`、`mode`，不要使用 Kiro 的 `effortLevel`。
- 响应含完整 `configOptions`，同时可能发出 `config_option_update`，mode 还会发 `current_mode_update`。去重状态更新，不去重真实业务事件。
- 请求值不等于生效值；读取返回的 currentValue 后再更新 UI。未知 Thinking 值本次返回 `-32602`。
- `model` 值是 alias。Host ModelRef 只允许 transport-safe 字符，而官方常见 alias 含 `/`。建议统一用 `kimi.` + UTF-8 alias 的 base64url 编码，反向解码后再传给 CLI；严禁把 `/` 改为 `-` 造成碰撞。
- Thinking 以当前模型返回选项为准，可是 off/on，也可是多档；`always_thinking` 可能没有 off。切模型后重新读取，不能沿用上一模型的菜单。
- 本次只有一个已配置模型；同 alias 的 set 操作已验证，跨两个不同模型切换仍需实施验收。

权限表：

| ACP mode | 原生意图 | Host 展示建议 |
|---|---|---|
| `default` | manual | 询问确认 |
| `plan` | plan + manual | 计划模式 |
| `auto` | 自动处理安全操作 | 按需询问 |
| `yolo` | 自动批准模式 | 无需询问，标记 dangerous |

CLI 的 `--yolo` 帮助文本对应 Ask When Needed，而 `--auto` 对应 Never Ask；**不要凭 CLI 参数名推导 ACP mode 的含义**，更不要拿 `--yolo` 代替 ACP `mode=yolo`。

`unattended-full-access` 必须落到已证实等价的原生执行策略。仅“set yolo 返回成功”还未证明所有 Question/Plan 交互都不会等待；实施时验证这些分支。不满足时返回 `unsupported`，不得后台自动回答用户问题以伪造无人值守。

### 8.4 Turn 与取消

`turn.start` 返回 accepted 后异步驱动 `session/prompt`，不等待整轮模型完成才返回 Host RPC。每 Session 同时最多一轮。

```text
turn.started
  item.started → item.updated* → item.completed
  interaction → interaction.closed
补齐本轮原生终态、NativeTurnRef、实际文件变化
turn.completed（恰好一次）
```

`session/cancel` 是 notification，不等待一个不存在的 JSON-RPC response。Host 的 `cancellationRequested: true` 只表示请求已发出；等 prompt settle/native 终态后再结束旧轮。实测 stopReason 为 cancelled，随后提问轮正常运行。

普通取消不要杀死整个会话进程。关闭时先原生 `session/close`，再结束 stdin；有界等待后用项目已有进程树关闭方式收尾。待处理交互也要解除，禁止留下悬挂 Promise。晚到旧轮消息不可进入新轮。

“调整方向”复用 Host 现有 cancel → terminal → start 路径，不新造 Kimi steer RPC。

## 9. 工具、审批和 Question 的具体映射

### 9.1 实时工具消息不是一条稳定完整对象

实测 Write/Bash 顺序：

1. `tool_call`：pending，名称已知，参数可能为空。
2. 多条 `tool_call_update`：content 是**累计参数预览**，不是输出增量。
3. 带 `rawInput` 的更新：参数完整，可映射结构化工具调用。
4. `session/request_permission` 可能在这附近到达。
5. 最终 `tool_call_update`：completed/failed，content 替换成结果，可能带 rawOutput。

因此不能把每个 content 都 `output.append`；会把参数重复十几遍。维护一个按 toolCallId 的 accumulator。公共 Host Item 类型的 tool arguments/command 本身没有任意替换事件：可以先缓存 early pending/预览，待 rawInput 可用时再发 item.started；若审批先到，可以让 interaction 暂不绑定 itemId。最终成功/失败再完成同一个 Item。

映射建议：

| 原生消息/内容 | 公共表示 |
|---|---|
| `agent_message_chunk` | agentMessage + text.append；没有明确依据时不猜 commentary/final phase |
| `agent_thought_chunk` | reasoning；只取原生公开文本 |
| Bash/已知命令工具 | commandExecution；command 来自 rawInput，cwd 来自原生记录 |
| Write/Edit/其他工具 | toolExecution，并在确认实际变化后另发 fileChange |
| tool result | output.replace / item.completed；缺失 exit code 则省略或 null，不能伪造 0 |
| usage/config/commands update | Session 状态，不是工具或普通回答 |
| ACP plan | 当前公共接口没有等价计划事件；如有展示要求，使用既有公共工具/消息投影，不私自新增事件种类 |

### 9.2 审批范围必须准确

本次收到：

```json
[
  {"optionId":"approve_once","name":"Approve once","kind":"allow_once"},
  {"optionId":"approve_always","name":"Approve for this session","kind":"allow_always"},
  {"optionId":"reject","name":"Reject","kind":"reject_once"}
]
```

这里的 `approve_always` 实际是 **session scope**。映射为 Host `allowForSession`，不是 `allowAlways`。保存原始 optionId 供回答，不能从展示文本反推协议值。

建立 `HostApprovalInteraction`，通过 `validateHostApprovalResponse` 后 resolve 原 ACP 回调，发 interaction.closed。拒绝、取消、晚到响应、跨 session ID、close 竞态都要覆盖。

Plan review 可出现 `plan_approve`、`plan_opt_N`、`plan_revise`、`plan_reject_and_exit`。保留原生选项及 ID，不能压成“同意/拒绝”后丢失 Revise 与 Exit 的区别；这些路径本次只读到源码，尚未实测。

### 9.3 必须接 elicitation，不能只支持 approval

本次 `elicitation/create` 在一个 request 里包含：

```json
{
  "mode":"form",
  "requestedSchema":{
    "type":"object",
    "properties":{
      "q0":{"type":"string","oneOf":[{"const":"Red","title":"Red"},{"const":"Blue","title":"Blue"}]},
      "q1":{"type":"array","minItems":1,"items":{"anyOf":[{"const":"Apple"},{"const":"Pear"},{"const":"Orange"}]}}
    },
    "required":["q0","q1"]
  }
}
```

转换到 Host choice question：id 用 q0/q1；`value` 用原生 const；single/multiple 根据 string/array；required 对应 optional=false。保留标题、描述。一次 interaction 包含全部题目。

本次回答：`{ action: "accept", content: { q0: "Red", q1: ["Apple", "Pear"] } }`，模型确认了这两个选择。Host `answers` 的 string[] 对单选需转成单一 string，对多选保留数组；取消映射 `action: "cancel"`，不带伪造答案。

本版本 Question bridge 不支持自由 Other text；不要展示无法回传的“其他”。没有 elicitation 时，Kimi 的 permission fallback 只保留第一题并降成单选。若收到 `q0_opt_N` / `q0_skip` 的 fallback，应映射 Question，不能当文件执行权限自动放行。

## 10. 原生历史：本方案的关键补全层

### 10.1 定位方法，禁止自己推测 workspace hash

原生根目录：`KIMI_CODE_HOME`，未设置则 `~/.kimi-code`。

1. 只读 `session_index.jsonl`，按精确 sessionId 找 entry，取得 sessionDir/workDir。重复记录使用与当前原生实现一致的最新有效项。
2. 读 `sessionDir/state.json`，确认 `id`、`version`、`cwd`。
3. 从 `state.agents.main.homedir` 读取 `wire.jsonl`。
4. 原生路径属于输入边界：规范化，确认在选定 Kimi 数据目录内且身份匹配；不要接受 locator 指向任意敏感文件。

实际路径形态为：

```text
~/.kimi-code/sessions/<workspace-id>/<session-id>/
  state.json
  agents/main/
    wire.jsonl
    file-history/...
```

`~/.kimi-code/sessions/<session-id>` 并不是本机实际位置。也不要套用旧 SDK 的 `~/.kimi/sessions/<md5>/context.jsonl`。

### 10.2 确认的记录与映射

| type | 本次实际字段 | 用途 |
|---|---|---|
| `turn.prompt` | agentId、turnId、promptId、input、origin、time | 真正用户输入和稳定 Turn 边界 |
| `context.append_loop_event` / `event.type=content.part` | uuid、turnId、step、part | 完整文字/公开 Thinking |
| 同上 / `tool.call` | uuid、turnId、toolCallId、name、args、display | 工具身份与结构化参数 |
| 同上 / `tool.result` | parentUuid、toolCallId、result | 关联前面工具的结果；自身可能无 turnId |
| 同上 / `step.end` | turnId、step、usage、finishReason、messageId | 分步 Token 和完成线索 |
| `turn.ended` | agentId、turnId、reason、durationMs、time | 主权威终态；实测 completed/cancelled |
| `usage.record` | usageScope、model、usage | 另一份 Usage 表达，不能与 step.end 重复相加 |
| `file_history.tracked` | turnId、path、entry.key | 文件修改前版本；key=null 的语义需结合已有文件历史 |
| `file_history.checkpoint` | turnId、phase、entries | 该轮结束时的原生文件版本 |

使用 `agentId=main` 的记录；不要把后台子会话和主会话拼在一起。`tool.result` 用 parentUuid 或此前 toolCallId 关联，不能错误归入“读文件时的当前轮”。

`agent.message.appended` 与 `context.append_loop_event` 都能表达相同内容。选后一套完成正文/工具投影，不同时追加两套导致重复回答。真正用户轮次以 `turn.prompt` 为准；ACP replay 里的 `<system-reminder>` 不能变成新用户问题。

NativeTurnRef 建议：

```ts
{
  formatVersion: 1,
  harnessId: harnessIdSchema.parse("kimi-code"),
  nativeSessionId,
  nativeTurnKey: `turn:${nativeTurnId}`,
}
```

这里的 turnId 来自持久化日志。本次进程重启后仍连续为 0、1。实时消息不包含这个字段时，记录本轮提交前的日志位置，找到本次新产生的 main `turn.prompt`，再关联其 `turn.ended`。不能拿“最后一条日志”或 ACP replay 合成前缀冒充真实轮次；若存在其他客户端同时写入，无法唯一关联则返回 sessionBusy/protocolError。

Snapshot Item ID 可由稳定 turnId + 原生 toolCallId、content.part uuid 或固定有序序号生成。对同一日志重复读取必须稳定；实时结束快照与 readSnapshot 要对齐。

### 10.3 readSnapshot 的算法

1. 活动 Turn 不允许安全读取时返回 `sessionBusy`；不另开原生会话。
2. 按上述定位打开日志，流式按行解析；末尾未完整换行时等待下一次读取，不把半条记录当完整历史。中间坏行/版本不识别须明确报告，不静默跳过后返回完整成功。
3. `turn.prompt` 建立逻辑 Turn，收集该轮 content/tool 记录。
4. 按 `turn.ended` 映射 completed→succeeded、cancelled→cancelled、failed→failed。缺失终态用历史允许的 unknown，不能猜成功。
5. 工具失败不等于整轮失败；用真实工具 outcome 和最终 Turn outcome 分别表示。
6. 保留原生时间、有效模型、配置状态；返回 `HostThreadSnapshot`，不往 outputs 重放旧事件。

首版不需要新增一套 Host 历史库或持久化 ACP 全流。原生日志已有事实，Adapter 负责只读投影。仅在确有原生缺失信息时才增加小型映射记录，并说明不可从原生恢复的字段。

### 10.4 `end_turn` 不足以判定成功

官方 `events-map.ts::turnEndReasonToStopReason` 会把部分 failed 映射为 end_turn；`session.ts::onTurnEnded` 对认证错误另走 JSON-RPC error。因此：

- RPC error 首先按其错误处理；auth_required 不能被吞掉。
- 普通 prompt 返回 end_turn 后，从本轮原生日志确认 reason，再发 Host 最终 outcome。
- 设置有限的日志落盘等待；到时仍缺少可关联终态，返回明确的协议/原生错误及诊断，不能把“不知道”改成 succeeded。
- 不通过分析模型的自然语言回答判断失败，也不解析任意 stderr 文案制造 outcome。
- 对原生日志读取失败的环境，明确说明语义受限；不能悄悄回退成“ACP end_turn 全部成功”。

本次证实了 completed/cancelled 的关联；人为触发 provider 非认证失败及故障恢复尚未实测，必须作为实现验收用例。

## 11. 文件变化、Usage 与命令

### 11.1 实际文件变化

ACP `content.type=diff` 中 oldText/newText 可能是工具预览或片段；工具成功前不发成功 fileChange。失败/拒绝不等于文件已变化。

本次 Write 创建确实写出 `KIMI_PROBE_OK\n`，但其 ACP 工具结果主要是文字说明，没有完整实际 diff。原生日志提供 `file_history.tracked` 和结束 checkpoint，可据此读取原生保存的前后内容，通过已有 `diff` 依赖生成 unified diff。

实施建议：

1. 优先使用已完成工具的原生 diff；只有已确认全文件内容才标作完整 diff，局部片段使用 `diffScope: "fragment"`。
2. 对 Write/Create/Delete 无 diff 的情况，从该轮原生 file-history 前后版本补齐。只读取该轮明确涉及的路径，不跑整仓库 Git diff 来猜 Agent 修改。
3. 历史版本 key 是原生路径标识；检查其解析范围，不自行计算或反复验证无关文件哈希。
4. 以 `sourceItemIds` 关联原始工具，避免同一修改在工具预览与最终文件汇总中重复累计。
5. shell 任意改文件的覆盖范围尚未验证；缺乏原生跟踪时应报告限制，不能从“命令成功”推导出完整文件变更清单。

真实文件历史的更新/删除/多次改同一文件/失败后部分修改仍需实施测试。本次仅验证新文件写入，不能把该项标为全场景通过。

### 11.2 Usage

本次 ACP 示例：`{sessionUpdate:"usage_update", used:42347, size:200000}`。

```ts
{
  contextUsedTokens: used,
  contextWindowTokens: size,
  contextUsagePercent: used / size * 100,
}
```

这不是累计计费 inputTokens，更不是余额。Usage 可在 prompt response 之后到达，是 Session 级事件；不要因旧 Turn 已结束而丢弃，也不要默认归到刚开始的新 Turn。

原生 step.end.usage 的字段为 inputOther、inputCacheRead、inputCacheCreation、output。选一套完整来源逐步累计，不能同时累加 `usage.record`、`step.end` 和 `agent.message.appended.meta.usage`。实施时核对这些字段的原生定义后，映射总输入、cachedInputTokens、cacheWriteInputTokens、outputTokens；不要把 inputOther 单独当作全部输入。

成本、剩余额度、五小时/周额度本次没有证据，不填 0，不伪造 inspectAccount。没有数据返回 null 或省略对应字段。

### 11.3 Commands 与压缩

`available_commands_update` 来自新建/恢复后的异步通知，包含 compact/status/usage/mcp/tasks/help 及本机 skill 命令。本机目录不是全用户固定目录。

- Session 的 `commands.list()` 返回当前真实目录，不复制 TUI 的所有 slash command。
- `commands.execute()` 通过 prompt 发送真实 slash 文本，并遵守同一 Turn 生命周期；`/compact` 不是本地假动作。
- Adapter 的静态 commandCatalog 若无法无副作用提供，就省略；不能在 getter 中启动 CLI。
- 自动压缩在当前 ACP 中部分呈现为普通文字消息；不要靠英文字符串硬编码推断 contextCompaction。需要完整专用卡片时，结合已版本化原生日志事件验证后再映射。

## 12. Fork、Rollback、导入与子 agent 的处理

### 必须明确拒绝的首版操作

Host `open({kind:"fork", checkpoint})` 要求精确到指定历史边界。原生 ACP Fork 仅调用原生无 checkpoint 参数的 fork，并沿用源 cwd。因此：

- `history.fork=false`，相应 open 分支返回 typed unsupported。
- `forkAcrossCwd=false`。
- `rollbackLastTurn=false`，不能截掉 Host 显示历史但让原生上下文仍保留那轮。
- 不直接编辑 Kimi 原生 state/wire 文件实现删除历史，不复制旧 SDK storage.forkSession 处理新目录。

### 可增加但不能冒充已完成的能力

- `sessionImport`：ACP session/list + 原生 index/state 可定位已有 Session；必须处理分页和 native cwd 校验。所查 server 实现没有把 cursor 传给其底层 list，因此不能假设多页完整。提供 Adapter 导入接口不代表 Desktop 有通用导入 UI。
- 子 agent：普通 Agent 工具可先作为 toolExecution 如实呈现。完整 observe/readTranscript 需要验证原生子身份、结束通知、子日志目录及主轮结束后的事件，不以解析标题代替。
- 自主轮次：ACP 当前 driver 关联 Host prompt，不能默认捕获所有后台行为。未验证前 `autonomousTurns.observe=false`，明确后台模式限制。
- 图片：ACP 支持 image，但当前 Host TurnStartCommand 只有 HostTextInput。若要图片输入，需单独扩展公共契约和全链路；首版不宣称 Desktop 图片支持。
- SSH/Remote Control：Adapter 在目标 Host 读取目标机器的 Kimi 配置/日志，不在本机读取远端文件。Windows 本地通过不能证明其他环境通过。

## 13. 给实施 agent 的执行顺序

### 步骤 A：确认基线，先做插件和原生边界

1. 阅读根 AGENTS 和 `.agents/skills/codexhost-add-harness/SKILL.md`，确认仍在 `kimi`，保留用户现有未提交文件。
2. 阅读本文证据，不重跑全部研究。不自动升级 Kimi 或安装旧 Python CLI。
3. 新建最小 package/manifest/factory，正确依赖公共包与 ACP SDK。
4. 实现 discovery、environment、initialize、反向请求、close；用假 ACP server 验证进程及 RPC 语义。
5. 实现只读 native identity/history parser，用本目录 native-history.json 转成聚焦测试 fixture。

完成标志：能识别真实 CLI；不能把 SDK 0.1.8 当作可工作的执行后端；历史能还原成功/取消的稳定两轮。

### 步骤 B：完成公共 Adapter/Session

1. inspect 不建会话，不发 prompt；无安装/无认证/错误配置状态可区分。
2. create/resume 返回同一可写 native 身份，所有环境传递正确。
3. turn.start/cancel、完整工具生命周期、approval、elicitation、model/thinking/permission select。
4. 实时结束前补原生 reason/ref；readSnapshot 只读且不重播 outputs。
5. Unsupported Fork/Rollback 在产生副作用前拒绝。

完成标志：真实两轮、关闭重启恢复、取消续跑、双题多选、工具批准/拒绝；没有重复文本或“永远进行中”的工具。

### 步骤 C：原生内容完整性

1. 生成实际文件变化，验证已存在文件更新/删除及拒绝操作。
2. Usage 不重复累计；恢复后数值/上下文正确。
3. Slash commands 与手动压缩走真实原生路径。
4. 错误、断线、进程退出、pending Question/Approval 的 close 全部完成终态。

完成标志：本阶段有明确通过/限制记录，不把基础聊天当作全部能力通过。

### 步骤 D：预装与 Desktop

1. 加 root tsconfig reference、预装清单、必要 lockfile；不要给 Host 加 Adapter 静态依赖。
2. 用真实 Loader 从独立 bundle 启动插件。
3. 按第 6.3 节完成 UI 与创建/恢复 route，保证模型/权限不与其他 Harness 串状态。
4. 实际 Desktop 创建 Kimi Thread，重启 Host 后恢复，验证工具、审批、Question、取消、调整方向和 Sidebar 身份。

完成标志：用户可从 Picker 创建并继续 Kimi Code Thread。未做实际 UI 验收就明确标记 Desktop 未验收。

## 14. 验收用例与命令

以下是未来实现需要完成的检查；本次没有运行产品构建或整仓测试。

| 用例 | 必须观察到的结果 |
|---|---|
| 新建 + 两轮 | NativeSessionRef 稳定，HostTurnId 不混用，唯一终态 |
| 关闭后恢复 | 同 ID，同历史，可继续；不重复显示旧回答 |
| 文本流/工具中/等待审批时取消 | 旧轮终结，交互关闭，下一轮可用 |
| 配置变更 | 只报告原生确认值，模型切换后重建 Thinking 选项 |
| 模型 alias 含 `/` 和非 ASCII | opaque 编码往返无碰撞，route schema 接受 |
| 审批 allow-once/session/reject | 范围正确，拒绝没有伪造成功修改 |
| 双题 + 多选 + 取消 | 每道题完整回传，不能降成第一题 |
| 回放污染 | system-reminder 不成为用户 Turn，工具 ID 不因 replay 前缀改变 |
| 原生失败但 ACP end_turn | 由匹配的 turn.ended.reason 判定失败 |
| 半行/缺失/未知日志版本 | 明确不完整或错误，无空历史假成功 |
| 同文件多次改动 | 工具与实际 fileChange 正确归属、最终汇总不重复 |
| 只读 inspect | 不增加 native Session、不产生 prompt、不改默认配置 |
| Loader/bundle | 仓库外 bundle 可加载，不借 workspace node_modules |
| Desktop 恢复/切 Host | Agent、Model、Thinking、权限、图标不串线 |

当前仓库的有效命令来源为根 `package.json`：

```powershell
# 满足类型/运行依赖后，运行具体新增测试，不默认全仓测试。
npx vitest run --config tests/vitest.config.js packages/adapters/kimi-code/test/<实际测试文件>.test.ts

# 预装阶段
npm run build:typescript

# UI 阶段
npm run build:renderer

# 接口/边界变更按范围执行
npm run typecheck
node tools/check-boundaries.mjs
```

上面的 `<实际测试文件>` 是占位符，实施者必须替换成自己创建的文件。已有包测试可能读取 dist，所以在需要时先构建相关依赖。`npm start` 会停止并重启运行中的 Desktop，只有用户要求实际启动时再用，不作为普通语法检查。

不要复制一套完整 SOP，也不要为了“保险”运行无关实验或全仓审计。每个实现阶段选择最直接的行为测试；失败或明确影响面扩大才加检查。

## 15. 复现本次探针

探针是用于调查的最小原始 JSON-RPC 客户端，不是生产 Transport 模板。真实 Adapter 应使用仓库已有 ACP SDK 和公共辅助函数。

```powershell
# 从 D:\CodeProject\codex-host 执行。
$probe = 'D:\DevTools\probes\kimi-sdk-20260917'
$kimi = 'C:\Users\21240\.kimi-code\bin\kimi.exe'

node tools/probes/kimi-code/probe.mjs metadata "$probe/acp" $kimi

# live 会提交两个真实模型 prompt，并只在 probe workspace 写 probe.txt。
node tools/probes/kimi-code/probe.mjs live "$probe/acp" $kimi

# features 依赖前面的 live-summary.json；会发一个随后取消的 prompt、一个提问 prompt。
node tools/probes/kimi-code/probe.mjs features "$probe/acp" $kimi

# 只读取上述两种探针产生的 native 会话，输出白名单日志摘录。
node tools/probes/kimi-code/probe.mjs history "$probe/acp" $kimi

# SDK 隔离安装已保留；本命令只验证初始化，失败是已记录的兼容性结论。
node tools/probes/kimi-code/probe.mjs sdk "$probe/sdk" $kimi "$probe/node_modules/@moonshot-ai/kimi-agent-sdk"
```

live 模式只为这个受控测试批准 allow-once；features 模式仅为固定提问选择第一项/前两项。**生产 Adapter 不得照搬这种自动审批/自动回答。** 本次探针没声明 fs/terminal 能力，执行由 Kimi 原生负责。

单次探针默认 180 秒硬截止，可由 `KIMI_PROBE_DEADLINE` 指定更早的 ISO 时间。整个调查的 wall-clock 截止为 `2026-09-17T06:14:24.2158894-07:00`；复现是新的授权工作时使用新的合理时限，不照抄已过期值。

## 16. 未验证事项与发布前限制

已经实测：Windows 2.0.0 的握手/创建、Write/Bash/allow-once、原生文件写入、进程重启恢复及续聊、取消与后续执行、双题单选/多选、配置确认及非法 Thinking、末尾 Fork/忽略 cwd、Fork 删除、Session close、原生日志稳定轮次与成功/取消原因。

尚未实测，不能在实施报告中标通过：

- 两个不同模型之间切换；未认证账户与 Provider 非认证失败。
- 工具运行中或审批/提问等待中的取消；并行 Session 与外部 CLI 同时操作同一 Session。
- approve-for-session、拒绝、Plan review、无人值守的 Question/Plan 语义。
- 更新/删除文件、shell 任意修改、原生 file-history 前后版本的完整恢复。
- 主动压缩/自动压缩后历史、原生子 agent、后台自主轮次、上下文很长时的快照。
- 大规模 session/list 分页、已有原生 Session 的导入体验。
- 其他平台、SSH/Remote Control、真实 Desktop UI 与发行 bundle。

这些是边界清单，不要求本次研究把它们全跑一遍；实施 agent 应对其实际声明的能力补必要验收。原生日志是随版本变化的内部持久化格式，需限定已支持版本并对未知版本给出明确错误；不要建立多代兼容框架直到真实出现第二个需要支持的版本。

## 17. 官方资料与源码锚点

以官方源码 commit 和本目录实测证据为准；网页 main 会变化。

- 官方 SDK 仓库：<https://github.com/MoonshotAI/kimi-agent-sdk>
- SDK 固定版本 Node 接口：<https://github.com/MoonshotAI/kimi-agent-sdk/tree/ed4be6be5280d02191da88bbafb3f828dcd33d72/node/agent_sdk>
- SDK 启动参数：同 commit 的 `node/agent_sdk/protocol.ts`，`buildArgs`（约 367–397 行）。
- SDK 会话、Question、steer：`node/agent_sdk/session.ts`；历史路径/派生：`paths.ts`、`storage.ts`。
- Kimi Code ACP 官方文档：<https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html>
- CLI 文档：<https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html>
- 配置文档：<https://moonshotai.github.io/kimi-code/en/configuration/config-files.html>
- 固定 ACP 实现：<https://github.com/MoonshotAI/kimi-code/tree/86e08208e3445171f6500c948234d7e3a0684324/packages/acp-server/src>
- `server.ts`：initialize/new/fork/load/resume/list/config/auth；约 193、242、266、296、312、323、471、625 行。
- `replay.ts`：回放构造合成 toolCallId；约 39–92 行。
- `events-map.ts`：Turn reason 信息损失、工具 content 替换、Usage；约 49–74、367–397、502–520 行。
- `session.ts`：onTurnEnded/emitUsageUpdate、动态 config；约 907–939、1012–1151 行。
- `approval.ts`：allow_always 实际 session scope，Plan review 选项。
- `question.ts` 与 `interaction-bridge.ts`：elicitation 全题/多选以及 permission fallback 的降级。
- `config-options.ts`、`model-catalog.ts`、`modes.ts`：模型/Thinking/模式转换。

## 18. 可直接交给实施 agent 的任务文本

> 在当前 `kimi` 分支实施 Kimi Code Harness 接入。先完整阅读 `docs/harnesses/kimi-code/implementation-guide.md` 和随附 evidence，再阅读 codexhost-add-harness skill 及实际公共类型。当前目标是本机已安装的 Kimi Code 2.0.0；官方 Kimi SDK 0.1.8 已被探针证实启动不兼容，使用 `kimi acp` 与仓库现有 ACP SDK，按文档只读原生日志补齐历史、稳定轮次和真实终态。按步骤 A→D 完成后端、必要内容投影、预装和 Desktop 接线。保留原生能力和实际限制，不硬编码本机模型/用户路径，不改认证或默认配置，不新增 Kimi 专用 Host 路由，不伪造 Fork/Rollback/子 agent 支持。每阶段做与改动最相关的检查，失败修复后继续；不要只做文本回显后就称完成。所有最终声明必须有实现和对应验收依据。未经用户另行授权不 commit/push、不提交 upstream PR、不运行 npm start 重启当前 Desktop；确需真实 UI 启动时清楚说明当前阻塞和需要的动作。
