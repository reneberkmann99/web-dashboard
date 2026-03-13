# HostPanel Node Agent

The node agent runs on each host and exposes a secure internal API for container monitoring and control.

## Endpoints

- `GET /health`
- `GET /containers`
- `GET /containers/:id`
- `GET /containers/:id/logs?tail=200`
- `POST /containers/:id/start`
- `POST /containers/:id/stop`
- `POST /containers/:id/restart`

All endpoints require `x-agent-key`.

## Modes

- `AGENT_DOCKER_MODE=mock` uses sample in-memory container data.
- `AGENT_DOCKER_MODE=rootless` runs Docker CLI commands in a rootless-compatible context.

## Rootless mode notes

Run the agent as the Linux user that owns the rootless Docker daemon and configure:

```bash
DOCKER_HOST=unix:///run/user/1000/docker.sock
XDG_RUNTIME_DIR=/run/user/1000
```

The adapter only allows whitelisted Docker actions (`start`, `stop`, `restart`) and validates container identifiers before command execution.
