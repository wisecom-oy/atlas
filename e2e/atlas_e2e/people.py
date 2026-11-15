"""Contacts and calendar fixtures: seed through Graph, read back through Graph, sweep by marker.

Both workloads back up the whole mailbox, with no folder scope, so the suite cannot limit what a
backup reads. It can limit what it asserts on and what it deletes: every contact folder and
calendar created here is named after the run marker, and nothing else is touched.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from atlas_e2e.graph import Graph, GraphError
from atlas_e2e.marker import PREFIX, is_marked, is_stale

log = logging.getLogger(__name__)

ATTACHMENT_BYTES = 4096

# The default Contacts folder. Atlas walks its child folders, so fixtures live beneath it.
CONTACTS_ROOT = "contacts"


@dataclass(frozen=True)
class SeededContact:
    """A contact the suite created."""

    contact_id: str
    display_name: str
    email: str


@dataclass(frozen=True)
class SeededEvent:
    """An event the suite created, plus the attachment hash a restore must reproduce."""

    event_id: str
    subject: str
    attachment_name: str
    attachment_sha256: str


def create_contact_folder(graph: Graph, mailbox: str, name: str) -> str:
    """Creates a contact folder under the default Contacts folder and returns its id."""
    folder = graph.post(
        f"/users/{mailbox}/contactFolders/{CONTACTS_ROOT}/childFolders", {"displayName": name}
    )
    return str(folder["id"])


def create_contact(
    graph: Graph, mailbox: str, folder_id: str, marker: str, index: int
) -> SeededContact:
    """Creates a contact whose name and address carry the run marker.

    The address is under `example.com`, a reserved domain, so nothing is ever delivered to it.
    """
    display_name = f"{marker}-contact-{index}"
    email = f"{marker}-{index}@example.com"
    created = graph.post(
        f"/users/{mailbox}/contactFolders/{folder_id}/contacts",
        {
            "givenName": display_name,
            "surname": "E2E",
            "displayName": display_name,
            "companyName": "Atlas E2E fixture",
            "emailAddresses": [{"address": email, "name": display_name}],
        },
    )
    return SeededContact(contact_id=str(created["id"]), display_name=display_name, email=email)


def contacts_in(graph: Graph, mailbox: str, folder_id: str) -> list[dict[str, Any]]:
    """Contacts in one folder, with the fields the assertions need."""
    return list(
        graph.paged(
            f"/users/{mailbox}/contactFolders/{folder_id}/contacts",
            **{"$select": "id,displayName,emailAddresses,companyName", "$top": 100},
        )
    )


def delete_contact(graph: Graph, mailbox: str, contact_id: str) -> None:
    """Removes a contact so a restore has something to prove."""
    graph.delete(f"/users/{mailbox}/contacts/{contact_id}")


def marked_contact_folders(graph: Graph, mailbox: str) -> list[dict[str, Any]]:
    """Marker-named contact folders, wherever Graph lists them.

    Both listings are read: `/contactFolders` returns the folders at the top of the contacts tree,
    and the default folder's `childFolders` returns the ones the suite creates. Which one a given
    mailbox reports them under is Exchange's choice, so cleanup does not depend on it.
    """
    found: dict[str, dict[str, Any]] = {}
    for path in (
        f"/users/{mailbox}/contactFolders",
        f"/users/{mailbox}/contactFolders/{CONTACTS_ROOT}/childFolders",
    ):
        try:
            for folder in graph.paged(path, **{"$select": "id,displayName", "$top": 100}):
                if is_marked(str(folder.get("displayName", ""))):
                    found[str(folder["id"])] = folder
        except GraphError as err:
            log.debug("Could not list %s: %s", path, err)
    return list(found.values())


def create_calendar(graph: Graph, mailbox: str, name: str) -> str:
    """Creates a secondary calendar and returns its id."""
    return str(graph.post(f"/users/{mailbox}/calendars", {"name": name})["id"])


def create_event(
    graph: Graph, mailbox: str, calendar_id: str, marker: str, index: int
) -> SeededEvent:
    """Creates a one-hour event with a random file attachment and no attendees.

    No attendees, so creating and deleting it sends no invitation or cancellation to anyone. The
    attachment is the fidelity proof, as in the Outlook suite: its bytes round-trip verbatim, while
    Exchange rewrites an event body.
    """
    subject = f"{marker}-event-{index}"
    start = (datetime.now(UTC) + timedelta(days=30)).replace(minute=0, second=0, microsecond=0)
    created = graph.post(
        f"/users/{mailbox}/calendars/{calendar_id}/events",
        {
            "subject": subject,
            "body": {"contentType": "Text", "content": "Atlas E2E fixture."},
            "start": {"dateTime": start.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"},
            "end": {
                "dateTime": (start + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
                "timeZone": "UTC",
            },
            "isReminderOn": False,
        },
    )
    event_id = str(created["id"])

    payload = os.urandom(ATTACHMENT_BYTES)
    attachment_name = f"{marker}-event-attachment-{index}.bin"
    graph.post(
        f"/users/{mailbox}/events/{event_id}/attachments",
        {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": attachment_name,
            "contentBytes": base64.b64encode(payload).decode("ascii"),
        },
    )
    return SeededEvent(
        event_id=event_id,
        subject=subject,
        attachment_name=attachment_name,
        attachment_sha256=hashlib.sha256(payload).hexdigest(),
    )


def events_in(graph: Graph, mailbox: str, calendar_id: str) -> list[dict[str, Any]]:
    """Events in one calendar, with the fields the assertions need."""
    return list(
        graph.paged(
            f"/users/{mailbox}/calendars/{calendar_id}/events",
            **{"$select": "id,subject,hasAttachments", "$top": 100},
        )
    )


def event_attachment_sha256(graph: Graph, mailbox: str, event_id: str, name: str) -> str | None:
    """SHA-256 of a named file attachment on an event, or None when it is absent."""
    for attachment in graph.paged(f"/users/{mailbox}/events/{event_id}/attachments"):
        if attachment.get("name") != name:
            continue
        content = attachment.get("contentBytes")
        return hashlib.sha256(base64.b64decode(content)).hexdigest() if content else None
    return None


def delete_event(graph: Graph, mailbox: str, event_id: str) -> None:
    """Removes an event so a restore has something to prove."""
    graph.delete(f"/users/{mailbox}/events/{event_id}")


def marked_calendars(graph: Graph, mailbox: str) -> list[dict[str, Any]]:
    """Marker-named calendars in the mailbox."""
    return [
        calendar
        for calendar in graph.paged(
            f"/users/{mailbox}/calendars", **{"$select": "id,name", "$top": 100}
        )
        if is_marked(str(calendar.get("name", "")))
    ]


def sweep(graph: Graph, mailbox: str, marker: str) -> list[str]:
    """Deletes this run's contact folders and calendars, and stale ones a local run left behind.

    Neither resource reports a creation time, so a foreign marker's age is read from its name. A
    local run's marker embeds its start time (`atlas-e2e-local-<epoch>`); a CI marker embeds only
    the run id, so a foreign CI fixture is left alone. The workflow's sweep step runs under the
    same run id as the suite, so a crashed CI run still cleans up after itself.
    """
    removed: list[str] = []
    targets = [
        (f"/users/{mailbox}/contactFolders/{folder['id']}", str(folder.get("displayName", "")))
        for folder in _tolerant(lambda: marked_contact_folders(graph, mailbox), "contact folders")
    ] + [
        (f"/users/{mailbox}/calendars/{calendar['id']}", str(calendar.get("name", "")))
        for calendar in _tolerant(lambda: marked_calendars(graph, mailbox), "calendars")
    ]
    for url, name in targets:
        if marker not in name and not _is_stale_local(name):
            log.info("Leaving foreign fixture %s", name)
            continue
        try:
            graph.delete(url)
            removed.append(name)
            log.info("Cleaned up %s", name)
        except GraphError as err:
            log.warning("Could not delete %s: %s", name, err)
    return removed


def _is_stale_local(name: str) -> bool:
    """Whether a name carries a local run's marker old enough that no live run owns it."""
    prefix = f"{PREFIX}-local-"
    if not name.startswith(prefix):
        return False
    epoch = name[len(prefix) :].split("-", 1)[0]
    if not epoch.isdigit():
        return False
    return is_stale(datetime.fromtimestamp(int(epoch), UTC))


def _tolerant(listing: Any, label: str) -> list[dict[str, Any]]:
    """Runs a listing, returning nothing when the app lacks the permission to read it."""
    try:
        return list(listing())
    except GraphError as err:
        log.info("Skipping the %s sweep: %s", label, err)
        return []
