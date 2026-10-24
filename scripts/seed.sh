#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-mcp-platform}"

echo "==> Checking WordPress & WooCommerce bootstrap status in namespace '${NAMESPACE}'..."
kubectl exec -n "${NAMESPACE}" deployment/wordpress -c wp-bootstrap -- \
  wp product list --user=1 --path=/var/www/html

echo "==> Checking Gateway registered upstream servers..."
kubectl logs -n "${NAMESPACE}" deployment/gateway --tail=15
