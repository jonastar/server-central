# Running behind a reverse proxy

Server Central serves its web UI and API over plain HTTP on `:4141`. That's fine on a
home LAN and not fine at work, where you want a real hostname and a real certificate.
This describes putting a TLS-terminating reverse proxy in front of it.

Everything below assumes SC gets its **own hostname** — `https://sc.example.com/`,
proxied to `127.0.0.1:4141`. Serving it from a sub-path of a shared hostname
(`https://example.com/sc/`) is not supported: the web app's asset URLs are rooted at `/`.

## The two ports are not the same thing

| Port | Who connects | Transport | Through the proxy? |
| --- | --- | --- | --- |
| `4141` | Browsers (web UI + API) | Plain HTTP | **Yes** — this is what you proxy |
| `4142` | Host agents | HTTPS, SC's own self-signed CA | **Never** |

`:4142` runs its own TLS with a certificate SC issues itself, and the enrollment command
you copy from the UI carries a public-key pin for it. That pin is what makes a
`curl … | sudo bash` enrollment safe without a domain or a public CA, and it's the
agents' trust anchor from then on. A TLS-terminating proxy in front of `:4142` presents
a *different* certificate, which breaks the pin — so don't proxy it. Agents connect to it
directly, and it needs to stay reachable from wherever your hosts are.

## Configure SC

Settings live in `config.json` in the data dir (`/var/lib/sc-central/config.json` for an
installed control plane). Both of these are read once at startup — restart after editing.

```jsonc
{
    // Don't listen on anything but loopback: the proxy is the only thing that
    // should be able to reach the plaintext port.
    "bindHost": "127.0.0.1",

    // Believe the forwarded header, but only from the proxy itself. An entry may
    // name the header that particular proxy writes, for a server reachable through
    // two front ends at once; without one it uses forwardedHeader below.
    "trustedProxies": [
        "127.0.0.1",
        { "address": "10.42.0.0/16", "header": "CF-Connecting-IP" }
    ],

    // Optional. Default header for entries that don't name one; X-Forwarded-For if
    // unset. Also accepts X-Real-IP, True-Client-IP, or Forwarded for RFC 7239.
    "forwardedHeader": "X-Forwarded-For",

    // The canonical URL browsers reach SC at — what you just put on the proxy.
    // Also the OIDC issuer. Settable from Settings → Primary URL.
    "primaryUrl": "https://sc.example.com",

    // Optional. *Other* origins allowed to call the API cross-origin. Unset keeps
    // the historical "*". The UI itself is same-origin and needs no entry here.
    "allowedOrigins": ["https://app.example.com"]
}
```

`primaryUrl` and `allowedOrigins` are editable from **Settings → General** and apply
immediately; `bindHost` and `trustedProxies` are read at startup, so they need a restart.
A pre-rename `issuerUrl` is read as `primaryUrl` automatically.

These can also come from the environment, which is usually easier for a systemd
drop-in or a container: `SC_BIND=127.0.0.1`, `SC_TRUSTED_PROXIES=127.0.0.1`,
`SC_FORWARDED_HEADER=X-Forwarded-For` and `SC_ALLOWED_ORIGINS=https://app.example.com`
(the list-valued ones comma-separated). The environment wins over `config.json`.

### What `allowedOrigins` does, and doesn't

Unset, `Access-Control-Allow-Origin` stays `*`, as it has been. Set it and only those
origins are allowed — the request's own `Origin` is echoed back when it matches, with
`Vary: Origin`, and no allow header at all when it doesn't. The primary URL's origin is
included automatically, since SC's own address is always allowed to call SC.

This list is for **other** apps' frontends. It is not "the addresses SC is served at" —
that's the primary URL, and conflating the two would let a third-party origin stand in as
SC's own identity.

Know what you're getting: CORS decides whether a browser hands the **response** back to a
calling page. It does not stop the request being **sent** — a "simple" cross-origin POST
(`Content-Type: text/plain`) skips preflight and reaches the handler regardless. Narrowing
this is tidiness and defence in depth, not a request-level control.

### Why `trustedProxies` matters more than it looks

Without it, every request appears to come from the proxy's address. Sessions all record
that one IP — cosmetic — but the login throttle also keys on it, so **one person
failing a login repeatedly would lock out everyone**. Set it and the throttle works per
real client again.

It is deliberately not on by default, and deliberately not a boolean. `X-Forwarded-For`
is just a header: anyone who can reach SC directly can send one. SC only reads it when
the connection's actual peer is a listed proxy, and then walks the chain from the right,
taking the first hop that isn't itself a listed proxy — so a client that pre-seeds the
header with a fake address can't shadow the address its proxy appends.

Use the address the proxy connects *from*. Same host is `127.0.0.1`; a separate proxy box
or a container network is that address or its CIDR (`10.42.0.0/16`).

`forwardedHeader` names the header those proxies are expected to write into. The default
suits Caddy, nginx's `X-Forwarded-For`, and Traefik. Point it at `X-Real-IP` if that's
what your nginx sets, at `CF-Connecting-IP` or `True-Client-IP` behind a CDN, or at
`Forwarded` for RFC 7239 — which is parsed in its own `for=` syntax, quoted and bracketed
IPv6 included, rather than as a plain list. Single-address headers need no special
handling; they're a one-element chain.

Each entry may override it, for a control plane reachable through more than one front end
at once — an internal nginx writing `X-Real-IP` *and* a CDN tunnel writing
`CF-Connecting-IP`, each connecting directly. The header is chosen by whichever entry
matches the peer, so both paths resolve correctly instead of one degrading to the proxy's
own address. Overlapping ranges resolve to the first matching entry, so list specific
addresses above the ranges that contain them.

This does nothing for *chained* proxies (CDN → nginx → SC): the peer is only ever the last
hop, so only that hop's header is ever ours to read — the rest is nginx's job, one hop up.

Whichever header applies, exactly one is read rather than a list tried in order. That's
deliberate: falling back to a second header lets an address your proxy never set win
whenever the expected one is missing, which is the failure this whole mechanism exists to
prevent.

Trusted proxies are editable in **Settings → Trusted proxies** and apply live. Setting
`SC_TRUSTED_PROXIES` makes the environment authoritative and the UI read-only, so a save
there can't be silently overridden.

## Configure the proxy

Requirements, whichever you use:

- **Forward WebSocket upgrades.** The dashboard's live-update channel (`/api/events`) and
  the terminal (`/api/terminal`) are both WebSockets. Without upgrade support the UI
  loads and then never updates.
- **Set `X-Forwarded-For`.** Most proxies do by default.
- **Allow large request bodies.** File uploads are base64 inside a JSON body, so the
  256 MB upload limit needs roughly **384 MB** of body allowance.
- **Don't set a short read timeout.** A terminal WebSocket can sit idle for a long time.

### Caddy

```caddyfile
sc.example.com {
    reverse_proxy 127.0.0.1:4141
}
```

That's the whole file. Caddy gets the certificate itself, proxies WebSockets without
being asked, sets `X-Forwarded-For`, and streams request bodies with no size cap.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name sc.example.com;

    ssl_certificate     /etc/letsencrypt/live/sc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sc.example.com/privkey.pem;

    # Uploads are base64 in a JSON body: ~4/3 of the 256 MB file limit.
    client_max_body_size 384m;

    location / {
        proxy_pass http://127.0.0.1:4141;

        # Required for /api/events and /api/terminal.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # An idle terminal shouldn't be hung up on.
        proxy_read_timeout  1h;
        proxy_send_timeout  1h;
        proxy_buffering     off;
    }
}

# Paired with the Upgrade header above; nginx needs this map to clear
# `Connection` on non-upgrade requests.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

### SC's own reverse proxy

SC can also front itself with the Caddy instance it manages (**Proxy** in the sidebar),
if the control plane's host is enrolled as a node: add a route for `sc.example.com`
targeting that node and port `4141`. Worth knowing what you're accepting — the thing
serving your admin UI is then managed *from* that admin UI, so a bad route can lock you
out of the place you'd go to fix it. Keep `:4141` reachable from somewhere (an SSH
tunnel, the LAN address) as a way back in.

## The External domain setting

**Settings → External domain** is easy to misread while you're setting up a proxy. It is
the hostname **agents** use — it goes into the node server's TLS certificate and becomes
the off-LAN endpoint in enrollment commands (`wss://<domain>:4142/node`). Nothing the
browser talks to reads it.

So it is *not* automatically the hostname you proxy the UI at:

- **Proxy on the same host as the control plane, one DNS name.** `sc.example.com` resolves
  here, so it works for both — set it, provided `:4142` is open on that name.
- **Proxy on a separate machine** (a load balancer, an ingress, another VM). `sc.example.com`
  resolves to the *proxy*, which has nothing on `:4142`. Setting it there hands agents an
  endpoint that never answers. Leave it as the name or IP that resolves to the control-plane
  host, or leave it unset and let the discovered WAN IP stand.

The setting that *does* mean "the external URL of this web UI" is **Primary URL** — set
that to `https://sc.example.com`, matching what browsers see. It doubles as the OIDC `iss`
claim, so once an SSO client trusts it, changing it is refused unless you confirm: relying
parties pin the issuer, and moving it breaks their sign-in.
