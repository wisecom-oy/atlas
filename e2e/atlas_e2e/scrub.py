"""Redaction for anything the run uploads.

GitHub masks registered secrets in *logs*, but artifacts are raw files in a public repository -- a
mask in the Actions UI does nothing for a downloaded zip. So every byte we persist passes through
here first.

Two layers, deliberately overlapping:

1. **Exact values** we were given (tenant id, mailbox, site, keys). Precise, and useless the moment
   a value appears in a form we did not anticipate.
2. **Shape patterns** (GUIDs, bearer tokens, email addresses). Catches the derived identifiers layer
   one cannot know about: a drive id, an owner object id, a site collection GUID.

Reference behaviour is `tools/graph-tap/tap.mjs`: tokens elided, GUIDs and UPNs templated.
"""

from __future__ import annotations

import re

from atlas_e2e.config import Settings

# Order matters only in that longer literals are replaced before shorter ones, so a mailbox
# address is not left half-redacted by an earlier hit on its domain.
_GUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_BEARER = re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{20,}=*")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SHAREPOINT_HOST = re.compile(r"(?i)\bhttps?://[A-Za-z0-9-]+\.sharepoint\.com\S*")
# Graph drive ids (`b!<base64>`) embed the site and web GUIDs, so they identify the tenant as surely
# as the site URL does.
_DRIVE_ID = re.compile(r"\bb![A-Za-z0-9_-]{20,}")


def scrub(text: str, settings: Settings) -> str:
    """Replaces secrets and identifying shapes with stable placeholders."""
    literals = {
        settings.client_secret: "<client-secret>",
        settings.passphrase: "<passphrase>",
        settings.s3_secret_key: "<s3-secret-key>",
        settings.s3_access_key: "<s3-access-key>",
        settings.sharepoint_site: "<sharepoint-site>",
        settings.mailbox: "<mailbox>",
        settings.onedrive_owner: "<onedrive-owner>",
        settings.tenant_id: "<tenant-id>",
        settings.client_id: "<client-id>",
    }
    for value, placeholder in sorted(literals.items(), key=lambda kv: -len(kv[0])):
        if value:
            text = text.replace(value, placeholder)

    text = _SHAREPOINT_HOST.sub("<sharepoint-url>", text)
    text = _DRIVE_ID.sub("<drive-id>", text)
    text = _BEARER.sub(r"\1<token>", text)
    text = _EMAIL.sub("<upn>", text)
    return _GUID.sub("<guid>", text)
