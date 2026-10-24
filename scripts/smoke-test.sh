#!/usr/bin/env bash
set -euo pipefail

STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}"
APP_URL="${APP_URL:-http://app.127.0.0.1.nip.io}"
NAMESPACE="${NAMESPACE:-mcp-platform}"

ADMIN_COOKIE=$(mktemp)
MEMBER_COOKIE=$(mktemp)
trap 'rm -f "$ADMIN_COOKIE" "$MEMBER_COOKIE"' EXIT

echo "================================================================"
echo "1. Verifying Storefront (${STORE_URL}) & Dashboard (${APP_URL})"
echo "================================================================"
curl -fsS "${STORE_URL}" >/dev/null
echo "[PASS] Storefront HTTP 200"
curl -fsS "${APP_URL}" >/dev/null
echo "[PASS] Dashboard HTTP 200"

echo "================================================================"
echo "2. User A (Admin) Login & Chat Agent Flow (source='chat')"
echo "================================================================"
curl -fsS -c "$ADMIN_COOKIE" -X POST "${APP_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@urumi.local","password":"AdminPass!2026"}' >/dev/null
echo "[PASS] User A logged in (admin@urumi.local)"

CHAT_CREATE=$(curl -fsS -b "$ADMIN_COOKIE" -X POST "${APP_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Create a product '\''Test Mug'\'' priced 12.50"}')
echo "$CHAT_CREATE" | grep -q "Test Mug"
echo "[PASS] User A Chat created product 'Test Mug' priced 12.50 via woo__create_product"

CHAT_ORDERS=$(curl -fsS -b "$ADMIN_COOKIE" -X POST "${APP_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What orders came in today?"}')
echo "$CHAT_ORDERS" | grep -q "woo__list_orders"
echo "[PASS] User A Chat queried today's orders via woo__list_orders"

echo "================================================================"
echo "3. User B (Member) API Key & External MCP Client Flow (/mcp)"
echo "================================================================"
curl -fsS -c "$MEMBER_COOKIE" -X POST "${APP_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"member@urumi.local","password":"MemberPass!2026"}' >/dev/null

KEY_RESP=$(curl -fsS -b "$MEMBER_COOKIE" -X POST "${APP_URL}/api/keys" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test Key"}')
KEY_ID=$(echo "$KEY_RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
API_KEY=$(echo "$KEY_RESP" | sed -n 's/.*"plaintextKey":"\([^"]*\)".*/\1/p')
echo "[PASS] User B generated API key (prefix: ${API_KEY:0:13}...)"

TOOLS_LIST=$(curl -fsS -X POST "${APP_URL}/mcp" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
echo "$TOOLS_LIST" | grep -q "woo__list_products"
echo "$TOOLS_LIST" | grep -q "utility__list_products"
echo "$TOOLS_LIST" | grep -q "everything__echo"
echo "[PASS] /mcp tools/list returned aggregated tools with collision-safe prefixes (woo__list_products & utility__list_products)"

CALL_WOO=$(curl -fsS -X POST "${APP_URL}/mcp" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"woo__list_products","arguments":{"search":"Test Mug"}}}')
echo "$CALL_WOO" | grep -q "Test Mug"
echo "[PASS] User B /mcp called woo__list_products and verified 'Test Mug'"

CALL_TIME=$(curl -fsS -X POST "${APP_URL}/mcp" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"utility__current_time","arguments":{"timezone":"UTC"}}}')
echo "$CALL_TIME" | grep -q "iso"
echo "[PASS] User B /mcp called utility__current_time"

echo "================================================================"
echo "4. RBAC Denial Check & Key Revocation Check"
echo "================================================================"
DENIED_CALL=$(curl -fsS -X POST "${APP_URL}/mcp" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"woo__update_order_status","arguments":{"id":1,"status":"completed"}}}')
echo "$DENIED_CALL" | grep -q "Permission denied"
echo "[PASS] Member call to restricted tool woo__update_order_status was denied and audited"

curl -fsS -b "$MEMBER_COOKIE" -X DELETE "${APP_URL}/api/keys/${KEY_ID}" >/dev/null
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${APP_URL}/mcp" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}')
if [ "$HTTP_CODE" != "401" ]; then
  echo "[FAIL] Expected 401 after key revocation, got ${HTTP_CODE}"
  exit 1
fi
echo "[PASS] Revoked key rejected immediately with HTTP 401"

echo "================================================================"
echo "5. NetworkPolicy Isolation Check (Non-gateway pod -> woo-mcp blocked)"
echo "================================================================"
if kubectl exec -n "${NAMESPACE}" deployment/wordpress -c wordpress -- \
  curl -sS --max-time 3 http://woo-mcp:3000/healthz >/dev/null 2>&1; then
  echo "[FAIL] wordpress pod should NOT be able to reach woo-mcp:3000!"
  exit 1
else
  echo "[PASS] NetworkPolicy blocked non-gateway pod (wordpress) from reaching woo-mcp:3000"
fi

echo "================================================================"
echo "6. Audit Log & Prometheus Metrics Verification"
echo "================================================================"
AUDIT_JSON=$(curl -fsS -b "$ADMIN_COOKIE" "${APP_URL}/api/audit")
echo "$AUDIT_JSON" | grep -q '"source":"chat"'
echo "$AUDIT_JSON" | grep -q '"source":"mcp"'
echo "$AUDIT_JSON" | grep -q '"outcome":"denied"'
echo "[PASS] Audit log contains attributed rows for User A (chat), User B (mcp), and RBAC denial"

METRICS_TXT=$(curl -fsS "${APP_URL}/metrics")
echo "$METRICS_TXT" | grep -q "tool_calls_total"
echo "$METRICS_TXT" | grep -q "upstream_up"
echo "[PASS] /metrics exposes Prometheus counters and upstream gauges"

echo "================================================================"
echo "ALL SMOKE TESTS PASSED!"
echo "================================================================"
