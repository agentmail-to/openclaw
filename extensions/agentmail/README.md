# AgentMail OpenClaw channel

Official external OpenClaw channel plugin for durable, reply-only email conversations through AgentMail. Webhook ingress is verified before durable admission; WebSocket mode uses persisted REST catch-up to recover restart and reconnect gaps.

## Install

```sh
openclaw plugins install @openclaw/agentmail
```

## Docs

See `docs/channels/agentmail.md` in this repository or <https://docs.openclaw.ai/channels/agentmail>.
