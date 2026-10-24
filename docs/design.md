# System Design & Architecture Tradeoffs

## 1. High-Level Topology

```text
                             Traefik Ingress Controller (kube-system)
                     store.<domain>                           app.<domain>
                           |                                       |
                           | /                                     |-----------------------+
                           v                                       | /                     | /api, /mcp, /metrics
                  +-----------------+                     +--------v--------+     +--------v--------+
                  |    WordPress    |                     |    Dashboard    |     |     Gateway     |
                  |  + WooCommerce  |                     | (Nginx :8080)   |     | (Express :4000) |
                  +--------+--------+                     +-----------------+     +--+-----+-----+--+
                           |                                                         |     |     |
         +-----------------+-----------------+                       +---------------+     |     +---------------+
         | :3306                             | :80 (ClusterIP)       | :5432               |                     |
+--------v--------+                 +--------+--------+     +--------v--------+            |                     |
|     MariaDB     |                 |     woo-mcp     |     |    Postgres     |            |                     |
|  (StatefulSet)  |                 | (ClusterIP:3000)|     |  (StatefulSet)  |            |                     |
+-----------------+                 +--------+--------+     +-----------------+            |                     |
                                             ^                                             |                     |
                                             |-------------- MCP / Streamable HTTP --------+                     |
                                                                                           v                     v
                                                                                  +-----------------+   +-----------------+
                                                                                  |   sample-mcp    |   | everything-mcp  |
                                                                                  | (ClusterIP:3000)|   | (ClusterIP:3001)|
                                                                                  +-----------------+   +-----------------+
```

### Public vs. Cluster-Internal Surface
- **Public (Ingress):** Only two hostnames are exposed outside the cluster:
  - `store.<domain>` routes `/` to the `wordpress` Service (`:80`).
  - `app.<domain>` routes `/api`, `/mcp`, and `/metrics` to `gateway` (`:4000`), and `/` to `dashboard` (`:80` -> `:8080`). Because `/api` and `/mcp` share the same origin as the React SPA, session cookies work with `SameSite=Lax` and require zero wildcard CORS headers.
- **Internal (`ClusterIP` + `NetworkPolicy`):**
  - `woo-mcp`, `sample-mcp`, `everything-mcp`, `mariadb`, and `postgres` have no Ingress rules and are enforced at the CNI layer by `charts/mcp-platform/templates/60-networkpolicies.yaml`.
  - The `allow-only-gateway-to-upstreams` policy selects all pods labeled `mcp.platform/role: upstream-mcp` and permits TCP ingress exclusively from pods labeled `app.kubernetes.io/component: gateway`.

---

## 2. Key Engineering Decisions & Tradeoffs

### 2.1 Why `woo-mcp` Uses WooCommerce REST API v3 Instead of Direct SQL or WP-CLI
- **Business Logic & Hooks:** Creating a product or updating an order status in WooCommerce updates multiple tables (`wp_posts`, `wp_postmeta`, `wc_product_meta_lookup`, `wc_orders`, stock ledger, and action scheduler hooks). Writing directly to MariaDB bypasses validation, tax/total calculation, and webhook firing.
- **Security Boundary:** Running `wp-cli` per tool call would require either mounting the WordPress PVC into `woo-mcp` (impossible across nodes with `ReadWriteOnce`) or granting `woo-mcp` Kubernetes RBAC to `pods/exec` into the WordPress container. Calling `/wp-json/wc/v3` over the internal `wordpress` ClusterIP Service keeps `woo-mcp` stateless, non-root (`uid 10001`), and decoupled from the PHP runtime.

### 2.2 Solving WooCommerce REST Auth Over In-Cluster HTTP
- **The Problem:** WooCommerce REST API v3 only permits HTTP Basic Auth (`consumer_key:consumer_secret`) when WordPress detects an HTTPS request (`is_ssl() === true`), expecting OAuth 1.0a over plain HTTP. Additionally, calling `http://wordpress` directly without the public `Host` header triggers a 301 canonical redirect to `http://store.<domain>`.
- **The Solution:**
  1. `woo-mcp` connects to `http://wordpress/wp-json/wc/v3/...` and sets `Host: <storeHost>` and `X-Forwarded-Proto: https`.
  2. WordPress's `WORDPRESS_CONFIG_EXTRA` inspects `$_SERVER['HTTP_X_FORWARDED_PROTO']` and sets `$_SERVER['HTTPS'] = 'on'` before `wp-settings.php` loads.
  3. Traffic remains entirely inside the cluster network (protected by `allow-woo-mcp-to-wordpress` NetworkPolicy), while WordPress treats the request as TLS-terminated and accepts standard Basic Auth without redirect loops.

### 2.3 Idempotent WordPress & WooCommerce Bootstrap Placement
- **Why a Sidecar Instead of a Pre-Install Job:** A Helm `pre-install` Job runs before MariaDB is ready and before the `wordpress:apache` entrypoint copies WordPress core into `/var/www/html`. Furthermore, a separate Job pod cannot reliably mount a `ReadWriteOnce` PVC already attached to the WordPress pod.
- **How It Works:** The `wp-bootstrap` container runs alongside `wordpress` in the same Pod (sharing the `wordpress-data` PVC as `uid 33` `www-data`). It waits for `wp-config.php` and `wp db check`, runs `wp core install` if needed, installs WooCommerce `9.3.3`, sets pretty permalinks (`/%postname%/`), enables Cash on Delivery (`woocommerce_cod_settings`), inserts the hashed REST API key (`wc_api_hash($ck)`) into `wp_woocommerce_api_keys` idempotently, seeds 3 products and 1 COD order if the catalog is empty, and touches `/var/www/html/.bootstrap-complete` (checked by the pod's `readinessProbe`).

### 2.4 Stateless Streamable HTTP (`/mcp`)
- Both `woo-mcp`, `sample-mcp`, `everything-mcp`, and the `gateway` `/mcp` endpoint run `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`.
- **Benefits:**
  - Any gateway replica can serve any `initialize`, `tools/list`, or `tools/call` request without sticky load-balancing or Redis session affinity.
  - Pod restarts or rolling upgrades never orphan active client sessions.
  - Authentication and key revocation (`revoked_at IS NULL`) are verified on every single HTTP request.
- **Tradeoff:** Because there is no long-lived GET SSE stream open from the client, the gateway cannot push `notifications/tools/list_changed` events when an administrator disables an upstream server. Clients see the updated toolset on their next `tools/list` call.

### 2.5 Tool Namespacing & Collision Resolution (`<server_slug>__<tool_name>`)
- Every upstream server is assigned a unique slug (`^[a-z0-9-]{2,24}$`, e.g., `woo`, `utility`, `everything`).
- Tools are exposed as `<slug>__<tool_name>` (for example, `woo__list_products` vs. `utility__list_products`).
- If the combined identifier exceeds 64 characters (the limit enforced by OpenAI/Gemini/Anthropic tool-calling APIs), `buildExposedToolName` truncates the prefix to 57 characters and appends a deterministic 6-character SHA-256 suffix.
- On `tools/call`, the gateway splits on the first `__`, resolves the upstream server by slug, verifies role permissions, and forwards the unprefixed tool name to the target upstream.

### 2.6 Failure Isolation, Timeouts, and Circuit Breaker
- **Health Probes:** `refreshAllServers()` probes all registered upstreams in parallel using `Promise.allSettled` with an independent 6-second `AbortSignal.timeout`. One hung or unreachable upstream never blocks health updates or `tools/list` for healthy servers.
- **Tool Cache & Availability:** Discovered tool schemas are cached in Postgres (`tool_cache`). When an upstream becomes `Unreachable` or `Disabled`, its tools are immediately omitted from `/mcp` `tools/list` (so LLMs do not attempt to call dead tools) while still displayed in the Dashboard UI with an unavailable badge and failure reason.
- **Circuit Breaker:** After 3 consecutive failures against an upstream, the gateway opens the per-server circuit breaker for 15 seconds, failing fast without waiting on TCP timeouts, then transitions to half-open on the next probe.

### 2.7 Why Postgres Instead of SQLite
- SQLite locks the database file on writes and requires a single `ReadWriteOnce` volume, preventing the gateway Deployment from scaling past 1 replica (`replicas: 2` in `values-prod.yaml`).
- Postgres supports concurrent writes for high-throughput `audit_log` insertions, `tool_cache` updates, and multi-replica horizontal scaling.

### 2.8 Local (`values-local.yaml`) vs. Production (`values-prod.yaml`)
- Only the Helm values file changes between `k3d` and a production `k3s` VPS:
  - **Domains & TLS:** `*.127.0.0.1.nip.io` (HTTP) locally vs. `store.example.com` / `app.example.com` with `cert-manager.io/cluster-issuer: letsencrypt-prod` and TLS secret blocks in production.
  - **Images:** `mcp-platform/*:local` (`IfNotPresent`) imported via `k3d image import` vs. versioned GHCR images (`Always`).
  - **Secrets:** Auto-generated and preserved via Helm `lookup` locally vs. pre-created `existingSecret: mcp-platform-secrets` (managed via SealedSecrets / ExternalSecrets) in production.
