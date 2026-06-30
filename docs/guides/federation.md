# Federation Setup Guide

> **Advanced feature.** Gateway federation links multiple Marina instances. Most deployments run a single instance and never need this — skip it unless you specifically intend to bridge separate instances. It requires a shared secret, open WebSocket ports between hosts, and the `gateway.connect` safety gate on each instance.

Connect two or more Marina instances so they can relay channel messages and direct tells across instance boundaries.

## Prerequisites

- Two or more Marina instances running (`bun run start` on each)
- `GATEWAY_SECRET` environment variable set to the **same value** on all instances
- Network access between instances (WebSocket port open, default 3300)
- `gateway.connect` safety gate on both instances to run gateway commands

## Setup

### 1. Set the shared secret

On **every** instance, set the same secret before starting:

```bash
export GATEWAY_SECRET="your-strong-secret-here"
bun run start
```

If `GATEWAY_SECRET` is not set, gateway auth messages are silently ignored (backward compatible), but any connection with a `Gateway_` prefix name will be rejected if the receiving instance has a secret set.

### 2. Add a gateway

On instance A, connect to instance B:

```
gateway add site-b ws://instance-b-host:3300/ws
```

The gateway name (`site-b`) is a local label -- alphanumeric, 2-40 characters. The URL must point to the remote instance's WebSocket endpoint (`/ws`).

### 3. Verify the connection

```
gateway status site-b
```

You should see `Status: connected`, the URL, and `Messages relayed: 0`.

### 4. Bridge a channel

```
gateway bridge site-b general
```

This joins the `general` channel on the remote instance. Any message sent to `#general` on instance B will now be relayed to `#general` on instance A.

### 5. Test it

On instance B:

```
channel send general hello from B
```

On instance A, the message appears in `#general` as `[from site-b/SomeUser] hello from B`.

### 6. Make it bidirectional

Bridging is one-directional. To relay messages both ways, repeat the setup on instance B:

```
# On instance B:
gateway add site-a ws://instance-a-host:3300/ws
gateway bridge site-a general
```

## Cross-Instance Messaging

### Channel bridging

```
gateway bridge <name> <channel>       # Start relaying a channel
gateway unbridge <name> <channel>     # Stop relaying a channel
```

### Direct tells

Send a message to a specific entity on the remote instance:

```
gateway send <name> <entity> <message>
```

Example:

```
gateway send site-b Alice Hey, check the research channel
```

### Management

```
gateway list                          # Show all gateways and their status
gateway status <name>                 # Detailed status for one gateway
gateway remove <name>                 # Disconnect and delete a gateway
```

The `gw` alias works for all subcommands (e.g., `gw list`, `gw status site-b`).

## Persistence

Gateways and bridges are persisted to the database. On restart, the engine automatically reconnects all active gateways and re-bridges their channels.

## Security

- **Always use `wss://` in production.** Terminate TLS with a reverse proxy (nginx, Caddy) in front of each instance.
- **Set a strong `GATEWAY_SECRET`.** This is a pre-shared key -- all instances in the federation must share it. Without it, anyone who can reach the WebSocket port can impersonate a gateway.
- **Gateway commands require the `gateway.connect` safety gate.** Only the creator or an operator with the relevant administrative authority can remove a gateway.
- **Rate limiting.** Channel relay is throttled to 1 message per channel per second. Tell relay has the same 1/sec limit. This prevents message floods across the federation.
- **Gateway loop prevention.** Messages from other `Gateway_` entities are never relayed, preventing cross-gateway amplification loops.

## Production Considerations

- **TLS termination.** Use a reverse proxy to upgrade `ws://` to `wss://`. The gateway URL would then be `wss://instance-b.example.com/ws`.
- **Monitoring.** `gateway status <name>` shows uptime, relay count, and bridged channels. Use this to verify health.
- **Auto-reconnect.** The gateway client reconnects automatically (5-second delay) if the remote instance goes down temporarily.
- **Connection timeout.** Initial connection attempts time out after 15 seconds.
- **No state sync.** Entities, rooms, memory, tasks, and canvas data are all instance-local. Only channel messages and direct tells cross the federation boundary.
- **Firewall rules.** Only the WebSocket port (default 3300) needs to be open between instances. No additional ports are required.

## Production Hardening

### TLS

Always use `wss://` in production. Terminate TLS at a reverse proxy (nginx, Caddy):

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

### Monitoring

- `gateway status <name>` shows message count and connection age
- Watch for increasing error counts or stale `lastMessageAt` timestamps
- Set alerts on `gateway list` output for disconnected gateways

### Dead Letters

Messages that fail to relay are currently dropped. For critical channels:

- Bridge both directions (A->B and B->A) for redundancy
- Use channel message history as audit trail: `channel history <name>`
- Consider writing a room agent that monitors relay health

### Rate Limiting

- Relay rate: 1 message per channel per second (built-in)
- No per-gateway bandwidth quotas -- monitor and add GATEWAY_SECRET rotation if abused
- Gateway loop prevention: messages from `Gateway_*` senders are not re-relayed

### Backup

- Gateway configs persist in the database -- included in `export` snapshots
- Bridge state auto-restores on restart
- GATEWAY_SECRET is env-only -- not exported (keep it in `.env`)
