---
name: verify
description: Boot and drive the real Server Central control plane for runtime verification of server/API changes.
---

# Verifying Server Central changes

## Surface

The control plane is one Bun process: HTTP API on **:4141** (ops are
`POST /<opName>` with a JSON body, bearer token auth), node WS server on
**:4142** (hardcoded `NODE_SERVER_PORT`), embedded agent in-process. The web
app is a thin client over the :4141 ops (`apps/web/src/api.ts`), so most UI
changes can be verified at the HTTP surface.

## Launch (isolated from the dev instance)

The dev server usually already occupies 4141/4142 and `4142` has **no env
override**, so a second instance crashes on bind. Run the real entry in a
private network namespace instead — no source changes, normal ports:

```bash
unshare -r -n bash -c '
  ip link set lo up
  DATA=$(mktemp -d)
  cd apps/server && SC_DATA_DIR="$DATA" bun src/index.ts &
  # poll until up:
  curl -sf -X POST http://127.0.0.1:4141/getAuthState -H "Content-Type: application/json" -d null
  ...
'
```

- `SC_DATA_DIR` isolates all state (users, TLS, agents); `PORT` overrides 4141 only.
- Boot takes ~2s (3s STUN timeout fires harmlessly without network; DNS fails fast in the ns).
- Inside the userns you are fake-root: `useradd`/`usermod` run for real but
  can't write `/etc/passwd`/`/etc/group` → clean error-path probes, no host mutation.

## Drive

```bash
# First run: claim ownership, get a token
curl -s -X POST $API/setupOwner -d '{"username":"admin","password":"supersecret1"}' -H 'Content-Type: application/json'
# Then any op from CentralApiOperations (shared/src/index.ts):
curl -s -X POST $API/<op> -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '<data json>'
```

Useful probes: unauthenticated → 401; non-owner token against `requireOwner`
ops → `{"error":"Only the owner can do this"}`; create extra users via
`createUser` + `login`.

## Gotchas

- No browser/Playwright in this dev container — web UI can't be pixel-driven;
  verify the ops it calls and note the gap.
- Agent-flow verification: spawn the real `--agent` subprocess against the ns
  instance (see `apps/server/test/integration/helpers.ts` `spawnTestAgent`).
