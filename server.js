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
  const roleplayCore = `You are an expert, immersive roleplay AI assistant. Follow these formatting and writing rules strictly:

FORMATTING RULES — this is the most important part:
- Wrap ALL narration, actions, and scene description in asterisks: *like this*
- Dialogue is NEVER inside asterisks. It sits outside on its own line: "like this"
- When dialogue interrupts narration, close the asterisks, write the dialogue, then open new asterisks: *narration* "dialogue" *narration continues*
- Each narration block and each line of dialogue is its own paragraph, separated by a blank line
- NEVER mix dialogue inside an asterisk block

CORRECT format example:
*The moment his hand made contact, she went completely still. Her breath hitched, a sharp little gasp escaping before she could catch it.*
"H-hey!" *Her voice cracked, losing its usual edge.* "I said look, not—"
*She gripped the chair, knuckles whitening against the wood. The flush creeping up her neck betrayed her far more than her words did.*
"This wasn't part of the deal." *She sucked in a slow breath through clenched teeth.* "Tch. Fine."

WRITING RULES:
1. NEVER stop mid-sentence. Always complete every sentence and thought fully.
2. Write rich, descriptive prose with sensory details, emotions, and physical reactions.
3. Never break the fourth wall or mention being an AI.
4. Match the tone, energy, and length of the scene.
5. Stay in character consistently throughout the conversation.
6. Never abruptly end a reply — gracefully close the current scene beat.`;

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
function buildGLMParams(userParams) {
  return {
    model: userParams.model || MODEL,
    // ALWAYS force 4096 — ignore whatever Janitor AI sends (0, undefined, low values).
    // GLM-5 treats 0 as "use default" which is very low and causes mid-sentence cuts.
    max_tokens: 4096,
    temperature: userParams.temperature ?? 0.85,
    top_p: userParams.top_p ?? 0.92,
    frequency_penalty: userParams.frequency_penalty ?? 0.1,
    presence_penalty: userParams.presence_penalty ?? 0.05,
    // Null out stop sequences — GLM-5's built-ins cut responses way too early
    stop: null,
    stream: false, // we handle streaming ourselves after stitching
  };
}

// ─── Sentence completion check ────────────────────────────────────────────────
// Returns true if the text ends on a clean sentence boundary
function isComplete(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return true;
  const last = trimmed.slice(-1);
  // Accept common sentence-ending punctuation including roleplay markers
  return [".", "!", "?", '"', "\u201D", "*", "~", "\n"].includes(last);
}

// ─── Single upstream call ─────────────────────────────────────────────────────
async function callUpstream(payload) {
  const res = await fetch(RESURGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESURGE_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, data };
  return data;
}

// ─── Auto-continuation ────────────────────────────────────────────────────────
// If GLM-5 stops mid-sentence (finish_reason === "length"), we feed its output
// back as an assistant message and ask it to continue — up to MAX_CONTINUATIONS
// times. The final stitched text is returned as one complete response.
const MAX_CONTINUATIONS = 4;

async function fetchComplete(payload, originalMessages) {
  let fullContent = "";
  let lastData = null;
  let messages = [...originalMessages];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const data = await callUpstream({ ...payload, messages });
    lastData = data;

    const choice = data?.choices?.[0];
    const chunk = choice?.message?.content || "";
    const finishReason = choice?.finish_reason;

    fullContent += chunk;
    log(
      attempt === 0 ? "RESPONSE" : `CONTINUE-${attempt}`,
      `finish_reason=${finishReason} chars=${chunk.length} total=${fullContent.length}`
    );

    // Done — model finished naturally
    if (finishReason !== "length") break;

    // Still cut off — check if it at least ended on a sentence boundary
    if (isComplete(fullContent)) break;

    // Hit max retries
    if (attempt === MAX_CONTINUATIONS) {
      log("WARN", "Hit max continuations — response may still be incomplete");
      break;
    }

    // Feed the partial response back and ask GLM-5 to continue
    messages = [
      ...messages,
      { role: "assistant", content: chunk },
      {
        role: "user",
        content:
          "Continue your previous response. Pick up exactly where you left off mid-sentence. Do not repeat anything. Do not add any preamble.",
      },
    ];
  }

  // Stitch the full content back into the last API response shape
  if (lastData?.choices?.[0]?.message) {
    lastData.choices[0].message.content = formatParagraphs(fullContent);
    lastData.choices[0].finish_reason = "stop";
  }

  return lastData;
}

// ─── Paragraph formatter ──────────────────────────────────────────────────────
// Enforces the correct roleplay format:
//   *Narration and actions are wrapped in asterisks as full blocks*
//   "Dialogue sits outside asterisks on its own line"
//   Inline: *narration* "speech" *narration resumes*
//
// Rules:
//  - Narration blocks (*...*) stay together — no line breaks inside them
//  - Each distinct narration block and each dialogue line is its own paragraph
//  - Dialogue that interrupts narration splits the narration cleanly
function formatParagraphs(text) {
  if (!text) return text;

  // Step 1 — normalize whitespace
  let out = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Step 2 — collapse all newlines inside asterisk spans so narration blocks
  // don't get broken into individual lines
  // e.g. "*She turned.\nHer eyes narrowed.*" → "*She turned. Her eyes narrowed.*"
  out = out.replace(/\*([^*]+)\*/gs, (match, inner) => {
    const cleaned = inner
      .replace(/\n+/g, " ")  // collapse internal newlines to spaces
      .replace(/\s{2,}/g, " ") // collapse double spaces
      .trim();
    return `*${cleaned}*`;
  });

  // Step 3 — ensure every narration block (*...*) and every dialogue line ("...")
  // is separated by a blank line from whatever comes before/after it

  // Insert \n\n before an opening * that follows dialogue or text
  out = out.replace(/([^\n])\s*(\*[^*])/g, "$1\n\n$2");

  // Insert \n\n after a closing * that is followed by dialogue or text
  out = out.replace(/(\*)\s*([^\n*])/g, "$1\n\n$2");

  // Insert \n\n before opening quote that follows narration or text
  out = out.replace(/([^\n])\s*("|\u201C)/g, "$1\n\n$2");

  // Insert \n\n after closing quote that is followed by narration or text
  out = out.replace(/("|'|\u201D)\s*([^\n"'])/g, "$1\n\n$2");

  // Step 4 — clean up any over-aggressive breaks we may have introduced
  // (3+ newlines back to 2)
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

// ─── Shared chat handler ──────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { messages = [], system, stream, ...rest } = req.body;

    // 1. Extract and enhance system prompt
    const systemMessage = messages.find((m) => m.role === "system");
    const existingSystem = system || systemMessage?.content || "";
    const enhancedSystem = buildSystemPrompt(existingSystem);

    // 2. Build final message array
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const finalMessages = [
      { role: "system", content: enhancedSystem },
      ...sanitizeMessages(nonSystemMessages),
    ];

    // 3. Build params
    const params = buildGLMParams(rest);
    const wantsStream = stream ?? false;

    log("REQUEST", `model=${params.model} msgs=${finalMessages.length} max_tokens=${params.max_tokens} stream=${wantsStream}`);

    // ─── Non-streaming: fetch with auto-continuation ──────────────────────────
    const data = await fetchComplete({ ...params }, finalMessages);

    // ─── If Janitor AI requested streaming, fake an SSE stream from our result ─
    // This ensures compatibility regardless of what Janitor AI expects
    if (wantsStream) {
      const content = data?.choices?.[0]?.message?.content || "";
      const model = data?.model || params.model;
      const id = data?.id || `chatcmpl-${Date.now()}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Send content in one chunk
      const chunkPayload = JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      });
      res.write(`data: ${chunkPayload}\n\n`);

      // Send the [DONE] terminator
      const donePayload = JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write(`data: ${donePayload}\n\n`);
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
    return res.status(500).json({ error: "Proxy server error", details: err.message });
  }
}

// ─── Route aliases ────────────────────────────────────────────────────────────
// Janitor AI (and similar frontends) may POST to several different paths
// depending on how the custom API URL is entered by the user. We handle all of them.
app.post("/v1/chat/completions", handleChat); // standard OpenAI path
app.post("/chat/completions", handleChat);    // without /v1 prefix
app.post("/", handleChat);                    // bare root — the 404 you hit

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
// Only fires on GET /, POST / is already handled above by handleChat
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "ResurgeAI GLM-5 Proxy is running",
    endpoints: {
      chat: "POST /v1/chat/completions  (or POST / or POST /chat/completions)",
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
