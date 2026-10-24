# Live Demo & Interview Walkthrough Script (12–15 Minutes)

## Part 1: Architecture Overview (2 min)
1. Open `README.md` and `docs/design.md`.
2. Point out the 4 layers:
   - **Store Layer:** Official WordPress + MariaDB StatefulSet (`store.127.0.0.1.nip.io`) bootstrapped idempotently via a `wp-cli` sidecar (`11-wordpress.yaml`).
   - **WooCommerce MCP Server (`apps/woo-mcp`):** Stateless Streamable HTTP MCP server (`ClusterIP` only) talking to WooCommerce REST API v3 over internal HTTP with `Host: store.127.0.0.1.nip.io` and `X-Forwarded-Proto: https`.
   - **Team MCP Gateway (`apps/gateway`):** Aggregates `woo-mcp`, `sample-mcp` (`utility__*`), and `everything-mcp` (`everything__*`) behind a single `/mcp` endpoint with AES-256-GCM encrypted upstream credentials, SHA-256 hashed API keys, circuit breaking, RBAC, and Postgres audit logging.
   - **Dashboard & Chat Agent (`apps/dashboard`):** Same-origin React SPA (`app.127.0.0.1.nip.io`) + SSE chat agent executing tools through `/mcp` as the logged-in user.

---

## Part 2: Kubernetes & NetworkPolicy Tour (3 min)
Run in terminal:
```bash
kubectl get pods,svc,ingress,pvc,networkpolicy -n mcp-platform
```
Highlight:
- Only `store-ingress` and `app-ingress` are exposed via Traefik.
- `woo-mcp`, `sample-mcp`, `everything-mcp`, `mariadb`, and `postgres` are `ClusterIP` only.
- Prove NetworkPolicy isolation live:
  ```bash
  # From wordpress pod -> woo-mcp:3000 (Blocked by allow-only-gateway-to-upstreams NetworkPolicy)
  kubectl exec -n mcp-platform deployment/wordpress -c wordpress -- \
    curl -sS --max-time 3 http://woo-mcp:3000/healthz
  ```

---

## Part 3: Definition of Done Live Flow with Two Users (5 min)

### Step A — Storefront & User A (Admin) Chat Flow
1. Open `http://store.127.0.0.1.nip.io` to show the seeded WooCommerce catalog.
2. Open `http://app.127.0.0.1.nip.io` and sign in as **User A** (`admin@urumi.local` / `AdminPass!2026`).
3. In **Upstream Servers**, expand `woo` and `utility` to show the collision resolution (`woo__list_products` vs. `utility__list_products`).
4. Switch to **Chat Agent**:
   - Click `+ Create 'Test Mug' ($12.50)` (or type `"Create a product 'Test Mug' priced 12.50"`).
   - Expand the `woo__create_product` tool call card to show the JSON arguments, latency, and new product ID.
   - Refresh `http://store.127.0.0.1.nip.io/?post_type=product` to show **Test Mug** live on the storefront.
5. Ask `"What orders came in today?"` in Chat and expand the `woo__list_orders` tool trace showing the ISO date filter (`after: YYYY-MM-DDT00:00:00`).

### Step B — User B (Member) External MCP Client Flow
1. Sign out and sign in as **User B** (`member@urumi.local` / `MemberPass!2026`).
2. Go to **API Keys**, click **Generate API Key**, and copy the `mcpg_<prefix>_<secret>` key (plus show the ready-to-paste Claude Code and Cursor snippets).
3. In terminal (or MCP Inspector), call `/mcp` as User B across multiple upstreams:
   ```bash
   export MCP_KEY="mcpg_..."

   # 1. List aggregated tools
   curl -s http://app.127.0.0.1.nip.io/mcp \
     -H "Authorization: Bearer $MCP_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

   # 2. Call woo__list_products and utility__current_time
   curl -s http://app.127.0.0.1.nip.io/mcp \
     -H "Authorization: Bearer $MCP_KEY" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"woo__list_products","arguments":{"search":"Test Mug"}}}'
   ```

---

## Part 4: Failure & Security Demos (2 min)
1. **Revoke User B's Key:** Click `Revoke` in the API Keys table and re-run the `curl` command — show immediate `HTTP 401`.
2. **Disable Upstream Server:** Sign in as Admin, click `Disable` on `everything`, and verify `everything__*` tools vanish from `tools/list`.
3. **Kill `woo-mcp` Pod:**
   ```bash
   kubectl delete pod -n mcp-platform -l app.kubernetes.io/component=woo-mcp
   ```
   Show that `utility__*` and `everything__*` continue working without interruption and `woo-mcp` automatically recovers when the Deployment replica becomes Ready.
4. **Audit Log:** Open the **Audit Log** tab and filter by `source=chat`, `source=mcp`, and `outcome=denied`.

---

## Part 5: Helm Upgrade & Rollback Demo (2 min)
```bash
# Inspect release history
helm history mcp-platform -n mcp-platform

# Perform a deliberate bad image tag upgrade and watch atomic rollback, or manual rollback:
helm rollback mcp-platform -n mcp-platform
```
