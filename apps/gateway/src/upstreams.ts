import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pool } from "./db.js";
import { decryptCredential } from "./crypto.js";

export interface Principal {
  userId: string;
  email: string;
  role: "admin" | "member";
  source: "mcp" | "chat";
}

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header_name: string | null;
  credential_encrypted: string | null;
  enabled: boolean;
  status: "Connected" | "Unreachable" | "Disabled";
  status_reason: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AggregatedTool {
  exposedName: string;
  serverSlug: string;
  serverName: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 15000;
const UPSTREAM_CALL_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 25000);
const HEALTH_TIMEOUT_MS = 6000;

const breakers = new Map<string, BreakerState>();

// In-memory Prometheus metric counters
export const metricsStore = {
  toolCallsTotal: new Map<string, number>(),
  toolDurationSecondsSum: new Map<string, number>(),
  toolDurationSecondsCount: new Map<string, number>(),
  upstreamUp: new Map<string, number>(),
};

function recordMetric(server: string, tool: string, outcome: string, source: string, durationMs: number) {
  const key = `server="${server}",tool="${tool}",outcome="${outcome}",source="${source}"`;
  metricsStore.toolCallsTotal.set(key, (metricsStore.toolCallsTotal.get(key) ?? 0) + 1);
  const durKey = `server="${server}",tool="${tool}"`;
  metricsStore.toolDurationSecondsSum.set(
    durKey,
    (metricsStore.toolDurationSecondsSum.get(durKey) ?? 0) + durationMs / 1000
  );
  metricsStore.toolDurationSecondsCount.set(
    durKey,
    (metricsStore.toolDurationSecondsCount.get(durKey) ?? 0) + 1
  );
}

/**
 * Formats an exposed tool name as `<server_slug>__<tool_name>`, sanitizing characters
 * to `[a-zA-Z0-9_-]` and capping at 64 characters for OpenAI/Anthropic/Gemini compatibility.
 */
export function buildExposedToolName(slug: string, toolName: string): string {
  const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const combined = `${cleanSlug}__${cleanTool}`;
  if (combined.length <= 64) {
    return combined;
  }
  const suffix = crypto.createHash("sha256").update(combined).digest("hex").slice(0, 6);
  return `${combined.slice(0, 57)}_${suffix}`;
}

export function parseExposedToolName(exposedName: string): { slug: string; toolName: string } | null {
  const idx = exposedName.indexOf("__");
  if (idx <= 0 || idx >= exposedName.length - 2) return null;
  return {
    slug: exposedName.slice(0, idx),
    toolName: exposedName.slice(idx + 2),
  };
}

function buildAuthHeaders(server: ServerRow): Record<string, string> {
  if (server.auth_type === "none" || !server.credential_encrypted) {
    return {};
  }
  const secret = decryptCredential(server.credential_encrypted);
  if (!secret) return {};
  if (server.auth_type === "bearer") {
    return { Authorization: `Bearer ${secret}` };
  }
  const headerName = server.auth_header_name?.trim() || "X-API-Key";
  return { [headerName]: secret };
}

async function withUpstreamClient<T>(
  server: ServerRow,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const headers = buildAuthHeaders(server);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    },
  });
  const client = new Client({
    name: "mcp-gateway-client",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.close().catch(() => {});
  }
}

function isCircuitOpen(serverId: string): boolean {
  const st = breakers.get(serverId);
  if (!st || !st.openedAt) return false;
  if (Date.now() - st.openedAt >= CIRCUIT_COOLDOWN_MS) {
    // Half-open: allow probe request
    return false;
  }
  return true;
}

function recordSuccess(serverId: string) {
  breakers.set(serverId, { failures: 0, openedAt: null });
}

function recordFailure(serverId: string) {
  const prev = breakers.get(serverId) ?? { failures: 0, openedAt: null };
  const failures = prev.failures + 1;
  breakers.set(serverId, {
    failures,
    openedAt: failures >= CIRCUIT_THRESHOLD ? Date.now() : prev.openedAt,
  });
}

export async function probeSingleServer(server: ServerRow): Promise<{
  status: "Connected" | "Unreachable" | "Disabled";
  reason: string | null;
  toolsCount: number;
}> {
  if (!server.enabled) {
    await pool.query(
      `UPDATE mcp_servers
       SET status = 'Disabled', status_reason = 'Disabled by administrator', last_checked_at = NOW()
       WHERE id = $1`,
      [server.id]
    );
    metricsStore.upstreamUp.set(server.slug, 0);
    return { status: "Disabled", reason: "Disabled by administrator", toolsCount: 0 };
  }

  try {
    const listResp = await withUpstreamClient(server, HEALTH_TIMEOUT_MS, (client) =>
      client.listTools()
    );
    const tools = listResp.tools ?? [];

    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("DELETE FROM tool_cache WHERE server_id = $1", [server.id]);
      for (const t of tools) {
        await dbClient.query(
          `INSERT INTO tool_cache (server_id, tool_name, definition_json, fetched_at)
           VALUES ($1, $2, $3, NOW())`,
          [server.id, t.name, JSON.stringify(t)]
        );
      }
      await dbClient.query(
        `UPDATE mcp_servers
         SET status = 'Connected', status_reason = NULL, last_checked_at = NOW()
         WHERE id = $1`,
        [server.id]
      );
      await dbClient.query("COMMIT");
    } catch (e) {
      await dbClient.query("ROLLBACK");
      throw e;
    } finally {
      dbClient.release();
    }

    recordSuccess(server.id);
    metricsStore.upstreamUp.set(server.slug, 1);
    return { status: "Connected", reason: null, toolsCount: tools.length };
  } catch (err) {
    recordFailure(server.id);
    metricsStore.upstreamUp.set(server.slug, 0);
    const rawMsg = err instanceof Error ? err.message : String(err);
    const reason = rawMsg.slice(0, 180);
    await pool.query(
      `UPDATE mcp_servers
       SET status = 'Unreachable', status_reason = $2, last_checked_at = NOW()
       WHERE id = $1`,
      [server.id, reason]
    );
    return { status: "Unreachable", reason, toolsCount: 0 };
  }
}

/**
 * Checks all registered servers concurrently using Promise.allSettled so one
 * slow or dead upstream never blocks health updates for the rest.
 */
export async function refreshAllServers(): Promise<void> {
  const { rows } = await pool.query<ServerRow>("SELECT * FROM mcp_servers ORDER BY created_at ASC");
  await Promise.allSettled(rows.map((srv) => probeSingleServer(srv)));
}

export async function checkToolPermission(
  role: "admin" | "member",
  serverSlug: string,
  toolName: string
): Promise<boolean> {
  if (role === "admin") return true;
  const { rows } = await pool.query<{ server_slug: string; tool_name: string; effect: "allow" | "deny" }>(
    `SELECT server_slug, tool_name, effect
     FROM tool_permissions
     WHERE role = $1
       AND (server_slug = $2 OR server_slug = '*')
       AND (tool_name = $3 OR tool_name = '*')`,
    [role, serverSlug, toolName]
  );

  // Explicit deny always wins over wildcard allow
  if (rows.some((r) => r.effect === "deny")) {
    return false;
  }
  return rows.some((r) => r.effect === "allow");
}

export async function getAggregatedToolsForUser(principal: Principal): Promise<AggregatedTool[]> {
  const { rows } = await pool.query<{
    slug: string;
    name: string;
    tool_name: string;
    definition_json: any;
  }>(
    `SELECT s.slug, s.name, tc.tool_name, tc.definition_json
     FROM mcp_servers s
     JOIN tool_cache tc ON tc.server_id = s.id
     WHERE s.enabled = TRUE AND s.status = 'Connected'
     ORDER BY s.slug ASC, tc.tool_name ASC`
  );

  const result: AggregatedTool[] = [];
  for (const row of rows) {
    const allowed = await checkToolPermission(principal.role, row.slug, row.tool_name);
    if (!allowed) continue;
    const def = row.definition_json ?? {};
    result.push({
      exposedName: buildExposedToolName(row.slug, row.tool_name),
      serverSlug: row.slug,
      serverName: row.name,
      originalName: row.tool_name,
      description: `[${row.name}] ${def.description ?? ""}`.trim(),
      inputSchema: def.inputSchema ?? { type: "object", properties: {} },
    });
  }
  return result;
}

export async function executeRoutedToolCall(
  principal: Principal,
  exposedToolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; durationMs: number }> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const parsed = parseExposedToolName(exposedToolName);

  let serverId: string | null = null;
  let serverSlug = parsed?.slug ?? "unknown";
  let toolName = parsed?.toolName ?? exposedToolName;
  let outcome: "success" | "error" | "timeout" | "denied" = "error";
  let errorMessage: string | null = null;

  try {
    if (!parsed) {
      errorMessage = `Invalid namespaced tool name '${exposedToolName}'. Expected '<server_slug>__<tool_name>'.`;
      return {
        isError: true,
        durationMs: Date.now() - startedAt,
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
      };
    }

    const srvRes = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE slug = $1", [
      parsed.slug,
    ]);
    const server = srvRes.rows[0];

    if (!server) {
      errorMessage = `Upstream server '${parsed.slug}' does not exist`;
      return {
        isError: true,
        durationMs: Date.now() - startedAt,
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
      };
    }

    serverId = server.id;

    // Resolve truncated tool names via tool_cache if needed
    const cacheRes = await pool.query<{ tool_name: string }>(
      "SELECT tool_name FROM tool_cache WHERE server_id = $1",
      [server.id]
    );
    const matched = cacheRes.rows.find(
      (r) => buildExposedToolName(server.slug, r.tool_name) === exposedToolName
    );
    if (matched) {
      toolName = matched.tool_name;
    }

    const allowed = await checkToolPermission(principal.role, server.slug, toolName);
    if (!allowed) {
      outcome = "denied";
      errorMessage = `Permission denied: role '${principal.role}' is not allowed to invoke '${server.slug}__${toolName}'`;
      return {
        isError: true,
        durationMs: Date.now() - startedAt,
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
      };
    }

    if (!server.enabled) {
      outcome = "error";
      errorMessage = `Upstream server '${server.slug}' is currently disabled`;
      return {
        isError: true,
        durationMs: Date.now() - startedAt,
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
      };
    }

    if (isCircuitOpen(server.id)) {
      outcome = "error";
      errorMessage = `Circuit breaker open for upstream '${server.slug}' after repeated failures`;
      return {
        isError: true,
        durationMs: Date.now() - startedAt,
        content: [{ type: "text", text: JSON.stringify({ error: errorMessage }) }],
      };
    }

    const upstreamResult = await withUpstreamClient(server, UPSTREAM_CALL_TIMEOUT_MS, (client) =>
      client.callTool({
        name: toolName,
        arguments: args,
      })
    );

    recordSuccess(server.id);
    if (server.status !== "Connected") {
      pool
        .query("UPDATE mcp_servers SET status = 'Connected', status_reason = NULL WHERE id = $1", [
          server.id,
        ])
        .catch(() => {});
    }

    const isErr = Boolean(upstreamResult.isError);
    outcome = isErr ? "error" : "success";

    const rawContent = Array.isArray(upstreamResult.content) ? upstreamResult.content : [];
    const normalized = rawContent.map((item: any) => {
      const txt = typeof item?.text === "string" ? item.text : JSON.stringify(item);
      // Cap individual tool output at 32KB to protect downstream context windows
      const capped = txt.length > 32768 ? `${txt.slice(0, 32768)}\n...[truncated]` : txt;
      return { type: "text" as const, text: capped };
    });

    if (isErr) {
      errorMessage = normalized[0]?.text?.slice(0, 200) ?? "Upstream returned tool error";
    }

    return {
      isError: isErr,
      durationMs: Date.now() - startedAt,
      content: normalized.length > 0 ? normalized : [{ type: "text", text: "{}" }],
    };
  } catch (err) {
    if (serverId) {
      recordFailure(serverId);
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 180);
      pool
        .query(
          "UPDATE mcp_servers SET status = 'Unreachable', status_reason = $2, last_checked_at = NOW() WHERE id = $1",
          [serverId, reason]
        )
        .catch(() => {});
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      rawMsg.toLowerCase().includes("timeout") || rawMsg.toLowerCase().includes("aborted");
    outcome = isTimeout ? "timeout" : "error";
    errorMessage = rawMsg.slice(0, 240);

    return {
      isError: true,
      durationMs: Date.now() - startedAt,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Upstream '${serverSlug}' call failed (${outcome}): ${errorMessage}`,
          }),
        },
      ],
    };
  } finally {
    const durationMs = Date.now() - startedAt;
    recordMetric(serverSlug, toolName, outcome, principal.source, durationMs);
    pool
      .query(
        `INSERT INTO audit_log
          (user_id, user_email, source, server_id, server_slug, tool_name, duration_ms, outcome, error_message, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          principal.userId,
          principal.email,
          principal.source,
          serverId,
          serverSlug,
          toolName,
          durationMs,
          outcome,
          errorMessage,
          requestId,
        ]
      )
      .catch((auditErr) => {
        console.error("[gateway] failed to write audit_log row:", auditErr);
      });
  }
}
