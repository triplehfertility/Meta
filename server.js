// Triple H Fertility Hub - Messaging Assistant
// Flow: WhatsApp / Messenger / Instagram message -> this server -> Gemini -> reply sent back.
// Supabase stores conversation memory and appointment requests. Staff can take over from /inbox.

const crypto = require("crypto");
const express = require("express");

const env = process.env;

// ====== REQUIRED SETTINGS (set these as environment variables on Render, never in this file) ======
const REQUIRED = ["VERIFY_TOKEN", "APP_SECRET", "GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ADMIN_PASSWORD"];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

// ====== OPTIONAL SETTINGS (each channel only works if its values are set) ======
const WHATSAPP_TOKEN = env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = env.PHONE_NUMBER_ID || "";
const PAGE_ACCESS_TOKEN = env.PAGE_ACCESS_TOKEN || ""; // Facebook Messenger
const IG_ACCESS_TOKEN = env.IG_ACCESS_TOKEN || "";
const IG_ACCOUNT_ID = env.IG_ACCOUNT_ID || "";
const STAFF_WHATSAPP_NUMBER = env.STAFF_WHATSAPP_NUMBER || ""; // gets alerts, e.g. 2348034043725
const BASE_URL = env.BASE_URL || ""; // e.g. https://triple-h-assistant.onrender.com
const ADMIN_USER = env.ADMIN_USER || "admin";
const ASSISTANT_NAME = env.ASSISTANT_NAME || "Triple H Assistant";
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GRAPH = "https://graph.facebook.com/v21.0";

const SESSION_TIMEOUT_MS = Number(env.SESSION_TIMEOUT_HOURS || 48) * 3600 * 1000;
const HUMAN_PAUSE_MS = Number(env.HUMAN_PAUSE_HOURS || 2) * 3600 * 1000;
const RETENTION_DAYS = Number(env.RETENTION_DAYS || 30); // chat history older than this is deleted
const DEBOUNCE_MS = 6000;
const MAX_HISTORY_TURNS = 30;
const BLOCKED_NUMBERS = (env.BLOCKED_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);

const WEBSITE_URLS = (env.WEBSITE_URLS ||
  "https://www.triplehfertilityhub.com/,https://www.triplehfertilityhub.com/services,https://www.triplehfertilityhub.com/about,https://www.triplehfertilityhub.com/contact")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MEDIA_PLACEHOLDER = "[The customer sent an image, file or voice note. The assistant cannot open it.]";
const FALLBACK_REPLY = "Sorry, I'm having trouble responding right now. A member of our team will follow up shortly.";

const app = express();
// Keep the raw body so we can verify Meta's signature on webhook calls
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// ====== Small helpers ======
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ====== Supabase (REST) ======
const sbHeaders = {
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sb(path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...sbHeaders, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ====== Conversation memory (cached in RAM, persisted in Supabase) ======
const cache = new Map();

function rowToConvo(row) {
  return {
    history: row.history || [],
    lastMessageTime: new Date(row.last_message_time).getTime(),
    lastCustomerTime: row.last_customer_time ? new Date(row.last_customer_time).getTime() : null,
    platform: row.platform || null,
    phoneNumberId: row.phone_number_id || null,
    humanPausedUntil: row.human_paused_until ? new Date(row.human_paused_until).getTime() : null,
  };
}

async function getConversation(senderId) {
  const now = Date.now();
  const cached = cache.get(senderId);
  if (cached && now - cached.lastMessageTime < SESSION_TIMEOUT_MS) return cached;

  try {
    const rows = await sb(`conversations?sender_id=eq.${encodeURIComponent(senderId)}&select=*`);
    const row = rows?.[0];
    if (row && now - new Date(row.last_message_time).getTime() < SESSION_TIMEOUT_MS) {
      const restored = rowToConvo(row);
      cache.set(senderId, restored);
      return restored;
    }
  } catch (err) {
    console.error("Failed to load conversation:", err.message);
  }

  const fresh = { history: [], lastMessageTime: now, lastCustomerTime: null, platform: null, phoneNumberId: null, humanPausedUntil: null };
  cache.set(senderId, fresh);
  return fresh;
}

async function saveConversation(senderId, convo) {
  if (convo.history.length > MAX_HISTORY_TURNS) convo.history = convo.history.slice(-MAX_HISTORY_TURNS);
  cache.set(senderId, convo);
  try {
    await sb("conversations", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        sender_id: senderId,
        history: convo.history,
        last_message_time: new Date(convo.lastMessageTime).toISOString(),
        last_customer_time: convo.lastCustomerTime ? new Date(convo.lastCustomerTime).toISOString() : null,
        platform: convo.platform || null,
        phone_number_id: convo.phoneNumberId || null,
        human_paused_until: convo.humanPausedUntil ? new Date(convo.humanPausedUntil).toISOString() : null,
      }),
    });
  } catch (err) {
    console.error("Failed to save conversation:", err.message);
  }
}

// Gemini wants the first turn to be from the user and turns to alternate
function normalizeHistory(history) {
  const out = [];
  for (const turn of history) {
    const text = turn.parts?.[0]?.text || "";
    if (!text) continue;
    if (out.length === 0 && turn.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.parts[0].text += "\n" + text;
    else out.push({ role: turn.role, parts: [{ text }] });
  }
  return out;
}

// ====== Leads / appointment requests ======
async function saveLead(platform, senderId, lead) {
  try {
    await sb("leads", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        platform,
        sender_id: senderId,
        name: lead.name || null,
        phone: lead.phone || null,
        email: lead.email || null,
        service_interest: lead.service || null,
        preferred_time: lead.preferred_time || null,
        consultation_mode: lead.mode || null,
        appointment_request: Boolean(lead.appointment_request),
        notes: lead.notes || null,
      }),
    });
  } catch (err) {
    console.error("Failed to save lead:", err.message);
  }
}

async function getKnownName(senderId) {
  try {
    const rows = await sb(`leads?sender_id=eq.${encodeURIComponent(senderId)}&name=not.is.null&order=created_at.desc&limit=1&select=name`);
    return rows?.[0]?.name || null;
  } catch (err) {
    return null;
  }
}

// ====== Live website content (so the assistant stays current when the site changes) ======
let cachedWebsiteContent = "";

async function refreshWebsiteContent() {
  const pages = [];
  for (const url of WEBSITE_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      // Jina Reader renders JavaScript-built sites and returns clean text
      const res = await fetch(`https://r.jina.ai/${url}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { console.error(`Website fetch ${url} returned ${res.status}`); continue; }
      const text = (await res.text()).trim().slice(0, 5000);
      pages.push(`--- Content from ${url} ---\n${text}`);
    } catch (err) {
      console.error(`Website fetch failed for ${url}:`, err.message);
    }
  }
  if (pages.length) cachedWebsiteContent = pages.join("\n\n");
  console.log(`Website content refreshed (${cachedWebsiteContent.length} characters)`);
}
refreshWebsiteContent();
setInterval(refreshWebsiteContent, 6 * 3600 * 1000);

// ====== BUSINESS CONTEXT: what the assistant knows and how it must behave ======
function buildBusinessContext() {
  return `
You are "${ASSISTANT_NAME}", the virtual assistant for Triple H Fertility Hub and Specialist Hospital in Surulere, Lagos, Nigeria. You are an AI assistant, not a doctor, nurse or member of staff. If anyone asks, say so honestly. Your job is to help people feel welcome, answer practical questions about the hospital, and help them request an appointment. The clinical team handles everything medical.

TONE
- Warm, calm, respectful and discreet. Many people messaging a fertility clinic are anxious or going through a hard time. Be kind and never pushy. No hype, no pressure, no promises of success.
- Write like a caring person texting on WhatsApp. Most replies are 1 to 3 short sentences. Never send long blocks of text.
- Ask only ONE question per message.
- Plain text only. No Markdown (no **bold**, no # headers, no dash bullets). Use at most an occasional emoji.
- Never use em dashes. Use a period or comma instead.
- Reply in the language the customer writes in (English, Nigerian Pidgin, or simple Yoruba). If unsure, use English.
- On the first message of a conversation, greet briefly and introduce yourself as the Triple H virtual assistant. Do not re-introduce yourself later.

HOSPITAL INFORMATION
- Name: Triple H Fertility Hub and Specialist Hospital
- Address: No. 5 Onitolo Street, opposite Love Garden Event Centre, off Olumegbon Road, Gbaja, Surulere, Lagos, Nigeria. Landmarks: National Stadium and Randle Mother & Child Hospital, Gbaja.
- Phone: +234 80 3404 3725 | Email: 3hfertilityhub@gmail.com
- Opening hours: Monday to Thursday 9:00 AM to 6:00 PM, Friday closed, Saturday 10:00 AM to 4:00 PM, Sunday closed.
- Booking: https://www.triplehfertilityhub.com/book (in-person and online consultations). Online consultations are available for patients in Abuja, abroad and anywhere else.
- Website: https://www.triplehfertilityhub.com
- Social: Instagram @triplehfertilityhub, Facebook "Triple H Fertility Hub", YouTube @TripleHFertility, TikTok @mediatriplehferti
- The team has 45+ years of combined doctor experience.

SERVICES
Fertility testing and assessment: fertility assessment for men and women, Sono HSG and transvaginal ultrasound, DNA fragmentation test, sickle cell screening (PGT), breast and cervical cancer screening, premarital screening and counselling.
Fertility treatment: IVF, IUI and ICSI, fertility preservation (egg, sperm and embryo freezing), ovarian and endometrial rejuvenation, surgical sperm retrieval, male fertility care including semen analysis, ovulation and ovarian induction.
Gynaecology and surgery: laparoscopy and hysteroscopy, fibroid removal and myomectomy, female gynae care (contraception, cervical screening), antenatal services.
Wellness and support: fertility wellness and third-party reproduction support through an AFRH-accredited agency, counselling and sexual dysfunction treatment, psychologist review, online consultations.

WHAT YOU CAN DO
- Answer general questions about services, hours, location, directions and how to book.
- Explain in simple, general terms what a service is (for example, what an HSG scan generally is). Keep it general and never about the person's own case.
- Help the customer request an appointment (see APPOINTMENT REQUESTS).
- Hand the conversation to the team when needed (see HAND-OFF).

STRICT RULES (SAFETY AND PRIVACY)
- Never diagnose, interpret test results, suggest medicines or doses, advise on treatment, or predict someone's chances of pregnancy. Say that a doctor needs to discuss this in a consultation.
- Never quote prices or estimate costs, including IVF cost. Say: "Pricing depends on your assessment, so our team will confirm it for you." Do not invent discounts, packages or success rates.
- Never confirm whether any person is a patient, and never share information about any patient.
- Do not ask for medical history, test results, ID numbers, or card or bank details. If the customer starts sharing detailed medical information, kindly say that a doctor should go through that in consultation, and do not repeat it back.
- Do not take payments or give account numbers. Direct payment questions to the clinic on +234 80 3404 3725.
- You cannot see the clinic's calendar. You can only record an appointment REQUEST. Never say an appointment is confirmed. Say the team will confirm the time.
- EMERGENCIES: if someone describes heavy bleeding, severe pain, fainting, a pregnancy emergency or any urgent medical problem, tell them to go to the nearest hospital emergency department or call the clinic straight away, and do not wait for this chat. Then use the HANDOFF tag.
- If someone says they want to harm themselves or seems in crisis, respond with care, encourage them to contact local emergency services or someone they trust right now, and use the HANDOFF tag.
- If a message says the customer sent an image, file or voice note, explain that you cannot open files in this chat, ask them not to send test results here, say the team will follow up, and use the HANDOFF tag.
- If you do not know something, say so and offer to have the team follow up. Never invent information.
- If a message arrives when the clinic is closed (use the current Lagos time below), mention that the team will reply on the next working day.

APPOINTMENT REQUESTS
Collect these one at a time, naturally, without making it feel like a form:
1. Their name.
2. What they would like to come in for, in general terms only (for example "fertility assessment" or "antenatal care"). No medical details.
3. In-person or online consultation.
4. Preferred day and time (remind them of the opening hours if needed).
5. On Messenger or Instagram only: the best WhatsApp number or email to reach them. On WhatsApp you already have their number, never ask for it.
When you have these, thank them, say the team will confirm the exact time shortly, and include the SAVE_LEAD tag with "appointment_request":true.

TECHNICAL TAGS (invisible to the customer, removed before sending)
- To record contact details or an appointment request, include anywhere in your reply:
  [SAVE_LEAD:{"name":"","phone":"","email":"","service":"","mode":"in-person or online","preferred_time":"","appointment_request":true,"notes":""}]
  Use appointment_request true only when they asked to book. Leave phone as an empty string on WhatsApp. Never invent values. Do not put any medical details in notes.
  On WhatsApp, save the moment you learn their name, then save again if more details come. On Messenger and Instagram, save once you have their name and a phone number or email.
- To bring in a human (urgent matter, complaint, request to speak to a doctor or staff, results, files, anything outside your role), include:
  [HANDOFF:{"reason":"short reason with no medical details"}]
  and tell the customer in your normal reply that a team member will follow up.
`;
}

// ====== Gemini ======
async function callGemini(systemText, contents) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: { temperature: 0.4 },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error("Gemini error:", JSON.stringify(data.error || data));
    return null;
  }
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || null;
}

async function askAssistant(senderId, userText, platform, phoneNumberId) {
  const convo = await getConversation(senderId);

  let knownNameNote = "";
  if (convo.history.length === 0) {
    const knownName = await getKnownName(senderId);
    if (knownName) knownNameNote = `\n\nRETURNING CUSTOMER: We have spoken before and know their name is ${knownName}. Greet them warmly by name and do not ask for their name again.`;
  }

  const lagosTime = new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true });
  const systemText =
    `${buildBusinessContext()}\n\nCURRENT PLATFORM: ${platform}\nCURRENT DAY AND TIME IN LAGOS: ${lagosTime}. Use it to greet appropriately and to know whether the clinic is open.${knownNameNote}` +
    (cachedWebsiteContent ? `\n\nLIVE WEBSITE CONTENT (use for general information; the rules above always win, and never quote prices even if a page mentions them):\n${cachedWebsiteContent}` : "");

  const contents = [...normalizeHistory(convo.history), { role: "user", parts: [{ text: userText }] }];
  const reply = (await callGemini(systemText, contents)) || FALLBACK_REPLY;

  convo.history.push({ role: "user", parts: [{ text: userText }] });
  convo.history.push({ role: "model", parts: [{ text: reply }] });
  convo.lastMessageTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;
  await saveConversation(senderId, convo);
  return reply;
}

// ====== Tag handling: strip special tags from the reply and act on them ======
function extractTag(text, name) {
  const m = text.match(new RegExp(`\\[${name}:(\\{[\\s\\S]*?\\})\\]`));
  if (!m) return { text, data: null };
  let data = null;
  try { data = JSON.parse(m[1]); } catch (err) { console.error(`Bad ${name} tag:`, m[1]); }
  return { text: text.replace(m[0], "").trim(), data };
}

async function processReply(raw, platform, senderId) {
  let { text, data: lead } = extractTag(raw, "SAVE_LEAD");
  let handoff;
  ({ text, data: handoff } = extractTag(text, "HANDOFF"));
  text = text.replace(/\[[A-Z_]+:\{[\s\S]*?\}\]/g, "").trim(); // any stray tags

  if (lead) {
    if (platform === "WhatsApp" && !lead.phone) lead.phone = senderId;
    await saveLead(platform, senderId, lead);
    if (lead.appointment_request) {
      await notifyStaff(
        `New appointment request (${platform})\nName: ${lead.name || "-"}\nContact: ${lead.phone || lead.email || "-"}\nFor: ${lead.service || "-"}\nMode: ${lead.mode || "-"}\nPreferred time: ${lead.preferred_time || "-"}\n${BASE_URL ? `Leads: ${BASE_URL}/leads` : ""}`
      );
    }
  }
  if (handoff) {
    await notifyStaff(`A person needs a team member (${platform}, ${senderId}).\nReason: ${handoff.reason || "-"}\n${BASE_URL ? `Inbox: ${BASE_URL}/inbox` : ""}`);
  }
  return text || FALLBACK_REPLY;
}

// ====== Sending messages ======
const messageStore = new Map(); // WhatsApp message id -> { text, time } (to understand quoted replies)

async function sendWhatsAppText(to, text, phoneNumberId = PHONE_NUMBER_ID) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) { console.error("WhatsApp not configured"); return false; }
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  const data = await res.json();
  if (!res.ok) { console.error("WhatsApp send failed:", JSON.stringify(data)); return false; }
  const id = data.messages?.[0]?.id;
  if (id) messageStore.set(id, { text, time: Date.now() });
  return true;
}

// Template messages work outside the 24-hour window (used only for staff alerts)
async function sendWhatsAppTemplate(to, templateName, bodyParams = []) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return false;
  const clean = (p) => String(p).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  const template = { name: templateName, language: { code: "en" } };
  if (bodyParams.length) template.components = [{ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: clean(p) })) }];
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });
  if (!res.ok) console.error(`Template "${templateName}" failed:`, await res.text());
  return res.ok;
}

async function sendMessenger(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) { console.error("Messenger not configured"); return false; }
  const res = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) console.error("Messenger send failed:", await res.text());
  return res.ok;
}

async function sendInstagram(recipientId, text) {
  if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) { console.error("Instagram not configured"); return false; }
  const res = await fetch(`https://graph.instagram.com/v21.0/${IG_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!res.ok) console.error("Instagram send failed:", await res.text());
  return res.ok;
}

function sendToPlatform(platform, to, text, phoneNumberId) {
  if (platform === "WhatsApp") return sendWhatsAppText(to, text, phoneNumberId || PHONE_NUMBER_ID);
  if (platform === "Messenger") return sendMessenger(to, text);
  if (platform === "Instagram") return sendInstagram(to, text);
  return Promise.resolve(false);
}

async function markAsReadAndTyping(messageId, phoneNumberId) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) return;
  try {
    await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } }),
    });
  } catch (err) {
    console.error("Failed to mark as read:", err.message);
  }
}

// Alert the team on WhatsApp. Needs an approved template named "lead_alert" with ONE body variable
// (for example: "Triple H alert: {{1}}") so alerts still arrive when the 24-hour window is closed.
async function notifyStaff(text) {
  if (!STAFF_WHATSAPP_NUMBER) { console.log("[staff alert]", text); return; }
  const sent = await sendWhatsAppText(STAFF_WHATSAPP_NUMBER, `Triple H alert\n\n${text}`);
  if (!sent) await sendWhatsAppTemplate(STAFF_WHATSAPP_NUMBER, "lead_alert", [text.slice(0, 900)]);
}

// ====== Incoming message pipeline (shared by all three channels) ======
const seen = new Map();
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  return false;
}

// If a customer sends several messages quickly, wait a few seconds and answer them together
const buffers = new Map();
function bufferAndDebounce(senderId, text, onReady) {
  let buf = buffers.get(senderId);
  if (!buf) { buf = { texts: [] }; buffers.set(senderId, buf); }
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(senderId);
    onReady(buf.texts.join("\n"));
  }, DEBOUNCE_MS);
}

async function handleIncoming({ platform, senderId, text, messageId, phoneNumberId }) {
  if (alreadySeen(messageId)) return; // Meta retries webhooks, so ignore duplicates
  if (BLOCKED_NUMBERS.includes(senderId)) return;

  if (platform === "WhatsApp") markAsReadAndTyping(messageId, phoneNumberId);

  const convo = await getConversation(senderId);
  convo.lastCustomerTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;

  // A staff member is handling this chat: record the message, but stay quiet
  if (convo.humanPausedUntil && convo.humanPausedUntil > Date.now()) {
    convo.history.push({ role: "user", parts: [{ text }] });
    convo.lastMessageTime = Date.now();
    await saveConversation(senderId, convo);
    return;
  }
  await saveConversation(senderId, convo);

  bufferAndDebounce(senderId, text, async (combinedText) => {
    try {
      const raw = await askAssistant(senderId, combinedText, platform, phoneNumberId);
      const reply = await processReply(raw, platform, senderId);
      await sendToPlatform(platform, senderId, reply, phoneNumberId);
    } catch (err) {
      console.error("Failed to answer message:", err);
    }
  });
}

// A staff member replied from the phone app or Page inbox: pause the assistant on that chat
async function pauseForStaff(platform, customerId, text, phoneNumberId) {
  const convo = await getConversation(customerId);
  convo.history.push({ role: "model", parts: [{ text: text || "[Staff reply]" }] });
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;
  convo.lastMessageTime = Date.now();
  convo.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS;
  await saveConversation(customerId, convo);
}

// ====== Webhook: verification and signature check ======
app.get("/", (req, res) => res.send("Triple H messaging assistant is running."));

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === env.VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

function validSignature(req) {
  const header = req.headers["x-hub-signature-256"] || "";
  if (!header.startsWith("sha256=") || !req.rawBody) return false;
  const secrets = [env.APP_SECRET, env.IG_APP_SECRET].filter(Boolean);
  return secrets.some((secret) => {
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  });
}

app.post("/webhook", (req, res) => {
  if (!validSignature(req)) {
    console.error("Rejected webhook call with an invalid signature");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // acknowledge quickly, Meta expects a fast response
  (async () => {
    try {
      const object = req.body.object;
      if (object === "whatsapp_business_account") await handleWhatsApp(req.body);
      else if (object === "page") await handleMessaging(req.body, "Messenger");
      else if (object === "instagram") await handleMessaging(req.body, "Instagram");
    } catch (err) {
      console.error("Error handling webhook:", err);
    }
  })();
});

// ---- WhatsApp ----
async function handleWhatsApp(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || PHONE_NUMBER_ID;

      // Coexistence events (only sent when the number uses the WhatsApp Business app and the API together).
      // Check these field names against Meta's current docs when you enable coexistence.
      if (change.field === "smb_message_echoes") {
        for (const echo of value.message_echoes || []) {
          if (echo.to) await pauseForStaff("WhatsApp", echo.to, echo.text?.body, phoneNumberId);
        }
        continue;
      }
      if (change.field === "history" || change.field === "smb_app_state_sync") {
        console.log(`[coexistence] ${change.field} event received (not stored, by design)`);
        continue;
      }

      for (const m of value.messages || []) {
        let text = null;
        if (m.type === "text") text = m.text?.body;
        else if (m.type === "button") text = m.button?.text;
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        else if (["image", "audio", "video", "document"].includes(m.type)) text = MEDIA_PLACEHOLDER; // never downloaded or sent to AI
        if (!text) continue;

        if (m.type === "text") messageStore.set(m.id, { text, time: Date.now() });
        if (m.context?.id) {
          const quoted = messageStore.get(m.context.id);
          if (quoted) text = `[The customer is replying to this earlier message: "${quoted.text}"]\n${text}`;
        }
        await handleIncoming({ platform: "WhatsApp", senderId: m.from, text, messageId: m.id, phoneNumberId });
      }
    }
  }
}

// ---- Facebook Messenger and Instagram (same payload shape) ----
async function handleMessaging(body, platform) {
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg) continue; // reads, postbacks, reactions are ignored

      if (msg.is_echo) {
        // Sent by the page/account. If no app sent it, a human did, so pause the assistant.
        // Confirm this behaviour in testing, since Meta's echo fields differ slightly by channel.
        if (!msg.app_id && ev.recipient?.id) await pauseForStaff(platform, ev.recipient.id, msg.text);
        continue;
      }

      const senderId = ev.sender?.id;
      if (!senderId || senderId === IG_ACCOUNT_ID) continue;
      let text = msg.text;
      if (!text && msg.attachments?.length) text = MEDIA_PLACEHOLDER;
      if (!text) continue;
      await handleIncoming({ platform, senderId, text, messageId: msg.mid });
    }
  }
}

// ====== Staff area (password protected): inbox, takeover and leads ======
function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const idx = decoded.indexOf(":");
    if (idx > -1 && safeEqual(decoded.slice(0, idx), ADMIN_USER) && safeEqual(decoded.slice(idx + 1), env.ADMIN_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Triple H staff"').status(401).send("Authentication required");
}

function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host === req.headers.host) return next(); } catch (err) { /* fall through */ }
    return res.status(403).send("Blocked: cross-site request");
  }
  next();
}

const ago = (ts) => {
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  return mins < 60 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
};
const windowOpen = (ts) => ts && Date.now() - new Date(ts).getTime() < 24 * 3600 * 1000;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:900px;margin:20px auto;padding:0 12px;color:#222}
  table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;font-size:14px}
  th{background:#f5f5f5}a{color:#0F5132}.muted{color:#777}.bubble{max-width:75%;padding:10px 14px;border-radius:12px;margin:6px 0;white-space:pre-wrap}
  .cust{background:#f0f0f0}.bot{background:#0F5132;color:#fff;margin-left:auto}button{padding:8px 16px;cursor:pointer}</style></head>
  <body><nav><a href="/inbox">Inbox</a> &nbsp;|&nbsp; <a href="/leads">Leads</a></nav>${body}</body></html>`;
}

app.get("/inbox", adminAuth, async (req, res) => {
  try {
    const rows = await sb("conversations?order=last_message_time.desc&limit=50&select=*");
    const tr = rows.map((c) => {
      const last = c.history?.[c.history.length - 1]?.parts?.[0]?.text || "";
      const paused = c.human_paused_until && new Date(c.human_paused_until).getTime() > Date.now();
      return `<tr><td>${esc(c.platform)}</td><td>${esc(c.sender_id)}</td><td>${esc(last.slice(0, 90))}</td><td>${ago(c.last_message_time)}</td>
        <td>${paused ? "Staff handling" : "Assistant active"}</td><td>${windowOpen(c.last_customer_time) ? "Open" : "Closed"}</td>
        <td><a href="/inbox/chat?sender=${encodeURIComponent(c.sender_id)}">Open</a></td></tr>`;
    }).join("");
    res.send(page("Inbox", `<h2>Inbox (${rows.length})</h2><table><tr><th>Channel</th><th>Contact</th><th>Last message</th><th>When</th><th>Status</th><th>Reply window</th><th></th></tr>${tr}</table>`));
  } catch (err) {
    res.status(500).send(page("Error", `<p>Could not load the inbox: ${esc(err.message)}</p>`));
  }
});

app.get("/inbox/chat", adminAuth, async (req, res) => {
  try {
    const sender = String(req.query.sender || "");
    const rows = await sb(`conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`);
    const c = rows?.[0];
    if (!c) return res.status(404).send(page("Not found", "<p>Conversation not found.</p>"));
    const paused = c.human_paused_until && new Date(c.human_paused_until).getTime() > Date.now();
    const bubbles = (c.history || []).map((t) => `<div class="bubble ${t.role === "user" ? "cust" : "bot"}">${esc(t.parts?.[0]?.text)}</div>`).join("");
    const banner = paused
      ? `<p>Staff are handling this chat. The assistant is paused until ${esc(new Date(c.human_paused_until).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }))}.
         <form method="POST" action="/inbox/resume" style="display:inline"><input type="hidden" name="sender" value="${esc(sender)}"><button>Resume assistant now</button></form></p>`
      : `<p class="muted">The assistant is active on this chat. Sending a reply pauses it.</p>`;
    const form = windowOpen(c.last_customer_time)
      ? `<form method="POST" action="/inbox/reply"><input type="hidden" name="sender" value="${esc(sender)}">
         <textarea name="message" rows="3" style="width:100%" required></textarea><br><button>Send reply</button></form>`
      : `<p class="muted">The 24-hour reply window is closed. Please contact them by phone or ask them to message again.</p>`;
    res.send(page("Chat", `<h3>${esc(c.platform)}: ${esc(sender)}</h3>${banner}<div>${bubbles || "<p>No messages.</p>"}</div>${form}`));
  } catch (err) {
    res.status(500).send(page("Error", `<p>${esc(err.message)}</p>`));
  }
});

app.post("/inbox/reply", adminAuth, sameOrigin, async (req, res) => {
  try {
    const sender = String(req.body.sender || "");
    const message = String(req.body.message || "").trim();
    if (!sender || !message) return res.status(400).send("Missing sender or message");
    const convo = await getConversation(sender);
    const sent = await sendToPlatform(convo.platform, sender, message, convo.phoneNumberId);
    convo.history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED] ${message}` }] });
    convo.lastMessageTime = Date.now();
    convo.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS; // pause even if the send failed, so the assistant does not talk over staff
    await saveConversation(sender, convo);
    res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}`);
  } catch (err) {
    console.error("Inbox reply failed:", err);
    res.status(500).send("Something went wrong. Check the Render logs.");
  }
});

app.post("/inbox/resume", adminAuth, sameOrigin, async (req, res) => {
  try {
    const sender = String(req.body.sender || "");
    const convo = await getConversation(sender);
    convo.humanPausedUntil = null;
    await saveConversation(sender, convo);
    res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}`);
  } catch (err) {
    res.status(500).send("Something went wrong. Check the Render logs.");
  }
});

app.get("/leads", adminAuth, async (req, res) => {
  try {
    const rows = await sb("leads?order=created_at.desc&limit=200&select=*");
    const tr = rows.map((l) => `<tr><td>${esc((l.created_at || "").slice(0, 16).replace("T", " "))}</td><td>${esc(l.platform)}</td>
      <td>${esc(l.name)}</td><td>${esc(l.phone || l.email)}</td><td>${esc(l.service_interest)}</td><td>${esc(l.consultation_mode)}</td>
      <td>${esc(l.preferred_time)}</td><td>${l.appointment_request ? "Yes" : ""}</td><td>${esc(l.status)}</td>
      <td>${l.status === "contacted" ? "" : `<form method="POST" action="/leads/contacted"><input type="hidden" name="id" value="${esc(l.id)}"><button>Mark contacted</button></form>`}</td></tr>`).join("");
    res.send(page("Leads", `<h2>Leads and appointment requests (${rows.length})</h2><table><tr><th>Date</th><th>Channel</th><th>Name</th><th>Contact</th><th>For</th><th>Mode</th><th>Preferred time</th><th>Booking request</th><th>Status</th><th></th></tr>${tr}</table>`));
  } catch (err) {
    res.status(500).send(page("Error", `<p>${esc(err.message)}</p>`));
  }
});

app.post("/leads/contacted", adminAuth, sameOrigin, async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isInteger(id)) return res.status(400).send("Bad id");
    await sb(`leads?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "contacted" }) });
    res.redirect("/leads");
  } catch (err) {
    res.status(500).send("Something went wrong. Check the Render logs.");
  }
});

// ====== Housekeeping ======
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of cache) if (now - c.lastMessageTime > SESSION_TIMEOUT_MS) cache.delete(id);
  for (const [id, t] of seen) if (now - t > 3600 * 1000) seen.delete(id);
  for (const [id, m] of messageStore) if (now - m.time > 24 * 3600 * 1000) messageStore.delete(id);
}, 3600 * 1000);

// Delete old chat history automatically (patients' chats can contain sensitive details)
async function purgeOldConversations() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
  try {
    await sb(`conversations?last_message_time=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    console.log(`Purged conversations older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error("Purge failed:", err.message);
  }
}
purgeOldConversations();
setInterval(purgeOldConversations, 6 * 3600 * 1000);

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`Triple H assistant running on port ${PORT}`));
