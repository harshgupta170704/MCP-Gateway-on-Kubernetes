import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const RAW_MASTER_KEY = process.env.GATEWAY_ENCRYPTION_KEY ?? "default-dev-master-key-do-not-use-in-prod";
const SESSION_SECRET = process.env.GATEWAY_SESSION_SECRET ?? "default-dev-session-secret";

// Derive a 32-byte key from the configured secret for AES-256-GCM
const MASTER_KEY = crypto.createHash("sha256").update(RAW_MASTER_KEY, "utf8").digest();

/**
 * Encrypts an upstream credential with AES-256-GCM.
 * Stored format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encryptCredential(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptCredential(packed: string | null | undefined): string {
  if (!packed) return "";
  const parts = packed.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted credential format");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Password hashing with scrypt + 16-byte salt and constant-time comparison.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(keyHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Generates an API key with format: mcpg_<8char_prefix>_<32bytes_base64url>
 * High entropy (256 bits) allows fast SHA-256 hashing without brute-force risk.
 */
export function generateApiKey(): { plaintext: string; prefix: string; keyHash: string } {
  const prefix = crypto.randomBytes(4).toString("hex");
  const secretPart = crypto.randomBytes(32).toString("base64url");
  const plaintext = `mcpg_${prefix}_${secretPart}`;
  const keyHash = hashToken(plaintext);
  return { plaintext, prefix, keyHash };
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function safeCompareHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "utf8");
  const b = Buffer.from(bHex, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface SignedTokenPayload {
  sub: string;
  email: string;
  role: "admin" | "member";
  purpose: "session" | "chat";
  exp: number;
}

export function signToken(payload: SignedTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${payload.purpose === "chat" ? "chat_" : ""}${body}.${sig}`;
}

export function verifyToken(rawToken: string, expectedPurpose: "session" | "chat"): SignedTokenPayload | null {
  const stripped = expectedPurpose === "chat" && rawToken.startsWith("chat_")
    ? rawToken.slice("chat_".length)
    : rawToken;
  const parts = stripped.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedTokenPayload;
    if (parsed.purpose !== expectedPurpose) return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBlockedIp(ip: string, allowPrivateClusterIp: boolean): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    // Loopback 127.0.0.0/8 or 0.0.0.0/8
    if (parts[0] === 127 || parts[0] === 0) return true;
    // Cloud metadata / link-local 169.254.0.0/16 (AWS/GCP/Azure IMDS)
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (!allowPrivateClusterIp) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
    }
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === "::1" || norm === "::" || norm.startsWith("fe80:")) return true;
    if (!allowPrivateClusterIp && (norm.startsWith("fc") || norm.startsWith("fd"))) return true;
  }
  return false;
}

/**
 * SSRF validation for admin-registered upstream MCP server URLs.
 * Blocks loopback (127.0.0.1/localhost), link-local cloud metadata (169.254.169.254),
 * and arbitrary RFC1918 addresses unless the hostname matches a known in-cluster service name.
 */
export async function validateUpstreamUrl(
  rawUrl: string,
  allowedInternalSuffixes: string[]
): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "Invalid URL syntax" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: "Only http:// and https:// protocols are permitted" };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "169.254.169.254") {
    return { valid: false, reason: `SSRF guard blocked forbidden host '${host}'` };
  }

  // Allow bare Kubernetes service names in the same namespace (e.g. 'woo-mcp', 'sample-mcp')
  // or FQDNs matching configured cluster suffixes (.svc, .svc.cluster.local)
  const isClusterService =
    /^[a-z0-9-]+$/.test(host) ||
    allowedInternalSuffixes.some((suffix) => host.endsWith(suffix.toLowerCase()));

  if (net.isIP(host)) {
    if (isBlockedIp(host, false)) {
      return { valid: false, reason: `SSRF guard blocked IP address '${host}'` };
    }
    return { valid: true };
  }

  try {
    const records = await dns.lookup(host, { all: true });
    for (const rec of records) {
      if (isBlockedIp(rec.address, isClusterService)) {
        return {
          valid: false,
          reason: `Host '${host}' resolved to blocked address ${rec.address}`,
        };
      }
    }
  } catch {
    // Host may not be resolvable yet if the upstream Deployment is still starting;
    // permit if it is a valid cluster service name, otherwise reject.
    if (!isClusterService) {
      return { valid: false, reason: `Could not resolve external host '${host}'` };
    }
  }

  return { valid: true };
}
