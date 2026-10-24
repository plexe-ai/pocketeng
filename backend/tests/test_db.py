"""Unit tests for session/message DB helpers in src/lib/db.py."""
import time
from unittest.mock import MagicMock, call, patch

import pytest


def _make_ddb_mock():
    """Return a mock that mimics boto3.resource('dynamodb') with a .Table() accessor."""
    mock_table = MagicMock()
    mock_ddb = MagicMock()
    mock_ddb.Table.return_value = mock_table
    return mock_ddb, mock_table


# ─── put_session ──────────────────────────────────────────────────────────────

class TestPutSession:
    def test_stores_item(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import put_session
            item = {
                "sessionId": "abc123",
                "serverId": "srv-1",
                "userId": "user-1",
                "createdAt": "2024-01-01T00:00:00+00:00",
                "status": "running",
                "prompt": "Build me a landing page",
                "agent": "claude",
            }
            put_session(item)
            mock_table.put_item.assert_called_once_with(Item=item)


# ─── update_session ───────────────────────────────────────────────────────────

class TestUpdateSession:
    def test_builds_correct_update_expression(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import update_session
            update_session("abc123", {"status": "done"})
            call_kwargs = mock_table.update_item.call_args[1]
            assert call_kwargs["Key"] == {"sessionId": "abc123"}
            assert "SET" in call_kwargs["UpdateExpression"]
            assert ":v0" in call_kwargs["ExpressionAttributeValues"]
            assert call_kwargs["ExpressionAttributeValues"][":v0"] == "done"

    def test_multiple_updates(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import update_session
            update_session("abc123", {"status": "done", "updatedAt": "2024-01-02"})
            call_kwargs = mock_table.update_item.call_args[1]
            assert len(call_kwargs["ExpressionAttributeValues"]) == 2


# ─── get_session ──────────────────────────────────────────────────────────────

class TestGetSession:
    def test_returns_item(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.get_item.return_value = {"Item": {"sessionId": "abc123", "status": "done"}}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_session
            result = get_session("abc123")
            assert result == {"sessionId": "abc123", "status": "done"}
            mock_table.get_item.assert_called_once_with(Key={"sessionId": "abc123"})

    def test_returns_none_when_not_found(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.get_item.return_value = {}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_session
            result = get_session("missing")
            assert result is None


# ─── get_sessions_by_server ───────────────────────────────────────────────────

class TestGetSessionsByServer:
    def test_queries_correct_index(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": [{"sessionId": "s1"}, {"sessionId": "s2"}]}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_sessions_by_server
            result = get_sessions_by_server("srv-1", limit=5)
            assert len(result) == 2
            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["IndexName"] == "serverId-updatedAt-index"
            assert call_kwargs["ScanIndexForward"] is False
            assert call_kwargs["Limit"] == 5

    def test_returns_empty_list_when_no_sessions(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": []}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_sessions_by_server
            result = get_sessions_by_server("srv-1")
            assert result == []


class TestGetServersByTeam:
    def test_queries_team_index(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": [{"serverId": "s1"}]}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_servers_by_team
            result = get_servers_by_team("team-1")
            assert result == [{"serverId": "s1"}]
            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["IndexName"] == "teamId-createdAt-index"
            assert call_kwargs["ScanIndexForward"] is False


class TestClaimSessionNotification:
    def test_sets_notification_key_with_conditional_guard(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import claim_session_notification

            claimed = claim_session_notification(
                "sess-1",
                "done:4:9",
                {"lastNotifiedAt": "2026-04-02T15:00:00+00:00"},
            )

            assert claimed is True
            call_kwargs = mock_table.update_item.call_args[1]
            assert call_kwargs["Key"] == {"sessionId": "sess-1"}
            assert call_kwargs["ConditionExpression"] == "attribute_not_exists(#notificationKey) OR #notificationKey <> :notificationKey"
            assert call_kwargs["ExpressionAttributeValues"][":notificationKey"] == "done:4:9"

    def test_returns_false_on_conditional_failure(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.update_item.side_effect = Exception()
        mock_table.update_item.side_effect.response = {
            "Error": {"Code": "ConditionalCheckFailedException"}
        }

        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import claim_session_notification

            assert claim_session_notification("sess-1", "done:4:9") is False


# ─── put_message ──────────────────────────────────────────────────────────────

class TestPutMessage:
    def test_stores_all_fields(self):
        mock_ddb, mock_table = _make_ddb_mock()
        before = int(time.time())
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import put_message
            put_message("abc123", 0, "user", "hello", "2024-01-01T00:00:00+00:00")
            item = mock_table.put_item.call_args[1]["Item"]
            assert item["sessionId"] == "abc123"
            assert item["seq"] == 0
            assert item["role"] == "user"
            assert item["content"] == "hello"
            assert item["createdAt"] == "2024-01-01T00:00:00+00:00"

    def test_sets_90_day_ttl(self):
        mock_ddb, mock_table = _make_ddb_mock()
        before = int(time.time())
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import put_message
            put_message("abc123", 1, "agent", '{"type":"text"}', "2024-01-01T00:00:00+00:00")
            item = mock_table.put_item.call_args[1]["Item"]
            expected_ttl_approx = before + 90 * 86400
            assert abs(item["ttl"] - expected_ttl_approx) < 5  # within 5 seconds


# ─── get_messages ─────────────────────────────────────────────────────────────

class TestGetMessages:
    def test_queries_ascending_by_seq(self):
        mock_ddb, mock_table = _make_ddb_mock()
        msgs = [{"sessionId": "s1", "seq": 0}, {"sessionId": "s1", "seq": 1}]
        mock_table.query.return_value = {"Items": msgs}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_messages
            result = get_messages("s1")
            assert result == msgs
            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["ScanIndexForward"] is True

    def test_returns_empty_list_when_no_messages(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": []}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_messages
            result = get_messages("s1")
            assert result == []

    def test_supports_after_seq_range(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": [{"sessionId": "s1", "seq": 3}]}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_messages

            get_messages("s1", after_seq=2)

            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["KeyConditionExpression"].__class__.__name__ == "And"
            assert call_kwargs["ScanIndexForward"] is True

    def test_supports_closed_range_queries(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": [{"sessionId": "s1", "seq": 4}]}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_messages

            get_messages("s1", from_seq=4, to_seq=7, scan_forward=False, limit=10)

            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["KeyConditionExpression"].__class__.__name__ == "And"
            assert call_kwargs["ScanIndexForward"] is False
            assert call_kwargs["Limit"] == 10


# ─── advance_session_run ──────────────────────────────────────────────────────

class TestAdvanceSessionRun:
    def test_updates_offsets_and_extra_fields(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import advance_session_run

            advance_session_run(
                "sess-1",
                4,
                7,
                {"updatedAt": "2024-01-02T00:00:00+00:00", "status": "running"},
            )

            call_kwargs = mock_table.update_item.call_args[1]
            assert call_kwargs["Key"] == {"sessionId": "sess-1"}
            assert call_kwargs["ExpressionAttributeValues"][":runOffset"] == 4
            assert call_kwargs["ExpressionAttributeValues"][":nextSeq"] == 7
            assert call_kwargs["ConditionExpression"] == "attribute_not_exists(#runOffset) OR #runOffset < :runOffset"
            assert "#k0" in call_kwargs["ExpressionAttributeNames"]
            assert "#k1" in call_kwargs["ExpressionAttributeNames"]

    def test_ignores_conditional_failures(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.update_item.side_effect = Exception()
        mock_table.update_item.side_effect.response = {
            "Error": {"Code": "ConditionalCheckFailedException"}
        }

        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import advance_session_run

            advance_session_run("sess-1", 1, 2)

    def test_reraises_other_errors(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.update_item.side_effect = RuntimeError("boom")

        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import advance_session_run

            with pytest.raises(RuntimeError):
                advance_session_run("sess-1", 1, 2)


# ─── find_last_message ────────────────────────────────────────────────────────

class TestFindLastMessage:
    def test_returns_first_matching_item_from_descending_page(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {
            "Items": [
                {"sessionId": "s1", "seq": 9, "role": "agent"},
                {"sessionId": "s1", "seq": 8, "role": "user"},
            ]
        }
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import find_last_message

            result = find_last_message("s1", to_seq=9, role="user")

            assert result == {"sessionId": "s1", "seq": 8, "role": "user"}
            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["ScanIndexForward"] is False
            assert call_kwargs["Limit"] == 50

    def test_pages_until_matching_role_is_found(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.side_effect = [
            {
                "Items": [{"sessionId": "s1", "seq": 9, "role": "agent"}],
                "LastEvaluatedKey": {"sessionId": "s1", "seq": 9},
            },
            {
                "Items": [{"sessionId": "s1", "seq": 8, "role": "user"}],
            },
        ]
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import find_last_message

            result = find_last_message("s1", to_seq=9, role="user", page_size=1)

            assert result == {"sessionId": "s1", "seq": 8, "role": "user"}
            second_call = mock_table.query.call_args_list[1][1]
            assert second_call["ExclusiveStartKey"] == {"sessionId": "s1", "seq": 9}

    def test_returns_none_when_no_match_exists(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": []}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import find_last_message

            assert find_last_message("s1", role="user") is None


class TestPushDevices:
    def test_put_push_device_stores_item(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import put_push_device

            item = {
                "installationId": "install-1",
                "userId": "user-1",
                "endpointArn": "arn:aws:sns:123:endpoint",
            }
            put_push_device(item)
            mock_table.put_item.assert_called_once_with(Item=item)

    def test_get_push_devices_by_user_queries_index(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.return_value = {"Items": [{"installationId": "install-1"}]}
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_push_devices_by_user

            result = get_push_devices_by_user("user-1", limit=10)

            assert result == [{"installationId": "install-1"}]
            call_kwargs = mock_table.query.call_args[1]
            assert call_kwargs["IndexName"] == "userId-updatedAt-index"
            assert call_kwargs["Limit"] == 10

    def test_get_all_push_devices_by_user_pages_until_complete(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.side_effect = [
            {
                "Items": [{"installationId": "install-1"}],
                "LastEvaluatedKey": {"installationId": "install-1"},
            },
            {
                "Items": [{"installationId": "install-2"}],
            },
        ]
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_all_push_devices_by_user

            result = get_all_push_devices_by_user("user-1")

            assert result == [{"installationId": "install-1"}, {"installationId": "install-2"}]
            second_call = mock_table.query.call_args_list[1][1]
            assert second_call["ExclusiveStartKey"] == {"installationId": "install-1"}


class TestSessionCleanupHelpers:
    def test_get_all_sessions_by_server_pages_until_complete(self):
        mock_ddb, mock_table = _make_ddb_mock()
        mock_table.query.side_effect = [
            {
                "Items": [{"sessionId": "sess-1"}],
                "LastEvaluatedKey": {"sessionId": "sess-1"},
            },
            {
                "Items": [{"sessionId": "sess-2"}],
            },
        ]
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import get_all_sessions_by_server

            result = get_all_sessions_by_server("srv-1")

            assert result == [{"sessionId": "sess-1"}, {"sessionId": "sess-2"}]
            second_call = mock_table.query.call_args_list[1][1]
            assert second_call["ExclusiveStartKey"] == {"sessionId": "sess-1"}

    def test_delete_messages_for_session_uses_batch_writer(self):
        mock_ddb, mock_table = _make_ddb_mock()
        batch_writer = MagicMock()
        batch_writer.__enter__.return_value = batch_writer
        batch_writer.__exit__.return_value = None
        mock_table.batch_writer.return_value = batch_writer

        with patch("src.lib.db._ddb", mock_ddb), \
             patch("src.lib.db.get_messages", return_value=[
                 {"sessionId": "sess-1", "seq": 0},
                 {"sessionId": "sess-1", "seq": 1},
             ]):
            from src.lib.db import delete_messages_for_session

            result = delete_messages_for_session("sess-1")

            assert result == 2
            batch_writer.delete_item.assert_has_calls([
                call(Key={"sessionId": "sess-1", "seq": 0}),
                call(Key={"sessionId": "sess-1", "seq": 1}),
            ])


class TestOAuthCredentials:
    def test_put_oauth_credential_stores_item(self):
        mock_ddb, mock_table = _make_ddb_mock()
        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import put_oauth_credential

            item = {
                "userId": "user-1",
                "provider": "apple",
                "refreshToken": "encrypted",
            }
            put_oauth_credential(item)
            mock_table.put_item.assert_called_once_with(Item=item)

    def test_delete_oauth_credentials_by_user_batches_items(self):
        mock_ddb, mock_table = _make_ddb_mock()
        batch_writer = MagicMock()
        batch_writer.__enter__.return_value = batch_writer
        batch_writer.__exit__.return_value = None
        mock_table.batch_writer.return_value = batch_writer
        mock_table.query.return_value = {
            "Items": [
                {"userId": "user-1", "provider": "apple"},
                {"userId": "user-1", "provider": "github"},
            ]
        }

        with patch("src.lib.db._ddb", mock_ddb):
            from src.lib.db import delete_oauth_credentials_by_user

            result = delete_oauth_credentials_by_user("user-1")

            assert result == 2
            batch_writer.delete_item.assert_has_calls([
                call(Key={"userId": "user-1", "provider": "apple"}),
                call(Key={"userId": "user-1", "provider": "github"}),
            ])
