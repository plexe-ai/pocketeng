import boto3

_ec2 = boto3.client("ec2")


def find_latest_ami():
    resp = _ec2.describe_images(
        Owners=["amazon"],
        Filters=[
            {"Name": "name", "Values": ["al2023-ami-*-x86_64"]},
            {"Name": "state", "Values": ["available"]},
        ],
    )
    images = sorted(resp["Images"], key=lambda x: x["CreationDate"], reverse=True)
    if not images:
        raise Exception("No Amazon Linux 2023 AMI found")
    return images[0]["ImageId"]


def create_security_group(name):
    """Create an SG for a managed workspace. Ingress is SSH only.

    Dev-server ports (3000–9000) used to be open to 0.0.0.0/0 for the
    Vercel preview proxy's fast path. After the Cloudflare Tunnel
    migration the workspace exposes dev servers outbound-only through
    `cloudflared`, so we no longer need (or want) them open at the
    EC2 edge. Existing workspaces' SGs are untouched — this only
    affects newly-provisioned workspaces.
    """
    sg = _ec2.create_security_group(
        GroupName=name, Description="PocketEng managed server"
    )
    sg_id = sg["GroupId"]
    _ec2.authorize_security_group_ingress(
        GroupId=sg_id,
        IpPermissions=[
            {
                "IpProtocol": "tcp",
                "FromPort": 22,
                "ToPort": 22,
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            },
        ],
    )
    return sg_id


def import_key_pair(name, public_key_bytes):
    _ec2.import_key_pair(KeyName=name, PublicKeyMaterial=public_key_bytes)


def _compress_userdata(userdata):
    """Gzip + base64 encode userdata. Linux cloud-init natively decompresses gzipped userdata."""
    import base64
    import gzip
    return base64.b64encode(gzip.compress(userdata.encode())).decode()


def launch_instance(ami_id, key_name, sg_id, userdata, user_id):
    resp = _ec2.run_instances(
        ImageId=ami_id,
        InstanceType="t3.medium",
        MinCount=1,
        MaxCount=1,
        KeyName=key_name,
        SecurityGroupIds=[sg_id],
        UserData=_compress_userdata(userdata),
        BlockDeviceMappings=[
            {
                "DeviceName": "/dev/xvda",
                "Ebs": {
                    "VolumeSize": 30,
                    "VolumeType": "gp3",
                    "DeleteOnTermination": True,
                },
            }
        ],
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "ManagedBy", "Value": "pocketeng"},
                    {"Key": "UserId", "Value": user_id},
                ],
            }
        ],
    )
    return resp["Instances"][0]["InstanceId"]


def describe_instance(instance_id):
    try:
        resp = _ec2.describe_instances(InstanceIds=[instance_id])
    except Exception:
        return None
    reservations = resp.get("Reservations", [])
    if not reservations:
        return None
    inst = reservations[0]["Instances"][0]
    return {
        "state": inst["State"]["Name"],
        "publicIp": inst.get("PublicIpAddress"),
    }


def describe_instance_infra(instance_id):
    """Extended instance info for the workspace overview Infra tab.

    Returns:
      {
        "state": "running" | "stopped" | ...,
        "publicIp": str | None,
        "launchTime": ISO8601 str | None,   # for uptime calc on the client
        "volumes": [{"id": str, "sizeGB": int, "type": str}, ...],
      }
    Wraps describe_instances + describe_volumes in one call. Returns None on any
    AWS error so callers can fall back to the cached DDB values without blowing
    up the response.
    """
    try:
        resp = _ec2.describe_instances(InstanceIds=[instance_id])
    except Exception:
        return None
    reservations = resp.get("Reservations", [])
    if not reservations:
        return None
    inst = reservations[0]["Instances"][0]

    # Collect the EBS volume IDs attached to this instance. Skip ephemeral
    # block devices (no Ebs key on instance store volumes — those don't
    # incur the per-month rate users care about).
    volume_ids = []
    for mapping in inst.get("BlockDeviceMappings", []) or []:
        ebs = mapping.get("Ebs")
        if ebs and ebs.get("VolumeId"):
            volume_ids.append(ebs["VolumeId"])

    volumes = []
    if volume_ids:
        try:
            vols = _ec2.describe_volumes(VolumeIds=volume_ids).get("Volumes", [])
            for v in vols:
                volumes.append({
                    "id": v.get("VolumeId"),
                    "sizeGB": int(v.get("Size") or 0),
                    "type": v.get("VolumeType"),
                })
        except Exception:
            # Don't fail the whole infra fetch over volume details — the
            # caller still wants state/launchTime.
            pass

    launch_time = inst.get("LaunchTime")
    if launch_time:
        try:
            launch_time = launch_time.isoformat()
        except Exception:
            launch_time = str(launch_time)

    return {
        "state": inst["State"]["Name"],
        "publicIp": inst.get("PublicIpAddress"),
        "launchTime": launch_time,
        "volumes": volumes,
    }


def start_instance(instance_id):
    _ec2.start_instances(InstanceIds=[instance_id])


def stop_instance(instance_id):
    _ec2.stop_instances(InstanceIds=[instance_id])


def terminate_instance(instance_id):
    _ec2.terminate_instances(InstanceIds=[instance_id])


def delete_security_group(sg_id):
    try:
        _ec2.delete_security_group(GroupId=sg_id)
    except Exception:
        pass


def delete_key_pair(name):
    try:
        _ec2.delete_key_pair(KeyName=name)
    except Exception:
        pass
