$ErrorActionPreference = "Stop"

$ClusterName = if ($env:CLUSTER_NAME) { $env:CLUSTER_NAME } else { "mcp-platform" }
$Tag         = if ($env:TAG) { $env:TAG } else { "local" }

Write-Host "==> Building Docker images..."
docker build -t "mcp-platform/woo-mcp:$Tag" ./apps/woo-mcp
if ($LASTEXITCODE -ne 0) { throw "woo-mcp build failed" }

docker build -t "mcp-platform/sample-mcp:$Tag" ./apps/sample-mcp
if ($LASTEXITCODE -ne 0) { throw "sample-mcp build failed" }

docker tag "mcp-platform/sample-mcp:$Tag" "mcp-platform/everything-mcp:$Tag"

docker build -t "mcp-platform/gateway:$Tag" ./apps/gateway
if ($LASTEXITCODE -ne 0) { throw "gateway build failed" }

docker build -t "mcp-platform/dashboard:$Tag" ./apps/dashboard
if ($LASTEXITCODE -ne 0) { throw "dashboard build failed" }

Write-Host "==> Importing images into k3d cluster '$ClusterName'..."
k3d image import `
  "mcp-platform/woo-mcp:$Tag" `
  "mcp-platform/sample-mcp:$Tag" `
  "mcp-platform/everything-mcp:$Tag" `
  "mcp-platform/gateway:$Tag" `
  "mcp-platform/dashboard:$Tag" `
  -c $ClusterName
if ($LASTEXITCODE -ne 0) { throw "k3d image import failed" }

Write-Host "==> All images built and loaded into k3d ($ClusterName)."
