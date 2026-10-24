"""SSH helper for connecting to EC2 instances via paramiko."""
import paramiko
from io import StringIO


def ssh_connect(host: str, private_key_pem: str, username: str = "ec2-user", timeout: int = 10):
    """Connect to an EC2 instance. Returns an SSHClient."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    # Try Ed25519 first, fall back to RSA
    try:
        pkey = paramiko.Ed25519Key.from_private_key(StringIO(private_key_pem))
    except Exception:
        pkey = paramiko.RSAKey.from_private_key(StringIO(private_key_pem))

    client.connect(
        hostname=host,
        username=username,
        pkey=pkey,
        timeout=timeout,
        banner_timeout=timeout,
        auth_timeout=timeout,
    )
    return client


def ssh_exec(client: paramiko.SSHClient, command: str, timeout: int = 20) -> tuple:
    """Execute a command and return (stdout, stderr, exit_code)."""
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    exit_code = stdout.channel.recv_exit_status()
    return stdout.read().decode(errors="replace"), stderr.read().decode(errors="replace"), exit_code


def ssh_exec_bytes(
    client: paramiko.SSHClient,
    command: str,
    stdin_bytes: bytes = b"",
    timeout: int = 20,
) -> tuple:
    """Execute a command with optional stdin bytes; return (stdout_bytes, stderr_bytes, exit_code)."""
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_bytes:
        stdin.write(stdin_bytes)
        stdin.flush()
    stdin.channel.shutdown_write()
    exit_code = stdout.channel.recv_exit_status()
    return stdout.read(), stderr.read(), exit_code


def ssh_disconnect(client: paramiko.SSHClient):
    """Close the SSH connection."""
    try:
        client.close()
    except Exception:
        pass
