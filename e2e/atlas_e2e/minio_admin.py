"""MinIO user and policy administration through the `mc` that ships in the MinIO image.

boto3 speaks S3 only, and creating a user is a MinIO admin API call, so this runs `mc` inside the
container with `docker exec`. The MinIO root credentials are the suite's throwaway defaults, not
secrets (see `docker-compose.e2e.yml`).
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field

from atlas_e2e.config import Settings

# Inside the container MinIO always listens on 9000, whatever port the host maps it to.
_INTERNAL_URL = "127.0.0.1:9000"


def container() -> str:
    """The MinIO container: the compose service by default, overridable for a local MinIO."""
    return os.environ.get("E2E_MINIO_CONTAINER", "atlas-e2e-minio-primary")


def _mc(settings: Settings, *args: str, stdin: str | None = None) -> None:
    """Runs one `mc` command against the container's own MinIO, raising on failure.

    The alias comes from `MC_HOST_e2e`, so no alias state is left in the container.

    A failure is re-raised as a `CalledProcessError` naming only the `mc` verb. The original
    exception's argv holds the root credentials and, for `user add`, the new user's secret, and a
    traceback that reaches `report.xml` is published as an artifact.
    """
    host = f"http://{settings.s3_access_key}:{settings.s3_secret_key}@{_INTERNAL_URL}"
    verb = ["mc", *args[:3]]
    try:
        # S603/S607: fixed argv, no shell; `docker` resolves from PATH like `node` in atlas.py.
        subprocess.run(  # noqa: S603
            ["docker", "exec", "-i", "-e", f"MC_HOST_e2e={host}", container(), "mc", *args],  # noqa: S607
            check=True,
            capture_output=True,
            text=True,
            input=stdin,
            timeout=60,
        )
    except subprocess.CalledProcessError as err:
        raise subprocess.CalledProcessError(err.returncode, verb) from None
    except subprocess.TimeoutExpired:
        raise subprocess.CalledProcessError(-1, verb) from None


def read_only_policy(bucket: str) -> str:
    """A policy that may list and read one bucket and nothing else, as a provider replica key."""
    return json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": [
                        "s3:GetBucketLocation",
                        "s3:ListBucket",
                        "s3:ListBucketVersions",
                        "s3:ListBucketMultipartUploads",
                    ],
                    "Resource": [f"arn:aws:s3:::{bucket}"],
                },
                {
                    "Effect": "Allow",
                    "Action": ["s3:GetObject", "s3:GetObjectVersion"],
                    "Resource": [f"arn:aws:s3:::{bucket}/*"],
                },
            ],
        }
    )


def add_read_only_user(settings: Settings, bucket: str, user: str, secret: str) -> None:
    """Creates `user` with a policy named after it that may only read `bucket`."""
    _mc(
        settings,
        "admin",
        "policy",
        "create",
        "e2e",
        user,
        "/dev/stdin",
        stdin=read_only_policy(bucket),
    )
    _mc(settings, "admin", "user", "add", "e2e", user, secret)
    _mc(settings, "admin", "policy", "attach", "e2e", user, "--user", user)


def remove_user(settings: Settings, user: str) -> None:
    """Removes the user and its policy. Each step is attempted even when an earlier one failed."""
    for args in (
        ("admin", "policy", "detach", "e2e", user, "--user", user),
        ("admin", "user", "remove", "e2e", user),
        ("admin", "policy", "remove", "e2e", user),
    ):
        try:
            _mc(settings, *args)
        except (subprocess.CalledProcessError, OSError):
            continue


@dataclass(frozen=True)
class ReadOnlyCopy:
    """A copy of the tenant bucket under another name, and a user that may only read it."""

    bucket: str
    user: str
    secret: str = field(repr=False)

    def cli_env(self) -> dict[str, str]:
        """ATLAS_* variables that point a CLI run at the copy with the read-only user."""
        return {
            "ATLAS_S3_BUCKET": self.bucket,
            "ATLAS_S3_ACCESS_KEY": self.user,
            "ATLAS_S3_SECRET_KEY": self.secret,
        }
