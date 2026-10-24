import React, { useEffect, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

declare global {
  interface Window {
    __MCP_CONFIG__?: {
      API_BASE?: string;
      STORE_URL?: string;
    };
  }
}

const API_BASE = window.__MCP_CONFIG__?.API_BASE ?? "";
const STORE_URL = window.__MCP_CONFIG__?.STORE_URL ?? "http://store.127.0.0.1.nip.io";

interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

interface ToolItem {
  name: string;
  exposedName: string;
  description: string;
  available: boolean;
}

interface McpServerItem {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  status: "Connected" | "Unreachable" | "Disabled";
  statusReason: string | null;
  lastCheckedAt: string | null;
  tools: ToolItem[];
}

interface ApiKeyItem {
  id: string;
  user_id: string;
  user_email: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface AuditEntry {
  id: string;
  ts: string;
  user_id: string;
  user_email: string;
  source: "mcp" | "chat";
  server_slug: string;
  tool_name: string;
  duration_ms: number;
  outcome: "success" | "error" | "timeout" | "denied";
  error_message: string | null;
  request_id: string;
}

interface ToolTrace {
  id: string;
  exposedName: string;
  serverSlug: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolTrace[];
  modelUsed?: string;
}

type TabKey = "servers" | "chat" | "keys" | "audit" | "team";

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("servers");

  // Login / Invite form state
  const urlParams = new URLSearchParams(window.location.search);
  const inviteTokenParam = urlParams.get("invite") ?? "";
  const [isAcceptingInvite, setIsAcceptingInvite] = useState(Boolean(inviteTokenParam));
  const [inviteToken, setInviteToken] = useState(inviteTokenParam);
  const [inviteName, setInviteName] = useState("");
  const [email, setEmail] = useState("admin@urumi.local");
  const [password, setPassword] = useState("AdminPass!2026");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Data state
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({
    woo: true,
    utility: true,
  });
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServer, setNewServer] = useState({
    name: "",
    slug: "",
    url: "",
    authType: "bearer",
    authHeaderName: "Authorization",
    credential: "",
  });
  const [serverError, setServerError] = useState<string | null>(null);
  const [probingServerId, setProbingServerId] = useState<string | null>(null);

  // API keys state
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdPlaintextKey, setCreatedPlaintextKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Audit state
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditFilters, setAuditFilters] = useState({
    server: "",
    outcome: "",
    source: "",
  });

  // Team & Permissions state
  const [teamUsers, setTeamUsers] = useState<any[]>([]);
  const [teamInvites, setTeamInvites] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [generatedInviteLink, setGeneratedInviteLink] = useState<string | null>(null);
  const [newPerm, setNewPerm] = useState({
    role: "member",
    serverSlug: "woo",
    toolName: "update_order_status",
    effect: "deny",
  });

  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Connected to the MCP Gateway router. Every tool invocation below executes through `/mcp` using a short-lived signed token for your logged-in user and is recorded in the audit log.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>({});

  useEffect(() => {
    apiFetch<{ user: User }>("/api/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  const loadServers = async () => {
    const d = await apiFetch<{ servers: McpServerItem[] }>("/api/servers");
    setServers(d.servers);
  };

  const loadKeys = async () => {
    const d = await apiFetch<{ keys: ApiKeyItem[] }>("/api/keys");
    setKeys(d.keys);
  };

  const loadAudit = async () => {
    const q = new URLSearchParams();
    if (auditFilters.server) q.set("server", auditFilters.server);
    if (auditFilters.outcome) q.set("outcome", auditFilters.outcome);
    if (auditFilters.source) q.set("source", auditFilters.source);
    const d = await apiFetch<{ entries: AuditEntry[] }>(`/api/audit?${q.toString()}`);
    setAuditEntries(d.entries);
  };

  const loadTeamAndPerms = async () => {
    const permData = await apiFetch<{ permissions: any[] }>("/api/permissions");
    setPermissions(permData.permissions);
    if (user?.role === "admin") {
      const teamData = await apiFetch<{ users: any[]; invites: any[] }>("/api/users");
      setTeamUsers(teamData.users);
      setTeamInvites(teamData.invites);
    }
  };

  useEffect(() => {
    if (!user) return;
    loadServers().catch(() => {});
    loadKeys().catch(() => {});
    loadAudit().catch(() => {});
    loadTeamAndPerms().catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (activeTab === "servers") loadServers().catch(() => {});
    if (activeTab === "keys") loadKeys().catch(() => {});
    if (activeTab === "audit") loadAudit().catch(() => {});
    if (activeTab === "team") loadTeamAndPerms().catch(() => {});
  }, [activeTab, auditFilters.server, auditFilters.outcome, auditFilters.source]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const d = await apiFetch<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setUser(d.user);
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAcceptInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const d = await apiFetch<{ user: User }>("/api/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token: inviteToken, name: inviteName, password }),
      });
      window.history.replaceState({}, "", "/");
      setIsAcceptingInvite(false);
      setUser(d.user);
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  };

  const handleToggleServer = async (srv: McpServerItem) => {
    await apiFetch(`/api/servers/${srv.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !srv.enabled }),
    });
    await loadServers();
  };

  const handleProbeServer = async (id: string) => {
    setProbingServerId(id);
    try {
      await apiFetch(`/api/servers/${id}/test`, { method: "POST" });
      await loadServers();
    } finally {
      setProbingServerId(null);
    }
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    try {
      await apiFetch("/api/servers", {
        method: "POST",
        body: JSON.stringify(newServer),
      });
      setShowAddServer(false);
      setNewServer({
        name: "",
        slug: "",
        url: "",
        authType: "bearer",
        authHeaderName: "Authorization",
        credential: "",
      });
      await loadServers();
    } catch (err: any) {
      setServerError(err.message);
    }
  };

  const handleDeleteServer = async (id: string) => {
    await apiFetch(`/api/servers/${id}`, { method: "DELETE" });
    await loadServers();
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const d = await apiFetch<{ plaintextKey: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: newKeyName || "CLI Key" }),
    });
    setCreatedPlaintextKey(d.plaintextKey);
    setNewKeyName("");
    await loadKeys();
  };

  const handleRevokeKey = async (id: string) => {
    await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const d = await apiFetch<{ inviteToken: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const link = `${window.location.origin}/?invite=${d.inviteToken}`;
    setGeneratedInviteLink(link);
    setInviteEmail("");
    await loadTeamAndPerms();
  };

  const handleAddPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch("/api/permissions", {
      method: "POST",
      body: JSON.stringify(newPerm),
    });
    await loadTeamAndPerms();
  };

  const handleDeletePermission = async (id: string) => {
    await apiFetch(`/api/permissions/${id}`, { method: "DELETE" });
    await loadTeamAndPerms();
  };

  const sendChatMessage = async (promptText?: string) => {
    const text = (promptText ?? chatInput).trim();
    if (!text || chatLoading) return;

    const userMsg: ChatEntry = {
      id: `u_${Date.now()}`,
      role: "user",
      content: text,
    };
    const assistantId = `a_${Date.now()}`;
    const placeholder: ChatEntry = {
      id: assistantId,
      role: "assistant",
      content: "",
      toolCalls: [],
    };

    setChatInput("");
    setChatLoading(true);
    setChatHistory((prev) => [...prev, userMsg, placeholder]);

    try {
      const messagesPayload = [...chatHistory, userMsg]
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ messages: messagesPayload, stream: true }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Chat HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          let eventType = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            if (line.startsWith("data:")) dataLine = line.slice(5).trim();
          }
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine);

          if (eventType === "tool_call") {
            setChatHistory((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), payload] }
                  : m
              )
            );
          } else if (eventType === "tool_result") {
            setChatHistory((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      toolCalls: (m.toolCalls ?? []).map((tc) =>
                        tc.id === payload.id ? payload : tc
                      ),
                    }
                  : m
              )
            );
          } else if (eventType === "done") {
            setChatHistory((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: payload.reply,
                      toolCalls: payload.toolCalls,
                      modelUsed: payload.modelUsed,
                    }
                  : m
              )
            );
          } else if (eventType === "error") {
            setChatHistory((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: `Error: ${payload.error}` }
                  : m
              )
            );
          }
        }
      }
      loadAudit().catch(() => {});
    } catch (err: any) {
      setChatHistory((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: `Request failed: ${err.message}` } : m
        )
      );
    } finally {
      setChatLoading(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400 text-sm font-mono">
        Initializing gateway session...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col justify-center items-center px-4">
        <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg p-6 shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <Terminal className="w-5 h-5 text-emerald-400" />
                <h1 className="text-base font-semibold tracking-tight text-zinc-100">
                  Urumi MCP Gateway
                </h1>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Kubernetes Control Plane &amp; Multi-Tenant Tool Router
              </p>
            </div>
            <span className="text-[11px] font-mono bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded border border-zinc-700">
              ns: mcp-platform
            </span>
          </div>

          {isAcceptingInvite ? (
            <form onSubmit={handleAcceptInvite} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Invite Token
                </label>
                <input
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Your Name
                </label>
                <input
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="Priya Sharma"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Set Password (min 8 chars)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              {authError && (
                <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded px-3 py-2">
                  {authError}
                </div>
              )}
              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm py-2 rounded transition"
              >
                {authLoading ? "Activating Account..." : "Accept Invite & Sign In"}
              </button>
              <button
                type="button"
                onClick={() => setIsAcceptingInvite(false)}
                className="w-full text-xs text-zinc-400 hover:text-zinc-200 text-center pt-1"
              >
                Back to password sign-in
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>
              {authError && (
                <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded px-3 py-2">
                  {authError}
                </div>
              )}
              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm py-2 rounded transition"
              >
                {authLoading ? "Signing in..." : "Sign In"}
              </button>

              <div className="pt-3 border-t border-zinc-800">
                <div className="text-[11px] text-zinc-400 mb-2 font-mono">
                  Seeded Kubernetes Secret Identities (Quick Fill):
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEmail("admin@urumi.local");
                      setPassword("AdminPass!2026");
                    }}
                    className="text-left px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-xs"
                  >
                    <div className="font-medium text-zinc-200">User A (Admin)</div>
                    <div className="text-[11px] font-mono text-zinc-400">admin@urumi.local</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEmail("member@urumi.local");
                      setPassword("MemberPass!2026");
                    }}
                    className="text-left px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-xs"
                  >
                    <div className="font-medium text-zinc-200">User B (Member)</div>
                    <div className="text-[11px] font-mono text-zinc-400">member@urumi.local</div>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setIsAcceptingInvite(true)}
                  className="w-full text-xs text-zinc-400 hover:text-zinc-200 text-center mt-3"
                >
                  Have a team invite token? Redeem here
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  const gatewayMcpUrl = `${window.location.origin}/mcp`;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Top Header */}
      <header className="h-14 border-b border-zinc-800 bg-zinc-900/70 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            <span className="font-semibold tracking-tight text-sm">Urumi MCP Gateway</span>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
            endpoint: {gatewayMcpUrl}
          </span>
          <a
            href={STORE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-mono"
          >
            Storefront <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs font-medium text-zinc-200 flex items-center gap-2 justify-end">
              {user.name}
              <span
                className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                  user.role === "admin"
                    ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                    : "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                }`}
              >
                {user.role}
              </span>
            </div>
            <div className="text-[11px] font-mono text-zinc-400">{user.email}</div>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Navigation */}
        <aside className="w-56 border-r border-zinc-800 bg-zinc-900/40 p-3 flex flex-col justify-between">
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab("servers")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${
                activeTab === "servers"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Server className="w-4 h-4" />
              Upstream Servers
              <span className="ml-auto font-mono text-[11px] bg-zinc-800 px-1.5 py-0.5 rounded">
                {servers.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab("chat")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${
                activeTab === "chat"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Chat Agent
            </button>

            <button
              onClick={() => setActiveTab("keys")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${
                activeTab === "keys"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <KeyRound className="w-4 h-4" />
              API Keys
            </button>

            <button
              onClick={() => setActiveTab("audit")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${
                activeTab === "audit"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Activity className="w-4 h-4" />
              Audit Log
            </button>

            <button
              onClick={() => setActiveTab("team")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${
                activeTab === "team"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Shield className="w-4 h-4" />
              Team &amp; RBAC
            </button>
          </nav>

          <div className="p-3 rounded bg-zinc-900 border border-zinc-800 text-[11px] space-y-1.5">
            <div className="font-mono text-zinc-300 font-medium">Isolation Status</div>
            <div className="text-zinc-400 flex items-center justify-between">
              <span>Upstream NetPol</span>
              <span className="text-emerald-400 font-mono">Enforced</span>
            </div>
            <div className="text-zinc-400 flex items-center justify-between">
              <span>Cred Storage</span>
              <span className="text-emerald-400 font-mono">AES-256-GCM</span>
            </div>
            <div className="text-zinc-400 flex items-center justify-between">
              <span>Transport</span>
              <span className="text-zinc-300 font-mono">Stateless HTTP</span>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* TAB 1: UPSTREAM SERVERS */}
          {activeTab === "servers" && (
            <div className="max-w-5xl space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Upstream MCP Servers</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    ClusterIP MCP backends aggregated under{" "}
                    <code className="font-mono text-zinc-300">&lt;slug&gt;__&lt;tool_name&gt;</code>{" "}
                    to prevent tool collisions across servers.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={loadServers}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-medium flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                  {user.role === "admin" && (
                    <button
                      onClick={() => setShowAddServer(!showAddServer)}
                      className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" /> Register Upstream
                    </button>
                  )}
                </div>
              </div>

              {showAddServer && (
                <form
                  onSubmit={handleCreateServer}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3"
                >
                  <div className="text-xs font-semibold text-zinc-200">
                    Register Upstream MCP Server (SSRF-Guarded)
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">Display Name</label>
                      <input
                        value={newServer.name}
                        onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
                        placeholder="Inventory MCP"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Namespace Slug ([a-z0-9-])
                      </label>
                      <input
                        value={newServer.slug}
                        onChange={(e) => setNewServer({ ...newServer, slug: e.target.value })}
                        placeholder="inventory"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Streamable HTTP Endpoint URL
                      </label>
                      <input
                        value={newServer.url}
                        onChange={(e) => setNewServer({ ...newServer, url: e.target.value })}
                        placeholder="http://sample-mcp:3000/mcp"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono"
                        required
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">Auth Type</label>
                      <select
                        value={newServer.authType}
                        onChange={(e) => setNewServer({ ...newServer, authType: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                      >
                        <option value="none">None</option>
                        <option value="bearer">Bearer Token</option>
                        <option value="header">Custom Header</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Upstream Secret Credential (write-only; encrypted with AES-256-GCM at rest)
                      </label>
                      <input
                        type="password"
                        value={newServer.credential}
                        onChange={(e) => setNewServer({ ...newServer, credential: e.target.value })}
                        placeholder="Leave blank if authType = none"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>
                  {serverError && (
                    <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
                      {serverError}
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddServer(false)}
                      className="px-3 py-1.5 rounded bg-zinc-800 text-xs"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                    >
                      Save &amp; Probe Server
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-3">
                {servers.map((srv) => {
                  const isExpanded = Boolean(expandedServers[srv.slug]);
                  return (
                    <div
                      key={srv.id}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden"
                    >
                      <div className="p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() =>
                              setExpandedServers({
                                ...expandedServers,
                                [srv.slug]: !isExpanded,
                              })
                            }
                            className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </button>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-zinc-100">{srv.name}</span>
                              <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-800 text-emerald-300 border border-zinc-700">
                                {srv.slug}__*
                              </span>
                              <span
                                title={srv.statusReason ?? "Healthy"}
                                className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                                  srv.status === "Connected"
                                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                    : srv.status === "Disabled"
                                      ? "bg-zinc-800 text-zinc-400 border-zinc-700"
                                      : "bg-red-500/15 text-red-300 border-red-500/30"
                                }`}
                              >
                                {srv.status}
                              </span>
                              <span className="text-[11px] font-mono text-zinc-400">
                                ({srv.tools.length} tools)
                              </span>
                            </div>
                            <div className="text-xs font-mono text-zinc-400 mt-1 flex items-center gap-3">
                              <span>{srv.url}</span>
                              <span>•</span>
                              <span>
                                auth: {srv.authType}{" "}
                                {srv.hasCredential ? "(encrypted secret stored)" : ""}
                              </span>
                              {srv.statusReason && (
                                <>
                                  <span>•</span>
                                  <span className="text-amber-400">reason: {srv.statusReason}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {user.role === "admin" && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleProbeServer(srv.id)}
                              disabled={probingServerId === srv.id}
                              className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200"
                            >
                              {probingServerId === srv.id ? "Testing..." : "Test Connection"}
                            </button>
                            <button
                              onClick={() => handleToggleServer(srv)}
                              className={`px-2.5 py-1 rounded text-xs font-medium ${
                                srv.enabled
                                  ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30"
                                  : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30"
                              }`}
                            >
                              {srv.enabled ? "Disable" : "Enable"}
                            </button>
                            {srv.slug !== "woo" && (
                              <button
                                onClick={() => handleDeleteServer(srv.id)}
                                className="p-1.5 rounded bg-zinc-800 hover:bg-red-950/60 text-zinc-400 hover:text-red-300"
                                title="Delete Server"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {isExpanded && (
                        <div className="border-t border-zinc-800 bg-zinc-950/60 px-4 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {srv.tools.map((t) => (
                              <div
                                key={t.exposedName}
                                className={`p-2.5 rounded border ${
                                  t.available
                                    ? "bg-zinc-900/70 border-zinc-800"
                                    : "bg-zinc-900/20 border-zinc-800/50 opacity-50"
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <code className="text-xs font-mono text-emerald-300 font-medium">
                                    {t.exposedName}
                                  </code>
                                  {t.name === "list_products" && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                                      collision-safe prefix
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] text-zinc-400 mt-1">{t.description}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: CHAT AGENT */}
          {activeTab === "chat" && (
            <div className="max-w-4xl h-[calc(100vh-7.5rem)] flex flex-col">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Gateway Tool-Calling Chat Agent</h2>
                  <p className="text-xs text-zinc-400">
                    Executes tools via <code className="font-mono text-zinc-300">POST /mcp</code> as{" "}
                    <span className="font-mono text-emerald-300">{user.email}</span> (
                    <code className="font-mono">source=&apos;chat&apos;</code>).
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() =>
                      sendChatMessage("Create a product 'Test Mug' priced 12.50")
                    }
                    className="text-[11px] font-mono bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-2.5 py-1 rounded text-zinc-300"
                  >
                    + Create &apos;Test Mug&apos; ($12.50)
                  </button>
                  <button
                    onClick={() => sendChatMessage("What orders came in today?")}
                    className="text-[11px] font-mono bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-2.5 py-1 rounded text-zinc-300"
                  >
                    Orders today
                  </button>
                  <button
                    onClick={() =>
                      sendChatMessage(
                        "List both store products and warehouse utility products, then tell me the current time"
                      )
                    }
                    className="text-[11px] font-mono bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-2.5 py-1 rounded text-zinc-300"
                  >
                    Multi-server + Collision demo
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto bg-zinc-900/60 border border-zinc-800 rounded-lg p-4 space-y-4">
                {chatHistory.map((m) => (
                  <div
                    key={m.id}
                    className={`flex flex-col ${
                      m.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-3xl rounded-lg px-4 py-3 text-sm ${
                        m.role === "user"
                          ? "bg-emerald-600/20 border border-emerald-500/30 text-zinc-100"
                          : "bg-zinc-900 border border-zinc-800 text-zinc-200 w-full"
                      }`}
                    >
                      <div className="text-[10px] font-mono uppercase text-zinc-400 mb-1 flex items-center justify-between">
                        <span>{m.role === "user" ? user.email : "Gateway Agent"}</span>
                        {m.modelUsed && <span>engine: {m.modelUsed}</span>}
                      </div>

                      {m.toolCalls && m.toolCalls.length > 0 && (
                        <div className="my-2 space-y-2">
                          {m.toolCalls.map((tc) => {
                            const open = Boolean(expandedTraces[tc.id]);
                            return (
                              <div
                                key={tc.id}
                                className="bg-zinc-950 border border-zinc-800 rounded p-2.5 text-xs font-mono"
                              >
                                <div
                                  onClick={() =>
                                    setExpandedTraces({ ...expandedTraces, [tc.id]: !open })
                                  }
                                  className="flex items-center justify-between cursor-pointer"
                                >
                                  <div className="flex items-center gap-2">
                                    {open ? (
                                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                                    ) : (
                                      <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                                    )}
                                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-emerald-300">
                                      {tc.serverSlug}
                                    </span>
                                    <span className="text-zinc-200 font-semibold">
                                      {tc.exposedName}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {tc.durationMs !== undefined && (
                                      <span className="text-zinc-400">{tc.durationMs} ms</span>
                                    )}
                                    <span
                                      className={`px-1.5 py-0.5 rounded text-[10px] ${
                                        tc.isError
                                          ? "bg-red-500/15 text-red-300 border border-red-500/30"
                                          : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                                      }`}
                                    >
                                      {tc.isError ? "ERROR / DENIED" : "SUCCESS"}
                                    </span>
                                  </div>
                                </div>
                                {open && (
                                  <div className="mt-2 pt-2 border-t border-zinc-800 space-y-2 text-[11px]">
                                    <div>
                                      <div className="text-zinc-400 mb-0.5">Arguments:</div>
                                      <pre className="bg-zinc-900 p-2 rounded overflow-x-auto text-zinc-300">
                                        {JSON.stringify(tc.arguments, null, 2)}
                                      </pre>
                                    </div>
                                    {tc.result && (
                                      <div>
                                        <div className="text-zinc-400 mb-0.5">Result Payload:</div>
                                        <pre className="bg-zinc-900 p-2 rounded overflow-x-auto text-zinc-300 max-h-48">
                                          {tc.result}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="whitespace-pre-wrap leading-relaxed text-xs sm:text-sm">
                        {m.content || (chatLoading ? "Executing MCP tool calls..." : "")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendChatMessage();
                }}
                className="mt-3 flex gap-2"
              >
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask the agent (e.g. Create a product 'Test Mug' priced 12.50, or What orders came in today?)"
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="submit"
                  disabled={chatLoading}
                  className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50"
                >
                  {chatLoading ? "Running..." : "Send"}
                </button>
              </form>
            </div>
          )}

          {/* TAB 3: API KEYS */}
          {activeTab === "keys" && (
            <div className="max-w-5xl space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Personal &amp; Team MCP API Keys</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Keys use format{" "}
                    <code className="font-mono text-zinc-300">
                      mcpg_&lt;8char_prefix&gt;_&lt;32bytes_base64url&gt;
                    </code>
                    . Only <code className="font-mono text-zinc-300">SHA-256(key)</code> and the
                    prefix are persisted in Postgres.
                  </p>
                </div>
                <form onSubmit={handleCreateKey} className="flex items-center gap-2">
                  <input
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key label (e.g. Claude Code Laptop)"
                    className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" /> Generate API Key
                  </button>
                </form>
              </div>

              {createdPlaintextKey && (
                <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-emerald-300">
                      New API Key Generated — Copy Now (Shown Once)
                    </div>
                    <button
                      onClick={() => setCreatedPlaintextKey(null)}
                      className="text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Dismiss
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-emerald-300 select-all">
                      {createdPlaintextKey}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdPlaintextKey);
                        setCopiedKey(true);
                        setTimeout(() => setCopiedKey(false), 2000);
                      }}
                      className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-medium flex items-center gap-1.5"
                    >
                      {copiedKey ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                    <div>
                      <div className="text-[11px] font-mono text-zinc-400 mb-1">
                        Claude Code CLI:
                      </div>
                      <pre className="bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] font-mono text-zinc-300 overflow-x-auto">
                        {`claude mcp add --transport http gateway ${gatewayMcpUrl} \\\n  --header "Authorization: Bearer ${createdPlaintextKey}"`}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[11px] font-mono text-zinc-400 mb-1">
                        Cursor (~/.cursor/mcp.json):
                      </div>
                      <pre className="bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] font-mono text-zinc-300 overflow-x-auto">
                        {JSON.stringify(
                          {
                            mcpServers: {
                              "urumi-gateway": {
                                url: gatewayMcpUrl,
                                headers: {
                                  Authorization: `Bearer ${createdPlaintextKey}`,
                                },
                              },
                            },
                          },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400 font-mono text-[11px] bg-zinc-950/50">
                      <th className="py-2.5 px-4">Label</th>
                      <th className="py-2.5 px-4">Owner</th>
                      <th className="py-2.5 px-4">Key Prefix</th>
                      <th className="py-2.5 px-4">Created</th>
                      <th className="py-2.5 px-4">Last Used</th>
                      <th className="py-2.5 px-4">Status</th>
                      <th className="py-2.5 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {keys.map((k) => (
                      <tr key={k.id} className="hover:bg-zinc-800/30">
                        <td className="py-2.5 px-4 font-medium text-zinc-200">{k.name}</td>
                        <td className="py-2.5 px-4 font-mono text-zinc-400">{k.user_email}</td>
                        <td className="py-2.5 px-4 font-mono text-emerald-300">
                          mcpg_{k.prefix}_••••••••
                        </td>
                        <td className="py-2.5 px-4 font-mono text-zinc-400">
                          {new Date(k.created_at).toLocaleString()}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-zinc-400">
                          {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never"}
                        </td>
                        <td className="py-2.5 px-4">
                          {k.revoked_at ? (
                            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-red-500/15 text-red-300 border border-red-500/30">
                              Revoked
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              Active
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          {!k.revoked_at && (
                            <button
                              onClick={() => handleRevokeKey(k.id)}
                              className="px-2.5 py-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-[11px] font-mono"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {keys.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-6 text-center text-zinc-500">
                          No API keys generated yet. Create one above to connect Claude Code or MCP
                          Inspector.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: AUDIT LOG */}
          {activeTab === "audit" && (
            <div className="max-w-6xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Tool Execution Audit Trail</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Every <code className="font-mono text-zinc-300">tools/call</code> invocation (via
                    external MCP client or internal Chat agent) is recorded with user attribution and
                    latency.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={auditFilters.server}
                    onChange={(e) => setAuditFilters({ ...auditFilters, server: e.target.value })}
                    className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                  >
                    <option value="">All Servers</option>
                    {servers.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.slug}
                      </option>
                    ))}
                  </select>

                  <select
                    value={auditFilters.outcome}
                    onChange={(e) => setAuditFilters({ ...auditFilters, outcome: e.target.value })}
                    className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                  >
                    <option value="">All Outcomes</option>
                    <option value="success">success</option>
                    <option value="denied">denied</option>
                    <option value="error">error</option>
                    <option value="timeout">timeout</option>
                  </select>

                  <select
                    value={auditFilters.source}
                    onChange={(e) => setAuditFilters({ ...auditFilters, source: e.target.value })}
                    className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                  >
                    <option value="">All Sources</option>
                    <option value="mcp">mcp</option>
                    <option value="chat">chat</option>
                  </select>

                  <button
                    onClick={loadAudit}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400 font-mono text-[11px] bg-zinc-950/50">
                      <th className="py-2.5 px-3">Timestamp</th>
                      <th className="py-2.5 px-3">Principal</th>
                      <th className="py-2.5 px-3">Source</th>
                      <th className="py-2.5 px-3">Server</th>
                      <th className="py-2.5 px-3">Tool Name</th>
                      <th className="py-2.5 px-3">Duration</th>
                      <th className="py-2.5 px-3">Outcome</th>
                      <th className="py-2.5 px-3">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70 font-mono">
                    {auditEntries.map((a) => (
                      <tr key={a.id} className="hover:bg-zinc-800/30">
                        <td className="py-2 px-3 text-zinc-400 text-[11px]">
                          {new Date(a.ts).toLocaleTimeString()}
                        </td>
                        <td className="py-2 px-3 text-zinc-200">{a.user_email}</td>
                        <td className="py-2 px-3">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                              a.source === "chat"
                                ? "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                                : "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                            }`}
                          >
                            {a.source}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-emerald-300">{a.server_slug}</td>
                        <td className="py-2 px-3 text-zinc-200">{a.tool_name}</td>
                        <td className="py-2 px-3 text-zinc-400">{a.duration_ms} ms</td>
                        <td className="py-2 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] uppercase ${
                              a.outcome === "success"
                                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                                : a.outcome === "denied"
                                  ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                  : "bg-red-500/15 text-red-300 border border-red-500/30"
                            }`}
                          >
                            {a.outcome}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[11px] text-zinc-400 max-w-xs truncate">
                          {a.error_message ?? "—"}
                        </td>
                      </tr>
                    ))}
                    {auditEntries.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-6 text-center text-zinc-500 font-sans">
                          No audit entries recorded matching current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: TEAM & RBAC */}
          {activeTab === "team" && (
            <div className="max-w-5xl space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Team Members &amp; Role-Based Tool Policy</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Manage gateway users, one-time invite tokens, and fine-grained tool allow/deny
                  rules enforced in both <code className="font-mono">tools/list</code> and{" "}
                  <code className="font-mono">tools/call</code>.
                </p>
              </div>

              {user.role === "admin" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <form
                    onSubmit={handleCreateInvite}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3"
                  >
                    <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-emerald-400" /> Create One-Time Team Invite
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="teammate@urumi.local"
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs"
                        required
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as any)}
                        className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs"
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                      >
                        Create Invite
                      </button>
                    </div>
                    {generatedInviteLink && (
                      <div className="p-2.5 rounded bg-zinc-950 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 break-all">
                        One-time invite URL: {generatedInviteLink}
                      </div>
                    )}
                  </form>

                  <form
                    onSubmit={handleAddPermission}
                    className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3"
                  >
                    <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                      <Shield className="w-4 h-4 text-amber-400" /> Add / Update Tool RBAC Rule
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <select
                        value={newPerm.role}
                        onChange={(e) => setNewPerm({ ...newPerm, role: e.target.value })}
                        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                      <input
                        value={newPerm.serverSlug}
                        onChange={(e) => setNewPerm({ ...newPerm, serverSlug: e.target.value })}
                        placeholder="server (or *)"
                        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      />
                      <input
                        value={newPerm.toolName}
                        onChange={(e) => setNewPerm({ ...newPerm, toolName: e.target.value })}
                        placeholder="tool (or *)"
                        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      />
                      <select
                        value={newPerm.effect}
                        onChange={(e) => setNewPerm({ ...newPerm, effect: e.target.value })}
                        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs font-mono"
                      >
                        <option value="deny">deny</option>
                        <option value="allow">allow</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      className="w-full py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-medium"
                    >
                      Save RBAC Policy Rule
                    </button>
                  </form>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
                    Active Tool Permission Rules
                  </div>
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-400 text-[11px] bg-zinc-950/50">
                        <th className="py-2 px-3">Role</th>
                        <th className="py-2 px-3">Server</th>
                        <th className="py-2 px-3">Tool</th>
                        <th className="py-2 px-3">Effect</th>
                        <th className="py-2 px-3 text-right"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/70">
                      {permissions.map((p) => (
                        <tr key={p.id}>
                          <td className="py-2 px-3 text-zinc-200">{p.role}</td>
                          <td className="py-2 px-3 text-emerald-300">{p.server_slug}</td>
                          <td className="py-2 px-3 text-zinc-200">{p.tool_name}</td>
                          <td className="py-2 px-3">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                                p.effect === "allow"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-red-500/15 text-red-300"
                              }`}
                            >
                              {p.effect}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            {user.role === "admin" && (
                              <button
                                onClick={() => handleDeletePermission(p.id)}
                                className="text-zinc-500 hover:text-red-400"
                              >
                                <XCircle className="w-3.5 h-3.5 inline" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {user.role === "admin" && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
                      Registered Team Accounts
                    </div>
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-400 font-mono text-[11px] bg-zinc-950/50">
                          <th className="py-2 px-3">Name</th>
                          <th className="py-2 px-3">Email</th>
                          <th className="py-2 px-3">Role</th>
                          <th className="py-2 px-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70">
                        {teamUsers.map((u) => (
                          <tr key={u.id}>
                            <td className="py-2 px-3 font-medium text-zinc-200">{u.name}</td>
                            <td className="py-2 px-3 font-mono text-zinc-400">{u.email}</td>
                            <td className="py-2 px-3 font-mono text-emerald-300">{u.role}</td>
                            <td className="py-2 px-3 font-mono text-zinc-400">{u.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
