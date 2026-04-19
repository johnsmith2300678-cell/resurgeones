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
  const roleplayCore = `You are an expert roleplay writer. You MUST follow these formatting rules on every single response without exception.

═══ FORMATTING RULES ═══

RULE 1 — ASTERISKS WRAP NARRATION ONLY:
Narration, actions, and scene description are wrapped in asterisks as complete paragraphs.
*She turned slowly, eyes scanning the room. Her breath came in shallow pulls, the tension in her shoulders visible even from across the hall.*

RULE 2 — WHEN {{char}} SPEAKS, NEVER USE ASTERISKS:
The character's spoken words use "quotes" only. No asterisks. Ever. Period.
CORRECT: "I told you not to come here."
CORRECT: "Tch. Don't flatter yourself." *She turned away, jaw tight.* "Just hurry up."
FORBIDDEN: *"I told you not to come here."*
FORBIDDEN: *"Tch."*
FORBIDDEN: *She said "stop."*
If the character is speaking, asterisks are completely removed from that speech. The mouth opens — asterisks close.

RULE 3 — INLINE DIALOGUE SPLITS NARRATION CLEANLY:
When a character speaks mid-narration, close * before the quote, then reopen * after.
CORRECT: *Her voice dropped.* "Don't move." *She didn't look at him when she said it.*
CORRECT: "Well?" *The word hung in the air.* "Are you just going to stand there?"
FORBIDDEN: *Her voice dropped. "Don't move." She didn't look at him.*

RULE 4 — EVERY BLOCK IS ITS OWN PARAGRAPH:
Each narration block and each dialogue line is separated by a blank line.
CORRECT:
*The moment his hand made contact, she went completely still. Her breath hitched, a sharp gasp escaping before she could catch it.*

"H-hey!" *Her voice cracked.* "I said look, not—"

*She gripped the chair, knuckles whitening. The flush up her neck betrayed her far more than her words.*

"This wasn't part of the deal." *She sucked in a breath.* "Tch. Fine."

RULE 5 — NEVER DO THESE (ALL FORBIDDEN):
FORBIDDEN — asterisk on its own line:
*
narration
*
FORBIDDEN — dialogue inside asterisk block:
*She said "stop" and turned away.*
FORBIDDEN — broken apostrophes or split words:
don' t    it' s    she' d    you' re
FORBIDDEN — wall of text with no paragraph breaks

═══ WRITING RULES ═══
- NEVER stop mid-sentence. Complete every thought fully.
- Write vivid, immersive prose with sensory detail and physical reactions.
- Never break character or mention being an AI.
- Match the tone and energy of the scene.
- Gracefully close each scene beat — never end abruptly.`;

  if (!existingSystem || existingSystem.trim() === "") {
    return roleplayCore;
  }
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

// ─── Format enforcer ──────────────────────────────────────────────────────────
// Hard-enforces the correct roleplay format on every response.
// Fixes the three forbidden patterns:
//   1. Wall of text — no paragraph breaks
//   2. Asterisk-per-line mess — * on its own line, broken blocks
//   3. Dialogue leaked inside asterisk blocks
function formatParagraphs(text) {
  if (!text) return text;

  let out = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  // ── Fix 1: broken apostrophes/contractions from bad tokenization ─────────
  // e.g. "don' t" → "don't", "it' s" → "it's", "she' d" → "she'd"
  out = out.replace(/(\w)'\s+(\w)/g, "$1'$2");

  // ── Fix 2: lone asterisks on their own line (the * \n text \n * pattern) ──
  // Collapse them into inline *text* blocks
  out = out.replace(/\*\s*\n+([\s\S]*?)\n+\s*\*/g, (_, inner) => {
    const cleaned = inner.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    return `*${cleaned}*`;
  });

  // ── Fix 3: collapse all internal newlines inside *...* spans ─────────────
  // Narration blocks should be single unbroken paragraphs
  out = out.replace(/\*([^*]+)\*/gs, (_, inner) => {
    const cleaned = inner.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    return `*${cleaned}*`;
  });

  // ── Fix 4: dialogue that leaked inside asterisks ──────────────────────────
  // *She said "stop" and turned.* → *She said* "stop" *and turned.*
  // Detect "..." inside *...* and split it out
  out = out.replace(/\*([^*]*)"([^"]*)"([^*]*)\*/g, (_, before, dialogue, after) => {
    const parts = [];
    if (before.trim()) parts.push(`*${before.trim()}*`);
    parts.push(`"${dialogue}"`);
    if (after.trim()) parts.push(`*${after.trim()}*`);
    return parts.join("\n\n");
  });

  // ── Fix 5: ensure blank line between every narration block and dialogue ───

  // After closing * before dialogue or new narration
  out = out.replace(/\*\s*\n?([^*\n])/g, "*\n\n$1");

  // Before opening * after dialogue or text
  out = out.replace(/([^*\n])\s*\n?\*/g, "$1\n\n*");

  // After closing quote before narration or new content
  out = out.replace(/"\s*\n?(\*|[A-Z])/g, '"\n\n$1');

  // Before opening quote after narration or text
  out = out.replace(/(\*|[a-z.])\s*\n?"/g, '$1\n\n"');

  // ── Fix 6: clean up over-breaks ──────────────────────────────────────────
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
