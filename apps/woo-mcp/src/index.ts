import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3000);
const WP_INTERNAL_URL = (process.env.WP_INTERNAL_URL ?? "http://wordpress").replace(/\/+$/, "");
const STORE_HOST = process.env.STORE_HOST ?? "store.127.0.0.1.nip.io";
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY ?? "";
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET ?? "";
const WOO_MCP_TOKEN = process.env.WOO_MCP_TOKEN ?? "";
const WC_TIMEOUT_MS = Number(process.env.WC_TIMEOUT_MS ?? 10000);

if (!WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
  console.warn("[woo-mcp] warning: WC_CONSUMER_KEY or WC_CONSUMER_SECRET is not set");
}

function verifyBearer(header: string | undefined): boolean {
  if (!WOO_MCP_TOKEN) return false;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(WOO_MCP_TOKEN, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

interface WcRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Calls WooCommerce REST API v3 over the in-cluster WordPress Service.
 * Sends `Host: STORE_HOST` to prevent WordPress canonical redirects and
 * `X-Forwarded-Proto: https` so WordPress sets $_SERVER['HTTPS']='on',
 * allowing standard HTTP Basic Auth with consumer_key:consumer_secret.
 */
async function wcRequest<T = any>(path: string, opts: WcRequestOptions = {}): Promise<T> {
  const url = new URL(`/wp-json/wc/v3${path}`, WP_INTERNAL_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const basicAuth = Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`, "utf8").toString("base64");
  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Host: STORE_HOST,
      "X-Forwarded-Proto": "https",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(WC_TIMEOUT_MS),
  });

  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }

  if (!res.ok) {
    const msg = data?.message || data?.code || `WooCommerce HTTP ${res.status}`;
    throw new Error(`WooCommerce API error (${res.status}): ${msg}`);
  }

  return data as T;
}

function trimProduct(p: any) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
    type: p.type,
    price: p.price,
    regular_price: p.regular_price,
    stock_status: p.stock_status,
    description: typeof p.short_description === "string" && p.short_description
      ? p.short_description.replace(/<[^>]+>/g, "").trim()
      : typeof p.description === "string"
        ? p.description.replace(/<[^>]+>/g, "").trim()
        : "",
    permalink: p.permalink,
    date_created: p.date_created_gmt ?? p.date_created,
  };
}

function trimOrder(o: any) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    currency: o.currency,
    total: o.total,
    payment_method: o.payment_method,
    payment_method_title: o.payment_method_title,
    date_created: o.date_created,
    date_created_gmt: o.date_created_gmt,
    customer: {
      first_name: o.billing?.first_name ?? "",
      last_name: o.billing?.last_name ?? "",
      email: o.billing?.email ?? "",
      city: o.billing?.city ?? "",
    },
    line_items: Array.isArray(o.line_items)
      ? o.line_items.map((li: any) => ({
          product_id: li.product_id,
          name: li.name,
          quantity: li.quantity,
          total: li.total,
        }))
      : [],
  };
}

function okResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "woo-mcp",
    version: "1.0.0",
  });

  server.tool(
    "list_products",
    "List products from the WooCommerce store catalog with optional search and pagination",
    {
      search: z.string().optional().describe("Keyword search filter"),
      per_page: z.number().int().min(1).max(50).optional().default(20).describe("Results per page (max 50)"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      status: z.enum(["any", "publish", "draft", "pending", "private"]).optional().default("publish"),
    },
    async ({ search, per_page, page, status }) => {
      try {
        const rows = await wcRequest<any[]>("/products", {
          query: { search, per_page, page, status },
        });
        return okResult({ count: rows.length, products: rows.map(trimProduct) });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "get_product",
    "Retrieve details for a single WooCommerce product by ID",
    {
      id: z.number().int().positive().describe("WooCommerce product ID"),
    },
    async ({ id }) => {
      try {
        const product = await wcRequest<any>(`/products/${id}`);
        return okResult(trimProduct(product));
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "create_product",
    "Create a new product in the WooCommerce store",
    {
      name: z.string().min(1).describe("Product title"),
      regular_price: z.union([z.string(), z.number()]).describe("Product price, e.g. '12.50'"),
      description: z.string().optional().describe("Product description"),
      status: z.enum(["publish", "draft", "pending", "private"]).optional().default("publish"),
      type: z.enum(["simple", "grouped", "external", "variable"]).optional().default("simple"),
    },
    async ({ name, regular_price, description, status, type }) => {
      try {
        const priceStr = typeof regular_price === "number" ? regular_price.toFixed(2) : String(regular_price);
        const created = await wcRequest<any>("/products", {
          method: "POST",
          body: {
            name,
            regular_price: priceStr,
            description: description ?? "",
            short_description: description ?? "",
            status,
            type,
          },
        });
        return okResult(trimProduct(created));
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "update_product",
    "Update an existing WooCommerce product's name, price, description, or status",
    {
      id: z.number().int().positive().describe("WooCommerce product ID"),
      name: z.string().optional().describe("Updated product title"),
      regular_price: z.union([z.string(), z.number()]).optional().describe("Updated price"),
      description: z.string().optional().describe("Updated description"),
      status: z.enum(["publish", "draft", "pending", "private"]).optional(),
    },
    async ({ id, name, regular_price, description, status }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (regular_price !== undefined) {
          body.regular_price = typeof regular_price === "number" ? regular_price.toFixed(2) : String(regular_price);
        }
        if (description !== undefined) {
          body.description = description;
          body.short_description = description;
        }
        if (status !== undefined) body.status = status;

        const updated = await wcRequest<any>(`/products/${id}`, {
          method: "PUT",
          body,
        });
        return okResult(trimProduct(updated));
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "list_orders",
    "List WooCommerce customer orders. Dates accept ISO-8601 strings (e.g. 2026-10-24T00:00:00Z).",
    {
      status: z
        .enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"])
        .optional()
        .default("any"),
      after: z.string().optional().describe("ISO-8601 timestamp; limit to orders placed after this date"),
      before: z.string().optional().describe("ISO-8601 timestamp; limit to orders placed before this date"),
      per_page: z.number().int().min(1).max(50).optional().default(20),
      page: z.number().int().min(1).optional().default(1),
    },
    async ({ status, after, before, per_page, page }) => {
      try {
        const rows = await wcRequest<any[]>("/orders", {
          query: { status, after, before, per_page, page },
        });
        return okResult({ count: rows.length, orders: rows.map(trimOrder) });
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "get_order",
    "Retrieve full details for a single WooCommerce order by ID",
    {
      id: z.number().int().positive().describe("WooCommerce order ID"),
    },
    async ({ id }) => {
      try {
        const order = await wcRequest<any>(`/orders/${id}`);
        return okResult(trimOrder(order));
      } catch (err) {
        return errResult(err);
      }
    }
  );

  server.tool(
    "update_order_status",
    "Update the fulfillment status of a WooCommerce order",
    {
      id: z.number().int().positive().describe("WooCommerce order ID"),
      status: z
        .enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"])
        .describe("Target order status"),
    },
    async ({ id, status }) => {
      try {
        const updated = await wcRequest<any>(`/orders/${id}`, {
          method: "PUT",
          body: { status },
        });
        return okResult(trimOrder(updated));
      } catch (err) {
        return errResult(err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "woo-mcp" });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!verifyBearer(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid or missing bearer token" },
      id: null,
    });
    return;
  }
  next();
}

// Stateless Streamable HTTP MCP transport: new server + transport instance per request
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = createServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[woo-mcp] transport error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP transport error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", requireAuth, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless Streamable HTTP mode" },
    id: null,
  });
});

app.delete("/mcp", requireAuth, (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless Streamable HTTP mode" },
    id: null,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[woo-mcp] listening on 0.0.0.0:${PORT} (target=${WP_INTERNAL_URL}, host=${STORE_HOST})`);
});
