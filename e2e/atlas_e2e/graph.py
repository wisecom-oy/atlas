"""Microsoft Graph client: client-credentials token, throttle-aware requests, paging."""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from typing import Any

import httpx
import msal

from atlas_e2e.config import Settings

log = logging.getLogger(__name__)

"""Graph answers 4xx and 5xx with an error body; anything below 400 is a usable response."""
HTTP_ERROR_FLOOR = 400

BASE_URL = "https://graph.microsoft.com/v1.0"
SCOPE = ["https://graph.microsoft.com/.default"]
RETRY_STATUSES = {429, 503, 504}
MAX_ATTEMPTS = 5


class GraphError(RuntimeError):
    """A Graph call that failed for a reason retrying will not fix."""


class Graph:
    """Thin Graph wrapper. Mirrors what the product does: app-only auth, retry on throttling."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._app: msal.ConfidentialClientApplication | None = None
        self._client = httpx.Client(base_url=BASE_URL, timeout=60.0)

    def token(self) -> str:
        """Acquires (or reuses msal's cached) app-only access token."""
        result = self._msal().acquire_token_for_client(scopes=SCOPE)
        token = result.get("access_token") if isinstance(result, dict) else None
        if not token:
            # Only the error code is surfaced: descriptions echo tenant and app identifiers.
            code = result.get("error", "unknown") if isinstance(result, dict) else "unknown"
            raise GraphError(f"Graph token request failed: {code}")
        return str(token)

    def _msal(self) -> msal.ConfidentialClientApplication:
        """Builds the msal app on first use.

        Construction performs OIDC discovery against the authority, i.e. a network call. Doing it
        eagerly would make every storage-only test fail with an authority error when credentials
        are wrong, instead of failing the one preflight check that owns that diagnosis.
        """
        if self._app is None:
            try:
                self._app = msal.ConfidentialClientApplication(
                    client_id=self._settings.client_id,
                    client_credential=self._settings.client_secret,
                    authority=f"https://login.microsoftonline.com/{self._settings.tenant_id}",
                )
            except ValueError as err:
                raise GraphError(
                    f"Authority discovery failed for the configured tenant: {err}"
                ) from err
        return self._app

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Issues a request, retrying throttled and transient statuses per Retry-After."""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            response = self._client.request(
                method,
                url,
                headers={"Authorization": f"Bearer {self.token()}", **kwargs.pop("headers", {})},
                **kwargs,
            )
            if response.status_code not in RETRY_STATUSES:
                return response
            delay = float(response.headers.get("Retry-After", 2 * attempt))
            log.info(
                "Graph %s on %s %s; retrying in %.0fs", response.status_code, method, url, delay
            )
            time.sleep(delay)
        return response

    def call(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        """Issues a request and returns the JSON body.

        Raises with the Graph error code on failure.
        """
        response = self.request(method, url, **kwargs)
        if response.status_code >= HTTP_ERROR_FLOOR:
            raise GraphError(f"{method} {url} -> {response.status_code} {_error_code(response)}")
        if not response.content:
            return {}
        return dict(response.json())

    def get(self, url: str, **params: Any) -> dict[str, Any]:
        """GET returning the JSON body."""
        return self.call("GET", url, params=params or None)

    def post(self, url: str, json: dict[str, Any]) -> dict[str, Any]:
        """POST returning the created entity."""
        return self.call("POST", url, json=json)

    def delete(self, url: str) -> None:
        """DELETE, tolerating an already-absent target."""
        response = self.request("DELETE", url)
        if response.status_code not in {200, 202, 204, 404}:
            raise GraphError(f"DELETE {url} -> {response.status_code} {_error_code(response)}")

    def paged(self, url: str, **params: Any) -> Iterator[dict[str, Any]]:
        """Yields every item across `@odata.nextLink` pages."""
        page = self.get(url, **params)
        while True:
            yield from page.get("value", [])
            next_link = page.get("@odata.nextLink")
            if not next_link:
                return
            page = self.call("GET", next_link)

    def close(self) -> None:
        """Releases the HTTP connection pool."""
        self._client.close()


def _error_code(response: httpx.Response) -> str:
    """Extracts Graph's error code. Messages are omitted: they quote identifiers we must not log."""
    try:
        return str(response.json().get("error", {}).get("code", ""))
    except ValueError:
        return ""
