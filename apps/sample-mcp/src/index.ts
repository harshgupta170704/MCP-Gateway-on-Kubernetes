import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3000);
const SERVER_MODE = (process.env.SERVER_MODE ?? "utility") as "utility" | "everything";
const AUTH_TOKEN = process.env.SAMPLE_MCP_TOKEN ?? "";

interface NoteItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

const notesStore: NoteItem[] = [
  {
    id: "note-1",
    title: "Supplier Restock Schedule",
    body: "Mechanical keyboard switches restock every Tuesday at 09:00 UTC.",
    createdAt: new Date().toISOString(),
  },
  {
    id: "note-2",
    title: "Fulfillment SLA",
    body: "Same-day dispatch applies to Cash on Delivery orders placed before 16:00 local time.",
    createdAt: new Date().toISOString(),
  },
];

const warehouseCatalog = [
  { sku: "WH-KB-01", name: "Tactile Switch Pack (90x)", bin: "A-14", unit_cost: "22.00" },
  { sku: "WH-HB-02", name: "USB-C Braided Cable 2m", bin: "B-03", unit_cost: "4.50" },
  { sku: "WH-MS-03", name: "PTFE Mouse Skates Set", bin: "C-09", unit_cost: "3.20" },
];

function verifyAuth(header: string | undefined): boolean {
  if (!AUTH_TOKEN) return true;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(AUTH_TOKEN, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function createUtilityServer(): McpServer {
  const server = new McpServer({
    name: "utility-mcp",
    version: "1.0.0",
  });

  server.tool(
    "echo",
    "Echo back a provided string message",
    { message: z.string().describe("Message to echo back") },
    async ({ message }) => ({
      content: [{ type: "text", text: JSON.stringify({ echoed: message, server: "utility-mcp" }) }],
    })
  );

  server.tool(
    "add",
    "Calculate the sum of two numbers",
    {
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: JSON.stringify({ a, b, sum: a + b }) }],
    })
  );

  server.tool(
    "current_time",
    "Return the current UTC and formatted server timestamp",
    {
      timezone: z.string().optional().default("UTC").describe("IANA timezone, e.g. 'UTC' or 'Asia/Kolkata'"),
    },
    async ({ timezone }) => {
      const now = new Date();
      let formatted = now.toISOString();
      try {
        formatted = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(now);
      } catch {
        // fallback to ISO if invalid timezone string
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              iso: now.toISOString(),
              date_only: now.toISOString().slice(0, 10),
              timezone,
              formatted,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "list_notes",
    "List team operational notes stored in the utility server",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ count: notesStore.length, notes: notesStore }, null, 2) }],
    })
  );

  server.tool(
    "save_note",
    "Save a new operational note to the utility server",
    {
      title: z.string().min(1).describe("Short note title"),
      body: z.string().min(1).describe("Note content"),
    },
    async ({ title, body }) => {
      const item: NoteItem = {
        id: `note-${notesStore.length + 1}`,
        title,
        body,
        createdAt: new Date().toISOString(),
      };
      notesStore.push(item);
      return {
        content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
      };
    }
  );

  // Deliberate tool name collision with woo-mcp's `list_products` to demonstrate
  // gateway namespace disambiguation (`woo__list_products` vs `utility__list_products`).
  server.tool(
    "list_products",
    "List internal warehouse wholesale SKU items (collides with woo-mcp list_products)",
    {
      search: z.string().optional().describe("Optional filter by SKU or item name"),
    },
    async ({ search }) => {
      const q = search?.toLowerCase().trim();
      const items = q
        ? warehouseCatalog.filter(
            (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)
          )
        : warehouseCatalog;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { source: "internal-warehouse-utility", count: items.length, items },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

function createEverythingServer(): McpServer {
  const server = new McpServer({
    name: "everything-mcp",
    version: "1.0.0",
  });

  server.tool(
    "echo",
    "Echoes back the input string (Everything reference server)",
    { message: z.string().describe("Message to echo") },
    async ({ message }) => ({
      content: [{ type: "text", text: `Everything echo: ${message}` }],
    })
  );

  server.tool(
    "add",
    "Adds two numbers together (Everything reference server)",
    { a: z.number(), b: z.number() },
    async ({ a, b }) => ({
      content: [{ type: "text", text: `The sum of ${a} and ${b} is ${a + b}.` }],
    })
  );

  server.tool(
    "longRunningOperation",
    "Demonstrates a bounded asynchronous operation with configurable duration",
    {
      durationMs: z.number().int().min(10).max(5000).optional().default(250),
      steps: z.number().int().min(1).max(10).optional().default(3),
    },
    async ({ durationMs, steps }) => {
      await new Promise((r) => setTimeout(r, durationMs));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              completed: true,
              durationMs,
              stepsCompleted: steps,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "annotatedMessage",
    "Generates a message with priority and audience metadata annotations",
    {
      messageType: z.enum(["info", "warning", "error"]).default("info"),
      includeMetadata: z.boolean().optional().default(true),
    },
    async ({ messageType, includeMetadata }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messageType,
            message: `Diagnostic ${messageType} payload from everything-mcp`,
            metadata: includeMetadata ? { priority: messageType === "error" ? 1.0 : 0.5 } : undefined,
          }),
        },
      ],
    })
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: `${SERVER_MODE}-mcp` });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!verifyAuth(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = SERVER_MODE === "everything" ? createEverythingServer() : createUtilityServer();
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
    console.error(`[${SERVER_MODE}-mcp] error:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal transport error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", requireAuth, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Stateless Streamable HTTP mode does not support GET SSE streams" },
    id: null,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${SERVER_MODE}-mcp] listening on 0.0.0.0:${PORT}`);
});
