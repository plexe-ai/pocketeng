import boto3
import os
import time
from boto3.dynamodb.conditions import Key, Attr

_ddb = boto3.resource("dynamodb")
SERVERS_TABLE = os.environ.get("SERVERS_TABLE", "pe-servers-prod")
SESSIONS_TABLE = os.environ.get("SESSIONS_TABLE", "pe-sessions-prod")
MESSAGES_TABLE = os.environ.get("MESSAGES_TABLE", "pe-messages-prod")
SESSION_EVENTS_TABLE = os.environ.get("SESSION_EVENTS_TABLE", "pe-session-events-prod")
PUSH_DEVICES_TABLE = os.environ.get("PUSH_DEVICES_TABLE", "pe-push-devices-prod")
OAUTH_CREDENTIALS_TABLE = os.environ.get("OAUTH_CREDENTIALS_TABLE", "pe-oauth-credentials-prod")
AGENT_CREDENTIALS_TABLE = os.environ.get("AGENT_CREDENTIALS_TABLE", "pe-agent-credentials-prod")
HARNESS_RUN_SUMMARIES_TABLE = os.environ.get("HARNESS_RUN_SUMMARIES_TABLE", "pe-harness-runs-prod")
HARNESS_SUGGESTIONS_TABLE = os.environ.get("HARNESS_SUGGESTIONS_TABLE", "pe-harness-suggestions-prod")
HARNESS_VERSIONS_TABLE = os.environ.get("HARNESS_VERSIONS_TABLE", "pe-harness-versions-prod")
TEAMS_TABLE = os.environ.get("TEAMS_TABLE", "pe-teams-prod")
TEAM_MEMBERSHIPS_TABLE = os.environ.get("TEAM_MEMBERSHIPS_TABLE", "pe-team-memberships-prod")
TEAM_INVITES_TABLE = os.environ.get("TEAM_INVITES_TABLE", "pe-team-invites-prod")


def _servers():
    return _ddb.Table(SERVERS_TABLE)


def get_server(server_id):
    return _servers().get_item(Key={"serverId": server_id}).get("Item")


def put_server(item):
    _servers().put_item(Item=item)


def update_server(server_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _servers().update_item(
        Key={"serverId": server_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def delete_server(server_id):
    _servers().delete_item(Key={"serverId": server_id})


def get_servers_by_user(user_id):
    return _servers().query(
        IndexName="userId-index",
        KeyConditionExpression=Key("userId").eq(user_id),
    ).get("Items", [])


def get_servers_by_team(team_id):
    return _servers().query(
        IndexName="teamId-createdAt-index",
        KeyConditionExpression=Key("teamId").eq(team_id),
        ScanIndexForward=False,
    ).get("Items", [])


def scan_active_servers():
    return _servers().scan(
        FilterExpression=Attr("instanceState").is_in(
            ["running", "stopping", "pending", "launching"]
        )
    ).get("Items", [])


# ─── Sessions ─────────────────────────────────────────────────────────────────

def _sessions():
    return _ddb.Table(SESSIONS_TABLE)


def _messages():
    return _ddb.Table(MESSAGES_TABLE)


def _push_devices():
    return _ddb.Table(PUSH_DEVICES_TABLE)


def _oauth_credentials():
    return _ddb.Table(OAUTH_CREDENTIALS_TABLE)


def _agent_credentials():
    return _ddb.Table(AGENT_CREDENTIALS_TABLE)


def put_session(item):
    _sessions().put_item(Item=item)


def update_session(session_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _sessions().update_item(
        Key={"sessionId": session_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def get_session(session_id):
    return _sessions().get_item(Key={"sessionId": session_id}).get("Item")


def delete_session(session_id):
    _sessions().delete_item(Key={"sessionId": session_id})


def get_sessions_by_server(server_id, limit=20):
    return _sessions().query(
        IndexName="serverId-updatedAt-index",
        KeyConditionExpression=Key("serverId").eq(server_id),
        ScanIndexForward=False,
        Limit=limit,
    ).get("Items", [])


def _query_all(table, **kwargs):
    all_items = []
    last_key = None

    while True:
        query_kwargs = dict(kwargs)
        if last_key is not None:
            query_kwargs["ExclusiveStartKey"] = last_key

        response = table.query(**query_kwargs)
        all_items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")

        if not last_key:
            break

    return all_items


def get_all_sessions_by_server(server_id):
    return _query_all(
        _sessions(),
        IndexName="serverId-updatedAt-index",
        KeyConditionExpression=Key("serverId").eq(server_id),
        ScanIndexForward=False,
    )


def claim_session_notification(session_id, notification_key, updates=None):
    names = {
        "#notificationKey": "lastNotificationKey",
    }
    values = {
        ":notificationKey": notification_key,
    }
    assignments = ["#notificationKey = :notificationKey"]

    for idx, (key, value) in enumerate((updates or {}).items()):
        name_key = f"#k{idx}"
        value_key = f":v{idx}"
        names[name_key] = key
        values[value_key] = value
        assignments.append(f"{name_key} = {value_key}")

    try:
        _sessions().update_item(
            Key={"sessionId": session_id},
            UpdateExpression="SET " + ", ".join(assignments),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_not_exists(#notificationKey) OR #notificationKey <> :notificationKey",
        )
        return True
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if error_code == "ConditionalCheckFailedException":
            return False
        raise


def advance_session_run(session_id, run_offset, next_seq, updates=None):
    names = {
        "#runOffset": "currentRunOffset",
        "#nextSeq": "nextSeq",
    }
    values = {
        ":runOffset": run_offset,
        ":nextSeq": next_seq,
    }

    extra_assignments = []
    for idx, (key, value) in enumerate((updates or {}).items()):
        name_key = f"#k{idx}"
        value_key = f":v{idx}"
        names[name_key] = key
        values[value_key] = value
        extra_assignments.append(f"{name_key} = {value_key}")

    update_expression = "SET #runOffset = :runOffset, #nextSeq = :nextSeq"
    if extra_assignments:
        update_expression += ", " + ", ".join(extra_assignments)

    try:
        _sessions().update_item(
            Key={"sessionId": session_id},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_not_exists(#runOffset) OR #runOffset < :runOffset",
        )
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if error_code != "ConditionalCheckFailedException":
            raise


def put_message(session_id, seq, role, content, created_at):
    _messages().put_item(Item={
        "sessionId": session_id,
        "seq": seq,
        "role": role,
        "content": content,
        "createdAt": created_at,
        "ttl": int(time.time()) + 90 * 86400,
    })


def query_messages(
    session_id,
    *,
    after_seq=None,
    from_seq=None,
    to_seq=None,
    scan_forward=True,
    limit=None,
    exclusive_start_key=None,
):
    key_condition = Key("sessionId").eq(session_id)

    if after_seq is not None:
        key_condition &= Key("seq").gt(after_seq)
    elif from_seq is not None:
        key_condition &= Key("seq").gte(from_seq)

    if to_seq is not None:
        key_condition &= Key("seq").lte(to_seq)

    kwargs = {
        "KeyConditionExpression": key_condition,
        "ScanIndexForward": scan_forward,
    }
    if limit is not None:
        kwargs["Limit"] = limit
    if exclusive_start_key is not None:
        kwargs["ExclusiveStartKey"] = exclusive_start_key

    return _messages().query(**kwargs)


def get_messages(
    session_id,
    *,
    after_seq=None,
    from_seq=None,
    to_seq=None,
    scan_forward=True,
    limit=None,
):
    all_items = []
    last_key = None
    while True:
        resp = query_messages(
            session_id,
            after_seq=after_seq,
            from_seq=from_seq,
            to_seq=to_seq,
            scan_forward=scan_forward,
            limit=limit,
            exclusive_start_key=last_key,
        )
        all_items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        if limit is not None:
            break
    return all_items


def _session_events():
    return _ddb.Table(SESSION_EVENTS_TABLE)


SESSION_EVENTS_TTL_DAYS = 30


def put_session_event(event):
    """Insert one session event. Dedup via ConditionExpression on (sessionId, seq).
    Returns True if inserted, False if a row with the same (sessionId, seq) already exists."""
    item = dict(event)
    item.setdefault("ttl", int(time.time()) + SESSION_EVENTS_TTL_DAYS * 86400)
    try:
        _session_events().put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(sessionId) AND attribute_not_exists(seq)",
        )
        return True
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if error_code == "ConditionalCheckFailedException":
            return False
        raise


def put_session_events_batch(events):
    """Insert a batch of events. Per-item dedup preserved by falling back to
    conditional PutItem (batch_writer has no condition support). Returns
    (inserted_count, skipped_count, highest_inserted_seq)."""
    inserted = 0
    skipped = 0
    highest_seq = None
    for event in events:
        if put_session_event(event):
            inserted += 1
            seq = int(event.get("seq", -1))
            if highest_seq is None or seq > highest_seq:
                highest_seq = seq
        else:
            skipped += 1
    return inserted, skipped, highest_seq


def query_session_events(session_id, *, after_seq=None, limit=200):
    key_condition = Key("sessionId").eq(session_id)
    if after_seq is not None:
        key_condition &= Key("seq").gt(after_seq)
    response = _session_events().query(
        KeyConditionExpression=key_condition,
        # Explicit projection skips `ttl` (which nothing downstream reads)
        # and keeps Lambda payload size tight. `#k` alias is required
        # because `kind` is a DynamoDB reserved word.
        ProjectionExpression="sessionId, seq, #k, payload, createdAt, turnId",
        ExpressionAttributeNames={"#k": "kind"},
        ScanIndexForward=True,
        Limit=limit,
    )
    return response.get("Items", [])


def get_recent_session_events(session_id, limit=50):
    """Return the most recent `limit` events for a session, ordered oldest to
    newest. Used by the voice `session_status` tool to determine what the
    agent is currently doing without scanning the whole turn history."""
    response = _session_events().query(
        KeyConditionExpression=Key("sessionId").eq(session_id),
        ScanIndexForward=False,
        Limit=limit,
    )
    items = response.get("Items", [])
    items.sort(key=lambda item: int(item.get("seq", 0)))
    return items


def advance_session_event_cursor(session_id, last_event_seq, last_event_at):
    """Bump sessions.lastEventSeq and lastEventAt, only if the new seq is higher.
    Idempotent and safe under concurrent ingest retries."""
    try:
        _sessions().update_item(
            Key={"sessionId": session_id},
            UpdateExpression="SET lastEventSeq = :seq, lastEventAt = :at",
            ExpressionAttributeValues={
                ":seq": last_event_seq,
                ":at": last_event_at,
            },
            ConditionExpression="attribute_not_exists(lastEventSeq) OR lastEventSeq < :seq",
        )
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if error_code != "ConditionalCheckFailedException":
            raise


def reserve_message_seqs(session_id, count):
    """Atomically allocate `count` message seqs from sessions.nextSeq.
    Returns the starting seq; caller uses [start, start+count). Safe
    under concurrent writers (two parallel ingest invocations will get
    non-overlapping ranges). Requires nextSeq to exist — chat.py seeds
    it at turn start — else ConditionalCheckFailed and we return None."""
    if count <= 0:
        return None
    try:
        resp = _sessions().update_item(
            Key={"sessionId": session_id},
            UpdateExpression="ADD nextSeq :c",
            ExpressionAttributeValues={":c": count},
            ConditionExpression="attribute_exists(nextSeq)",
            ReturnValues="UPDATED_NEW",
        )
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if error_code == "ConditionalCheckFailedException":
            return None
        raise
    new_next_seq = int(resp["Attributes"]["nextSeq"])
    return new_next_seq - count


def delete_session_events_for_session(session_id):
    items = query_session_events(session_id, limit=1000)
    if not items:
        return 0
    deleted = 0
    with _session_events().batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={"sessionId": session_id, "seq": item["seq"]})
            deleted += 1
    return deleted


def delete_messages_for_session(session_id):
    items = get_messages(session_id)
    if not items:
        return 0

    with _messages().batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={"sessionId": session_id, "seq": item["seq"]})

    return len(items)


def find_last_message(session_id, *, to_seq=None, role=None, page_size=50):
    start_key = None

    while True:
        response = query_messages(
            session_id,
            to_seq=to_seq,
            scan_forward=False,
            limit=page_size,
            exclusive_start_key=start_key,
        )
        items = response.get("Items", [])
        for item in items:
            if role is None or item.get("role") == role:
                return item

        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return None


# ─── Push Devices ─────────────────────────────────────────────────────────────

def put_push_device(item):
    _push_devices().put_item(Item=item)


def update_push_device(installation_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _push_devices().update_item(
        Key={"installationId": installation_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def get_push_device(installation_id):
    return _push_devices().get_item(Key={"installationId": installation_id}).get("Item")


def delete_push_device(installation_id):
    _push_devices().delete_item(Key={"installationId": installation_id})


def get_push_devices_by_user(user_id, limit=20):
    return _push_devices().query(
        IndexName="userId-updatedAt-index",
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,
        Limit=limit,
    ).get("Items", [])


def get_all_push_devices_by_user(user_id):
    return _query_all(
        _push_devices(),
        IndexName="userId-updatedAt-index",
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,
    )


def put_oauth_credential(item):
    _oauth_credentials().put_item(Item=item)


def update_oauth_credential(user_id, provider, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _oauth_credentials().update_item(
        Key={"userId": user_id, "provider": provider},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def get_oauth_credential(user_id, provider):
    return _oauth_credentials().get_item(Key={"userId": user_id, "provider": provider}).get("Item")


def delete_oauth_credential(user_id, provider):
    _oauth_credentials().delete_item(Key={"userId": user_id, "provider": provider})


def put_agent_credential(item):
    _agent_credentials().put_item(Item=item)


def get_agent_credential(user_id, agent):
    return _agent_credentials().get_item(Key={"userId": user_id, "agent": agent}).get("Item")


def list_agent_credentials_for_user(user_id):
    res = _agent_credentials().query(
        KeyConditionExpression=Key("userId").eq(user_id),
    )
    return res.get("Items", [])


def delete_agent_credential(user_id, agent):
    _agent_credentials().delete_item(Key={"userId": user_id, "agent": agent})


# ─── AWS Credentials (BYO-AWS provisioning) ──────────────────────────────

AWS_CREDENTIALS_TABLE = os.environ.get("AWS_CREDENTIALS_TABLE", "pe-aws-credentials-prod")


def _aws_credentials():
    return _ddb.Table(AWS_CREDENTIALS_TABLE)


def put_aws_credentials(item):
    _aws_credentials().put_item(Item=item)


def get_aws_credentials(user_id):
    return _aws_credentials().get_item(Key={"userId": user_id}).get("Item")


def delete_aws_credentials(user_id):
    _aws_credentials().delete_item(Key={"userId": user_id})


def delete_oauth_credentials_by_user(user_id):
    items = _query_all(
        _oauth_credentials(),
        KeyConditionExpression=Key("userId").eq(user_id),
    )

    if not items:
        return 0

    with _oauth_credentials().batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={"userId": user_id, "provider": item["provider"]})

    return len(items)


# ─── Harness ──────────────────────────────────────────────────────────────────


def _harness_runs():
    return _ddb.Table(HARNESS_RUN_SUMMARIES_TABLE)


def _harness_suggestions():
    return _ddb.Table(HARNESS_SUGGESTIONS_TABLE)


def _harness_versions():
    return _ddb.Table(HARNESS_VERSIONS_TABLE)


def _teams():
    return _ddb.Table(TEAMS_TABLE)


def _team_memberships():
    return _ddb.Table(TEAM_MEMBERSHIPS_TABLE)


def _team_invites():
    return _ddb.Table(TEAM_INVITES_TABLE)


def put_team(item):
    _teams().put_item(Item=item)


def get_team(team_id):
    return _teams().get_item(Key={"teamId": team_id}).get("Item")


def delete_team(team_id):
    _teams().delete_item(Key={"teamId": team_id})


def update_team(team_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _teams().update_item(
        Key={"teamId": team_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def put_team_membership(item):
    _team_memberships().put_item(Item=item)


def get_team_membership(user_id, team_id):
    return _team_memberships().get_item(Key={"userId": user_id, "teamId": team_id}).get("Item")


def list_team_memberships_for_user(user_id):
    return _team_memberships().query(
        KeyConditionExpression=Key("userId").eq(user_id),
    ).get("Items", [])


def list_team_members_for_team(team_id):
    return _team_memberships().query(
        IndexName="teamId-userId-index",
        KeyConditionExpression=Key("teamId").eq(team_id),
    ).get("Items", [])


def update_team_membership(user_id, team_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _team_memberships().update_item(
        Key={"userId": user_id, "teamId": team_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def delete_team_membership(user_id, team_id):
    _team_memberships().delete_item(Key={"userId": user_id, "teamId": team_id})


def put_team_invite(item):
    _team_invites().put_item(Item=item)


def get_team_invite(invite_id):
    return _team_invites().get_item(Key={"inviteId": invite_id}).get("Item")


def update_team_invite(invite_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _team_invites().update_item(
        Key={"inviteId": invite_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def list_team_invites_for_email(email):
    return _team_invites().query(
        IndexName="email-createdAt-index",
        KeyConditionExpression=Key("email").eq(email),
        ScanIndexForward=False,
    ).get("Items", [])


def list_team_invites_for_team(team_id):
    return _team_invites().query(
        IndexName="teamId-createdAt-index",
        KeyConditionExpression=Key("teamId").eq(team_id),
        ScanIndexForward=False,
    ).get("Items", [])


def put_harness_run_summary(item):
    _harness_runs().put_item(Item=item)


def list_harness_run_summaries(user_id, limit=20):
    return _harness_runs().query(
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,
        Limit=limit,
    ).get("Items", [])


def put_harness_suggestion(item):
    _harness_suggestions().put_item(Item=item)


def get_harness_suggestion(user_id, item_id):
    return _harness_suggestions().get_item(Key={"userId": user_id, "itemId": item_id}).get("Item")


def update_harness_suggestion(user_id, item_id, updates):
    keys = list(updates.keys())
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(keys)))
    names = {f"#k{i}": k for i, k in enumerate(keys)}
    values = {f":v{i}": updates[k] for i, k in enumerate(keys)}
    _harness_suggestions().update_item(
        Key={"userId": user_id, "itemId": item_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def list_harness_suggestions(user_id):
    return _harness_suggestions().query(
        KeyConditionExpression=Key("userId").eq(user_id),
    ).get("Items", [])


def put_harness_version(item):
    _harness_versions().put_item(Item=item)


def list_harness_versions(user_id, limit=20):
    return _harness_versions().query(
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,
        Limit=limit,
    ).get("Items", [])


def _delete_partition_rows(table, user_id, range_key):
    items = _query_all(
        table,
        KeyConditionExpression=Key("userId").eq(user_id),
    )

    if not items:
        return 0

    with table.batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={"userId": user_id, range_key: item[range_key]})

    return len(items)


def delete_harness_run_summaries(user_id):
    return _delete_partition_rows(_harness_runs(), user_id, "createdAt")


def delete_harness_suggestions(user_id):
    return _delete_partition_rows(_harness_suggestions(), user_id, "itemId")


def delete_harness_versions(user_id):
    return _delete_partition_rows(_harness_versions(), user_id, "versionSeq")
