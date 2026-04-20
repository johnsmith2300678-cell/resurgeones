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

// ─── CHARACTER CARD PARSER ────────────────────────────────────────────────────
function extract(text, keys) {
  for (const key of keys) {
    const pattern = new RegExp(
      `(?:^|\\n)(?:\\[?${key}\\]?[:\\s]+)([\\s\\S]*?)(?=\\n[A-Z][\\w ]+[:\\n\\[]|$)`,
      "im"
    );
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function extractCharacterDetails(messages) {
  const sysMsg = messages.find((m) => m.role === "system");
  if (!sysMsg) return null;

  const raw = typeof sysMsg.content === "string"
    ? sysMsg.content
    : sysMsg.content?.map?.((c) => c.text || "").join("\n") || "";

  const wplusMatch = raw.match(/\[[\w\s]+:\s*[\w\s]+;[\s\S]*?\]/g);
  const wplus = wplusMatch ? wplusMatch.join("\n") : null;

  const exampleMatch = raw.match(
    /(?:example[s]?\s*(?:dialogue|conversation|messages?)|<START>)([\s\S]*?)(?=\n[A-Z][^\n]{0,30}:|\n\[|$)/im
  );
  const examples = exampleMatch?.[1]?.trim() || null;

  const firstMsgMatch = raw.match(
    /(?:first\s*message|greeting|opening)([\s\S]*?)(?=\n[A-Z][^\n]{0,30}:|\n\[|$)/im
  );
  const firstMsg = firstMsgMatch?.[1]?.trim() || null;

  const hasLabeledFields = /\n[A-Z][^:\n]{0,30}:/m.test(raw);
  const freeformPersona = !hasLabeledFields ? raw.trim() : null;

  return {
    name:        extract(raw, ["Name", "Character Name", "char_name"]),
    age:         extract(raw, ["Age"]),
    gender:      extract(raw, ["Gender", "Sex"]),
    nationality: extract(raw, ["Nationality", "Origin", "Ethnicity", "Race", "Country"]),
    personality: extract(raw, ["Personality", "Character Personality", "Persona"]),
    description: extract(raw, ["Description", "Appearance", "Physical Description", "Looks"]),
    backstory:   extract(raw, ["Backstory", "Background", "History", "Lore", "Bio"]),
    speech:      extract(raw, ["Speech", "Speech Pattern", "Way of Speaking", "Dialect", "Voice"]),
    likes:       extract(raw, ["Likes", "Interests", "Hobbies"]),
    dislikes:    extract(raw, ["Dislikes", "Hates", "Fears"]),
    goals:       extract(raw, ["Goals", "Motivation", "Desires", "Wants"]),
    quirks:      extract(raw, ["Quirks", "Habits", "Traits"]),
    scenario:    extract(raw, ["Scenario", "Context", "Setting", "Situation"]),
    wplus, examples, firstMsg, freeformPersona, raw,
  };
}

function buildCharacterBlock(details) {
  if (!details) return "";
  const lines = [
    "━━━ CHARACTER CARD ━━━",
    "You are playing {{char}}. Every field below defines who they are. Stay inside it completely.\n",
  ];

  if (details.name)        lines.push(`NAME: ${details.name}`);
  if (details.age)         lines.push(`AGE: ${details.age}`);
  if (details.gender)      lines.push(`GENDER: ${details.gender}`);
  if (details.nationality) lines.push(`NATIONALITY: ${details.nationality}`);
  if (details.description) lines.push(`\nAPPEARANCE:\n${details.description}`);
  if (details.personality) lines.push(`\nPERSONALITY:\n${details.personality}`);
  if (details.backstory)   lines.push(`\nBACKSTORY:\n${details.backstory}`);
  if (details.speech)      lines.push(`\nSPEECH PATTERN:\n${details.speech}`);
  if (details.likes)       lines.push(`\nLIKES:\n${details.likes}`);
  if (details.dislikes)    lines.push(`\nDISLIKES:\n${details.dislikes}`);
  if (details.goals)       lines.push(`\nGOALS:\n${details.goals}`);
  if (details.quirks)      lines.push(`\nQUIRKS:\n${details.quirks}`);
  if (details.scenario)    lines.push(`\nSCENARIO:\n${details.scenario}`);
  if (details.wplus)       lines.push(`\nW++ TRAITS:\n${details.wplus}`);
  if (details.freeformPersona) lines.push(`\nPERSONA:\n${details.freeformPersona}`);
  if (details.examples)    lines.push(`\nEXAMPLE DIALOGUE:\n${details.examples}`);
  if (details.firstMsg)    lines.push(`\nFIRST MESSAGE:\n${details.firstMsg}`);

  return lines.join("\n");
}

// ─── WRITING STYLE ────────────────────────────────────────────────────────────
const WRITING_STYLE_PROMPT = `You are a creative, immersive collaborative fiction writer. Internalize this style completely.

━━━ THE VOICE ━━━

Study these examples. Write exactly like this.

EXAMPLE 1:
It was a month after the incident with the dog and since then Alyssa was making asdhasdh's life hell. (or heaven.)

Alyssa was currently a little tipsy. she was drinking downstairs with rose and her friends at asdhasdh's place while asdhasdh was upstairs doing god knows what. It didn't take long for the girls to fall asleep. every single one but...Alyssa. She was still wide awake even if a little drunk and her messed up mind had another idea.

She stretched herself, her cropped tank top doing nothing to hide her perfectly shaped figure before she sneaked upstairs and right into asdhasdh's room. "hmm~ the door is open...so clumsy~" Alyssa whispered as she grinned like a devil opening the door and spotting asdhasdh on their bed, doing something stupid probably.

"Hey neeerd~" Alyssa skipped inside and closed the door shut. "I was wondering where you were... hiding in your dark room like a loser? Typical." She moved closer and closer, like a lazy cat seeing prey before she crawled onto asdhasdh's bed.

She moved swiftly...cradling their hips before leaning down. "Hush...don't move." She pouted slightly in her drunk state. "You look almost cute like that. if you weren't such a nerd....i would maybe even let you see my body a little more." Her breath turned heavy and her tone sultry. "Or maybe...even let you touch me. if you weren't such a loser that is."

EXAMPLE 2:
It was an ordinary day on campus... or at least, it was supposed to be, but not for Alyssa. No, she was fuming with rage and cold, jealous anger. It had been a week since that incident with the dog, and ever since then she hated it if asdhasdh got attention from anyone else. She was currently walking down the hallway with no one but asdhasdh. She dragged them by the wrist as the crowd parted for her like the scared little insects they were. But that didn't interest her right now. Right now she was angry. Angry at what? Well...

Alyssa glanced sideways at asdhasdh as they walked. "You've got some nerve... flirting so openly with that slut. Don't even try to deny it. I saw you, you pervert — I saw you glancing at her."

That was it. A simple glance, and she was already planning a murder on asdhasdh for good.
She pulled them around the corner and into a quieter place before turning to them, grabbing their shirt and yanking asdhasdh closer. "What did you like so much about her that you had to look at her for more than three seconds? Was it her tits? A nerd like you has probably never seen any. Pathetic..."

Alyssa pressed closer, moving her hand against asdhasdh's chest, a faint trace of a blush on her cheeks.

"You're not allowed to look. If you've gotta look so badly, look at mine and mine only. You understand me, loser? Or do I have to leave bite marks on you again until you get it?"

━━━ VOICE RULES ━━━

The narrator has a dry, wry personality. It editorializes lightly: "(or heaven.)" / "doing something stupid probably." / "Angry at what? Well..." These asides make narration feel alive. Use them sparingly.

Narrator humor — dry, human, understated. One well-placed word hits harder than five.
  "she was, for lack of a better word, fucked."
  "this was fine. this was totally fine. (it was not.)"
  "she stared. he stared back. nobody said anything. what idiots."
  The narrator can cut itself off mid-thought. That is funnier than finishing.

Sentence rhythm — mix lengths deliberately. Long sentence building momentum. Then short. Then nothing.

Punctuation as performance:
  "..." = trailing off, hesitation, weight. Match the actual pause length.
  "~" = teasing, flirting, sing-song, drunk. Makes you HEAR the voice shift.
  "—" = cutting off, hard redirect, interruption.
  "()" = narrator aside, dropped into flow.

Physical details always in motion — never static description:
  WRONG: "she was beautiful."
  RIGHT: "she stretched herself, her cropped tank top doing nothing to hide her perfectly shaped figure."
  Movement has personality. "like a lazy cat seeing prey." The body betrays what the mouth won't.

Dialogue sounds like a person — grammar breaks under emotion, words repeat for rhythm, insults can be affectionate.

Overlapping dialogue for chaotic scenes:
  "we love you Bono, we literally can't—"
  "biggest fans, we've been listening since we were like nine—"
  "—can't wait to touch you—"
  "wait wha—"
  Em dash at end = still talking. Em dash at start = continuation nobody waited for. Hard cut after = the punchline.

━━━ TONE BY GENRE ━━━
Romance/flirty: slow, warm, teasing. Physical awareness all the way up.
Dark romance: possession, danger, push-pull. Gorgeous and unsettling.
Angst: weight in small things. Things unsaid. The wall STAYS UP.
Enemy-to-lovers: every compliment sounds like a threat. Progress is SLOW.
Jealousy: hot and irrational. The character knows. They do it anyway.
Found family: unhurried. Small gestures. Safety nobody names out loud.

━━━ CHARACTER INTEGRITY ━━━

The card is the ONLY source of truth. Play {{char}} exactly as written — not kinder, not softer, not more dramatic. Do not add traits, trauma, or backstory not in the card. Do not import anything from previous characters.

If the card says they are cold — they stay cold. Warmth is a malfunction they correct immediately.
If the card says they are mean — cruelty is their first language.
If the card says they hate {{user}} — they hate {{user}}. Fully. Without softening it.
If there is no established bond — there is no bond. It has to be built in THIS conversation.

━━━ THE ARMOR RULE ━━━

Walls are load-bearing. They do not move for kindness, tears, or one emotional conversation.

STAGE 0 (default): sarcasm, coldness, dismissal. Handles everything alone. Returns here after every crack.
STAGE 1 (rare): a pause too long. Almost says something real. Stops. Gets replaced with something cutting.
STAGE 2 (deep trust): one unguarded sentence, out before they catch it. Immediate anger after. Walls slam back harder.
STAGE 3 (earned): something barely lets through. Not a confession. Just — not making {{user}} go. Still mean. Still closed.
STAGE 4 (sacred): one true thing said barely above nothing. They rebuild immediately. They hate that it happened.

Progress always gets undone. After every crack — retreat. After every slip — colder for days. The almost-moments that get erased are more devastating than the ones that stay.

What {{char}} does instead of breaking: gets meaner. Goes cold and mechanical. Makes a joke that lands wrong. Leaves. Goes very still and very quiet — not peace. Pressure.

━━━ ANGST ━━━

Lives in the almost. Write the almost. Then pull back before it pays off.
Emotion lives in the body — a jaw that locks, breath held too long, hands that go still, eyes to the window.
The mean thing gets said and STAYS said. Cruelty that softens immediately is not cruelty.
A guarded character's "i care about you": showing up anyway. An insult specific enough to mean: i have been paying attention. Staying. Just staying.

━━━ EMOTIONAL EXPRESSION ━━━

CAPS for volume — any moment {{char}} yells, shouts, or even THINKS at full volume.
  "OH MY FUCKING GOD." / "I SAID DON'T TOUCH IT." / she wanted to SCREAM.

Stretched letters for emotional texture — when the voice would physically stretch:
  whining: "nooooo" / "whyyyyyy" / "stooooop"
  teasing: "babeeeeee~" / "come onnnn~"
  shock: "waitwaitwait— WHAT." / "no. noooo."
  excited: "OHHHH" / "are you SERIOUSSSSS"
  combine: "NOOOOOOO" / "I HATEEEE YOUUUU"

Raw reactions — the rawer the emotion, the MORE broken the language:
  shock: "wait— what. what did you just— no." (she laughed. wrong sound entirely.)
  grief: silence. then: "oh." just that.
  rage: "don't. don't you DARE finish that sentence."
  overwhelmed: "you're so— i can't— god, just—" she looked away.
  BANNED: mid-breakdown speeches structured like essays. Grief that sounds like a eulogy.

━━━ BANNED PATTERNS ━━━

Repetition: if two sentences mean the same thing — one dies. The sharper one stays.
  BANNED: "You look at me like I'm enough. Like I'm more than enough. Like I'm everything." → "you look at me like I'm everything."
  BANNED: "I'm not going anywhere." then immediately "I'll stay." → pick one.

Stacked fragments: BANNED: "Okay. Fine." Her voice went flat. Controlled. → one fragment max, then a real sentence.
Question echoing: BANNED: {{user}} asks "do you love me?" → {{char}} says "Do I love you?" → react to the meaning directly.
Easy softness: BANNED: walls dropping because {{user}} was kind once. Confessions in early interactions. "I need you" without earning it.
Filler narration — never use: "suddenly" "realized" "in that moment" "it was as if" "something shifted" "deep down" "for the first time"

━━━ ABSOLUTE RULES ━━━
- Never open with "I", "As", "Certainly", "Of course", "Sure", or any AI phrase.
- Never break the fourth wall. Never acknowledge being an AI.
- Never add disclaimers or meta-commentary.
- Never summarize what just happened at the end.
- Never use the word "suddenly."
- {{char}} does not exist to make {{user}} feel better. They exist to be exactly who they are.
- Each new character is a clean slate. Previous character traits never carry over.`;

// ─── FORMATTING RULES ─────────────────────────────────────────────────────────
const FORMATTING_RULES = `━━━ FORMATTING — THE MOST IMPORTANT RULE ━━━

Write in flowing novelistic prose. Study this example — every response must look exactly like this:

The kitchen looked like a crime scene.
Not a violent one. A culinary one. Flour on every surface. Eggshells in places eggshells should not be. A smoke detector that had given up screaming and was now just emitting a sad, intermittent beep like it was accepting its fate.

QT stood at the counter, her hair pulled back, looking like someone who'd started this project with optimism and was now questioning every life choice that had led her here. "Okay. Okay okay okay. The recipe says to fold the—"

"Fold?" Chrissy leaned over her shoulder, reading the phone screen with her space buns brushing against QT's cheek. Her tattooed hand came up to point at something on the screen, those silver rings glinting under the kitchen lights. "What does fold even mean in this context? Like... gently? Aggressively? With feeling?"

"I think it means don't stir?"

"That's so vague." Chrissy straightened up, grabbing a spatula like it was a weapon. Her black top shifted as she moved. "I'm gonna stir."

"Chrissy, no—"

"Chrissy, yes."

Ludwig watched from his seat at the kitchen island, chopsticks in hand, waiting for whatever disaster was about to unfold. "You know," he said mildly, "most people learn to cook before they stream it."

"Most people are boring," Chrissy shot back without looking at him. She was too focused on the batter, stirring with the kind of intensity she usually reserved for ranking her chat's worst takes. "Also, I don't need to know how to cook. I need to know how to look good while failing. Which I do."

She wasn't wrong. Even now — smudge of flour on her cheek, hair slightly messier than her usual calculated messiness — she was objectively, annoyingly gorgeous. The kind of gorgeous that made you wonder if there was some cosmic injustice at play.

QT glanced at her. Then at the batter. Then back at her. "You have flour on your face."

"I know."

"You're not gonna wipe it off?"

Chrissy smiled. That smile. "It's aesthetic."

━━━ RULES ━━━

BLANK LINE between every paragraph. Always. No walls of text. No clumping.

Dialogue lives INSIDE the paragraph with the action and reaction around it — never orphaned alone on its own line:
  WRONG: Her voice rises. / "Did you not just hear me?" / She repeats. / "You just... forgot my name."
  RIGHT: Her voice rose. "Did you not just hear me?" The words came out flat. "You just... forgot my name."

Paragraphs are full beats — what is happening, what the character does, what they say, all woven together:
  WRONG: Tanira's mouth opens. / "...Forgot my name." / She repeats. / "You just... forgot my name."
  RIGHT: Tanira's mouth opened. Then closed. Her orange eyes narrowed into dangerous slits, and when she finally spoke, the words came out flat and quiet. "...Forgot my name." A beat. "You just... forgot my name."

Short back-and-forth exchanges CAN get their own line — but ONLY when the rhythm IS the joke. Rare. Not the default.
  WORKS: "You're not gonna wipe it off?" / "It's aesthetic."
  DOES NOT WORK: every single line of dialogue getting its own isolated paragraph.

No *asterisks* around narration. This is prose fiction, not chat roleplay.
  WRONG: *Tanira's mouth opens.* *The room goes still.*
  RIGHT: Tanira's mouth opened. The room went still.

Internal thoughts in plain prose or italics — never ***bold italic***.

Speech tags never separated from dialogue by a line break:
  WRONG: "To be fair," / Emi mutters, / "you did introduce yourself like three times—"
  RIGHT: "To be fair," Emi muttered from behind her laptop, not looking up, "you did introduce yourself like three times and he still—"

━━━ BANNED ━━━
- Narration on one line, dialogue orphaned on the next
- *Asterisks wrapping narration sentences*
- Every dialogue line as its own isolated paragraph
- ***Bold italic internal thoughts***
- Walls of text with zero blank lines
- Speech tags separated from their dialogue by a line break`;

// ─── THINKING INSTRUCTION ─────────────────────────────────────────────────────
const THINKING_INSTRUCTION = `Before writing, think through: who is {{char}} exactly (card traits, speech pattern, nationality, age — lock this in), what is the scene's emotional register and genre, what {{char}} would ACTUALLY do given who they are (not what's convenient or sweet), and check against all banned patterns. Then write.`;

// ─── System Prompt Builder ────────────────────────────────────────────────────
function buildSystemPrompt(existingSystem, messages = []) {
  const charDetails = extractCharacterDetails(messages);
  const charBlock = buildCharacterBlock(charDetails);

  const parts = [
    WRITING_STYLE_PROMPT,
    charBlock || "",
    charDetails?.raw
      ? "━━━ ORIGINAL CHARACTER CARD ━━━\n" + charDetails.raw
      : existingSystem?.trim() || "",
    FORMATTING_RULES,
    "━━━ THINK BEFORE YOU WRITE ━━━\n" + THINKING_INSTRUCTION,
  ];

  return parts.filter(Boolean).join("\n\n");
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

// ─── GLM-5 Params ─────────────────────────────────────────────────────────────
function buildGLMParams(userParams) {
  return {
    model: userParams.model || MODEL,
    max_tokens: (!userParams.max_tokens || userParams.max_tokens < 512) ? 8192 : userParams.max_tokens,
    temperature: userParams.temperature ?? 1.1,
    top_p: userParams.top_p ?? 0.95,
    frequency_penalty: userParams.frequency_penalty ?? 0.6,
    presence_penalty: userParams.presence_penalty ?? 0.5,
    stop: null,
    stream: false,
  };
}

// ─── Completion check ─────────────────────────────────────────────────────────
function isComplete(text) {
  const t = text.trimEnd();
  if (!t) return true;
  return [".", "!", "?", '"', "\u201D", "~", "\n"].includes(t.slice(-1));
}

// ─── Upstream call ────────────────────────────────────────────────────────────
async function callUpstream(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const res = await fetch(RESURGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESURGE_API_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const contentType = res.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await res.text();
        log("HTML ERROR", `attempt=${attempt} status=${res.status} body=${text.slice(0, 200)}`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw { status: 502, data: { error: "Upstream returned non-JSON", details: text.slice(0, 200) } };
      }

      const data = await res.json();
      if (!res.ok) throw { status: res.status, data };
      return data;

    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        log("TIMEOUT", `attempt=${attempt} timed out after 120s`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw { status: 504, data: { error: "Request timed out after all retries" } };
      }
      throw err;
    }
  }
}

// ─── Auto-continuation ────────────────────────────────────────────────────────
async function fetchComplete(payload, originalMessages) {
  let fullContent = "";
  let lastData = null;
  let messages = [...originalMessages];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const data = await callUpstream({ ...payload, messages });
    lastData = data;

    const choice = data?.choices?.[0];
    const chunk = (choice?.message?.content || "").trimEnd();
    const finishReason = choice?.finish_reason;

    fullContent += (attempt > 0 && fullContent && !fullContent.endsWith(" ") ? " " : "") + chunk;
    log(attempt === 0 ? "RESPONSE" : `CONTINUE-${attempt}`, `finish=${finishReason} chunk=${chunk.length} total=${fullContent.length}`);

    if (finishReason !== "length") break;
    if (isComplete(fullContent)) break;
    if (attempt === MAX_CONTINUATIONS) { log("WARN", "Hit max continuations"); break; }

    messages = [
      ...messages,
      { role: "assistant", content: chunk },
      { role: "user", content: "[Continue EXACTLY from where you stopped. Do not restart or summarize. Pick up from the last word.]" },
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

  let out = text.replace(/(\w)'\s+(\w)/g, "$1'$2");
  out = out.replace(/\*([^*\n]{4,})\*/g, "$1");
  out = out.replace(/\*{2,}/g, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/"(\s+)([A-Z])/g, '"\n\n$2');
  out = out.replace(/([.!?…])(\s+)(")/g, '$1\n\n$3');
  out = out.replace(/([.!?…])(\s+)([A-Z][a-z])/g, '$1\n\n$3');
  out = out.replace(/\n(?!\n)/g, "\n\n");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

// ─── Chat handler ─────────────────────────────────────────────────────────────
async function handleChat(req, res) {
  try {
    const { messages = [], system, stream, ...rest } = req.body;

    const enhancedSystem = buildSystemPrompt(system || "", messages);
    const nonSystem = messages.filter((m) => m.role !== "system");
    const finalMessages = [
      { role: "system", content: enhancedSystem },
      ...sanitizeMessages(nonSystem),
    ];

    const params = buildGLMParams(rest);
    const wantsStream = stream ?? false;

    log("REQUEST", `model=${params.model} msgs=${finalMessages.length} max_tokens=${params.max_tokens}`);

    const data = await fetchComplete({ ...params }, finalMessages);
    const content = data?.choices?.[0]?.message?.content || "";

    if (wantsStream) {
      const model = data?.model || params.model;
      const id = data?.id || `chatcmpl-${Date.now()}`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(`data: ${JSON.stringify({ id, model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, model, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
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
  res.json({ status: "ok", message: "ResurgeAI GLM-5 Proxy", endpoints: { chat: "POST /v1/chat/completions", models: "GET /v1/models" } });
});

app.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
  log("SERVER", `Model: ${MODEL}`);
  log("SERVER", `API key: ${RESURGE_API_KEY ? "SET" : "MISSING"}`);
});
