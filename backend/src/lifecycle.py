"""
EventBridge scheduled Lambda — runs every 5 minutes.
Auto-stops idle instances (no heartbeat for autoStopMinutes).
"""
from datetime import datetime, timezone

from src.lib.db import scan_active_servers, update_server
from src.lib.ec2 import describe_instance, stop_instance

DEFAULT_IDLE_MINUTES = 30


def handler(event, context):
    print("Lifecycle check started")
    servers = scan_active_servers()
    print(f"Found {len(servers)} active server(s)")

    stopped = 0

    for server in servers:
        try:
            # Skip BYOS servers — they don't have EC2 instances to manage
            if server.get("envType") == "byos":
                continue

            live = describe_instance(server["instanceId"])
            if not live:
                update_server(server["serverId"], {"instanceState": "terminated", "publicIp": None})
                continue

            # Sync cached state
            if live["state"] != server.get("instanceState"):
                update_server(server["serverId"], {
                    "instanceState": live["state"],
                    "publicIp": live.get("publicIp"),
                })

            # Auto-stop idle running instances
            if live["state"] == "running":
                last_activity_str = server.get("lastActivityAt") or server.get("createdAt")
                last_activity = datetime.fromisoformat(last_activity_str.replace("Z", "+00:00"))
                idle_minutes = (datetime.now(timezone.utc) - last_activity).total_seconds() / 60
                threshold = server.get("autoStopMinutes") or DEFAULT_IDLE_MINUTES

                if idle_minutes > threshold:
                    print(f"Stopping idle server {server['serverId']} (idle {idle_minutes:.0f}min)")
                    stop_instance(server["instanceId"])
                    update_server(server["serverId"], {"instanceState": "stopping"})
                    stopped += 1

        except Exception as e:
            print(f"Error processing server {server.get('serverId')}: {e}")

    print(f"Lifecycle complete: {stopped} stopped")
    return {"stopped": stopped}
