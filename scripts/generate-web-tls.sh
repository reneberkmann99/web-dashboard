#!/bin/sh
set -eu

tls_dir="${HOSTPANEL_TLS_DIR:-/etc/hostpanel/tls}"
ip_sans="${HOSTPANEL_TLS_IP_SANS:-10.99.2.1,100.126.152.141}"
dns_sans="${HOSTPANEL_TLS_DNS_SANS:-vmi2804346}"
valid_days="${HOSTPANEL_TLS_VALID_DAYS:-825}"
force="${1:-}"

case "$tls_dir" in
  ""|"/"|"/etc"|"/home"|"/opt") echo "Refusing unsafe TLS directory" >&2; exit 1 ;;
esac
case "$valid_days" in *[!0-9]*|"") echo "HOSTPANEL_TLS_VALID_DAYS must be numeric" >&2; exit 1 ;; esac

cert_path="$tls_dir/hostpanel.crt"
key_path="$tls_dir/hostpanel.key"
if [ -e "$cert_path" ] || [ -e "$key_path" ]; then
  if [ "$force" != "--force" ]; then
    echo "TLS material already exists; refusing to replace it. Pass --force only for an intentional rotation." >&2
    exit 1
  fi
fi

subject_alt_name=""
old_ifs="$IFS"
IFS=','
for value in $ip_sans; do
  case "$value" in *[!0-9a-fA-F:.]*) echo "Invalid IP SAN" >&2; exit 1 ;; esac
  subject_alt_name="${subject_alt_name}${subject_alt_name:+,}IP:$value"
done
for value in $dns_sans; do
  case "$value" in *[!A-Za-z0-9._-]*) echo "Invalid DNS SAN" >&2; exit 1 ;; esac
  subject_alt_name="${subject_alt_name}${subject_alt_name:+,}DNS:$value"
done
IFS="$old_ifs"
[ -n "$subject_alt_name" ] || { echo "At least one SAN is required" >&2; exit 1; }

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
  -days "$valid_days" \
  -subj "/CN=Noderaft Private VPN/O=Noderaft" \
  -addext "subjectAltName=$subject_alt_name" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "$tmp_dir/hostpanel.key" \
  -out "$tmp_dir/hostpanel.crt"

install -d -m 0700 "$tls_dir"
install -m 0600 "$tmp_dir/hostpanel.key" "$key_path"
install -m 0644 "$tmp_dir/hostpanel.crt" "$cert_path"

echo "Certificate: $cert_path"
echo "Private key: $key_path (mode 0600)"
openssl x509 -in "$cert_path" -noout -dates -ext subjectAltName -fingerprint -sha256
