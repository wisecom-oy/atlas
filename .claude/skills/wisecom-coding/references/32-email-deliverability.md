# 32. Email Deliverability

Apply this chapter when code builds, signs, sends, queues, unsubscribes, suppresses, or diagnoses email, or when DNS for sending domains changes. Research basis: current Gmail/Google Workspace, Microsoft consumer mail and Microsoft 365, Yahoo/AOL, iCloud, GMX, Zoho, Proton, Yandex, and NetEase documentation, protocol RFCs, published research, and patents, checked 28 October 2026. Provider thresholds change; verify current provider documentation before treating a number below as a contract.

Receivers combine authenticated identity, sender reputation, recipient expectations, message content, and local organizational policy. Correct DNS cannot make unwanted mail wanted, and good wording cannot repair broken authentication or a damaged reputation. No provider publishes a reproducible global scoring formula.

Sections 32.1–32.8 state checks and practices; prohibitions live only in 32.9.

## 32.1 Keep outcomes separate

"Spam filtering" covers several distinct outcomes: temporary SMTP deferral, permanent rejection, Spam/Junk placement, quarantine, and later reclassification. Promotions and Updates are inbox categories, not spam verdicts.

- MUST model and report SMTP acceptance, inbox placement, inbox category, complaints, and business outcomes as separate measurements.
- MUST classify `4xx` responses as temporary (bounded retry with backoff) and `5xx` as permanent.

## 32.2 Provider requirements

Implement the strongest common requirement, even where one provider's minimum is weaker: aligned SPF and DKIM, DMARC, TLS, forward-confirmed reverse DNS (32.4), recorded consent (32.7), and one-click unsubscribe for marketing (32.6).

| Receiver | Requirement that matters to code |
| --- | --- |
| Personal Gmail | All senders: SPF or DKIM, valid forward/reverse DNS, TLS. Bulk senders (~5,000 messages/24h to personal Gmail, aggregated across the primary domain and subdomains; classification persists once reached): SPF and DKIM, DMARC, alignment, one-click unsubscribe. Keep complaints below 0.1%; never reach 0.3%. Workspace inbound is excluded from these specific rules. |
| Outlook.com/Hotmail/Live/MSN | 5,000+ messages from the same visible From domain: SPF **and** DKIM must pass, DMARC must pass. Failure can return `550 5.7.515`. |
| Microsoft 365 | Tenant policies, bulk thresholds, impersonation protection, and recipient history decide handling. Consumer thresholds do not describe enterprise filtering. |
| Yahoo/AOL | Bulk: SPF and DKIM, passing DMARC, complaints below 0.3%, unsubscribe processed within two days. No published bulk-volume threshold. Yahoo Japan is a separate system. |
| iCloud | Bulk: explicit subscription, SPF/DKIM, published DMARC, reverse DNS, stable identity, unsubscribe, list hygiene. No bulk allowlist, no complaint feedback loop. |
| GMX | Valid aligned DKIM is mandatory; SPF alone is insufficient. Static IP, meaningful PTR, valid HELO/EHLO. |

## 32.3 Keep sender identities straight

| Identity | Purpose |
| --- | --- |
| Visible `From:` | Author shown to the recipient. DMARC evaluates this domain. |
| SMTP `MAIL FROM` | Envelope sender for SPF and bounces; usually appears as `Return-Path`. |
| DKIM `d=` | Domain taking cryptographic responsibility. |
| DKIM `s=` | Selector locating the DNS public key. |
| `Reply-To:` | Where replies go. May differ from From; not authenticated by DMARC. |

Common failure: SPF and DKIM pass for the email platform's own domain, but neither aligns with the customer's visible From domain, so DMARC fails.

Coherent example (reserved names, documentation IP, placeholder key):

```
Visible From:    updates@news.example.com
SMTP MAIL FROM:  bounce+id@bounce.news.example.com
DKIM domain:     news.example.com
DKIM selector:   m202610
```

```
bounce.news.example.com.           TXT "v=spf1 ip4:192.0.2.25 -all"
m202610._domainkey.news.example.com. TXT ("v=DKIM1; k=rsa; p=PUBLIC_KEY")
_dmarc.news.example.com.           TXT ("v=DMARC1; p=none; rua=mailto:dmarc@example.com")
```

DKIM `d=` matches the From domain exactly; the bounce subdomain gives relaxed SPF alignment.

## 32.4 Authentication and DNS checks

SPF

- [ ] Exactly one SPF TXT record at the actual envelope domain.
- [ ] All authorized sending paths included.
- [ ] Ten or fewer evaluated lookup-causing terms (`include`, `a`, `mx`, `ptr`, `exists`, `redirect`), counted recursively through nested includes. Exceeding the limit is `permerror`. The limit is not "ten providers" or "ten DNS packets".

DKIM

- [ ] The active sending path actually signs. A published key alone proves nothing.
- [ ] Signing is the last step: after MIME serialization, personalization, link/tracking rewrites, and footer insertion.
- [ ] RSA-SHA256 with a 2048-bit key as baseline. SHA-1 is prohibited.
- [ ] `List-Unsubscribe` and `List-Unsubscribe-Post` are covered by the signature when present.

DMARC

- [ ] At least one passing SPF or DKIM identity aligns with the visible From domain. Some providers require both to pass.
- [ ] `p=none` understood as monitoring, not disabled authentication.
- [ ] Enforcement (`quarantine`/`reject`) chosen for spoofing protection, not expected to buy inbox placement.
- [ ] Current standard: RFC 9989 (May 2026), superseding RFCs 7489 and 9091. Verify receiver adoption before relying on new semantics.

DNS and SMTP identity

- [ ] Sending IP → PTR hostname → A/AAAA → same sending IP.
- [ ] Valid SMTP host identity in HELO/EHLO.
- [ ] TLS on outbound SMTP.
- [ ] IPv6 tested independently when enabled.
- [ ] MX records are not mistaken for outbound authentication; MX concerns receiving mail.

Forwarding can break SPF; mailing-list modification can break DKIM. ARC preserves prior authentication results but is not a universal trust override.

## 32.5 Message construction

- MUST build messages with a maintained MIME library, not string concatenation.
- MUST use correct encodings and multipart boundaries, a valid `Date`, a unique `Message-ID`, and no duplicated single-instance headers.
- MUST make `text/plain` and `text/html` alternatives carry the same information.
- SHOULD keep HTML simple and tested across email clients.
- SHOULD state why the recipient is receiving the message.
- SHOULD link to recognizable, sender-related domains; avoid URL shorteners.
- SHOULD send attachments only when expected, clearly named, without double extensions; prefer a link to an authenticated account page.

Content patterns:

| Higher risk | Trustworthy alternative |
| --- | --- |
| `Re:`/`Fwd:` subject with no real thread | Accurate subject: "The project estimate you requested" |
| Sender name impersonating a CEO, bank, or authority | Stable company/team name on an authorized domain |
| "FINAL WARNING: verify your password immediately" | A real event and deadline; credentials only through the normal sign-in flow |
| Unexpected bank-account change with a vague invoice | Reference the actual order; use an established payment route |
| Homoglyphs, zero-width characters, unrelated filler text | Ordinary accurate language, including legitimate non-English text |
| Familiar link label pointing to an unrelated domain | Clear action leading to the expected domain |
| Entire message in one promotional image | Readable text with supporting images and alt text |

## 32.6 One-click unsubscribe (marketing mail)

```
List-Unsubscribe: <https://news.example.com/u/OPAQUE_TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The endpoint is a trust boundary and a data-integrity path. Test each item end to end before release:

- [ ] HTTPS `POST` works without login, cookies, confirmation step, or redirect.
- [ ] Token is unguessable and verified; it does not expose the address or a sequential ID.
- [ ] Suppression is committed durably before success is returned.
- [ ] Repeated requests are idempotent and harmless.
- [ ] A plain `GET` (link scanners, prefetchers) changes nothing.
- [ ] A visible unsubscribe link also exists in the body.
- [ ] Suppression is shared across every sending system and re-applied at dispatch time, so queued campaigns honor recent opt-outs.
- [ ] Processing completes well within two days (Yahoo requirement).

## 32.7 Sending behavior and list hygiene

| Increases risk | Decreases risk |
| --- | --- |
| Purchased lists, accidental or unverified signups | Explicit consent, address confirmation, recorded subscription scope |
| Turning a monthly update into daily sales mail | Purpose and frequency the recipient selected |
| Repeatedly mailing nonexistent addresses | Bounce classification and suppression of genuinely invalid recipients |
| Sudden unexplained spikes, aggressive retries | Predictable queues, gradual ramp-up with real opted-in traffic, adaptive backoff |
| Abused shared pools, compromised accounts, unsafe linked domains | Monitored infrastructure, secured accounts, controlled sending |

- MUST record the user action or subscription that justifies each message.
- MUST make retries idempotent per Message-ID (chapter 16).
- MUST route bounce classifications and complaint feedback (32.8) into the suppression system.
- SHOULD separate transactional and promotional streams (subdomains, IPs, or ESP streams). This aids operations and diagnosis but does not guarantee independent reputation.
- SHOULD NOT use ordinary Exchange Online mailboxes as a bulk-mail platform.

## 32.8 Monitoring and diagnostics

- Keep full SMTP response text, enhanced status codes, sender identities, Message-ID, template version, and protected `.eml` samples. Treat samples as personal data.
- Verify authentication from the receiver-generated `Authentication-Results` header on a delivered message, through the real ESP, for each target receiver. DNS dashboards are not evidence.
- Investigate the receiver's stated reason before rewording content.
- Low or zero complaint rates can mean mail already lands in Spam, where users cannot report it. Low-volume data may be withheld and dashboards lag. Missing data is not health.
- Pixel opens are not a reputation signal: Google does not use them; Apple Mail Privacy Protection prefetches content.
- Microsoft 365: SCL no longer determines the cloud spam verdict (August 2026). Inspect `CAT`, `DIR`, `BCL`, `compauth`, the applicable policy, and the detection technology instead of an old SCL table.

| Receiver | Evidence source |
| --- | --- |
| Gmail | Postmaster Tools: authentication, reputation, compliance, campaign feedback |
| Yahoo | Complaint Feedback Loop for enrolled DKIM domains |
| Microsoft consumer | SNDS and JMRP |
| Microsoft 365 | Delivered headers, message trace, detector, tenant policy |

## 32.9 Never

Every "Higher risk" pattern in 32.5 is also prohibited. In addition:

- NEVER send promotional mail without recorded consent.
- NEVER modify a message after DKIM signing.
- NEVER forge, copy, or self-insert `Authentication-Results`, spam-score, or other trust headers.
- NEVER include scripts, forms, iframes, or embedded objects.
- NEVER keep mailing a recipient after an unsubscribe or complaint.
- NEVER retry `5xx` failures.
- NEVER report delivery success from SMTP acceptance, a DNS dashboard, or a generic spam checker.
- NEVER log message bodies, unsubscribe tokens, or recipient lists into unprotected telemetry.

## 32.10 Do not enforce myths

The evidence does not support these blanket rules. Do not encode them as validators, lint rules, or review blockers:

- "Never use free, invoice, or discount."
- "Every email needs a 60:40 text-to-image ratio."
- "Plain-text email automatically lands in the inbox."
- "A dedicated IP is always better."
- "An emoji, attachment, or no-reply address automatically means spam."
- "Passing a generic spam checker predicts Gmail's decision."

Words still matter in context. Microsoft 365 Advanced Spam Filter options (off by default, not in Standard/Strict presets) can act on an undisclosed sensitive-word list, URL forms, and HTML elements. Zoho administrators can define subject/body patterns. NetEase names keyword examples such as 发票 ("invoice") and 展会 ("trade fair"). A local administrator can always be stricter than the provider default; diagnose per receiver.
