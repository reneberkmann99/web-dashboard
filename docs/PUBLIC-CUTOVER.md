# Noderaft public domain cutover

Phase 6F.4 publishes the two canonical Noderaft origins without replacing the
VPN-only recovery endpoint:

- `https://noderaft.ee` — indexable static landing site;
- `https://platform.noderaft.ee` — authenticated platform, always noindex;
- `https://10.99.2.1:1337` and `https://100.126.152.141:1337` — VPN-only
  break-glass access using the existing private certificate.

## Routing architecture

Nginx Proxy Manager remains the only public listener on TCP/80 and TCP/443.
Both public proxy hosts forward HTTP over the existing private
`nginx-network` Docker network to the `noderaft-web:3000` alias. The web
container remains attached to its application network for PostgreSQL and
agent communication; none of those internal services receives a public port.

NPM host IDs 20 (`noderaft.ee`) and 21 (`platform.noderaft.ee`) use certificate
ID 23. HTTP is forced to HTTPS independently for each hostname. The platform
host enables WebSocket-compatible forwarding and applies a dedicated SSE
location for container log streams with buffering, caching, request buffering
and compression disabled, plus one-hour read/send timeouts.

## Canonical URL and indexing boundary

`HOSTPANEL_PUBLIC_BASE_URL` and its production default are
`https://platform.noderaft.ee`. Notification and deep-link generation must not
use a VPN IP, port 1337 or the host's machine name.

Middleware serves `/landing` at the public hostname root and redirects
platform-only surfaces away from the landing hostname. Responses on the
platform and recovery hosts carry `X-Robots-Tag: noindex, nofollow, noarchive`.
The dynamic `/robots.txt` allows the public landing origin while disallowing
all crawling on every other hostname.

Session and CSRF cookies omit the `Domain` attribute. They are therefore
host-only for `platform.noderaft.ee`; the session cookie is also Secure,
HttpOnly and SameSite=Lax. The CSRF cookie is intentionally readable by the
browser for the double-submit CSRF pattern, and remains Secure and
SameSite=Lax.

## Operations and qualification

The pre-cutover NPM snapshot is stored outside the repository under the
root-only `/home/rene/npm-backups/npm-pre-noderaft-20260820-210252` directory.
It contains the SQLite database, persisted NPM/Let's Encrypt state, container
inspection and SHA-256 checksums.

Run the public browser streaming qualification with production credentials
available in the local environment:

```bash
npm run test:public-cutover
```

The qualifier verifies a long-running log stream, stable connection count,
pause/resume, a controlled reconnect after changing the tail, bounded log
replacement, and the NPM SSE response headers. It does not persist or print
credentials, container IDs, screenshots or log content.

Certificate renewal is owned by NPM/Certbot. A non-destructive rehearsal is:

```bash
docker exec nginxproxymanager-app-1 \
  certbot renew --dry-run --no-random-sleep-on-renew --cert-name npm-23
```

Do not expose or republish TCP/1337. Its firewall rules must remain restricted
to `wg0` and `nordlynx`.
