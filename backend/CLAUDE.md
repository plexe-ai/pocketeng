# Backend API

AWS SAM stack with Python 3.12 Lambda functions behind API Gateway.

## Stack

- AWS SAM (template.yaml defines everything)
- Python 3.12 runtime
- DynamoDB for all state (no SQL database)
- KMS for encrypting SSH keys and API keys at rest
- paramiko for SSH from Lambda to EC2 instances

## Commands

```bash
sam build                # Build all functions
sam deploy               # Deploy (reads samconfig.toml for params)
sam local invoke FnName  # Test a function locally
```

Config is in `samconfig.toml` (NEVER COMMIT — has real secrets in parameter_overrides). Use `samconfig.toml.example` as a template.

## Lambda Functions

| Function | Route | What it does |
|---|---|---|
| ProvisionFunction | POST /servers | Provision EC2 or register BYOS server |
| ServersFunction | GET /servers | List all servers with live EC2 state |
| StatusFunction | GET /servers/{id} | Server status + decrypted SSH key |
| StatusFunction | POST /servers/{id}/heartbeat | Update lastActivityAt |
| ActionFunction | POST /servers/{id}/action | Start/stop/terminate |
| ChatFunction | POST /servers/{id}/chat | SSH commands: start-session, send-message, poll-output, install-agent, discover-services, preview-proxy |
| LifecycleFunction | EventBridge (disabled) | Auto-stop idle instances |
| SlackCommandFunction | POST /slack/command | Slack slash commands |
| SlackWorkerFunction | (invoked async) | Execute Slack commands via SSH |

## Auth

All endpoints verify Supabase JWT from `Authorization: Bearer <token>` header. The `src/lib/auth.py` module handles HS256 + ES256 verification. User ID comes from `claims["sub"]`.

## BYOS vs Managed Servers

This is the most important distinction in the codebase:

**Managed servers** (`envType: "general"` — Linux EC2):
- Have a real EC2 `instanceId`
- Can be started/stopped/terminated via EC2 API
- Lifecycle Lambda can auto-stop them
- `describe_instance()` works on them

**BYOS servers** (`envType: "byos"`):
- `instanceId` is literally the string `"byos"`
- CANNOT call any EC2 API on them (start/stop/terminate will crash)
- Lifecycle Lambda MUST skip them
- Action handler MUST guard against EC2 calls
- Always show as "running" — we don't control the instance

Every new feature that touches servers must handle both types. Check `envType` before calling EC2.

## Key Files

```
src/
  provision.py          POST /servers — two paths: BYOS (verify SSH + save) and managed (launch EC2)
  servers.py            GET /servers — list with live state, skip EC2 for BYOS
  status.py             GET /servers/{id} — return stored state for BYOS, live state for managed
  action.py             POST /servers/{id}/action — guard BYOS from EC2 calls
  chat.py               POST /servers/{id}/chat — SSH commands, uses sshUser field for BYOS
  lifecycle.py          Auto-stop idle instances — MUST skip BYOS
  lib/
    auth.py             JWT verification (HS256 + ES256)
    db.py               DynamoDB CRUD (get_server, put_server, update_server, scan_active_servers)
    ec2.py              EC2 operations (launch, describe, start, stop, terminate)
    kms.py              Encrypt/decrypt via KMS
    ssh.py              paramiko SSH helper (connect, exec, disconnect)
    userdata.py          EC2 userdata script (Linux only) — installs agents, clones repos, sets up skills
```

## DynamoDB Schema (pe-servers-{stage})

Key: `serverId` (UUID string). GSI on `userId`.

Important fields:
- `envType`: "general" | "byos"  (the legacy "ios" — mac2.metal Dedicated Hosts — was dropped in v1)
- `instanceId`: real EC2 ID or "byos"
- `instanceState`: "running" | "stopped" | "terminated" | "launching" | "pending"
- `publicIp`: current IP (null when stopped)
- `sshPrivateKey`: KMS-encrypted PEM
- `sshUser`: SSH username (default "ec2-user", BYOS might be "ubuntu" etc.)
- `agents`: list of installed agent IDs ["claude", "codex"]
- `skills`: list of skill IDs ["nextjs", "testing"]

## Gotchas

- Lambda timeout is 30s for HTTP API. The chat function's `install-agent` action can take 120s — it has a longer timeout in template.yaml.
- `samconfig.toml` parameter_overrides must include SupabaseUrl, SupabaseJwtSecret, SlackSigningSecret.
- Lifecycle Lambda is currently `Enabled: false` in template.yaml. Turn it back on when auto-stop is needed.
- SSH from Lambda uses paramiko. The Ed25519 key from KMS must be loaded via `StringIO`.
- BYOS provision path SSHs into the server to verify connectivity and detect agents before saving.
