import boto3
import base64
import os

_kms = boto3.client("kms")


def _key_id():
    return os.environ["KMS_KEY_ID"]


def encrypt(plaintext: str) -> str:
    resp = _kms.encrypt(KeyId=_key_id(), Plaintext=plaintext.encode())
    return base64.b64encode(resp["CiphertextBlob"]).decode()


def decrypt(ciphertext_b64: str) -> str:
    blob = base64.b64decode(ciphertext_b64)
    resp = _kms.decrypt(CiphertextBlob=blob)
    return resp["Plaintext"].decode()
