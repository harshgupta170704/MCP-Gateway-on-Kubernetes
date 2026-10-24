import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDatabase, pool } from "./db.js";
import {
  encryptCredential,
  generateApiKey,
  hashPassword,
  hashToken,
  safeCompareHex,
  signToken,
  validateUpstreamUrl,
  verifyPassword,
  verifyToken,
} from "./crypto.js";
import {
  buildExposedToolName,
  executeRoutedToolCall,
  getAggregatedToolsForUser,
  metricsStore,
  Principal,
  probeSingleServer,
  refreshAllServers,
  ServerRow,
} from "./upstreams.js";
import { ChatMessage, runChatTurn } from "./chat.js";

const PORT = Number(process.env.PORT ?? 4000);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 20000);
const ALLOWED_INTERNAL_SUFFIXES = (
  process.env.ALLOWED_INTERNAL_SUFFIXES ?? ".svc,.svc.cluster.local"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SESSION_COOKIE = "mcpg_session";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: "admin" | "member";
      };
      mcpPrincipal?: Principal;
    }
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function sanitizeServerForResponse(row: ServerRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    authType: row.auth_type,
    authHeaderName: row.auth_header_name,
    hasCredential: Boolean(row.credential_encrypted),
    enabled: row.enabled,
    status: row.status,
    statusReason: row.status_reason,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token =
    req.cookies?.[SESSION_COOKIE] ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined);

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const verified = verifyToken(token, "session");
  if (!verified) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: "admin" | "member";
    status: string;
  }>("SELECT id, email, name, role, status FROM users WHERE id = $1", [verified.sub]);

  const user = rows[0];
  if (!user || user.status !== "active") {
    res.status(401).json({ error: "Account not active" });
    return;
  }

  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}

/**
 * Authenticates requests to `/mcp` using either:
 * 1. An external user API key (`mcpg_<prefix>_<secret>`), looked up by prefix and verified
 *    with constant-time SHA-256 comparison (`revoked_at IS NULL` checked on every call).
 * 2. A short-lived HMAC-signed internal chat token (`chat_...`) minted on behalf of the
 *    logged-in dashboard user (`source = 'chat'`).
 */
async function authenticateMcpRequest(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing Authorization: Bearer token" },
      id: null,
    });
    return;
  }

  const rawToken = authHeader.slice("Bearer ".length).trim();

  // Case 1: Internal short-lived token minted for the logged-in user's chat session
  if (rawToken.startsWith("chat_")) {
    const verified = verifyToken(rawToken, "chat");
    if (!verified) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or expired internal chat token" },
        id: null,
      });
      return;
    }
    req.mcpPrincipal = {
      userId: verified.sub,
      email: verified.email,
      role: verified.role,
      source: "chat",
    };
    next();
    return;
  }

  // Case 2: User API key (mcpg_<8char_prefix>_<secret>)
  const match = rawToken.match(/^mcpg_([a-f0-9]{8})_[A-Za-z0-9_-]+$/);
  if (!match) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Malformed API key" },
      id: null,
    });
    return;
  }

  const prefix = match[1];
  const candidateHash = hashToken(rawToken);

  const { rows } = await pool.query<{
    key_id: string;
    key_hash: string;
    revoked_at: string | null;
    user_id: string;
    email: string;
    role: "admin" | "member";
    user_status: string;
  }>(
    `SELECT k.id AS key_id, k.key_hash, k.revoked_at,
            u.id AS user_id, u.email, u.role, u.status AS user_status
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.prefix = $1`,
    [prefix]
  );

  const matchedKey = rows.find((r) => safeCompareHex(r.key_hash, candidateHash));
  if (!matchedKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid API key" },
      id: null,
    });
    return;
  }

  if (matchedKey.revoked_at !== null) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "API key has been revoked" },
      id: null,
    });
    return;
  }

  if (matchedKey.user_status !== "active") {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "User account is disabled" },
      id: null,
    });
    return;
  }

  pool
    .query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [matchedKey.key_id])
    .catch(() => {});

  req.mcpPrincipal = {
    userId: matchedKey.user_id,
    email: matchedKey.email,
    role: matchedKey.role,
    source: "mcp",
  };
  next();
}

function createGatewayMcpServer(principal: Principal): Server {
  const server = new Server(
    { name: "urumi-mcp-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await getAggregatedToolsForUser(principal);
    return {
      tools: tools.map((t) => ({
        name: t.exposedName,
        description: t.description,
        inputSchema: t.inputSchema as any,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const exposedName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await executeRoutedToolCall(principal, exposedName, args);
    return {
      content: result.content,
      isError: result.isError,
    };
  });

  return server;
}

// ============================================================================
// Health & Prometheus Metrics
// ============================================================================

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "gateway" });
});

app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not_ready", error: String(err) });
  }
});

app.get("/metrics", (_req, res) => {
  const lines: string[] = [
    "# HELP tool_calls_total Total MCP tool calls routed by the gateway",
    "# TYPE tool_calls_total counter",
  ];
  for (const [labels, count] of metricsStore.toolCallsTotal.entries()) {
    lines.push(`tool_calls_total{${labels}} ${count}`);
  }
  lines.push("# HELP tool_call_duration_seconds_sum Total duration of MCP tool calls in seconds");
  lines.push("# TYPE tool_call_duration_seconds_sum counter");
  for (const [labels, sum] of metricsStore.toolDurationSecondsSum.entries()) {
    lines.push(`tool_call_duration_seconds_sum{${labels}} ${sum.toFixed(4)}`);
  }
  lines.push("# HELP tool_call_duration_seconds_count Count of timed MCP tool calls");
  lines.push("# TYPE tool_call_duration_seconds_count counter");
  for (const [labels, count] of metricsStore.toolDurationSecondsCount.entries()) {
    lines.push(`tool_call_duration_seconds_count{${labels}} ${count}`);
  }
  lines.push("# HELP upstream_up Whether each registered upstream MCP server is reachable (1=up, 0=down)");
  lines.push("# TYPE upstream_up gauge");
  for (const [slug, val] of metricsStore.upstreamUp.entries()) {
    lines.push(`upstream_up{server="${slug}"} ${val}`);
  }
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.status(200).send(lines.join("\n") + "\n");
});

// ============================================================================
// Stateless Streamable HTTP MCP Endpoint (/mcp)
// ============================================================================

app.post("/mcp", authenticateMcpRequest, async (req: Request, res: Response) => {
  const principal = req.mcpPrincipal!;
  const mcpServer = createGatewayMcpServer(principal);
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[gateway] /mcp error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal gateway MCP error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", authenticateMcpRequest, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Gateway runs in stateless Streamable HTTP mode; use POST /mcp",
    },
    id: null,
  });
});

app.delete("/mcp", authenticateMcpRequest, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Stateless mode: no session to delete" },
    id: null,
  });
});

// ============================================================================
// Auth & Session Endpoints (/api/auth/*, /api/me)
// ============================================================================

app.post("/api/auth/login", async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string;
    password_hash: string;
    role: "admin" | "member";
    status: string;
  }>("SELECT * FROM users WHERE email = $1", [email]);

  const user = rows[0];
  if (!user || user.status !== "active" || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    purpose: "session",
    exp: Date.now() + 24 * 60 * 60 * 1000,
  });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
});

app.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/auth/accept-invite", async (req: Request, res: Response) => {
  const rawToken = String(req.body?.token ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!rawToken || !name || password.length < 8) {
    res.status(400).json({ error: "Token, name, and password (min 8 chars) are required" });
    return;
  }

  const tokenHash = hashToken(rawToken);
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: "admin" | "member";
    expires_at: string;
    used_at: string | null;
  }>("SELECT * FROM invites WHERE token_hash = $1", [tokenHash]);

  const invite = rows[0];
  if (!invite || invite.used_at !== null || new Date(invite.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: "Invite token is invalid, expired, or already used" });
    return;
  }

  const pwHash = hashPassword(password);
  const userRes = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: "admin" | "member";
  }>(
    `INSERT INTO users (email, name, password_hash, role, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (email) DO UPDATE
     SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, status = 'active'
     RETURNING id, email, name, role`,
    [invite.email, name, pwHash, invite.role]
  );

  await pool.query("UPDATE invites SET used_at = NOW() WHERE id = $1", [invite.id]);

  const user = userRes.rows[0];
  const sessionToken = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    purpose: "session",
    exp: Date.now() + 24 * 60 * 60 * 1000,
  });

  res.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({ user });
});

app.get("/api/me", requireSession, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// ============================================================================
// Upstream MCP Server Registry (/api/servers)
// ============================================================================

app.get("/api/servers", requireSession, async (_req: Request, res: Response) => {
  const { rows } = await pool.query<ServerRow>(
    "SELECT * FROM mcp_servers ORDER BY created_at ASC"
  );
  const toolsRes = await pool.query<{
    server_id: string;
    tool_name: string;
    definition_json: any;
  }>("SELECT server_id, tool_name, definition_json FROM tool_cache ORDER BY tool_name ASC");

  const toolsByServer = new Map<string, any[]>();
  for (const t of toolsRes.rows) {
    const arr = toolsByServer.get(t.server_id) ?? [];
    arr.push({
      name: t.tool_name,
      description: t.definition_json?.description ?? "",
    });
    toolsByServer.set(t.server_id, arr);
  }

  const servers = rows.map((srv) => {
    const cachedTools = toolsByServer.get(srv.id) ?? [];
    return {
      ...sanitizeServerForResponse(srv),
      tools: cachedTools.map((t) => ({
        name: t.name,
        exposedName: buildExposedToolName(srv.slug, t.name),
        description: t.description,
        available: srv.enabled && srv.status === "Connected",
      })),
    };
  });

  res.json({ servers });
});

app.post("/api/servers", requireSession, requireAdmin, async (req: Request, res: Response) => {
  const slug = String(req.body?.slug ?? "").toLowerCase().trim();
  const name = String(req.body?.name ?? "").trim();
  const url = String(req.body?.url ?? "").trim();
  const authType = String(req.body?.authType ?? "none") as "none" | "bearer" | "header";
  const authHeaderName = req.body?.authHeaderName ? String(req.body.authHeaderName).trim() : null;
  const credential = req.body?.credential ? String(req.body.credential) : "";

  if (!/^[a-z0-9-]{2,24}$/.test(slug)) {
    res.status(400).json({
      error: "Slug must be 2–24 characters using only lowercase letters, numbers, and hyphens",
    });
    return;
  }
  if (!name || !url) {
    res.status(400).json({ error: "Server name and URL are required" });
    return;
  }

  const ssrfCheck = await validateUpstreamUrl(url, ALLOWED_INTERNAL_SUFFIXES);
  if (!ssrfCheck.valid) {
    res.status(400).json({ error: ssrfCheck.reason });
    return;
  }

  const encrypted = credential ? encryptCredential(credential) : null;

  try {
    const insertRes = await pool.query<ServerRow>(
      `INSERT INTO mcp_servers (slug, name, url, auth_type, auth_header_name, credential_encrypted, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING *`,
      [slug, name, url, authType, authHeaderName, encrypted]
    );
    const created = insertRes.rows[0];
    await probeSingleServer(created);
    const refreshed = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [
      created.id,
    ]);
    res.status(201).json({ server: sanitizeServerForResponse(refreshed.rows[0]) });
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: `Server with slug '${slug}' already exists` });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/servers/:id", requireSession, requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const existingRes = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [id]);
  const existing = existingRes.rows[0];
  if (!existing) {
    res.status(404).json({ error: "Server not found" });
    return;
  }

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const url = req.body?.url !== undefined ? String(req.body.url).trim() : existing.url;
  const authType =
    req.body?.authType !== undefined ? String(req.body.authType) : existing.auth_type;
  const authHeaderName =
    req.body?.authHeaderName !== undefined ? req.body.authHeaderName : existing.auth_header_name;
  const enabled =
    req.body?.enabled !== undefined ? Boolean(req.body.enabled) : existing.enabled;

  if (url !== existing.url) {
    const ssrfCheck = await validateUpstreamUrl(url, ALLOWED_INTERNAL_SUFFIXES);
    if (!ssrfCheck.valid) {
      res.status(400).json({ error: ssrfCheck.reason });
      return;
    }
  }

  const encrypted =
    typeof req.body?.credential === "string" && req.body.credential.length > 0
      ? encryptCredential(req.body.credential)
      : existing.credential_encrypted;

  const updRes = await pool.query<ServerRow>(
    `UPDATE mcp_servers
     SET name = $2, url = $3, auth_type = $4, auth_header_name = $5,
         credential_encrypted = $6, enabled = $7, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, name, url, authType, authHeaderName, encrypted, enabled]
  );

  await probeSingleServer(updRes.rows[0]);
  const finalRes = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [id]);
  res.json({ server: sanitizeServerForResponse(finalRes.rows[0]) });
});

app.delete("/api/servers/:id", requireSession, requireAdmin, async (req: Request, res: Response) => {
  await pool.query("DELETE FROM mcp_servers WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.post(
  "/api/servers/:id/test",
  requireSession,
  requireAdmin,
  async (req: Request, res: Response) => {
    const { rows } = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [
      req.params.id,
    ]);
    const srv = rows[0];
    if (!srv) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const probe = await probeSingleServer(srv);
    const updated = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [
      srv.id,
    ]);
    res.json({
      probe,
      server: sanitizeServerForResponse(updated.rows[0]),
    });
  }
);

app.get("/api/servers/:id/tools", requireSession, async (req: Request, res: Response) => {
  const srvRes = await pool.query<ServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [
    req.params.id,
  ]);
  const srv = srvRes.rows[0];
  if (!srv) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const { rows } = await pool.query<{ tool_name: string; definition_json: any; fetched_at: string }>(
    "SELECT tool_name, definition_json, fetched_at FROM tool_cache WHERE server_id = $1 ORDER BY tool_name ASC",
    [srv.id]
  );
  res.json({
    tools: rows.map((r) => ({
      name: r.tool_name,
      exposedName: buildExposedToolName(srv.slug, r.tool_name),
      description: r.definition_json?.description ?? "",
      inputSchema: r.definition_json?.inputSchema ?? {},
      fetchedAt: r.fetched_at,
      available: srv.enabled && srv.status === "Connected",
    })),
  });
});

// ============================================================================
// Team, Invites & Tool Permissions (/api/users, /api/invites, /api/permissions)
// ============================================================================

app.get("/api/users", requireSession, requireAdmin, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at ASC"
  );
  const invitesRes = await pool.query(
    "SELECT id, email, role, expires_at, used_at, created_at FROM invites ORDER BY created_at DESC LIMIT 20"
  );
  res.json({ users: rows, invites: invitesRes.rows });
});

app.post("/api/invites", requireSession, requireAdmin, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const role = (req.body?.role === "admin" ? "admin" : "member") as "admin" | "member";
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const rawToken = `inv_${crypto.randomBytes(24).toString("base64url")}`;
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await pool.query(
    `INSERT INTO invites (email, role, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, role, tokenHash, expiresAt, req.user!.id]
  );

  res.status(201).json({
    inviteToken: rawToken,
    email,
    role,
    expiresAt,
  });
});

app.delete("/api/users/:id", requireSession, requireAdmin, async (req: Request, res: Response) => {
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: "Cannot delete your own admin account" });
    return;
  }
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/permissions", requireSession, async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    "SELECT id, role, server_slug, tool_name, effect, created_at FROM tool_permissions ORDER BY role ASC, server_slug ASC, tool_name ASC"
  );
  res.json({ permissions: rows });
});

app.post("/api/permissions", requireSession, requireAdmin, async (req: Request, res: Response) => {
  const role = req.body?.role === "admin" ? "admin" : "member";
  const serverSlug = String(req.body?.serverSlug ?? "*").trim();
  const toolName = String(req.body?.toolName ?? "*").trim();
  const effect = req.body?.effect === "deny" ? "deny" : "allow";

  const { rows } = await pool.query(
    `INSERT INTO tool_permissions (role, server_slug, tool_name, effect)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (role, server_slug, tool_name) DO UPDATE SET effect = EXCLUDED.effect
     RETURNING *`,
    [role, serverSlug, toolName, effect]
  );
  res.status(201).json({ permission: rows[0] });
});

app.delete(
  "/api/permissions/:id",
  requireSession,
  requireAdmin,
  async (req: Request, res: Response) => {
    await pool.query("DELETE FROM tool_permissions WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }
);

// ============================================================================
// API Keys (/api/keys)
// ============================================================================

app.get("/api/keys", requireSession, async (req: Request, res: Response) => {
  const isAdmin = req.user!.role === "admin";
  const { rows } = isAdmin
    ? await pool.query(
        `SELECT k.id, k.user_id, u.email AS user_email, k.name, k.prefix,
                k.created_at, k.last_used_at, k.revoked_at
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         ORDER BY k.created_at DESC`
      )
    : await pool.query(
        `SELECT k.id, k.user_id, u.email AS user_email, k.name, k.prefix,
                k.created_at, k.last_used_at, k.revoked_at
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.user_id = $1
         ORDER BY k.created_at DESC`,
        [req.user!.id]
      );

  res.json({ keys: rows });
});

app.post("/api/keys", requireSession, async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "CLI Key").trim() || "CLI Key";
  const targetUserId =
    req.user!.role === "admin" && req.body?.userId ? String(req.body.userId) : req.user!.id;

  const { plaintext, prefix, keyHash } = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, name, prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, name, prefix, created_at, last_used_at, revoked_at`,
    [targetUserId, name, prefix, keyHash]
  );

  // Plaintext key is returned ONCE upon creation and never stored in the database.
  res.status(201).json({
    key: rows[0],
    plaintextKey: plaintext,
  });
});

app.delete("/api/keys/:id", requireSession, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (req.user!.role === "admin") {
    await pool.query("UPDATE api_keys SET revoked_at = NOW() WHERE id = $1", [id]);
  } else {
    await pool.query("UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2", [
      id,
      req.user!.id,
    ]);
  }
  res.json({ ok: true });
});

// ============================================================================
// Audit Log (/api/audit)
// ============================================================================

app.get("/api/audit", requireSession, async (req: Request, res: Response) => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role !== "admin") {
    params.push(req.user!.id);
    conditions.push(`user_id = $${params.length}`);
  } else if (req.query.user) {
    params.push(String(req.query.user));
    conditions.push(`(user_id::text = $${params.length} OR user_email ILIKE $${params.length})`);
  }

  if (req.query.server) {
    params.push(String(req.query.server));
    conditions.push(`server_slug = $${params.length}`);
  }

  if (req.query.outcome) {
    params.push(String(req.query.outcome));
    conditions.push(`outcome = $${params.length}`);
  }

  if (req.query.source) {
    params.push(String(req.query.source));
    conditions.push(`source = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = (page - 1) * limit;

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, ts, user_id, user_email, source, server_id, server_slug,
            tool_name, duration_ms, outcome, error_message, request_id
     FROM audit_log
     ${whereClause}
     ORDER BY ts DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ entries: rows, page, limit });
});

// ============================================================================
// Chat Agent Endpoint (/api/chat) — SSE & JSON
// ============================================================================

app.post("/api/chat", requireSession, async (req: Request, res: Response) => {
  const rawMessages: ChatMessage[] = Array.isArray(req.body?.messages)
    ? req.body.messages
    : req.body?.prompt
      ? [{ role: "user", content: String(req.body.prompt) }]
      : [];

  if (rawMessages.length === 0) {
    res.status(400).json({ error: "messages or prompt is required" });
    return;
  }

  const wantsStream =
    req.headers.accept?.includes("text/event-stream") || req.body?.stream === true;

  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (event: { type: string; data: unknown }) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };

    try {
      const result = await runChatTurn(
        {
          userId: req.user!.id,
          email: req.user!.email,
          role: req.user!.role,
        },
        rawMessages,
        sendEvent
      );
      sendEvent({ type: "done", data: result });
      res.end();
    } catch (err) {
      sendEvent({
        type: "error",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      res.end();
    }
    return;
  }

  try {
    const result = await runChatTurn(
      {
        userId: req.user!.id,
        email: req.user!.email,
        role: req.user!.role,
      },
      rawMessages
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function main() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[gateway] listening on 0.0.0.0:${PORT}`);
    refreshAllServers().catch((err) =>
      console.error("[gateway] initial upstream probe error:", err)
    );
    setInterval(() => {
      refreshAllServers().catch((err) =>
        console.error("[gateway] periodic upstream probe error:", err)
      );
    }, HEALTH_INTERVAL_MS);
  });
}

main().catch((err) => {
  console.error("[gateway] fatal startup error:", err);
  process.exit(1);
});
