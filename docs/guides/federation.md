# Federation Setup Guide

> **Advanced feature.** Gateway federation links multiple Marina instances. Most deployments run a
> single instance and never need this. It requires a shared secret, open WebSocket ports between
> hosts, and the `gateway.connect` safety gate on each instance.

Connect two or more Marina instances so they can relay channel messages and direct tells across
instance boundaries.

## Prerequisites

- Two or more Marina instances running (`bun run start` on each)
- `GATEWAY_SECRET` set to the same value on all instances
- Network access between instances (WebSocket port open, default 3300)
- `gateway.connect` safety gate on both instances

## Setup

### 1. Set the shared secret

On every instance, set the same strong secret before starting:

```bash
export GATEWAY_SECRET="your-strong-secret-here"
bun run start
```

If `GATEWAY_SECRET` is not set, gateway auth messages are silently ignored for backward
compatibility. If the receiver does have a secret, it rejects connections using a `Gateway_` prefix
that cannot authenticate.

### 2. Add and verify a gateway

On instance A:

```text
gateway add site-b ws://instance-b-host:3300/ws
gateway status site-b
```

The local label is 2-40 alphanumeric characters. The status should report `connected` before you
rely on it.

### 3. Bridge and test a channel

```text
gateway bridge site-b general
```

On instance B:

```text
channel send general hello from B
```

Instance A receives `[from site-b/SomeUser] hello from B` in `#general`.

### 4. Make it bidirectional

Bridging is directional. On instance B, add the reverse gateway and bridge:

```text
gateway add site-a ws://instance-a-host:3300/ws
gateway bridge site-a general
```

## Cross-instance messaging

```text
gateway bridge <name> <channel>
gateway unbridge <name> <channel>
gateway send <name> <entity> <message>
gateway list
gateway status <name>
gateway remove <name>
```

The `gw` alias works for all subcommands.

## Persistence and behavior

Gateways and bridges persist in the database. On restart, Marina reconnects active gateways and
re-bridges their channels. The client retries after a temporary disconnect. Initial connections time
out after 15 seconds.

Only channel messages and direct tells cross this boundary. Entities, rooms, memory, tasks, and
Canvas data remain local. Messages that fail to relay are currently dropped; channel history is the
available audit record, not a guaranteed delivery queue.

## Security

- Use `wss://` in production and terminate TLS with a reverse proxy.
- Use a strong `GATEWAY_SECRET`; anyone who obtains the shared secret can impersonate a gateway.
- Gateway commands require `gateway.connect`; removal also applies ownership/operator checks.
- Channel and tell relay is throttled to one message per channel per second.
- Messages from `Gateway_` entities are not relayed again, preventing amplification loops.
- Monitor `gateway status` for connection age, relay counts, and stale activity.
- Gateway configuration is included in database exports. `GATEWAY_SECRET` remains environment-only.

Example nginx WebSocket termination:

```nginx
server {
    listen 443 ssl;
    server_name marina.example.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /ws {
        proxy_pass http://localhost:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Federation discovery manifests are a separate passive identity/trust registry. They do not replace
the gateway transport or authenticate it. See [Federation discovery](federation-discovery.md).
