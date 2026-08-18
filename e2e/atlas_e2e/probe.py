"""Reads M365 state back via Graph. Restore assertions are made here, never against CLI output."""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Iterator

from atlas_e2e.graph import Graph

FOLDER_SELECT = "id,displayName,parentFolderId,totalItemCount"


def top_level_folders(graph: Graph, mailbox: str) -> list[dict[str, Any]]:
    """Every folder directly under the mailbox root."""
    return list(graph.paged(f"/users/{mailbox}/mailFolders", **{"$select": FOLDER_SELECT, "$top": 100}))


def child_folders(graph: Graph, mailbox: str, folder_id: str) -> list[dict[str, Any]]:
    """Direct children of a folder."""
    return list(
        graph.paged(
            f"/users/{mailbox}/mailFolders/{folder_id}/childFolders",
            **{"$select": FOLDER_SELECT, "$top": 100},
        )
    )


def walk_folders(graph: Graph, mailbox: str, folder_id: str) -> Iterator[dict[str, Any]]:
    """Yields a folder's whole subtree, the folder itself included."""
    for child in child_folders(graph, mailbox, folder_id):
        yield child
        yield from walk_folders(graph, mailbox, str(child["id"]))


def find_top_level_folder(graph: Graph, mailbox: str, name: str) -> dict[str, Any] | None:
    """Finds a top-level folder by exact display name."""
    return next((f for f in top_level_folders(graph, mailbox) if f.get("displayName") == name), None)


def messages_in(graph: Graph, mailbox: str, folder_id: str) -> list[dict[str, Any]]:
    """Messages in a folder, with the fields the assertions need."""
    return list(
        graph.paged(
            f"/users/{mailbox}/mailFolders/{folder_id}/messages",
            **{"$select": "id,subject,body,hasAttachments", "$top": 100},
        )
    )


def find_message_in_tree(graph: Graph, mailbox: str, root_id: str, subject: str) -> dict[str, Any] | None:
    """Finds a message by exact subject anywhere beneath a folder, root included."""
    for folder_id in [root_id, *(str(f["id"]) for f in walk_folders(graph, mailbox, root_id))]:
        for message in messages_in(graph, mailbox, folder_id):
            if message.get("subject") == subject:
                return message
    return None


def attachment_sha256(graph: Graph, mailbox: str, message_id: str, name: str) -> str | None:
    """SHA-256 of a named file attachment's bytes, or None when the attachment is absent."""
    attachments = graph.paged(f"/users/{mailbox}/messages/{message_id}/attachments")
    for attachment in attachments:
        if attachment.get("name") != name:
            continue
        content = attachment.get("contentBytes")
        if not content:
            return None
        return hashlib.sha256(base64.b64decode(content)).hexdigest()
    return None


def delete_message(graph: Graph, mailbox: str, message_id: str) -> None:
    """Removes a message so a restore has something to prove."""
    graph.delete(f"/users/{mailbox}/messages/{message_id}")


def restore_roots_containing(graph: Graph, mailbox: str, marker: str) -> list[dict[str, Any]]:
    """`Restore-*` roots that hold a marked descendant.

    Atlas names its restore root `Restore-{timestamp}` with no marker of ours, so identifying ours
    by name alone would risk deleting an operator's own restore. A root only counts as this run's
    when a folder or message inside it carries the marker.
    """
    roots: list[dict[str, Any]] = []
    for folder in top_level_folders(graph, mailbox):
        if not str(folder.get("displayName", "")).startswith("Restore-"):
            continue
        subtree = list(walk_folders(graph, mailbox, str(folder["id"])))
        if any(marker in str(f.get("displayName", "")) for f in subtree):
            roots.append(folder)
    return roots
