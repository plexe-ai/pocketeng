"""
POST /servers/{serverId}/upload — Upload a file to an EC2 instance via SFTP.
Returns the remote path the file was written to.
"""
import json
import base64
from io import BytesIO

from src.lib.auth import extract_auth_header, verify_token
from src.lib.db import get_server
from src.lib.kms import decrypt
from src.lib.ssh import ssh_connect, ssh_disconnect
from src.lib.team_auth import can_access_owned_resource


UPLOAD_DIR = "/tmp/pe-uploads"


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    try:
        # Auth
        try:
            claims = verify_token(extract_auth_header(event.get("headers", {})))
        except Exception as e:
            return respond(401, {"error": str(e)})

        user_id = claims["sub"]
        server_id = event.get("pathParameters", {}).get("serverId")
        if not server_id:
            return respond(400, {"error": "serverId required"})

        server = get_server(server_id)
        if not server:
            return respond(404, {"error": "Server not found"})
        if not can_access_owned_resource(user_id, server):
            return respond(403, {"error": "Not your server"})
        if server.get("instanceState") != "running":
            return respond(400, {"error": "Server is not running"})

        body = json.loads(event.get("body") or "{}")
        file_name = body.get("fileName")
        file_data_b64 = body.get("fileData")

        if not file_name or not file_data_b64:
            return respond(400, {"error": "fileName and fileData required"})

        # Decode file data
        try:
            file_bytes = base64.b64decode(file_data_b64)
        except Exception:
            return respond(400, {"error": "Invalid base64 fileData"})

        # Connect via SSH
        public_ip = server.get("publicIp")
        if not public_ip or not server.get("sshPrivateKey"):
            return respond(400, {"error": "Server not ready (no IP or key)"})

        ssh_user = server.get("sshUser", "ec2-user")
        private_key = decrypt(server["sshPrivateKey"])
        client = ssh_connect(public_ip, private_key, username=ssh_user)

        try:
            # Create upload dir and write file via SFTP
            sftp = client.open_sftp()
            try:
                sftp.mkdir(UPLOAD_DIR)
            except IOError:
                pass  # Directory already exists
            remote_path = f"{UPLOAD_DIR}/{file_name}"
            sftp.putfo(BytesIO(file_bytes), remote_path)
            sftp.close()
        finally:
            ssh_disconnect(client)

        return respond(200, {"path": remote_path})

    except Exception as e:
        print(f"[upload] Error: {e}")
        return respond(500, {"error": str(e)})
