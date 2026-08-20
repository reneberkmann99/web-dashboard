# Noderaft public and private HTTPS

The canonical application is `https://platform.noderaft.ee`. Nginx Proxy
Manager owns public TCP/80 and TCP/443, terminates the publicly trusted
certificate, and forwards both Noderaft hostnames over the private
`nginx-network` Docker network to `noderaft-web:3000`. The landing hostname
`noderaft.ee` is intentionally separate from the authenticated platform.

The private endpoint documented below remains a VPN-only break-glass path. It
is not canonical and must never replace the public base URL used in generated
notifications or platform links.

HostPanel terminates browser TLS at the lightweight `proxy` service
(`nginx:1.27-alpine`). The Next.js `web` service is exposed only on the private
Compose network (`web:3000`) and is no longer published on the Docker host.
The existing host port `1337` now speaks **HTTPS only**:

- WireGuard: `https://10.99.2.1:1337`
- Nord Meshnet: `https://100.126.152.141:1337`
- plaintext `http://…:1337` is intentionally unavailable and cannot serve the
  authenticated application;
- host firewall policy remains the network boundary: only `wg0` and
  `nordlynx` may reach TCP/1337. The Docker publish still binds all host
  interfaces, so those firewall rules must remain in place.

The recovery proxy does not use port 443 because that port belongs to Nginx
Proxy Manager. Its self-signed certificate is distinct from the public
Let's Encrypt certificate.

## Generate the persistent certificate

Run once on the Docker host before starting the proxy:

```bash
cd /opt/web-dashboard/web-dashboard
sudo HOSTPANEL_TLS_DIR=/etc/hostpanel/tls \
  HOSTPANEL_TLS_IP_SANS=10.99.2.1,100.126.152.141 \
  HOSTPANEL_TLS_DNS_SANS=vmi2804346 \
  ./scripts/generate-web-tls.sh
```

Defaults use RSA-3072/SHA-256, TLS server-auth extensions, proper IP and DNS
Subject Alternative Names, and an 825-day validity period. Creation refuses to
replace existing material. Intentional renewal/rotation requires `--force`:

```bash
sudo HOSTPANEL_TLS_DIR=/etc/hostpanel/tls \
  HOSTPANEL_TLS_IP_SANS=10.99.2.1,100.126.152.141 \
  HOSTPANEL_TLS_DNS_SANS=vmi2804346 \
  ./scripts/generate-web-tls.sh --force
sudo docker compose up -d --no-deps --force-recreate proxy
```

Record the old fingerprint before rotation. A rotation changes the trusted
certificate identity and clients must trust the new public certificate.

Persistent host paths:

- certificate: `/etc/hostpanel/tls/hostpanel.crt` (0644; public material)
- private key: `/etc/hostpanel/tls/hostpanel.key` (0600)

The directory is bind-mounted read-only into nginx and is not part of the Git
repository, application API, static files, or normal database backup. Include
it in a protected host configuration backup only when that is an intentional
backup policy. Ordinary container restart/recreation never regenerates it.

Inspect expiry/SAN/fingerprint without exposing the key:

```bash
sudo openssl x509 -in /etc/hostpanel/tls/hostpanel.crt \
  -noout -dates -ext subjectAltName -fingerprint -sha256
```

## Browser trust

A browser warning is expected until the self-signed public certificate is
trusted. Copy **only** `hostpanel.crt` to the operator device and import it into
the OS/browser trust store. Never copy or import `hostpanel.key`. Do not disable
TLS validation. A SAN mismatch is not acceptable; regenerate with the exact IP
or DNS name used in the address bar.

## Cookies, forwarded headers and streaming

Production sets `COOKIE_SECURE=true`; the session remains `HttpOnly` and
`SameSite=Lax`, and the CSRF cookie is also Secure. nginx overwrites
`X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Proto=https`. Because `web:3000`
is not host-published, external callers cannot bypass this trusted proxy path.

The LogViewer SSE route has buffering, request buffering, cache and compression
disabled, `X-Accel-Buffering: no`, and a one-hour read timeout. Browser API,
SSE and static requests remain same-origin/relative, preventing mixed content.
No WebSocket endpoint currently exists; none was introduced for TLS.

Public platform cookies are host-only: no `Domain` attribute is set, so the
browser does not send platform session or CSRF cookies to `noderaft.ee`.

TLS permits 1.2 and 1.3 only. HSTS is deliberately omitted for a self-signed
private deployment. Response headers include `nosniff`, same-origin referrer
policy and framing protection (`X-Frame-Options: DENY` plus CSP
`frame-ancestors 'none'`).

## Safe deployment and rollback

Deployment (never use `docker compose down`):

```bash
sudo docker compose build web
sudo docker compose up -d --no-deps web
sudo docker compose up -d --no-deps proxy
```

If TLS fails, inspect `docker compose logs proxy` and certificate permissions.
Rollback is the previous Compose mapping (`web: 1337:3000`) after removing the
proxy's port publish, followed by targeted `docker compose up -d --no-deps web`.
This rollback restores plaintext and is for emergency access only; restore TLS
before normal operation.
