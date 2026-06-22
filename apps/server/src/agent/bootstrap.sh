#!/bin/sh
# Server Central agent bootstrap. Fetched over a pubkey-pinned TLS connection and
# run as root (`curl … | sudo bash`). Templated by the control plane: the cert,
# pin, token, and URLs below are substituted at request time.
#
# It downloads the binary + cert into the current directory, runs the live agent
# in the foreground, and cleans up the downloaded files when it exits. Promotion to
# a permanent service (and the persistent install/data paths) happens later, from
# the web UI, which copies the binary out to the chosen location.
set -eu

TOKEN="__TOKEN__"
PIN="__PIN__"
BASE_URL="__BASE_URL__"
CONTROL_WS="__CONTROL_WS__"
ALT_FLAG="__ALT_FLAG__"

case "$(uname -s)" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="mac" ;;
    *) echo "sc-agent: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

# Stage in the current directory (SC_STAGE overrides). The binary runs from here
# and Bun extracts its native addons into TMPDIR here, so this dir must be writable
# and exec-mounted — verify with an actual exec probe rather than guessing.
STAGE="${SC_STAGE:-$PWD}"
PROBE="$STAGE/.sc-agent-exec-test.$$"
if ! { printf '#!/bin/sh\nexit 0\n' > "$PROBE" 2>/dev/null && chmod +x "$PROBE" 2>/dev/null && "$PROBE" 2>/dev/null; }; then
    rm -f "$PROBE" 2>/dev/null || true
    echo "sc-agent: current directory ($STAGE) is not writable + exec-capable." >&2
    echo "cd to a writable, exec-mounted directory and rerun (or set SC_STAGE)." >&2
    exit 1
fi
rm -f "$PROBE"

BIN="$STAGE/sc-agent"
CERT="$STAGE/sc-agent.crt"

# Remove the staged binary + cert on exit (normal exit, Ctrl-C, or after the live
# agent is promoted and exits) so we don't leave files behind.
trap 'rm -f "$BIN" "$CERT"' EXIT INT TERM

# The control-plane CA cert is public; embed it so we skip a round-trip. The agent
# uses it as its TLS trust anchor (the server presents a CA-signed leaf), so the
# leaf can be rotated/renewed server-side without re-running this install.
cat > "$CERT" <<'SC_AGENT_CERT_EOF'
__CERT__
SC_AGENT_CERT_EOF

# One-time download: verify by the current leaf's pinned pubkey (-k skips hostname/CA
# checks; the pin is the trust anchor for this fetch). The agent's own connection
# below verifies against the embedded CA instead, which survives leaf rotation.
curl -k --pinnedpubkey "$PIN" -fSL "$BASE_URL/node-bootstrap/$TOKEN/$PLATFORM" -o "$BIN"
chmod +x "$BIN"

echo "sc-agent: staged in $STAGE; connecting… complete setup from the web UI."
# Run in the foreground (not exec) so the trap above can clean up when it exits.
# TMPDIR so Bun extracts its native addons into the exec-capable stage dir.
TMPDIR="$STAGE" "$BIN" --agent --control "$CONTROL_WS" $ALT_FLAG --token "$TOKEN" --cert "$CERT"
