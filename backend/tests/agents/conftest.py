"""Shared fixtures and env-var setup for agent infrastructure tests."""
import os

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")
os.environ.setdefault("KMS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
