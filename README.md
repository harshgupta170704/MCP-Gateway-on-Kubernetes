# WooCommerce Hosting + Team MCP Gateway on Kubernetes

A multi-layer Kubernetes platform packaged as a single Helm chart (`charts/mcp-platform`):
1. **WooCommerce Storefront** (`store.<domain>`) — Official WordPress + MariaDB StatefulSet with idempotent WP-CLI bootstrap.
2. **Self-Written WooCommerce MCP Server** (`apps/woo-mcp`) — Internal-only (`ClusterIP`) Streamable HTTP MCP server talking to WooCommerce REST API v3.
3. **Team MCP Gateway** (`apps/gateway`) — Multi-user gateway (`app.<domain>/mcp` and `/api`) with Postgres persistence, AES-256-GCM encrypted upstream credentials, SHA-256 hashed API keys, circuit-breaking upstream connection manager, `<server_slug>__<tool_name>` namespace routing, and full audit logging.
4. **React Dashboard & Chat Agent** (`apps/dashboard` + `apps/gateway`) — Server registry, team invites, API key management, audit viewer, and an SSE chat agent executing tools through the gateway as the logged-in user.

## Repository Layout

```text
/
├── README.md
├── docs/
│   ├── design.md
│   ├── threat-model.md
│   └── demo-script.md
├── apps/
│   ├── woo-mcp/            # MCP server for WooCommerce
│   ├── gateway/            # Backend: REST + MCP server + MCP clients + chat
│   ├── dashboard/          # React + Vite + Tailwind UI
│   └── sample-mcp/         # 3rd upstream MCP server (collision + utility demo)
├── charts/
│   └── mcp-platform/       # Umbrella Helm chart (values-local.yaml / values-prod.yaml)
└── scripts/                # Cluster setup, image build/import, seed, smoke tests
```

## Quick Start (Phase 0 Verification)

```bash
# 1. Start k3d cluster with ports 80/443 mapped to Traefik
./scripts/k3d-up.sh   # or .\scripts\k3d-up.ps1 on Windows PowerShell

# 2. Deploy the Helm chart with local values
helm upgrade --install mcp-platform ./charts/mcp-platform \
  -n mcp-platform --create-namespace \
  -f ./charts/mcp-platform/values-local.yaml \
  --wait

# 3. Verify Ingress routing via nip.io
curl -i http://store.127.0.0.1.nip.io
curl -i http://app.127.0.0.1.nip.io
```
