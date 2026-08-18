"""Redaction for every byte this suite logs or uploads.

Two audiences, one rule. GitHub masks registered secrets in *workflow logs*, but only the exact
values it was given: a tenant id also appears as `wisecomfi-my.sharepoint.com`, a mailbox also
appears as `/personal/miika_wisecom_fi`, and neither is masked. Artifacts get no masking at all --
they are raw files in a public repository.

So everything passes through here, in two deliberately overlapping layers:

1. **Exact values** we were given, plus the derived forms they are known to take (a SharePoint
   personal-site path is the owner's address with `@` and `.` replaced by `_`).
2. **Shape patterns** for identifiers we cannot enumerate: GUIDs, bearer tokens, `tempauth`
   download tokens, email addresses, Graph drive ids, any `*.sharepoint.com` host.

The `tempauth` case is why layer 2 is not optional. A SharePoint download URL carries a signed JWT
whose payload decodes to the site id, the app display name, the user object id, the caller IP and
the granted scopes -- a usable credential until it expires. Nothing constructs that string from a
value we hold, so only its shape can catch it.
"""

from __future__ import annotations

import re

from atlas_e2e.config import Settings

_GUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_BEARER = re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{20,}=*")
# Signed SharePoint download token: a bearer credential with site, user and scope claims.
_TEMPAUTH = re.compile(r"(?i)([?&](?:tempauth|access_token|guestaccesstoken)=)[^&\s]+")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Any tenant host, with or without a scheme: the CLI accepts `hostname:/sites/name`, and OneDrive
# personal sites live on `<tenant>-my.sharepoint.com`. The hostname alone names the tenant.
_SHAREPOINT_HOST = re.compile(r"(?i)\b(?:https?://)?[A-Za-z0-9-]+\.sharepoint\.com(?:[:/][^\s\"']*)?")
# Graph drive ids (`b!<base64>`) embed the site and web GUIDs.
_DRIVE_ID = re.compile(r"\bb![A-Za-z0-9_-]{20,}")


def scrub(text: str, settings: Settings) -> str:
    """Replaces secrets, their derived forms, and identifying shapes with stable placeholders."""
    for value, placeholder in _literals(settings):
        text = text.replace(value, placeholder)

    # Tokens first: a download URL is both a token carrier and a host match, and the token is the
    # part that must not survive even in fragments.
    text = _TEMPAUTH.sub(r"\1<token>", text)
    text = _BEARER.sub(r"\1<token>", text)
    text = _SHAREPOINT_HOST.sub("<sharepoint-url>", text)
    text = _DRIVE_ID.sub("<drive-id>", text)
    text = _EMAIL.sub("<upn>", text)
    return _GUID.sub("<guid>", text)


def _literals(settings: Settings) -> list[tuple[str, str]]:
    """Secret values and their known derived forms, longest first so no value is half-redacted."""
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
    for address in (settings.mailbox, settings.onedrive_owner):
        if address:
            # `/personal/<upn with @ and . as _>` is how SharePoint spells a user's own drive.
            literals[address.replace("@", "_").replace(".", "_")] = "<personal-site>"

    # Short values would redact inside unrelated words; every real secret here is far longer.
    return sorted(
        ((value, placeholder) for value, placeholder in literals.items() if value and len(value) >= 8),
        key=lambda pair: -len(pair[0]),
    )
