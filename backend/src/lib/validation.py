"""
Customizable autopilot validation harness.

After an autopilot agent reports it's done, the backend runs a user-defined
bash script on the EC2 to validate the agent's work. If the script exits
non-zero, the harness feeds the failure output back to the same Claude session
as a follow-up turn so the agent can self-heal. Loop up to N times, then give
up and surface the failure to the user.

The script is discovered at one of two locations (project beats user):
  1. <worktree>/.pocketeng/validate.sh   — committed to the user's repo
  2. ~/.pocketeng/validate.sh            — per-EC2 default, provisioned by userdata.py

Both locations receive these env vars:
  PE_REPO_DIR   absolute path to the worktree
  PE_BASE_REF   base branch ref (e.g. origin/main)
  PE_BRANCH     current working branch
  PE_SESSION_ID session id for logging

Exit 0 = pass. Non-zero = fail. stdout+stderr is captured and fed back to the
agent (last ~4000 chars, tail-biased).
"""
import shlex

from src.lib.ssh import ssh_exec


_MAX_FEEDBACK_CHARS = 4000


def find_validation_script(client, worktree_path):
    """
    Return the absolute path to validate.sh on the EC2, or None if neither
    location has a script. Project-level (inside the worktree) beats the
    user-level default. The script must be executable (`-x`) to count.
    """
    project_script = None
    if worktree_path:
        project_script = f"{worktree_path.rstrip('/')}/.pocketeng/validate.sh"

    check_parts = []
    if project_script:
        check_parts.append(
            f'[ -x {shlex.quote(project_script)} ] && echo PROJECT && exit 0'
        )
    check_parts.append(
        '[ -x "$HOME/.pocketeng/validate.sh" ] && echo USER && exit 0'
    )
    check_parts.append('echo NONE')

    cmd = "; ".join(check_parts)
    stdout, _, _ = ssh_exec(client, cmd, timeout=5)
    tag = (stdout or "").strip().split("\n")[-1].strip() if stdout else "NONE"

    if tag == "PROJECT" and project_script:
        return project_script
    if tag == "USER":
        return "$HOME/.pocketeng/validate.sh"
    return None


def run_validation_script(
    client,
    script_path,
    worktree_path,
    base_ref="origin/main",
    branch="",
    session_id="",
    timeout=90,
):
    """
    Execute the validation script via SSH with the PE_* env vars set.

    Returns a tuple: (passed: bool, output: str, exit_code: int)

    Output is the last _MAX_FEEDBACK_CHARS of combined stdout+stderr, which is
    what gets fed back to the agent as the next user-style prompt.
    """
    cd_target = worktree_path or "$HOME"

    # Use `bash` explicitly (script_path might be unquoted `$HOME/...`).
    # Combine stderr into stdout so the agent sees both. Wrap the runtime in
    # `timeout` so a runaway script can't pin the Lambda for the full timeout.
    cmd = (
        f"cd {shlex.quote(cd_target)} 2>/dev/null || cd $HOME; "
        f"PE_REPO_DIR={shlex.quote(worktree_path or '')} "
        f"PE_BASE_REF={shlex.quote(base_ref or 'origin/main')} "
        f"PE_BRANCH={shlex.quote(branch or '')} "
        f"PE_SESSION_ID={shlex.quote(session_id or '')} "
        f"timeout {int(timeout)} bash {script_path} 2>&1"
    )

    stdout, stderr, exit_code = ssh_exec(
        client,
        f"bash -l -c {shlex.quote(cmd)}",
        timeout=timeout + 15,
    )

    combined = (stdout or "") + (stderr or "")
    if len(combined) > _MAX_FEEDBACK_CHARS:
        combined = (
            "…(output truncated; showing last "
            f"{_MAX_FEEDBACK_CHARS} chars)…\n"
            + combined[-_MAX_FEEDBACK_CHARS:]
        )

    passed = (exit_code == 0)
    return passed, combined, int(exit_code)
