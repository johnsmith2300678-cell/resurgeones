import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { config } from "dotenv";

config();

const app = express();
const PORT = process.env.PORT || 3000;

const RESURGE_API_URL = "https://api.resurge.one/v1/chat/completions";
const RESURGE_API_KEY = process.env.RESURGE_API_KEY || "";
const MODEL = process.env.MODEL || "glm-5";

// Max times we retry a cut-off response before giving up
const MAX_CONTINUATIONS = 5;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(existing) {
  const core = `You are a creative, immersive roleplay writer. Rules:
- ALWAYS finish every sentence completely. Never stop mid-sentence or mid-word.
- Stay fully in character at all times.
- Write vivid, descriptive prose with emotions, actions, and sensory detail.
- Never mention being an AI or break the fourth wall.
- Always end your reply on a complete sentence with proper punctuation.`;

  if (!existing || !existing.trim()) return core;
  return `${existing.trim()}\n\n---\n${core}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && m.role && m.content)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.trim() : m.content,
    }))
    .filter((m) => m.content !== "");
}

function isComplete(text) {
  const t = (text || "").trimEnd();
  if (!t) return true;
  return [".", "!", "?", '"', "\u201D", "*", "~", ")"].includes(t.slice(-1));
}

// ─── Upstream call ────────────────────────────────────────────────────────────
async function callUpstream(payload) {
  const response = await fetch(RESURGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESURGE_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) throw { status: response.status, data };
  return data;
}

// ─── Auto-continuation ────────────────────────────────────────────────────────
// If GLM-5 hits the token limit mid-sentence, we loop:
//   1. Feed its partial reply back as an assistant message
//   2. Ask it to continue from exactly where it stopped
//   3. Stitch all pieces together into one clean response
async function fetchComplete(params, messages) {
  let fullContent = "";
  let lastData = null;
  let currentMessages = [...messages];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const data = await callUpstream({ ...params, messages: currentMessages });
    lastData = data;

    const choice = data?.choices?.[0];
    const chunk = (choice?.message?.content || "").trimEnd();
    const finishReason = choice?.finish_reason;

    fullContent += (attempt > 0 && fullContent && !fullContent.endsWith(" ") ? " " : "") + chunk;

    log(
      attempt === 0 ? "RESPONSE" : `CONTINUE-${attempt}`,
      `finish=${finishReason} chunk=${chunk.length} total=${fullContent.length}`
    );

    // Natural finish — we're done
    if (finishReason !== "length") break;

    // Hit length limit but text ends cleanly — fine
    if (isComplete(fullContent)) {
      log("INFO", "Hit length limit but text ends cleanly — no continuation needed");
      break;
    }

    // Hit max retries
    if (attempt === MAX_CONTINUATIONS) {
      log("WARN", `Hit max continuations (${MAX_CONTINUATIONS}) — response may still be incomplete`);
      break;
    }

    // Feed partial reply back and ask GLM-5 to continue
    log("INFO", `Response cut off mid-sentence — requesting continuation ${attempt + 1}/${MAX_CONTINUATIONS}`);
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: chunk },
      {
        role: "user",
        content:
          "[SYSTEM: Your previous reply was cut off mid-sentence. Continue from exactly where you stopped. Do NOT repeat anything. Do NOT add any intro or preamble. Just continue the sentence naturally.]",
      },
    ];
  }

  // Write the stitched content back into the response object
  if (lastData?.choices?.[0]?.message) {
    lastData.choices[0].message.content = fullContent;
    lastData.choices[0].finish_reason = "stop";
  }

  return lastData;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { messages = [], system, stream, ...rest } = req.body;

    // Build system prompt
    const systemMsg = messages.find((m) => m.role === "system");
    const existing = system || systemMsg?.content || "";
    const enhancedSystem = buildSystemPrompt(existing);

    const nonSystem = messages.filter((m) => m.role !== "system");
    const finalMessages = [
      { role: "system", content: enhancedSystem },
      ...sanitizeMessages(nonSystem),
    ];

    // ── Token handling ───────────────────────────────────────────────────────
    // Janitor AI sends max_tokens=0 when the user sets it to 0 ("unlimited").
    // GLM-5 treats 0 as literally 0 tokens which causes immediate cutoff.
    // We always override with a safe high value. 8192 covers even long scenes.
    const incomingTokens = rest.max_tokens;
    const maxTokens =
      !incomingTokens || incomingTokens < 512 ? 8192 : incomingTokens;

    const params = {
      model: rest.model || MODEL,
      max_tokens: maxTokens,
      temperature: rest.temperature ?? 0.85,
      top_p: rest.top_p ?? 0.92,
      frequency_penalty: rest.frequency_penalty ?? 0.1,
      presence_penalty: rest.presence_penalty ?? 0.05,
      stop: null, // clear GLM-5's aggressive built-in stop sequences
      stream: false,
    };

    const wantsStream = stream ?? false;
    log("REQUEST", `model=${params.model} msgs=${finalMessages.length} max_tokens=${params.max_tokens} stream=${wantsStream}`);

    // Fetch with auto-continuation
    const data = await fetchComplete(params, finalMessages);
    const content = data?.choices?.[0]?.message?.content || "";

    // ── Return response ───────────────────────────────────────────────────────
    if (wantsStream) {
      // Janitor AI requested streaming — fake a valid SSE stream from our result
      const model = data?.model || params.model;
      const id = data?.id || `chatcmpl-${Date.now()}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(
        `data: ${JSON.stringify({
          id, model,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        })}\n\n`
      );

      res.write(
        `data: ${JSON.stringify({
          id, model,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return res.json(data);

  } catch (err) {
    if (err?.status) {
      log("UPSTREAM ERROR", `${err.status} — ${JSON.stringify(err.data)}`);
      return res.status(err.status).json(err.data);
    }
    log("ERROR", err.message);
    return res.status(500).json({ error: "Proxy error", details: err.message });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post("/v1/chat/completions", handleChat);
app.post("/chat/completions", handleChat);
app.post("/", handleChat);

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "glm-5",   object: "model", created: 1700000000, owned_by: "resurge-proxy" },
      { id: "glm-5.1", object: "model", created: 1700000000, owned_by: "resurge-proxy" },
    ],
  });
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "ResurgeAI GLM-5 Proxy — running",
    endpoints: {
      chat: "POST /  or  POST /v1/chat/completions",
      models: "GET /v1/models",
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
  log("SERVER", `Model: ${MODEL}`);
  log("SERVER", `API key: ${RESURGE_API_KEY ? "SET" : "MISSING — set RESURGE_API_KEY in env"}`);
});
