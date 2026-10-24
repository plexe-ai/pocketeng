"""Ship the agent-bridge files to an EC2 workspace over SFTP.

The bridge source lives in `src/lib/bridge/` and is bundled into the Lambda
by SAM. On each session launch we ensure the VM has the current version at
`~/.pocketeng/bridge/` and a `node_modules` symlink so the bridge's SDK
imports resolve against whatever npm installed globally.

Idempotent: a short version file is written alongside the bridge. If the
hash of our local files already matches what's on the VM we skip the SFTP
upload entirely — steady-state cost is one SSH read of a tiny file.
"""
import hashlib
import os
import shlex
from io import BytesIO

from src.lib.ssh import ssh_exec


BRIDGE_SRC_DIR = os.path.join(os.path.dirname(__file__), "bridge")
REMOTE_BRIDGE_DIR = "~/.pocketeng/bridge"


def _discover_bridge_files():
    """Ship every .mjs module in the bridge dir except tests. Auto-discovery
    so adding a new module doesn't silently break deploys."""
    return tuple(sorted(
        f for f in os.listdir(BRIDGE_SRC_DIR)
        if f.endswith(".mjs") and not f.endswith(".test.mjs")
    ))


BRIDGE_FILES = _discover_bridge_files()


def _bridge_version():
    """Compute a stable sha256 over the bridge source we're about to ship.

    The hash covers only the files we actually upload — not CLAUDE.md,
    package.json, or tests. That way editing docs or tests doesn't force a
    re-upload on every VM on next session start.
    """
    h = hashlib.sha256()
    for name in BRIDGE_FILES:
        path = os.path.join(BRIDGE_SRC_DIR, name)
        with open(path, "rb") as f:
            content = f.read()
        h.update(name.encode())
        h.update(b"\0")
        h.update(content)
        h.update(b"\0")
    return h.hexdigest()


def _read_bridge_file(name):
    with open(os.path.join(BRIDGE_SRC_DIR, name), "rb") as f:
        return f.read()


def _remote_version(client):
    """Read the version file the last deploy wrote. Missing → empty string."""
    stdout, _, _ = ssh_exec(
        client,
        f"cat {REMOTE_BRIDGE_DIR}/.version 2>/dev/null || true",
        timeout=10,
    )
    return stdout.strip()


def _ensure_sdk_deps_and_symlink(client):
    """Ensure SDK deps are at the npm global top level and node_modules is
    symlinked into the bridge dir. MUST run on every session launch (not
    gated by bridge file hash) — a VM may have the current bridge files but
    still be missing an SDK dep that we added later.

    The `test -d` check is cheap (stat only); the `npm install -g` inside
    only runs when at least one dep is missing. Safe to call every time.

    Linux VMs own the global node_modules dir as root; macOS Homebrew is
    user-owned. Try the plain install first, fall back to `sudo -n` on
    permission errors.
    """
    install_cmd = (
        "npm install -g @anthropic-ai/claude-agent-sdk @opencode-ai/sdk @openai/codex-sdk @cursor/sdk "
        "2>/tmp/pe-bridge-npm.log "
        "|| sudo -n npm install -g @anthropic-ai/claude-agent-sdk @opencode-ai/sdk @openai/codex-sdk @cursor/sdk "
        "2>>/tmp/pe-bridge-npm.log "
        "|| true"
    )
    # Source nvm first — on BYOS Ubuntu/Debian boxes Node is almost always
    # installed via nvm, and non-interactive SSH doesn't pick it up from
    # ~/.bashrc (which returns early without PS1). Without sourcing nvm
    # here, `command -v npm` fails and this whole function silently skips
    # the SDK install, leaving the bridge unable to `import` the Claude
    # Agent SDK.
    cmd = (
        f"export NVM_DIR=\"$HOME/.nvm\"; "
        f"[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"; "
        f"mkdir -p {REMOTE_BRIDGE_DIR} && "
        f"if command -v npm >/dev/null 2>&1; then "
        f"  NPM_ROOT=$(npm root -g 2>/dev/null); "
        f"  if [ ! -d \"$NPM_ROOT/@anthropic-ai/claude-agent-sdk\" ] "
        f"  || [ ! -d \"$NPM_ROOT/@opencode-ai/sdk\" ] "
        f"  || [ ! -d \"$NPM_ROOT/@openai/codex-sdk\" ] "
        f"  || [ ! -d \"$NPM_ROOT/@cursor/sdk\" ]; then "
        f"    {install_cmd}; "
        f"    NPM_ROOT=$(npm root -g 2>/dev/null); "
        f"  fi; "
        f"  if [ -n \"$NPM_ROOT\" ] && [ -d \"$NPM_ROOT\" ]; then "
        f"    ln -sfn \"$NPM_ROOT\" {REMOTE_BRIDGE_DIR}/node_modules; "
        f"  fi; "
        f"fi"
    )
    # First-time installs of three npm packages can take 30-120s on t3
    # instances. Subsequent calls are fast (only stat).
    ssh_exec(client, cmd, timeout=240)


def _sftp_write(client, remote_path, content_bytes):
    """Write a single file to the VM via SFTP. Uses paramiko's transport
    from the existing SSHClient — no new connection."""
    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH client has no transport; cannot open SFTP")
    sftp = transport.open_sftp_client()
    try:
        # Expand `~` — SFTP doesn't do that for us.
        if remote_path.startswith("~/"):
            stdout, _, _ = ssh_exec(client, "echo $HOME", timeout=5)
            home = stdout.strip()
            remote_path = home + remote_path[1:]
        with sftp.file(remote_path, "wb") as f:
            f.write(content_bytes)
    finally:
        sftp.close()


def ensure_bridge_deployed(client):
    """Idempotent setup on the VM:
      1. SDK deps + node_modules symlink — runs every call (cheap stat).
      2. Bridge .mjs files — hash-gated; skipped when version already matches.

    Returns the deployed version hash so callers can log it.
    """
    # (1) Always ensure deps + symlink. A prior deploy may have written
    # correct bridge files but never installed the SDKs.
    _ensure_sdk_deps_and_symlink(client)

    # (2) Hash-gated file upload.
    local_version = _bridge_version()
    remote_version = _remote_version(client)
    if remote_version == local_version:
        return local_version

    for name in BRIDGE_FILES:
        content = _read_bridge_file(name)
        _sftp_write(client, f"{REMOTE_BRIDGE_DIR}/{name}", content)

    _sftp_write(client, f"{REMOTE_BRIDGE_DIR}/.version", local_version.encode())

    return local_version
