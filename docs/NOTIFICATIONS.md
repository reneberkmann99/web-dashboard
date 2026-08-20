# Attention lifecycle and webhook notifications

Phase 6E keeps five concepts separate:

1. `AttentionState` mirrors current operational truth and resolves only when
   telemetry no longer derives the condition.
2. `AttentionAcknowledgement` is append-only operator history. It never changes
   severity/health and is automatically cleared when that occurrence resolves.
3. `AttentionSilence` temporarily suppresses delivery for a condition, node or
   workload. It does not hide or resolve anything.
4. `MaintenanceWindow` is scheduled metadata/policy for a node or workload.
   Descendant conditions remain truthful; default behavior suppresses ordinary
   operational notification delivery.
5. `NotificationEvent` is one logical, idempotent transition;
   `NotificationDelivery` is one persisted attempt to one destination.

## Transition and expiry semantics

Events are created for `CONDITION_OPENED`, `SEVERITY_ESCALATED` and
`CONDITION_RESOLVED`. Poll-only `lastObservedAt` refreshes produce no events.
Stable unique dedupe keys prevent a repeated sync or process restart from
creating another logical event.

When a silence expires while its scope still has an active warning/critical
condition, HostPanel creates at most one `SILENCE_EXPIRED_STILL_ACTIVE` event
for that silence. Suppressed history is never replayed. At maintenance end,
HostPanel re-evaluates the scope and creates at most one condition notification
with `transitionReason=MAINTENANCE_ENDED_STILL_ACTIVE` if the problem remains.
The condition does not need to close/reopen.

## Webhook payload and verification

Payload schema version 1 includes event/condition/resource identity, severity,
summary/detail, observation timestamps, and an HTTPS HostPanel deep link. It
does not contain database credentials, destination credentials or arbitrary
application environment data.

Headers:

```text
X-HostPanel-Event-Id: <stable logical event id>
X-HostPanel-Timestamp: <unix seconds>
X-HostPanel-Signature: sha256=<hex HMAC-SHA256>
```

Verification pseudocode:

```text
expected = HMAC_SHA256(signing_secret, timestamp + "." + exact_raw_body)
constant_time_compare("sha256=" + hex(expected), signature_header)
reject stale timestamps and deduplicate by X-HostPanel-Event-Id
```

Signing-secret rotation is deliberate: edit the destination with the new
secret after updating the receiver. URL, Authorization value and signing
secret are AES-256-GCM encrypted with the independent
`NOTIFICATION_DESTINATIONS_KEY` and never returned after creation.

## Delivery and SSRF policy

Delivery runs in the database-backed worker, never inside attention polling.
Retries are bounded: immediate attempt, short delay, longer delay, terminal
failure after attempt three. Manual retry appends a deliberate attempt without
duplicating the logical event. Disabled destinations receive no new delivery.
Three or more consecutive failures are shown as an internal pipeline warning;
that warning does not create a recursive notification event.

Native HTTP(S) delivery performs DNS resolution once, validates **every**
answer, pins the selected address while retaining the original Host/SNI, and
does not follow redirects. Link-local/cloud-metadata/multicast targets are
always blocked. Loopback, RFC1918, CGNAT and IPv6 ULA targets are blocked by
default. Set `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` only when an intentional
private n8n/OpenClaw/automation receiver is required; metadata/link-local
targets remain blocked. TLS certificate validation remains enabled.
