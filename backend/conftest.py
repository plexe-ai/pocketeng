# Set dummy AWS credentials so boto3 module-level initialization doesn't fail.
# Tests mock all actual DynamoDB calls; these just satisfy botocore's auth checks.
import os

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test-key-id")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test-secret-key")
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("SERVERS_TABLE", "pe-servers-test")
os.environ.setdefault("SESSIONS_TABLE", "pe-sessions-test")
os.environ.setdefault("MESSAGES_TABLE", "pe-messages-test")
os.environ.setdefault("KMS_KEY_ID", "test-kms-key")
