#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-mcp-platform}"
TAG="${TAG:-local}"

echo "==> Building Docker images..."
docker build -t "mcp-platform/woo-mcp:${TAG}" ./apps/woo-mcp
docker build -t "mcp-platform/sample-mcp:${TAG}" ./apps/sample-mcp
docker tag "mcp-platform/sample-mcp:${TAG}" "mcp-platform/everything-mcp:${TAG}"
docker build -t "mcp-platform/gateway:${TAG}" ./apps/gateway
docker build -t "mcp-platform/dashboard:${TAG}" ./apps/dashboard

echo "==> Importing images into k3d cluster '${CLUSTER_NAME}'..."
k3d image import \
  "mcp-platform/woo-mcp:${TAG}" \
  "mcp-platform/sample-mcp:${TAG}" \
  "mcp-platform/everything-mcp:${TAG}" \
  "mcp-platform/gateway:${TAG}" \
  "mcp-platform/dashboard:${TAG}" \
  -c "${CLUSTER_NAME}"

echo "==> All images built and loaded into k3d (${CLUSTER_NAME})."
