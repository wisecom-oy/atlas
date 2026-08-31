"""Direct S3 reads. Object keys and retention are ground truth; CLI output is not."""

from __future__ import annotations

from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from atlas_e2e.config import Settings

# Key layouts, mirrored from `*-storage-keys.ts`. Outlook predates the per-workload prefixes.
MANIFEST_PREFIXES = {
    "outlook": "manifests/",
    "onedrive": "onedrive/manifests/",
    "sharepoint": "sharepoint/manifests/",
}
DATA_PREFIXES = {
    "outlook": "data/",
    "onedrive": "onedrive/data/",
    "sharepoint": "sharepoint/data/",
}
INDEX_PREFIXES = {
    "onedrive": "onedrive/index/",
    "sharepoint": "sharepoint/index/",
}


def client(settings: Settings, endpoint: str | None = None) -> Any:
    """An S3 client for MinIO: path-style addressing, no retries beyond botocore's default."""
    return boto3.client(
        "s3",
        endpoint_url=endpoint or settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def bucket_names(s3: Any) -> list[str]:
    """Every bucket on the endpoint. Used to prove read-only commands provision nothing (#93)."""
    return sorted(b["Name"] for b in s3.list_buckets().get("Buckets", []))


def bucket_exists(s3: Any, bucket: str) -> bool:
    """Whether the bucket exists, without creating it."""
    return bucket in bucket_names(s3)


def list_keys(s3: Any, bucket: str, prefix: str = "") -> list[str]:
    """Every key under a prefix, paginated. Empty list when the bucket does not exist."""
    if not bucket_exists(s3, bucket):
        return []
    keys: list[str] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
        if not page.get("IsTruncated"):
            return sorted(keys)
        token = page.get("NextContinuationToken")


def snapshot_ids(s3: Any, bucket: str, owner_id: str, workload: str = "outlook") -> list[str]:
    """Snapshot ids for one owner or site, read from the manifest key names.

    The id lives in the key, so no decryption is needed -- and reading it here rather than parsing
    CLI tables keeps the suite independent of rendering (see issue #94). Prefixes differ per
    workload: Outlook uses `manifests/`, the file workloads nest under `<workload>/manifests/`.
    """
    prefix = MANIFEST_PREFIXES[workload] + f"{owner_id}/"
    return [
        k[len(prefix) : -len(".json")] for k in list_keys(s3, bucket, prefix) if k.endswith(".json")
    ]


def retention(s3: Any, bucket: str, key: str) -> dict[str, Any] | None:
    """Object Lock retention on a key, or None when the object carries none."""
    try:
        # boto3 is unstubbed, so the response is Any. Named here rather than returned
        # straight out, so the declared return type is the one callers can rely on.
        response: dict[str, Any] = s3.get_object_retention(Bucket=bucket, Key=key)
        retention_block = response.get("Retention")
        return retention_block if isinstance(retention_block, dict) else None
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchObjectLockConfiguration", "ObjectLockConfigurationNotFoundError"}:
            return None
        raise
