# Contract surface

All wire shapes live in `@devspace/contracts` as zod schemas; static types are
inferred from them so the format and the type cannot drift. This doc summarizes
them; the schemas are the source of truth.

## Sandbox Core API (agent-agnostic primitives)

| Method                                        | Request                    | Response                       |
| --------------------------------------------- | -------------------------- | ------------------------------ |
| `POST /environments`                          | `CreateEnvironmentRequest` | `Environment`                  |
| `GET /environments/:id`                       | —                          | `Environment \| null`          |
| `DELETE /environments/:id`                    | —                          | —                              |
| `POST /environments/:id/exec`                 | `ExecRequest`              | **bidi stream of `ExecFrame`** |
| `POST /environments/:id/fs/{read,write,list}` | `Fs*Request`               | bytes / `FsEntry[]`            |
| `POST /environments/:id/ports`                | `{containerPort}`          | `PortMapping`                  |

`ExecFrame` keeps `stdin`/`stdout`/`stderr`/`exit` as a discriminated union; byte
payloads are base64. This is the primitive ACP rides on.

`CreateEnvironmentRequest.mounts[]` and `.secrets[]` are the generic mechanisms
used to inject the agent runtime and the LLM/Git secrets — the core stays unaware.

## Agent Runner API (ACP-backed)

| Method                                 | Request                     | Response            |
| -------------------------------------- | --------------------------- | ------------------- |
| `POST /agents/sessions`                | `CreateAgentSessionRequest` | `{agentSessionId}`  |
| `POST /agents/sessions/:id/turn`       | `TurnRequest`               | SSE of `AgentEvent` |
| `POST /agents/sessions/:id/permission` | `PermissionDecision`        | —                   |
| `DELETE /agents/sessions/:id`          | —                           | —                   |

`AgentEvent` is the normalized stream (`thought`, `message`, `tool_call`,
`tool_result`, `file_edit`, `command_run`, `permission_request`, `turn_end`). Raw
ACP never leaks upward.

## Chat Gateway interfaces

- Inbound `ChatEvent`: `conversation.created` · `message.posted` · `action.invoked`.
- Outbound `RenderCommand`: `post_message` · `update_status` · `post_actions` · `stream_append`.
- `ChatAdapter` / `ChatRenderer` interfaces live in `@devspace/chat-gateway`.

## Orchestrator FSM

`WorkState`, `WorkEvent`, `WORK_TRANSITIONS`, `nextWorkState()`, and `WorkUnit`
are exported from `@devspace/contracts`. The orchestrator is the only writer;
`@devspace/db`'s `WorkUnitRepo.transition()` enforces legality.
