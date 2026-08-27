"""Tenant wipe, asserted last: `--purge` sweeps the whole bucket, not one workload's prefix.

Runs after every workload suite so the assertion covers Outlook, OneDrive and SharePoint objects
together -- `--purge` walks the bucket rather than a fixed prefix list, and the encrypted DEK goes
last and only if nothing survived.

This is the product's erasure path under test. The runner's MinIO volumes are destroyed separately
and unconditionally by the workflow, so a failure here cannot leave ciphertext on the runner.
"""

from __future__ import annotations

from typing import Any

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings


def test_purge_empties_the_whole_bucket(cli: Cli, settings: Settings, s3: Any) -> None:
    """Every object, every workload prefix, and the DEK are gone.

    Runs before the immutability suite, because a locked object would make this unsatisfiable
    (Atlas has no governance bypass); anything locked afterwards is a deliberate survivor that the
    volume teardown removes.
    """
    before = storage.list_keys(s3, settings.bucket)
    assert before, "nothing to purge: the workload suites stored no objects"

    # The cross-workload claim in this module's docstring has to be checked, not assumed. Before
    # issue #210 the bucket held Outlook objects alone by this point, so the sweep was proven
    # against one prefix while reading as though it covered three.
    #
    # Asserted on the data prefix, not the manifest one: `test_85` deletes a snapshot per drive and
    # a snapshot delete deliberately retains the content-addressed blobs, so a workload whose only
    # manifest was the deleted one still has objects the purge must sweep.
    for workload in settings.configured_workloads:
        prefix = storage.DATA_PREFIXES[workload]
        assert [k for k in before if k.startswith(prefix)], (
            f"{workload} has no objects to purge; the sweep would not be proven across workloads"
        )

    cli.ok("delete", "--purge", "-y")

    remaining = storage.list_keys(s3, settings.bucket)
    assert remaining == [], f"purge left {len(remaining)} object(s) behind: {remaining[:5]}"
