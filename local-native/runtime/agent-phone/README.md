# Rakazo 本机 Agent 通信

本机常驻服务将 Rakazo 的 MCP 工具接到真实 Codex App Server 和 Claude Code
双向 CLI。原生客户端保留工具和技能配置，按用户要求开启全部权限。
Codex 使用本服务 `config.json` 指定的模型连接；
新会话和重连使用明确配置的 provider。
Claude Code 沿用其原生连接配置。

- 监控页：`http://127.0.0.1:18779`
- MCP：`http://127.0.0.1:18779/mcp`
- Rakazo 连接名称：**本机 Agent 通信**，当前用户的 Bot 可用。
- 可选服务标签：`ai.rakazo.agent-phone`，由 macOS LaunchAgent 登录自启并保持运行。

## 使用

在 Rakazo 中直接说：

> 让 Codex 在 /绝对路径/项目 中完成这个任务，持续跟踪进度。

> 给刚才的 Claude Code 会话追加这个要求。

> 查看两边进度，停止 Codex 当前任务。

`phone_start` 省略 `model` 时使用服务配置的默认模型。`config.json` 的
`codex.modelProvider` 和 `codex.config` 传入原生 `thread/start`、
`thread/resume`；修改后仅需重启本通信服务，无需改写主客户端 `~/.codex/config.toml`。

Rakazo 可调用：

| 工具 | 功能 |
| --- | --- |
| `phone_start` | 派发任务并返回可重复联系的会话编号 |
| `phone_send` | 同一会话继续发消息，包括正在执行时 |
| `phone_read` | 按 cursor 增量读取进度，可等待新事件最多 25 秒 |
| `phone_list` | 查找已有会话及状态 |
| `phone_stop` | 请求停止并读取原生确认 |
| `phone_inspect` | 只读查询协议能力、稳定操作键及持久回执，不启动原生进程 |

监控页通过 SSE 实时显示回复和工具活动，可直接追加消息或停止任务。
Codex 在活动 turn 中接收 steering；Claude Code 即时接收输入并按原生执行边界
处理队列，界面明确显示已排队，不把排队说成已经执行。

`idle` 表示这一轮结束、会话仍可继续；原生后台子任务的进展以工具事件为准。
任务是否交付成功应以文件和实际结果核验。

## 操作回执与集成

协议版本为 `protocolVersion: 1`。`phone_start/send/stop` 支持稳定
`requestId`，也接受同义的 `operationKey`；同时提供时必须相同。不传则生成并返回。
同一键只能用于相同操作、会话和内容，重复调用返回原 `operation`，不会重新发送。
`phone_start` 仍立即返回会话，首个回执通常只是本地队列。

`phone_inspect({})` 返回能力；按 `agent` 或 `sessionId` 返回对应执行者的能力。
按 `requestId` / `operationKey` 可找回启动响应丢失的会话：

```json
{"sessionId":"optional-phone-session-id","requestId":"stable-key"}
```

找到时返回 `{protocolVersion,capabilities,found:true,session,operation}`；
未找到返回 `found:false`。仅提供 sessionId 时返回该会话的 `operations` 和
`pendingInputRequests`。查询不会连接、恢复或重发任务。

操作状态以 `operation.state` 为准：

| 状态 | 证据 |
| --- | --- |
| `registered` | 本地已登记意图 |
| `queued`，`queueOwner=local` | phone 本地队列，尚未原生接受 |
| `dispatching` | 发送已开始，尚未得到对应原生 ACK |
| `accepted` / `running` | 已有对应原生接受或执行证据 |
| `queued`，`queueOwner=native` | 原生已明确接纳排队输入 |
| `completed` / `failed` / `cancelled` | 对应操作的终态，不等于成品验收 |
| `unknown` | 无法确认接受或终态；保留 `acceptedAt`、`lastKnownState` 和已知标识 |

旧 `delivery=started/steered/queued` 字段保留兼容，不代替操作状态。
Claude 的 stdin 写入成功仍是 `dispatching`，收到原生 user-message echo 才确认接受。
多个输入合并或没有可核验的输入对应关系时，result 不会把它们都标成成功。
Claude 的 `turnIdSource=input` 表示输入 UUID，不能当作原生 turn ID；
Codex 的 `turnIdSource=native` 是原生 turn 标识。

事件保持原有文本、工具和状态字段，新增稳定 `providerEventId=sessionId:seq`、
有证据的 `operationKey/operationKeys` 和 turn 关联。不能唯一对应的 Claude
输出使用 `candidateOperationKeys`、`association=pending_inputs`，不当作确定关联。
`type=operation` 携带当时的操作快照，`phone_read` 的
`{session,events,cursor,hasMore}` 及增量游标保持不变。

HTTP 查询沿用原 Bearer/cookie 认证：

```text
GET /api/inspect?sessionId=...&requestId=...&agent=...
GET /api/operations?requestId=...
GET /api/operations/:encodedRequestId
GET /api/sessions/:id/inspect
```

原有 start/send/read/stop HTTP 路由继续可用，send/stop 接受新参数。
操作冲突或 turn 不匹配返回 HTTP 409；如果操作已登记，错误体保留其回执供查证。

## 停止与等待输入

`phone_stop` 支持自身的 `requestId`、`expectedTurnId` 和 `targetRequestId`。
`targetRequestId` 是要停止的 start/send 操作，不能与本次 stop 的键混淆。
旧 stop 键只返回原回执；旧 turn 不匹配时拒绝，不停止后来工作。
停止进行中不接受新发送。

成功 stop 回执是 `operation.state=completed` 且 `stopConfirmed=true`。
这需要 Codex 对应 turn 终态，或 Claude 本服务拥有的进程退出；
取消 ACK 本身不够。前台结果已经完成但原生后台仍工作时仍要停稳。
发送结果未知且没有目标 turn 时不借用最新 turn 取消。

Codex 的原生 `item/tool/requestUserInput` 事件提供 `inputRequestId`。
原连接仍有效时，使用 `phone_send` 回答原问题：

```json
{
  "sessionId": "phone-session-id",
  "requestId": "answer-operation-key",
  "expectedTurnId": "native-turn-id",
  "inputRequestId": "native-question-request-id",
  "answers": {"question-id": {"answers": ["answer"]}}
}
```

答案写回原 RPC request，不创建新 turn；后续原生 resolved 或对应终态确认结果。
过期问题拒绝，不改成新 prompt。能力声明中 Codex `inputResponse=true`，
Claude 为 false；无参数能力查询返回保守的 false，并给出 `capabilitiesByAgent`。
MCP elicitation、Claude 交互回答和重启后的原 RPC handle 恢复本版不支持。

## 会话与重启

`data/sessions/` 保存会话索引和逐条事件。`nativeSessionId` 关联原生客户端的历史。
服务重启不会自动重新派发旧 prompt；下次明确发送消息时按原生会话恢复。
中断状态不意味着任务未产生效果，不用重新发送原任务来推测状态。

操作回执随会话索引和逐条日志保存，重启重读日志补齐落后索引。
未完成的原生操作变为 `unknown` 并保留接受证据；确定尚未发出的本地输入可取消。
旧版 `sentRequestIds` 仅作为登记证据迁移为 unknown，不当作已接受。
同键重试只返回该事实，不重放。查询能力是本服务的持久操作查询，
`nativeOperationLookup=false` 明确表示不能保证在原生进程崩溃后找回丢失 ACK。

服务退出会关闭它自己启动的客户端连接，不操作用户在别处打开的 Codex/Claude。
本机休眠或关机时不能执行任务；唤醒或登录后的服务由 macOS 管理。

## 维护

```sh
launchctl print "gui/$(id -u)/ai.rakazo.agent-phone"
curl http://127.0.0.1:18779/health
```

LaunchAgent 配置：`~/Library/LaunchAgents/ai.rakazo.agent-phone.plist`。
日志位置由安装时的 LaunchAgent 配置指定。
MCP 凭据保存在权限 `0600` 的 `data/token`，不提交或展示其内容。
监控页面限本机访问，MCP 调用校验 Bearer 凭据。

定向检查：

```sh
# 在本目录运行
npm test
```

安装不修改 Rakazo 主运行时、模型默认值或三档审批配置。
