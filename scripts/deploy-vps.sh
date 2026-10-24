#!/usr/bin/env bash
set -euo pipefail

# One-command k3s VPS deployment script.
# Run directly on a fresh Ubuntu/Debian VPS (or via SSH):
#   VPS_IP=$(curl -s ifconfig.me) ./scripts/deploy-vps.sh

VPS_IP="${VPS_IP:-$(curl -fsS https://ifconfig.me)}"
STORE_HOST="${STORE_HOST:-store.${VPS_IP}.nip.io}"
APP_HOST="${APP_HOST:-app.${VPS_IP}.nip.io}"
NAMESPACE="${NAMESPACE:-mcp-platform}"

echo "==> Target VPS IP: ${VPS_IP}"
echo "==> Storefront Host: http://${STORE_HOST}"
echo "==> Gateway/Dashboard Host: http://${APP_HOST}"

if ! command -v k3s >/dev/null 2>&1; then
  echo "==> Installing k3s (includes Traefik Ingress, ServiceLB, local-path storage, and NetworkPolicy controller)..."
  curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644
fi

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

if ! command -v helm >/dev/null 2>&1; then
  echo "==> Installing Helm..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker for building images..."
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Building platform images and importing into k3s containerd..."
for entry in "woo-mcp:./apps/woo-mcp" "sample-mcp:./apps/sample-mcp" "gateway:./apps/gateway" "dashboard:./apps/dashboard"; do
  name="${entry%%:*}"
  dir="${entry#*:}"
  docker build -t "mcp-platform/${name}:local" "${dir}"
  docker save "mcp-platform/${name}:local" | sudo k3s ctr images import -
done
docker tag "mcp-platform/sample-mcp:local" "mcp-platform/everything-mcp:local"
docker save "mcp-platform/everything-mcp:local" | sudo k3s ctr images import -

echo "==> Deploying mcp-platform Helm chart on k3s..."
helm upgrade --install mcp-platform ./charts/mcp-platform \
  -n "${NAMESPACE}" --create-namespace \
  -f ./charts/mcp-platform/values-local.yaml \
  --set ingress.storeHost="${STORE_HOST}" \
  --set ingress.appHost="${APP_HOST}" \
  --wait --timeout 5m

echo "================================================================"
echo "VPS Deployment Complete!"
echo "Storefront URL: http://${STORE_HOST}"
echo "Dashboard URL:  http://${APP_HOST}"
echo "MCP Endpoint:   http://${APP_HOST}/mcp"
echo "================================================================"
