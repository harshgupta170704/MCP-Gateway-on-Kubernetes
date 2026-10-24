{{/*
Common labels applied to all resources in mcp-platform
*/}}
{{- define "mcp-platform.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: mcp-platform
{{- end }}

{{/*
Secret name helper: uses existingSecret if provided, otherwise the chart-managed secret
*/}}
{{- define "mcp-platform.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{ .Release.Name }}-secrets
{{- end -}}
{{- end }}

{{/*
Store base URL helper (switches http/https based on ingress.tls.enabled)
*/}}
{{- define "mcp-platform.storeUrl" -}}
{{- if .Values.ingress.tls.enabled -}}
https://{{ .Values.ingress.storeHost }}
{{- else -}}
http://{{ .Values.ingress.storeHost }}
{{- end -}}
{{- end }}

{{/*
App base URL helper (switches http/https based on ingress.tls.enabled)
*/}}
{{- define "mcp-platform.appUrl" -}}
{{- if .Values.ingress.tls.enabled -}}
https://{{ .Values.ingress.appHost }}
{{- else -}}
http://{{ .Values.ingress.appHost }}
{{- end -}}
{{- end }}
