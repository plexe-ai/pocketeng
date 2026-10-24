import re
from pathlib import Path


TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "template.yaml"


def _resource_block(resource_name):
    lines = TEMPLATE_PATH.read_text().splitlines()
    start = next(
        (index for index, line in enumerate(lines) if line == f"  {resource_name}:"),
        None,
    )
    assert start is not None, f"resource {resource_name} not found"

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^  [A-Za-z0-9][A-Za-z0-9_-]*:\s*$", lines[index]):
            end = index
            break

    return "\n".join(lines[start:end])


def test_sessions_function_can_delete_messages_and_session_events():
    block = _resource_block("SessionsFunction")

    assert "SESSION_EVENTS_TABLE: !Ref SessionEventsTable" in block
    assert "- DynamoDBCrudPolicy:\n            TableName: !Ref MessagesTable" in block
    assert "- DynamoDBCrudPolicy:\n            TableName: !Ref SessionEventsTable" in block


def test_account_function_uses_stage_scoped_session_events_table():
    block = _resource_block("AccountFunction")

    assert "SESSION_EVENTS_TABLE: !Ref SessionEventsTable" in block
    assert "- DynamoDBCrudPolicy:\n            TableName: !Ref SessionEventsTable" in block
