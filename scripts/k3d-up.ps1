$ErrorActionPreference = "Stop"

$ClusterName = if ($env:CLUSTER_NAME) { $env:CLUSTER_NAME } else { "mcp-platform" }
$Namespace   = if ($env:NAMESPACE) { $env:NAMESPACE } else { "mcp-platform" }

Write-Host "==> Checking if k3d cluster '$ClusterName' exists..."
$existing = k3d cluster list -o json | ConvertFrom-Json | Where-Object { $_.name -eq $ClusterName }

if ($existing) {
    Write-Host "==> Cluster '$ClusterName' already exists. Ensuring it is started..."
    k3d cluster start $ClusterName
} else {
    Write-Host "==> Creating k3d cluster '$ClusterName' (Traefik enabled, ports 80/443 mapped)..."
    k3d cluster create $ClusterName `
        --agents 1 `
        --port "80:80@loadbalancer" `
        --port "443:443@loadbalancer" `
        --wait
}

Write-Host "==> Waiting for nodes to be Ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=120s

Write-Host "==> Waiting for Traefik Ingress controller in kube-system..."
for ($i = 0; $i -lt 30; $i++) {
    $deploys = kubectl get deployments -n kube-system -o name
    if ($deploys -match "deployment.apps/traefik") { break }
    Start-Sleep -Seconds 2
}
kubectl rollout status deployment/traefik -n kube-system --timeout=120s

Write-Host "==> Ensuring namespace '$Namespace' exists..."
$nsYaml = kubectl create namespace $Namespace --dry-run=client -o yaml
$nsYaml | kubectl apply -f -

Write-Host "==> Cluster '$ClusterName' is ready!"
kubectl get nodes -o wide
