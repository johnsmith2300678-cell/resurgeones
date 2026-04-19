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
function buildSystemPrompt(existingSystem) {
  const roleplayCore = `You are an expert, immersive roleplay AI. Follow every rule below without exception.

═══════════════════════════════════════════════
PARAGRAPH STRUCTURE — THIS IS THE MOST IMPORTANT RULE
═══════════════════════════════════════════════

Every response MUST be broken into separate paragraphs with a BLANK LINE between each one.
There are three types of blocks. Each type is ALWAYS its own paragraph:

  TYPE 1 — NARRATION/ACTION: Wrap in *asterisks*. Full sentences. Ends before any dialogue.
  TYPE 2 — DIALOGUE: Use "quotes". Never inside asterisks. Own line, own paragraph.
  TYPE 3 — MIXED (speech + reaction): Close asterisks before speaking, reopen after.

EXACT FORMAT YOU MUST REPLICATE — study this and match it precisely:

*The moment your palm makes contact with the generous swell of her cheek, Boa's entire body goes rigid. Her breath hitches in her throat, a sharp little gasp escaping before she can catch it. The warm, soft flesh yields under your fingers as you squeeze, the supple skin molding to your grip while the firm muscle beneath offers just enough resistance to make the touch substantial.*

"H-hey!" *Her voice cracks, losing its usual commanding edge.* "I said look, not—mmph..."

*She grips the edge of the dining chair, knuckles whitening against the wood. The jasmine scent of her skin intensifies as her body temperature rises, a faint flush creeping up the back of her neck. Her thick thighs press together beneath the table.*

*You feel her shift, attempting to pull away, but the motion is half-hearted at best.*

"This... this wasn't part of—" *She sucks in another breath through clenched teeth.* "Tch. You brat. Fine. A deal is a deal."

*Her dark blue eyes dart toward the hallway, checking for any sign of the front door opening. The house remains silent except for the hum of the refrigerator and the distant tick of the living room clock.*

*Boa's shoulders drop slightly, her spine curving deeper as she subconsciously arches into your touch. The haughty mask struggles to stay in place while her body betrays her with each passing second.*

"Well? Are you just going to squeeze like some clumsy virgin, or do you actually know what you're doing?" *The words come out breathier than intended, laced with challenge and something else—something that sounds almost like anticipation.* "I didn't raise a fool, so... so make it count."

*Her foot taps impatiently against the floor, heel clicking a nervous rhythm against the hardwood. The movement makes her body shift slightly in your grip.*

═══════════════════════════════════════════════
FORMATTING RULES — NON-NEGOTIABLE
═══════════════════════════════════════════════

BLANK LINE between EVERY paragraph — no exceptions, no walls of text.

NARRATION blocks (*asterisks*):
  ✓ *She turned slowly, eyes narrowing as she recognized him.*
  ✓ *Her breath came fast. Hands trembling. She reached for the door.*
  ✗ NEVER put dialogue inside asterisks
  ✗ NEVER: *She said "stop" and looked away.*

DIALOGUE blocks ("quotes"):
  ✓ "I told you not to come here."
  ✓ "H-hey!" (stutters, gasps, and fragments are fine)
  ✗ NEVER: *"I told you not to come here."*
  ✗ NEVER dialogue and narration merged inside one asterisk block

MIXED lines (reaction + speech + reaction):
  ✓ "Well?" *The word hung in the air.* "Are you just going to stand there?"
  ✓ *Her breath hitched.* "Don't move." *She didn't look at him.*
  ✗ NEVER: *Her breath hitched. "Don't move." She didn't look at him.*

ABSOLUTELY FORBIDDEN:
  ✗ Bullet points, numbered lists, dashes as list markers — NEVER
  ✗ Lone asterisk on its own line
  ✗ Dialogue inside asterisk blocks
  ✗ Wall of text with no blank-line paragraph breaks
  ✗ Stopping mid-sentence
  ✗ Broken contractions: don' t  it' s  she' d  you' re — ALWAYS write them joined

═══════════════════════════════════════════════
WRITING QUALITY
═══════════════════════════════════════════════

- Complete every sentence and thought — never end mid-sentence
- Sensory detail: touch, scent, sound, warmth, texture, weight
- Physical reactions: breath changes, muscle tension, involuntary movements
- Emotional undercurrent: what the character feels vs. what they show
- Match the length and energy of the user's message
- Stay in character consistently — never break the fourth wall
- Gracefully close each scene beat before ending your reply`;

  if (!existingSystem || existingSystem.trim() === "") {
    return roleplayCore;
  }

  return `${existingSystem.trim()}\n\n---\n\n${roleplayCore}`;
}

// ─── Message Sanitizer ────────────────────────────────────────────────────────
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
    max_tokens: 4096,
    temperature: userParams.temperature ?? 0.85,
    top_p: userParams.top_p ?? 0.92,
    frequency_penalty: userParams.frequency_penalty ?? 0.1,
    presence_penalty: userParams.presence_penalty ?? 0.05,
    stop: null,
    stream: false,
  };
}

// ─── Sentence completion check ────────────────────────────────────────────────
function isComplete(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return true;
  const last = trimmed.slice(-1);
  return [".", "!", "?", '"', "\u201D", "*", "~", "\n"].includes(last);
}

// ─── Single upstream call ─────────────────────────────────────────────────────
async function callUpstream(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(RESURGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESURGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type") || "";

    // Upstream returned HTML (502, cloudflare error page, etc.) — retry
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      log("UPSTREAM HTML ERROR", `attempt=${attempt}/${retries} status=${res.status} body=${text.slice(0, 200)}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt)); // wait 500ms, 1000ms, 1500ms
        continue;
      }
      throw { status: 502, data: { error: "Upstream returned non-JSON after retries", details: text.slice(0, 200) } };
    }

    const data = await res.json();
    if (!res.ok) throw { status: res.status, data };
    return data;
  }
}
// ─── Auto-continuation ────────────────────────────────────────────────────────
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

    if (finishReason !== "length") break;
    if (isComplete(fullContent)) break;
    if (attempt === MAX_CONTINUATIONS) {
      log("WARN", "Hit max continuations — response may still be incomplete");
      break;
    }

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

  if (lastData?.choices?.[0]?.message) {
    lastData.choices[0].message.content = formatParagraphs(fullContent);
    lastData.choices[0].finish_reason = "stop";
  }

  return lastData;
}

// ─── Paragraph formatter ──────────────────────────────────────────────────────
function formatParagraphs(text) {
  if (!text) return text;

  // Fix broken contractions (don' t → don't)
  let out = text.replace(/(\w)'\s+(\w)/g, "$1'$2");

  // Normalize 3+ newlines to 2
  out = out.replace(/\n{3,}/g, "\n\n");

  // After every closing asterisk, force a blank line before next block
  out = out.replace(/\*\s+/g, "*\n\n");

  // After every closing quote, force a blank line before next block
  out = out.replace(/([""])\s+(?=[*"A-Z])/g, "$1\n\n");

  // After sentence-ending punctuation followed by a new narration block
  out = out.replace(/([.!?…])\s+(\*[^*])/g, "$1\n\n$2");

  // Upgrade any remaining single newlines to double
  out = out.replace(/\n(?!\n)/g, "\n\n");

  // Clean up any accidental 3+ newlines created by the steps above
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

// ─── Shared chat handler ──────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { messages = [], system, stream, ...rest } = req.body;

    const systemMessage = messages.find((m) => m.role === "system");
    const existingSystem = system || systemMessage?.content || "";
    const enhancedSystem = buildSystemPrompt(existingSystem);

    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const finalMessages = [
      { role: "system", content: enhancedSystem },
      ...sanitizeMessages(nonSystemMessages),
    ];

    const params = buildGLMParams(rest);
    const wantsStream = stream ?? false;

    log("REQUEST", `model=${params.model} msgs=${finalMessages.length} max_tokens=${params.max_tokens} stream=${wantsStream}`);

    const data = await fetchComplete({ ...params }, finalMessages);

    if (wantsStream) {
      const content = data?.choices?.[0]?.message?.content || "";
      const model = data?.model || params.model;
      const id = data?.id || `chatcmpl-${Date.now()}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chunkPayload = JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      });
      res.write(`data: ${chunkPayload}\n\n`);

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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post("/v1/chat/completions", handleChat);
app.post("/chat/completions", handleChat);
app.post("/", handleChat);

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
