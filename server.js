import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { config } from "dotenv";

config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── ResurgeAI Config ────────────────────────────────────────────────────────
const RESURGE_API_URL = "https://api.resurge.one/v1/chat/completions";
const RESURGE_API_KEY = process.env.RESURGE_API_KEY || "";
const MODEL = process.env.MODEL || "glm-5";

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── System Prompt Injector ───────────────────────────────────────────────────
// Injects a strong roleplay system prompt if none is present or enhances the
// existing one — this is the core fix for GLM-5's weak instruction following
// in long creative/roleplay contexts.
function buildSystemPrompt(existingSystem) {
  const roleplayCore = `You are an expert, immersive roleplay AI assistant. Follow these rules strictly:

1. NEVER stop mid-sentence. Always complete every sentence, paragraph, and thought fully before ending your reply.
2. Always write responses that feel natural, vivid, and in-character. Match the tone and style of the conversation.
3. Never break the fourth wall or mention being an AI unless directly asked by the user outside of roleplay context.
4. Write rich, descriptive prose. Use sensory details, emotions, and actions to bring the scene to life.
5. Match the length and energy of the user's message — short prompts get focused replies, detailed prompts get full scenes.
6. If the user sets up a character or scenario, stay in that frame consistently throughout the conversation.
7. Never abruptly end a reply. If you are close to the token limit, gracefully wrap up the current beat of the scene.
8. Use proper grammar, punctuation, and paragraph breaks for readability.`;

  if (!existingSystem || existingSystem.trim() === "") {
    return roleplayCore;
  }

  // Append the roleplay rules to an existing system prompt without overriding it
  return `${existingSystem.trim()}\n\n---\n${roleplayCore}`;
}

// ─── Message Sanitizer ────────────────────────────────────────────────────────
// Cleans up messages and ensures the array is valid before sending upstream
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((m) => m && typeof m === "object" && m.role && m.content)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.trim() : m.content,
    }))
    .filter((m) => m.content !== "");
}

// ─── GLM-5 Parameter Fixer ────────────────────────────────────────────────────
// These are the key fixes for GLM-5's mid-sentence stopping and weak output:
//
//  • max_tokens      — GLM-5 defaults very low; we push it up significantly
//  • stop            — GLM-5 has aggressive built-in stop sequences; clearing
//                      them prevents premature truncation in roleplay
//  • temperature     — Slightly higher for creative variety without incoherence
//  • top_p           — Balanced for fluency in long-form creative writing
//  • frequency_penalty — Reduces repetitive loops common in GLM-5 long outputs
//  • presence_penalty  — Encourages new ideas / scene progression
function buildGLMParams(userParams) {
  return {
    model: userParams.model || MODEL,
    max_tokens: Math.max(userParams.max_tokens || 0, 1024), // never let it go below 1024
    temperature: userParams.temperature ?? 0.85,
    top_p: userParams.top_p ?? 0.92,
    frequency_penalty: userParams.frequency_penalty ?? 0.1,
    presence_penalty: userParams.presence_penalty ?? 0.05,
    // ↓ Critical: override GLM-5's aggressive stop sequences
    stop: null,
    stream: userParams.stream ?? false,
  };
}

// ─── POST /v1/chat/completions ────────────────────────────────────────────────
// Drop-in OpenAI-compatible endpoint. Point Janitor AI's custom API to:
//   https://your-render-url.onrender.com/v1/chat/completions
// API Key: your RESURGE_API_KEY (or any string if you add auth below)
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages = [], system, stream, ...rest } = req.body;

    // 1. Extract and enhance system prompt
    const systemMessage = messages.find((m) => m.role === "system");
    const existingSystem = system || systemMessage?.content || "";
    const enhancedSystem = buildSystemPrompt(existingSystem);

    // 2. Build message array — replace or prepend system message
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const finalMessages = [
      { role: "system", content: enhancedSystem },
      ...sanitizeMessages(nonSystemMessages),
    ];

    // 3. Build fixed GLM-5 params
    const params = buildGLMParams(rest);

    const payload = {
      ...params,
      messages: finalMessages,
      stream: stream ?? false,
    };

    log("REQUEST", `model=${payload.model} msgs=${finalMessages.length} max_tokens=${payload.max_tokens} stream=${payload.stream}`);

    // ─── Streaming ────────────────────────────────────────────────────────────
    if (payload.stream) {
      const upstream = await fetch(RESURGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESURGE_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        log("STREAM ERROR", `${upstream.status} — ${errText}`);
        return res.status(upstream.status).json({ error: errText });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      upstream.body.on("data", (chunk) => res.write(chunk));
      upstream.body.on("end", () => res.end());
      upstream.body.on("error", (err) => {
        log("STREAM PIPE ERROR", err.message);
        res.end();
      });

      return;
    }

    // ─── Non-streaming ────────────────────────────────────────────────────────
    const upstream = await fetch(RESURGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESURGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      log("UPSTREAM ERROR", `${upstream.status} — ${JSON.stringify(data)}`);
      return res.status(upstream.status).json(data);
    }

    // ─── Mid-sentence detection & warning ────────────────────────────────────
    // Log if the response still ends abruptly (helps debugging edge cases)
    const content = data?.choices?.[0]?.message?.content || "";
    const finishReason = data?.choices?.[0]?.finish_reason;

    if (finishReason === "length" && content.length > 0) {
      const lastChar = content.trimEnd().slice(-1);
      if (![".", "!", "?", '"', "'", "*", "~"].includes(lastChar)) {
        log("WARN", "Response may have been cut off mid-sentence (finish_reason=length). Consider increasing max_tokens.");
      }
    }

    log("RESPONSE", `finish_reason=${finishReason} chars=${content.length}`);

    return res.json(data);
  } catch (err) {
    log("ERROR", err.message);
    return res.status(500).json({ error: "Proxy server error", details: err.message });
  }
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────
// Some frontends (including Janitor AI) hit this endpoint to list models
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "glm-5",
        object: "model",
        created: 1700000000,
        owned_by: "resurge-proxy",
        permission: [],
        root: "glm-5",
        parent: null,
      },
      {
        id: "glm-5.1",
        object: "model",
        created: 1700000000,
        owned_by: "resurge-proxy",
        permission: [],
        root: "glm-5.1",
        parent: null,
      },
    ],
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "ResurgeAI GLM-5 Proxy is running",
    endpoints: {
      chat: "POST /v1/chat/completions",
      models: "GET /v1/models",
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log("SERVER", `Proxy running on port ${PORT}`);
  log("SERVER", `Model: ${MODEL}`);
  log("SERVER", `API key configured: ${RESURGE_API_KEY ? "YES" : "NO — set RESURGE_API_KEY in .env"}`);
});
