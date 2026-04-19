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
const MAX_CONTINUATIONS = 4;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function buildSystemPrompt(existing) {
  const core = `You are an expert roleplay writer. Follow these rules on every single response. No exceptions.

FORMATTING — READ THIS CAREFULLY:

1. Narration and actions go inside asterisks as full paragraphs:
*She turned slowly, eyes scanning the room. Her breath came in shallow pulls, tension visible in every line of her body.*

2. When the character speaks, use "quotes" only. NEVER put speech inside asterisks:
CORRECT: "I told you not to come here."
CORRECT: "H-hey!" *Her voice cracked.* "I said look, not—mmph..."
WRONG: *"I told you not to come here."*
WRONG: *She said "stop" and turned away.*

3. When speech and narration mix on the same beat, close asterisks before speech and reopen after:
CORRECT: *Her breath hitched.* "Don't move." *She didn't look at him.*
CORRECT: "Well?" *The word hung in the air.* "Are you just going to stand there?"
WRONG: *Her breath hitched. "Don't move." She didn't look at him.*

4. Every narration block and every line of dialogue is its own paragraph with a blank line between them:
*The moment his hand made contact, she went completely still. A sharp gasp escaped before she could catch it.*

"H-hey!" *Her voice cracked, losing its usual edge.* "I said look, not—"

*She gripped the chair, knuckles whitening against the wood.*

"This wasn't part of the deal." *She sucked in a breath through clenched teeth.* "Tch. Fine."

STRICTLY FORBIDDEN — never do any of these:
- Bullet points or lists of any kind (no bullet, dash, numbered lists)
- Lone quote marks on their own line
- Asterisk on its own line with text below it
- Dialogue inside asterisk blocks
- Broken apostrophes like: don' t  it' s  she' d  you' re
- Wall of text with no paragraph breaks
- Stopping mid-sentence

WRITING:
- Complete every sentence and thought fully, never stop mid-sentence
- Write vivid, immersive prose with sensory detail and physical reactions
- Never break character or mention being an AI
- Match the tone and energy of the scene
- Gracefully close each scene beat`;

  if (!existing || !existing.trim()) return core;
  return `${existing.trim()}\n\n---\n${core}`;
}

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

function cleanOutput(text) {
  if (!text) return text;

  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Fix broken apostrophes: don' t -> don't
  out = out.replace(/(\w)'\s+(\w)/g, "$1'$2");

  // Strip bullet points and numbered lists
  out = out.replace(/^[ \t]*[•\-]\s+/gm, "");
  out = out.replace(/^[ \t]*\d+\.\s+/gm, "");

  // Fix lone quote marks wrapping text on separate lines
  out = out.replace(/^"\s*\n([\s\S]*?)\n\s*"$/gm, (_, inner) => `"${inner.trim()}"`);

  // Fix lone asterisks on their own line wrapping text
  out = out.replace(/^\*\s*\n([\s\S]*?)\n\s*\*$/gm, (_, inner) => {
    return `*${inner.replace(/\n+/g, " ").trim()}*`;
  });

  // Collapse newlines inside *...* spans
  out = out.replace(/\*([^*]+)\*/gs, (_, inner) => {
    return `*${inner.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim()}*`;
  });

  // Pull dialogue out of asterisk blocks
  out = out.replace(/\*([^*]*)"([^"]+)"([^*]*)\*/g, (_, before, speech, after) => {
    const parts = [];
    if (before.trim()) parts.push(`*${before.trim()}*`);
    parts.push(`"${speech}"`);
    if (after.trim()) parts.push(`*${after.trim()}*`);
    return parts.join("\n\n");
  });

  // Ensure blank line after closing *
  out = out.replace(/\*([^\n*])/g, "*\n\n$1");

  // Ensure blank line before opening *
  out = out.replace(/([^\n*])\*/g, "$1\n\n*");

  // Ensure blank line after closing quote followed by non-quote content
  out = out.replace(/"([^\n"])/g, '"\n\n$1');

  // Ensure blank line before opening quote after non-quote content
  out = out.replace(/([^\n"])"([^])/g, (match, before, after) => {
    if (before === "\n") return match;
    return `${before}\n\n"${after}`;
  });

  // Collapse 3+ newlines to 2
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

function isComplete(text) {
  const t = text.trimEnd();
  if (!t) return true;
  return [".", "!", "?", '"', "\u201D", "*", "~"].includes(t.slice(-1));
}

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

async function fetchComplete(params, messages) {
  let fullContent = "";
  let lastData = null;
  let currentMessages = [...messages];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const data = await callUpstream({ ...params, messages: currentMessages });
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
      log("WARN", "Hit max continuations");
      break;
    }

    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: chunk },
      {
        role: "user",
        content: "Continue your previous response. Pick up exactly where you left off. Do not repeat anything. Do not add any preamble.",
      },
    ];
  }

  if (lastData?.choices?.[0]?.message) {
    lastData.choices[0].message.content = cleanOutput(fullContent);
    lastData.choices[0].finish_reason = "stop";
  }

  return lastData;
}

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

    const params = {
      model: rest.model || MODEL,
      max_tokens: 4096,
      temperature: rest.temperature ?? 0.85,
      top_p: rest.top_p ?? 0.92,
      frequency_penalty: rest.frequency_penalty ?? 0.1,
      presence_penalty: rest.presence_penalty ?? 0.05,
      stop: null,
      stream: false,
    };

    const wantsStream = stream ?? false;
    log("REQUEST", `model=${params.model} msgs=${finalMessages.length} stream=${wantsStream}`);

    const data = await fetchComplete(params, finalMessages);

    if (wantsStream) {
      const content = data?.choices?.[0]?.message?.content || "";
      const model = data?.model || params.model;
      const id = data?.id || `chatcmpl-${Date.now()}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(`data: ${JSON.stringify({
        id, model,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\n`);

      res.write(`data: ${JSON.stringify({
        id, model,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);

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

app.post("/v1/chat/completions", handleChat);
app.post("/chat/completions", handleChat);
app.post("/", handleChat);

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "glm-5", object: "model", created: 1700000000, owned_by: "resurge-proxy" },
      { id: "glm-5.1", object: "model", created: 1700000000, owned_by: "resurge-proxy" },
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

app.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
  log("SERVER", `Model: ${MODEL}`);
  log("SERVER", `API key: ${RESURGE_API_KEY ? "SET" : "MISSING — set RESURGE_API_KEY in .env"}`);
});
