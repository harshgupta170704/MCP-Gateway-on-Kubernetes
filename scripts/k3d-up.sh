#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-mcp-platform}"
NAMESPACE="${NAMESPACE:-mcp-platform}"

echo "==> Checking if k3d cluster '${CLUSTER_NAME}' exists..."
if k3d cluster list | grep -q "^${CLUSTER_NAME} "; then
  echo "==> Cluster '${CLUSTER_NAME}' already exists. Starting if stopped..."
  k3d cluster start "${CLUSTER_NAME}" || true
else
  echo "==> Creating k3d cluster '${CLUSTER_NAME}' (Traefik enabled, ports 80/443 mapped)..."
  # k3s ships with Traefik ingress controller and embedded NetworkPolicy controller enabled by default.
  # Mapping host 80->80@loadbalancer and 443->443@loadbalancer allows store.127.0.0.1.nip.io and app.127.0.0.1.nip.io
  # to hit the cluster Ingress directly without port-forwarding.
  k3d cluster create "${CLUSTER_NAME}" \
    --agents 1 \
    --port "80:80@loadbalancer" \
    --port "443:443@loadbalancer" \
    --wait
fi

echo "==> Waiting for nodes to be Ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=120s

echo "==> Waiting for Traefik Ingress controller in kube-system..."
# Traefik is installed via a HelmChart job by k3s on startup; wait for deployment to appear
for i in {1..30}; do
  if kubectl get deployment traefik -n kube-system >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
kubectl rollout status deployment/traefik -n kube-system --timeout=120s

echo "==> Ensuring namespace '${NAMESPACE}' exists..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

echo "==> Cluster '${CLUSTER_NAME}' is ready!"
kubectl get nodes -o wide
