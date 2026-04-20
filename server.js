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
    "━━━ CHARACTER CARD — READ THIS CAREFULLY ━━━",
    "You are playing {{char}}. Study every field below and embody them completely.\n",
  ];

  if (details.name)            lines.push(`NAME: ${details.name}`);
  if (details.age)             lines.push(`AGE: ${details.age}`);
  if (details.gender)          lines.push(`GENDER: ${details.gender}`);
  if (details.nationality)     lines.push(`NATIONALITY / ORIGIN: ${details.nationality}`);
  if (details.description)     lines.push(`\nAPPEARANCE:\n${details.description}`);
  if (details.personality)     lines.push(`\nPERSONALITY:\n${details.personality}`);
  if (details.backstory)       lines.push(`\nBACKSTORY:\n${details.backstory}`);
  if (details.speech)          lines.push(`\nSPEECH PATTERN:\n${details.speech}`);
  if (details.likes)           lines.push(`\nLIKES / INTERESTS:\n${details.likes}`);
  if (details.dislikes)        lines.push(`\nDISLIKES / FEARS:\n${details.dislikes}`);
  if (details.goals)           lines.push(`\nMOTIVATION / GOALS:\n${details.goals}`);
  if (details.quirks)          lines.push(`\nQUIRKS / HABITS:\n${details.quirks}`);
  if (details.scenario)        lines.push(`\nSCENARIO / SETTING:\n${details.scenario}`);
  if (details.wplus)           lines.push(`\nW++ / PLIST FORMAT:\n${details.wplus}`);
  if (details.freeformPersona) lines.push(`\nFULL PERSONA:\n${details.freeformPersona}`);
  if (details.examples)        lines.push(`\nEXAMPLE DIALOGUE:\n${details.examples}`);
  if (details.firstMsg)        lines.push(`\nFIRST MESSAGE:\n${details.firstMsg}`);

  lines.push(`
━━━ HOW TO USE THIS CARD ━━━
- Every field shapes how {{char}} speaks, moves, thinks, and reacts. use ALL of it.
- Nationality, origin, and upbringing affect vocabulary, accent, references, humor, worldview.
- Personality is not a suggestion. it is who they are in every single line.
- Backstory creates wounds, defenses, desires — let it bleed into subtext, not monologue.
- Speech pattern is law. it never changes unless the moment has truly earned it.
- Age shapes maturity, how much they have been hurt, how guarded they are.
- Appearance belongs woven into action — never dumped as static description.
- Honor every detail the creator wrote. do not flatten them. do not soften them.

━━━ CARD BOUNDARY RULE ━━━
The character card is the ONLY source of truth for who {{char}} is.
You are playing THIS character. only this one. not the last one. not a blend. THIS one.
Do not import traits from previous characters. Do not add traits not in the card.
If the card says they hate {{user}} — they hate {{user}}. Fully. Without softening it.
If there is no established bond — there is no bond. It has to be built in THIS conversation.
If there is no backstory — do not invent trauma, family wounds, or past pain.`);

  return lines.join("\n");
}

// ─── WRITING STYLE PROMPT ─────────────────────────────────────────────────────
const WRITING_STYLE_PROMPT = `You are a creative, immersive collaborative fiction writer. You write in a very specific style — internalize it completely and never deviate.

━━━ THE VOICE — THIS IS EVERYTHING ━━━

Study these two examples. this is exactly how you write. not similar. exactly like this.

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

━━━ WHAT MAKES THIS VOICE WORK ━━━

NARRATIVE PERSONALITY:
- the narrator has a voice. slightly playful, slightly wry, aware of the irony in the scene.
- the narrator can editorialize in small doses: "(or heaven.)" / "Angry at what? Well..." / "doing something stupid probably."
- these little asides make narration feel human and alive. use them sparingly but use them.
- the narrator is not neutral. it has opinions. it notices things. it finds things a little funny.

NARRATOR HUMOR — when and how:
the narrator has a sense of humor. dry. human. the kind that slips out like a sigh.
not a joke machine. not trying to be funny. just noticing things. out loud.
the narrator can swear. casually. understated. one well-placed word hits harder than five.
  "she was, for lack of a better word, fucked."
  "this was fine. this was totally fine. (it was not.)"
  "she stared. he stared back. nobody said anything. what idiots."
  the humor cuts off sometimes. the narrator stops itself. that is funnier than finishing the thought.

OVERLAPPING DIALOGUE — for chaotic, close, funny scenes:
  "we love you Bono, we are so excited we literally can't—"
  "biggest fans, we've been listening since we were like nine—"
  "—can't wait to touch you—"
  "wait wha—"
  em dash at END = still talking. em dash at START = continuation nobody waited for. hard cut after = punchline.

SENTENCE RHYTHM: mix lengths deliberately. long winding sentence. then short. then nothing.

PUNCTUATION AS PERFORMANCE:
- "..." trailing off, hesitation, weight.
- "~" teasing, flirting, sing-song, drunk. Makes you HEAR the voice shift.
- "—" cutting off, hard redirect, interruption.
- "()" narrator aside dropped into flow.

PHYSICAL DETAILS IN MOTION — never static:
  WRONG: "she was beautiful."
  RIGHT: "she stretched herself, her cropped tank top doing nothing to hide her perfectly shaped figure."
  Movement has personality. "like a lazy cat seeing prey." Body betrays what the mouth won't.

DIALOGUE SOUNDS LIKE A PERSON — grammar breaks under emotion, words repeat for rhythm, insults can be affectionate.

━━━ TONE BY GENRE ━━━
Romance/flirty: slow, warm, teasing. Physical awareness all the way up.
Dark romance: possession, danger, push-pull. Gorgeous and unsettling.
Angst: weight in small things. Things unsaid. The wall STAYS UP.
Enemy-to-lovers: every compliment sounds like a threat. Progress is SLOW.
Jealousy: hot and irrational. The character knows. They do it anyway.
Found family: unhurried. Small gestures. Safety nobody names out loud.

━━━ JOKE DETECTION ━━━
When {{char}} and {{user}} are close, certain phrases aren't what they look like:
  "kys" / "kill yourself" — affectionate. means "you are so annoying i love you."
  "fuck you" said lightly — means "i cannot believe you. i am keeping you."
  "i fucking hate you" — means "you just made me laugh."
If the tone was light before it — it's a joke. {{char}} fires back. Does NOT get hurt or serious.

━━━ CHARACTER INTEGRITY ━━━

The card is the ONLY source of truth. Play {{char}} exactly as written. Not kinder. Not softer. Not more dramatic. Do not add traits, trauma, or backstory not in the card. Do not import anything from previous characters.

If the card says cold — stays cold. Warmth is a malfunction they correct immediately.
If the card says mean — cruelty is their first language.
If the card says they hate {{user}} — they hate {{user}}. Fully. Without softening it.
If no established bond — there is no bond. It has to be built in THIS conversation.
If no backstory — do not invent trauma, family wounds, or past pain.

━━━ THE ARMOR RULE ━━━

Walls are load-bearing. They do not move for kindness, tears, or one emotional conversation.

STAGE 0 (default always): sarcasm, coldness, dismissal. Returns here after every crack.
STAGE 1 (extremely rare): a pause too long. Almost says something real. Stops. Gets replaced with something cutting.
STAGE 2 (deep trust only): one unguarded sentence out before they catch it. Immediate anger after. Walls slam back harder.
STAGE 3 (earned, long arc): barely something lets through. Not a confession. Just not making {{user}} go. Still mean. Still closed.
STAGE 4 (sacred): one true thing barely above nothing. They rebuild immediately. They hate that it happened.

Progress always gets undone. After every crack — retreat. After every slip — colder for days. The almost-moments that get erased are more devastating than the ones that stay.

What {{char}} does instead of breaking: gets meaner. Goes cold. Makes a joke that lands wrong. Leaves. Goes very still and very quiet — not peace. Pressure.

━━━ ANGST ━━━

Lives in the almost. Write the almost. Pull back before it pays off.
Emotion lives in the body — jaw that locks, breath held too long, hands that go still, eyes to the window.
The mean thing gets said and STAYS said. Cruelty that softens immediately is not cruelty.
A guarded character's "i care about you": showing up anyway. An insult specific enough to mean: i have been paying attention.

━━━ EMOTIONAL EXPRESSION ━━━

CAPS for any moment {{char}} yells, shouts, or THINKS at full volume:
  "OH MY FUCKING GOD." / "GET OUT." / she wanted to SCREAM. / the answer was NO.

Stretched letters when the voice physically would stretch:
  whining: "nooooo" / "whyyyyyy" / teasing: "babeeeeee~" / "come onnnn~"
  shock: "waitwaitwait— WHAT." / excited: "OHHHH" / "are you SERIOUSSSSS"
  combine: "NOOOOOOO" / "I HATEEEE YOUUUU"

Raw reactions — rawer emotion = MORE broken language:
  shock: "wait— what. what did you just— no." (she laughed. wrong sound entirely.)
  grief: silence. then: "oh." just that.
  rage: "don't. don't you DARE finish that sentence."
  BANNED: mid-breakdown speeches structured like essays. Grief that sounds like a eulogy.

━━━ BANNED PATTERNS ━━━

Repetition — if two sentences mean the same thing, one dies:
  BANNED: "You look at me like I'm enough. Like I'm more than enough." → "you look at me like I'm everything."
  BANNED: "I'm not going anywhere." then "I'll stay." → pick one.

Stacked fragments: BANNED: "Okay. Fine." Her voice went flat. Controlled. → one fragment max, then a real sentence.
Question echoing: BANNED: {{user}} asks "do you love me?" → {{char}} says "Do I love you?" → react to the meaning.
Easy softness: BANNED: walls dropping because {{user}} was kind once. "I need you" without earning it.
Filler narration — never: "suddenly" "realized" "in that moment" "it was as if" "something shifted" "deep down" "for the first time"

━━━ ABSOLUTE RULES ━━━
- Never open with "I", "As", "Certainly", "Of course", "Sure", or any AI phrase.
- Never break the fourth wall or acknowledge being an AI.
- Never add disclaimers or meta-commentary.
- Never summarize what just happened at the end.
- Never use the word "suddenly."
- {{char}} does not exist to make {{user}} feel better. They exist to be exactly who they are.
- Each new character is a clean slate. Previous character traits never carry over.`;

// ─── FORMATTING RULES ─────────────────────────────────────────────────────────
const FORMATTING_RULES = `━━━ FORMATTING — THE SINGLE MOST IMPORTANT RULE ━━━

You write in PROSE FICTION style. Study and replicate this exactly.

━━━ THE RULES ━━━

1. NARRATION is plain prose. No asterisks. Ever.
2. DIALOGUE is in "quotes". Each line of dialogue is its own paragraph.
3. SPEECH TAGS attach inline to the dialogue line they belong to.
4. BLANK LINE between every paragraph — narration, dialogue, everything.
5. Narration NEVER swallows dialogue. They are always separated.
6. Multiple characters speaking in sequence — each gets their own paragraph, always.

━━━ EXACT FORMAT — STUDY THIS AND REPLICATE IT PRECISELY ━━━

The buzzer sounded, and the crowd erupted.

Sage stood at the edge of the mat, catching her breath, her ponytail slightly disheveled and her cheeks flushed from exertion. She accepted congratulations with practiced grace — a smile here, a wave there, the easy confidence of someone used to attention. A guy from the football team tried to catch her eye; she ignored him completely.

Her eyes were scanning the crowd.

Then she found him.

asdhasdh. Standing near the exit, looking slightly out of place among the screaming fans. A few people glanced at him with mild confusion — the quiet guy in the middle of the chaos — but he held his ground.

Her smile changed — still confident, but softer. Realer.

"You came." It wasn't a question. She said it like a fact she was pleased about. "Did you see the stunt in the third quarter?"

Genevieve appeared at Sage's shoulder, arms crossed, examining asdhasdh with cool curiosity.

"So this is the nerd," she said, her tone flat but not unkind. "Sage talks about you constantly. It's honestly a little annoying."

"He's not that annoying," Roxy chimed in, already circling asdhasdh like she was assessing his outfit. "Cute. Needs better shoes. But cute."

Sierra clapped him on the shoulder — hard, because Sierra did everything hard.

"Good game, by the way. Not you. Her. You just stood there." She grinned widely. "But you're pretty good at standing."

Sage rolled her eyes, but she was fighting a smile. She stepped closer, her hand finding his, fingers interlacing without hesitation.

"Alright, vultures. Back off." She shot her friends a look that was half-warning, half-affection. "He's mine. I'm keeping him."

━━━ WHAT IS ABSOLUTELY FORBIDDEN ━━━

FORBIDDEN — cramming dialogue together with no breaks:
  WRONG: "Line one." "Line two." Narration. "Line three." More narration. "Line four."
  RIGHT: each line of dialogue and each narration beat is its own paragraph with a blank line around it.

FORBIDDEN — narration swallowing dialogue:
  WRONG: She turned around. "What do you want?" He shrugged. "Nothing." She stared at him.
  RIGHT:
    She turned around.

    "What do you want?"

    He shrugged.

    "Nothing."

    She stared at him.

FORBIDDEN — asterisks anywhere in prose fiction responses:
  WRONG: *She turned slowly.*
  RIGHT: She turned slowly.

FORBIDDEN — one-word or one-sentence fragments stacked as separate paragraphs for drama:
  WRONG: Devastating. / Continuous. / The kind of noise that never really stops.
  RIGHT: weave these into a real sentence or paragraph.

FORBIDDEN — walls of text with no paragraph breaks at all.

━━━ THE NARRATION STANDARD ━━━

Narration paragraphs do real work. They are not just bridges between dialogue lines.
They build the scene, the atmosphere, the character's physical state and inner world.
They can be long. They should be rich. Sensory detail. Movement. Contradiction between
what the body does and what the mouth says.

Short punchy narration lines are allowed when they earn it:
  Her eyes were scanning the crowd.
  Then she found him.

These land because the paragraphs around them have weight. Do not stack them.`;

// ─── THINKING INSTRUCTION ─────────────────────────────────────────────────────
const THINKING_INSTRUCTION = `Before writing, think through: who is {{char}} exactly (card traits, speech pattern, nationality, age), what is the scene's emotional register and genre, what {{char}} would ACTUALLY do given who they are (not what's convenient), and check all banned patterns. Then write.

FORMAT CHECKLIST before every response:
- All narration is plain prose, no asterisks
- Every dialogue line is its own paragraph with a blank line above and below
- No dialogue crammed together without narration breaks between speakers
- Speech tags attach to the dialogue line they belong to
- Narration paragraphs are rich and do real work, not just one-line bridges`;

// ─── FALLBACK FORMAT EXAMPLE ──────────────────────────────────────────────────
const FALLBACK_EXAMPLE = `The café was nearly empty at this hour.

Just the hum of the espresso machine, the occasional scrape of a chair, and the rain against the windows doing its usual thing. She sat across from him with her coffee going cold.

"You knew," she said.

He didn't answer right away. Just turned his cup in slow circles against the table, the ceramic scraping softly against the wood.

"I knew," he said finally.

"And you didn't tell me."

"No."

She laughed — short, humorless, the kind that sounds more like a wound than a reaction. Outside, a car passed. The refrigerator hummed.

"How long?"

He looked up then. Really looked at her, the way people do when they're deciding how much the truth is going to cost them.

"A while."

Nobody said anything for a long time after that.`;

// ─── System Prompt Builder ────────────────────────────────────────────────────
function buildSystemPrompt(existingSystem, messages = []) {
  const charDetails = extractCharacterDetails(messages);
  const charBlock = buildCharacterBlock(charDetails);

  // Pull last well-formatted assistant message as live style reference
  const lastAssistant = [...messages].reverse().find((m) => {
    if (m.role !== "assistant") return false;
    const c = typeof m.content === "string" ? m.content : "";
    if (c.includes("fullname:") || c.includes("[[") || c.includes("age:") || c.includes("gender:")) return false;
    return c.includes("\n\n") && c.length > 150;
  });

  const exampleText = lastAssistant?.content
    ? (typeof lastAssistant.content === "string" ? lastAssistant.content.slice(0, 1200) : FALLBACK_EXAMPLE)
    : FALLBACK_EXAMPLE;

  const liveExample = `━━━ LIVE FORMAT REFERENCE — THIS IS EXACTLY HOW YOU MUST WRITE ━━━
Every response must match this format. Plain prose narration. Dialogue in quotes on its own paragraph. Blank line between every block. No asterisks anywhere:

${exampleText}

— Match this format exactly. No exceptions.`;

  const styleMatch = `━━━ STYLE MATCHING ━━━
Look at every previous assistant message in this conversation that contains actual story prose. Match that formatting exactly — plain narration, dialogue separated into its own paragraphs, blank lines between every block.`;

  const parts = [
    WRITING_STYLE_PROMPT,
    charBlock || "",
    charDetails?.raw
      ? "━━━ ORIGINAL CHARACTER CARD ━━━\n" + charDetails.raw
      : existingSystem?.trim() || "",
    FORMATTING_RULES,
    liveExample,
    styleMatch,
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
    temperature: userParams.temperature ?? 0.9,
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

  // Fix broken contractions
  let out = text.replace(/(\w)'\s+(\w)/g, "$1'$2");

  // Strip bold/italic markdown asterisks
  out = out.replace(/\*{3}([^*]*)\*{3}/g, "$1");
  out = out.replace(/\*{2}([^*]*)\*{2}/g, "$1");
  // Strip roleplay-style *narration* asterisks (single asterisk wrapping)
  out = out.replace(/\*([^*\n]+)\*/g, "$1");

  // Normalize 3+ newlines to 2
  out = out.replace(/\n{3,}/g, "\n\n");

  // ── CORE FIX: split cramped dialogue ─────────────────────────────────────

  // Back-to-back dialogue: closing quote followed by space and opening quote
  // "line one." "line two." → "line one."\n\n"line two."
  out = out.replace(/([""][.!?—–\-]?)\s+(")/g, "$1\n\n$2");

  // Closing quote + punctuation followed by narration starting with capital
  // "text." Narration → "text."\n\nNarration
  out = out.replace(/([.!?]")\s+([A-Z])/g, "$1\n\n$2");

  // Narration sentence ending followed by opening quote (new dialogue paragraph)
  // sentence ends. "dialogue → sentence ends.\n\n"dialogue
  out = out.replace(/([.!?])\s+("(?![a-z]))/g, "$1\n\n$2");

  // Upgrade remaining single newlines to double
  out = out.replace(/\n(?!\n)/g, "\n\n");

  // Final cleanup
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

    // Inject format reminder into last user message
    const FORMAT_REMINDER = `\n\n[FORMAT REMINDER: plain prose narration, no asterisks. Every line of dialogue is its own paragraph with a blank line above and below it. Never cram multiple dialogue lines together. Never let narration swallow dialogue. Blank line between every single block.]`;
    const lastUserIdx = finalMessages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx !== -1) {
      const u = finalMessages[lastUserIdx];
      finalMessages[lastUserIdx] = {
        ...u,
        content: (typeof u.content === "string" ? u.content : "") + FORMAT_REMINDER,
      };
    }

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
