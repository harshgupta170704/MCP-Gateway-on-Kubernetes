import pg from "pg";
import { encryptCredential, hashPassword } from "./crypto.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    `postgresql://${process.env.PGUSER ?? "gateway"}:${encodeURIComponent(
      process.env.PGPASSWORD ?? ""
    )}@${process.env.PGHOST ?? "postgres"}:${process.env.PGPORT ?? "5432"}/${
      process.env.PGDATABASE ?? "gateway"
    }`,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 25; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (attempt === 25) throw err;
      console.log(`[gateway] waiting for postgres (attempt ${attempt}/25)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
      auth_header_name TEXT,
      credential_encrypted TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'Unreachable' CHECK (status IN ('Connected', 'Unreachable', 'Disabled')),
      status_reason TEXT,
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tool_cache (
      server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      definition_json JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      user_email TEXT,
      source TEXT NOT NULL CHECK (source IN ('mcp', 'chat')),
      server_id UUID REFERENCES mcp_servers(id) ON DELETE SET NULL,
      server_slug TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'timeout', 'denied')),
      error_message TEXT,
      request_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

    CREATE TABLE IF NOT EXISTS tool_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      server_slug TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (role, server_slug, tool_name)
    );
  `);

  await seedInitialData();
}

async function seedInitialData(): Promise<void> {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@urumi.local").toLowerCase().trim();
  const adminName = process.env.ADMIN_NAME ?? "Platform Admin";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "AdminPass!2026";

  const memberEmail = (process.env.MEMBER_EMAIL ?? "member@urumi.local").toLowerCase().trim();
  const memberName = process.env.MEMBER_NAME ?? "Team Member";
  const memberPassword = process.env.MEMBER_PASSWORD ?? "MemberPass!2026";

  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status)
     VALUES ($1, $2, $3, 'admin', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [adminEmail, adminName, hashPassword(adminPassword)]
  );

  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, status)
     VALUES ($1, $2, $3, 'member', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [memberEmail, memberName, hashPassword(memberPassword)]
  );

  // Seed upstream MCP servers idempotently
  const wooToken = process.env.WOO_MCP_TOKEN ?? "";
  const sampleToken = process.env.SAMPLE_MCP_TOKEN ?? "";

  const defaultServers = [
    {
      slug: "woo",
      name: "WooCommerce Store",
      url: process.env.WOO_MCP_URL ?? "http://woo-mcp:3000/mcp",
      authType: "bearer",
      authHeader: "Authorization",
      encrypted: wooToken ? encryptCredential(wooToken) : null,
    },
    {
      slug: "utility",
      name: "Team Utility & Notes",
      url: process.env.SAMPLE_MCP_URL ?? "http://sample-mcp:3000/mcp",
      authType: "bearer",
      authHeader: "Authorization",
      encrypted: sampleToken ? encryptCredential(sampleToken) : null,
    },
    {
      slug: "everything",
      name: "Everything Reference",
      url: process.env.EVERYTHING_MCP_URL ?? "http://everything-mcp:3001/mcp",
      authType: "none",
      authHeader: null,
      encrypted: null,
    },
  ];

  for (const srv of defaultServers) {
    await pool.query(
      `INSERT INTO mcp_servers (slug, name, url, auth_type, auth_header_name, credential_encrypted, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (slug) DO UPDATE
       SET credential_encrypted = COALESCE(EXCLUDED.credential_encrypted, mcp_servers.credential_encrypted)`,
      [srv.slug, srv.name, srv.url, srv.authType, srv.authHeader, srv.encrypted]
    );
  }

  // Seed default role permissions:
  // Admins can invoke everything; members can invoke read/standard tools, with
  // order status mutation denied by default for members to demonstrate RBAC enforcement.
  await pool.query(
    `INSERT INTO tool_permissions (role, server_slug, tool_name, effect)
     VALUES
       ('admin', '*', '*', 'allow'),
       ('member', '*', '*', 'allow'),
       ('member', 'woo', 'update_order_status', 'deny')
     ON CONFLICT (role, server_slug, tool_name) DO NOTHING`
  );
}
