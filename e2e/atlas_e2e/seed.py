"""Creates test data in M365 via Graph. Everything created here carries the run marker."""

from __future__ import annotations

import base64
import hashlib
import os
from dataclasses import dataclass

from atlas_e2e.graph import Graph

ATTACHMENT_BYTES = 4096


@dataclass(frozen=True)
class SeededMessage:
    """A message the suite created, plus the hashes a restore must reproduce."""

    message_id: str
    subject: str
    sentinel: str
    attachment_name: str
    attachment_sha256: str


def create_folder(graph: Graph, mailbox: str, name: str, parent_id: str | None = None) -> str:
    """Creates a mail folder (optionally nested) and returns its id."""
    url = (
        f"/users/{mailbox}/mailFolders/{parent_id}/childFolders"
        if parent_id
        else f"/users/{mailbox}/mailFolders"
    )
    folder = graph.post(url, {"displayName": name})
    return str(folder["id"])


def create_message(
    graph: Graph, mailbox: str, folder_id: str, marker: str, index: int
) -> SeededMessage:
    """Creates a message with a random binary attachment.

    The attachment is the restore fidelity proof.

    Message bodies are normalised by Exchange (text is wrapped in HTML), so a body hash would be
    fragile. Attachment bytes round-trip verbatim, so they carry the SHA-256 assertion, while the
    body only has to still contain its sentinel.
    """
    subject = f"{marker}-mail-{index}"
    sentinel = f"{marker}-sentinel-{index}"
    created = graph.post(
        f"/users/{mailbox}/mailFolders/{folder_id}/messages",
        {
            "subject": subject,
            "body": {"contentType": "Text", "content": f"Atlas E2E fixture. {sentinel}"},
            "toRecipients": [{"emailAddress": {"address": mailbox}}],
        },
    )
    message_id = str(created["id"])

    payload = os.urandom(ATTACHMENT_BYTES)
    attachment_name = f"{marker}-attachment-{index}.bin"
    graph.post(
        f"/users/{mailbox}/messages/{message_id}/attachments",
        {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": attachment_name,
            "contentBytes": base64.b64encode(payload).decode("ascii"),
        },
    )
    return SeededMessage(
        message_id=message_id,
        subject=subject,
        sentinel=sentinel,
        attachment_name=attachment_name,
        attachment_sha256=hashlib.sha256(payload).hexdigest(),
    )
