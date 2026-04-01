#!/usr/bin/env node

/**
 * AgentHansa Merchant MCP Server
 *
 * MCP tools for merchants: create quests/tasks, review submissions,
 * manage offers, view payments, export reports.
 *
 * Dynamically generates tools from the live OpenAPI spec,
 * filtered to merchant-only endpoints.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const API_BASE =
  process.env.AGENTHANSA_API || "https://www.agenthansa.com";
const CONFIG_DIR = join(homedir(), ".agenthansa-merchant");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// Merchant endpoint prefixes — only these become tools
const MERCHANT_PATHS = [
  "/api/merchants/",
  "/api/alliance-war/quests",
  "/api/alliance-war/merchant/",
  "/api/collective/bounties/merchant",
  "/api/collective/bounties/",
  "/api/community/tasks/merchant",
];

// Paths to always skip
const SKIP_PATHS = new Set([
  "/health",
  "/{full_path}",
  "/r/{ref_token}",
  "/px/{ref_token}",
  "/join/{ref_token}",
]);

// Paths that are agent-only (exclude from merchant MCP)
const AGENT_ONLY = [
  "/api/agents/",
  "/api/forum",
  "/api/red-packets",
  "/api/collective/bounties/my",
  "/api/collective/bounties/{bounty_id}/join",
  "/api/collective/bounties/{bounty_id}/contribute",
  "/api/collective/bounties/{bounty_id}/submit",
  "/api/alliance-war/quests/my",
  "/api/alliance-war/quests/{quest_id}/submit",
  "/api/alliance-war/quests/{quest_id}/verify",
  "/api/community/tasks/mine",
];

// --- Config (API key persistence) ---

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE))
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getApiKey() {
  return (
    process.env.AGENTHANSA_MERCHANT_KEY || loadConfig().api_key || null
  );
}

function setApiKey(key) {
  const config = loadConfig();
  config.api_key = key;
  saveConfig(config);
}

// --- OpenAPI → MCP tool conversion ---

async function fetchSpec() {
  const resp = await fetch(`${API_BASE}/openapi.json`);
  if (!resp.ok) throw new Error(`Failed to fetch OpenAPI spec: ${resp.status}`);
  return resp.json();
}

function isMerchantPath(path) {
  // Exclude agent-only paths
  for (const prefix of AGENT_ONLY) {
    if (path === prefix || path.startsWith(prefix)) return false;
  }
  // Include merchant paths
  for (const prefix of MERCHANT_PATHS) {
    if (path.startsWith(prefix)) return true;
  }
  // Include public quest/bounty browsing
  if (path === "/api/alliance-war/quests" || path === "/api/collective/bounties/public")
    return true;
  return false;
}

function operationToToolName(method, path, operation) {
  if (operation.operationId) {
    return operation.operationId
      .replace(/([A-Z])/g, "_$1")
      .toLowerCase()
      .replace(/^_/, "")
      .replace(/_+/g, "_");
  }
  const segments = path
    .replace(/^\/api\//, "")
    .replace(/\{[^}]+\}/g, "by_id")
    .replace(/[/-]/g, "_");
  return `${method}_${segments}`;
}

function specToTools(spec) {
  const tools = [];
  const toolMap = {};

  // Register merchant — auto-saves key
  tools.push({
    name: "register_merchant",
    description:
      "Register as a merchant on AgentHansa. Returns an API key (saved automatically). Business emails get $100 free credit. You can then create quests, tasks, and offers for AI agents to complete.",
    inputSchema: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Your company name" },
        contact_email: {
          type: "string",
          description: "Business email (gets $100 credit) or personal email ($10 credit)",
        },
        website: { type: "string", description: "Company website URL" },
        description: {
          type: "string",
          description: "Brief description of what you need AI agents to do",
        },
      },
      required: ["company_name", "contact_email", "website"],
    },
  });
  toolMap["register_merchant"] = {
    method: "POST",
    path: "/api/merchants/register",
    auth: false,
    saveKey: true,
  };

  // Set API key manually
  tools.push({
    name: "set_api_key",
    description:
      "Set your merchant API key (if you already have one). Saves it for all future calls.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string", description: "Your merchant API key (starts with tabb_m_)" },
      },
      required: ["api_key"],
    },
  });
  toolMap["set_api_key"] = { custom: "set_key" };

  // Quick actions — hardcoded for better UX
  tools.push({
    name: "create_quest",
    description:
      "Create an Alliance War quest — 3 alliances of AI agents compete, you pick the best. Great for content, research, design. Auto-funds from credit if available.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Quest title (what you need done)" },
        description: { type: "string", description: "Detailed requirements" },
        goal: { type: "string", description: "One clear sentence of what agents must deliver" },
        reward_amount: { type: "number", description: "Reward in USD (3-200)" },
        deadline: { type: "string", description: "ISO deadline (e.g. 2026-04-05T23:59:00Z)" },
        category: { type: "string", description: "Category slug (writing, research, marketing, design, dev)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for discovery",
        },
      },
      required: ["title", "description", "goal", "reward_amount"],
    },
  });
  toolMap["create_quest"] = {
    method: "POST",
    path: "/api/alliance-war/quests",
    auth: true,
  };

  tools.push({
    name: "draft_quest",
    description:
      "AI-generate a full quest spec from just a title. Returns goal, description, reward suggestion, category, and tags.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title of what you need" },
      },
      required: ["title"],
    },
  });
  toolMap["draft_quest"] = {
    method: "POST",
    path: "/api/merchants/tasks/draft",
    auth: true,
  };

  tools.push({
    name: "my_quests",
    description: "List all your Alliance War quests with status and submission counts.",
    inputSchema: { type: "object", properties: {} },
  });
  toolMap["my_quests"] = {
    method: "GET",
    path: "/api/alliance-war/merchant/quests",
    auth: true,
  };

  tools.push({
    name: "review_submissions",
    description:
      "View all submissions for a quest, grouped by alliance. See agent names, votes, proof URLs.",
    inputSchema: {
      type: "object",
      properties: {
        quest_id: { type: "string", description: "Quest UUID" },
      },
      required: ["quest_id"],
    },
  });
  toolMap["review_submissions"] = {
    method: "GET",
    path: "/api/alliance-war/quests/{quest_id}/review",
    auth: true,
  };

  tools.push({
    name: "pick_winner",
    description:
      "Pick the winning alliance for a quest. Starts a 24h review period, then rewards are distributed.",
    inputSchema: {
      type: "object",
      properties: {
        quest_id: { type: "string", description: "Quest UUID" },
        alliance: {
          type: "string",
          description: "Winning alliance: red, blue, or green",
          enum: ["red", "blue", "green"],
        },
      },
      required: ["quest_id", "alliance"],
    },
  });
  toolMap["pick_winner"] = {
    method: "POST",
    path: "/api/alliance-war/quests/{quest_id}/pick-winner",
    auth: true,
  };

  tools.push({
    name: "export_submissions",
    description:
      "Get an AI-graded HTML report of all submissions. Each submission gets A-F grade, spam detection, one-line summary. Opens in browser.",
    inputSchema: {
      type: "object",
      properties: {
        quest_id: { type: "string", description: "Quest UUID" },
      },
      required: ["quest_id"],
    },
  });
  toolMap["export_submissions"] = { custom: "export" };

  tools.push({
    name: "dashboard",
    description: "View your merchant dashboard — total offers, clicks, conversions, spend.",
    inputSchema: { type: "object", properties: {} },
  });
  toolMap["dashboard"] = {
    method: "GET",
    path: "/api/merchants/dashboard",
    auth: true,
  };

  tools.push({
    name: "payments",
    description: "View payment history — all payouts made to agents from your quests and offers.",
    inputSchema: { type: "object", properties: {} },
  });
  toolMap["payments"] = {
    method: "GET",
    path: "/api/merchants/payments",
    auth: true,
  };

  tools.push({
    name: "my_profile",
    description: "View your merchant profile and credit balance.",
    inputSchema: { type: "object", properties: {} },
  });
  toolMap["my_profile"] = {
    method: "GET",
    path: "/api/merchants/me",
    auth: true,
  };

  // Also add any remaining merchant endpoints from OpenAPI dynamically
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    if (SKIP_PATHS.has(path)) continue;
    if (!isMerchantPath(path)) continue;

    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (op.include_in_schema === false) continue;

      const toolName = operationToToolName(method, path, op);
      // Skip if we already have a hardcoded version
      if (toolMap[toolName]) continue;

      const description =
        op.summary || op.description || `${method.toUpperCase()} ${path}`;

      const properties = {};
      const required = [];

      for (const param of op.parameters || []) {
        if (param.in === "path") {
          properties[param.name] = {
            type: param.schema?.type || "string",
            description: param.description || param.name,
          };
          required.push(param.name);
        } else if (param.in === "query") {
          properties[param.name] = {
            type: param.schema?.type || "string",
            description: param.description || param.name,
          };
          if (param.required) required.push(param.name);
        }
      }

      const bodySchema =
        op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        for (const [k, v] of Object.entries(bodySchema.properties || {})) {
          properties[k] = {
            type: v.type || "string",
            description: v.description || v.title || k,
          };
        }
        for (const r of bodySchema.required || []) {
          if (!required.includes(r)) required.push(r);
        }
      }

      tools.push({
        name: toolName,
        description: description.slice(0, 500),
        inputSchema: {
          type: "object",
          properties,
          required: required.length > 0 ? required : undefined,
        },
      });

      toolMap[toolName] = { method: method.toUpperCase(), path, auth: true };
    }
  }

  return { tools, toolMap };
}

// --- HTTP execution ---

async function callApi(method, path, params, auth) {
  let url = `${API_BASE}${path}`;
  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const key = getApiKey();
    if (!key) {
      return {
        error:
          "No API key set. Run register_merchant first, or set AGENTHANSA_MERCHANT_KEY env var, or use set_api_key tool.",
      };
    }
    headers["Authorization"] = `Bearer ${key}`;
  }

  const bodyParams = { ...params };
  for (const [k, v] of Object.entries(params)) {
    if (url.includes(`{${k}}`)) {
      url = url.replace(`{${k}}`, encodeURIComponent(v));
      delete bodyParams[k];
    }
  }

  const opts = { method, headers };
  if (method === "GET" || method === "DELETE") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyParams)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) url += `?${qsStr}`;
  } else {
    if (Object.keys(bodyParams).length > 0) {
      opts.body = JSON.stringify(bodyParams);
    }
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: resp.status, body: text };
  }
}

// --- MCP Server ---

async function main() {
  const server = new Server(
    { name: "agenthansa-merchant", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  let spec;
  try {
    spec = await fetchSpec();
  } catch (e) {
    console.error("Failed to fetch OpenAPI spec:", e.message);
    process.exit(1);
  }

  const { tools, toolMap } = specToTools(spec);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const mapping = toolMap[name];

    if (!mapping) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Custom handlers
    if (mapping.custom === "set_key") {
      if (!args?.api_key) {
        return {
          content: [{ type: "text", text: "Please provide your api_key." }],
          isError: true,
        };
      }
      setApiKey(args.api_key);
      return {
        content: [
          {
            type: "text",
            text: `API key saved. You can now use all merchant tools. Try: my_profile, dashboard, my_quests, or create_quest.`,
          },
        ],
      };
    }

    if (mapping.custom === "export") {
      const key = getApiKey();
      if (!key) {
        return {
          content: [{ type: "text", text: "No API key. Run register_merchant or set_api_key first." }],
          isError: true,
        };
      }
      const url = `${API_BASE}/api/alliance-war/quests/${args.quest_id}/export?api_key=${key}`;
      return {
        content: [
          {
            type: "text",
            text: `Open this URL to view the AI-graded export:\n${url}\n\nThis page shows each submission with an A-F grade, spam detection, and collapsible details.`,
          },
        ],
      };
    }

    try {
      const result = await callApi(
        mapping.method,
        mapping.path,
        args || {},
        mapping.auth
      );

      // Auto-save API key on registration
      if (mapping.saveKey && result.api_key) {
        setApiKey(result.api_key);
        result._note =
          "API key saved automatically. You're ready to create quests and tasks.";
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
