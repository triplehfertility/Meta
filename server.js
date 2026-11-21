// Triple H Fertility Hub - Messaging Assistant ("Nurse Hope")
// WhatsApp, Facebook Messenger and Instagram -> this server -> Gemini -> reply.
// When a patient wants to book, the chat shows a "Book appointment" button that opens
// the interactive booking form hosted by this server (same form on all three channels).
// No database. Chats live in memory; bookings go to staff by WhatsApp and (optionally) to Google Sheets.

"use strict";

const crypto = require("crypto");

const env = process.env;

// =====================================================================================
// 1. THE BOOKING FORM: the options on the form, and cleanup of what patients submit.
//    The web form and the staff alerts use these same lists, so they never drift apart.
//    To change services, days or times, edit the lists below.
// =====================================================================================
const SERVICES = [
  { id: "fertility_assessment", title: "Fertility Assessment" },
  { id: "ivf_iui_icsi", title: "IVF, IUI & ICSI" },
  { id: "male_fertility", title: "Male Fertility / Semen Test" },
  { id: "hsg_scan", title: "HSG & Pelvic Ultrasound" },
  { id: "fertility_preservation", title: "Egg / Sperm Freezing" },
  { id: "gynae_surgery", title: "Gynae Surgery (Fibroids etc)" },
  { id: "antenatal", title: "Antenatal Care" },
  { id: "premarital", title: "Premarital Screening" },
  { id: "genotype_pgt", title: "Sickle Cell Screening (PGT)" },
  { id: "counselling", title: "Counselling & Psychology" },
  { id: "not_sure", title: "Not sure yet" },
];

const MODES = [
  { id: "in_person", title: "In person (Surulere)" },
  { id: "telemedicine", title: "Telemedicine (online)" },
];

// The clinic is closed on Friday and Sunday, so those days are simply not offered.
const DAYS = [
  { id: "mon", title: "Monday" },
  { id: "tue", title: "Tuesday" },
  { id: "wed", title: "Wednesday" },
  { id: "thu", title: "Thursday" },
  { id: "sat", title: "Saturday" },
  { id: "any", title: "Any available day" },
];

const TIMES = [
  { id: "morning", title: "Morning (9am - 12pm)" },
  { id: "afternoon", title: "Afternoon (12pm - 4pm)" },
  { id: "late", title: "Late (4pm - 6pm, Mon-Thu)" },
  { id: "any", title: "Any time" },
];

// ---- Cleaning up what a customer submitted ----
const clip = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
const labelOf = (list, id) => (list.find((x) => x.id === id) || { title: clip(id, 60) }).title;

function normalizeSubmission(raw = {}) {
  return {
    name: clip(raw.name, 80),
    phone: clip(raw.phone, 30),
    email: clip(raw.email, 100),
    service: raw.service ? labelOf(SERVICES, raw.service) : "",
    mode: raw.mode ? labelOf(MODES, raw.mode) : "",
    day: raw.day ? labelOf(DAYS, raw.day) : "",
    time: raw.time ? labelOf(TIMES, raw.time) : "",
    notes: clip(raw.notes, 300),
    consent: raw.consent === true || raw.consent === "true" || raw.consent === "on",
  };
}

const express = require("express");

// =====================================================================================
// 2. SETTINGS (set these in Render > Environment. Never put real keys in this file.)
// =====================================================================================
const REQUIRED = ["VERIFY_TOKEN", "APP_SECRET", "GEMINI_API_KEY", "ADMIN_PASSWORD"];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const BASE_URL = (env.BASE_URL || "https://meta-n4tt.onrender.com").replace(/\/+$/, "");
const GRAPH_VERSION = env.GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const GRAPH_IG = `https://graph.instagram.com/${GRAPH_VERSION}`;

// WhatsApp
const WHATSAPP_TOKEN = env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = env.PHONE_NUMBER_ID || "";
const STAFF_WHATSAPP_NUMBER = (env.STAFF_WHATSAPP_NUMBER || "").replace(/\D/g, ""); // alerts go here, e.g. 2348034043725
// Messenger + Instagram
const PAGE_ACCESS_TOKEN = env.PAGE_ACCESS_TOKEN || "";
const IG_ACCESS_TOKEN = env.IG_ACCESS_TOKEN || "";
const IG_ACCOUNT_ID = env.IG_ACCOUNT_ID || "";
const META_APP_ID = env.META_APP_ID || ""; // optional: lets the bot tell staff replies from its own in Messenger/Instagram
// AI
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
// Staff pages
const ADMIN_USER = env.ADMIN_USER || "admin";
// Behaviour
const SESSION_TIMEOUT_MS = Number(env.SESSION_TIMEOUT_HOURS || 48) * 3600 * 1000;
const HUMAN_PAUSE_MS = Number(env.HUMAN_PAUSE_HOURS || 2) * 3600 * 1000;
const DEBOUNCE_MS = Number(env.DEBOUNCE_MS || 6000); // wait for the patient to finish typing
const MAX_HISTORY_TURNS = 30;
const AI_LIMIT_PER_HOUR = Number(env.AI_LIMIT_PER_HOUR || 40); // per person, stops runaway cost or abuse
const MEDIA_TO_AI = env.MEDIA_TO_AI !== "false"; // set to "false" to stop sending voice notes/images to Gemini
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const BLOCKED_NUMBERS = (env.BLOCKED_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MEDESK_URL = "https://app.medesk.net/patient/?e=654e537f7c6e2b0706f9c9c0&a=anonymous";
// Google Sheets (optional)
const SHEET_ID = env.GOOGLE_SHEET_ID || "";
const SHEET_LEADS_TAB = env.GOOGLE_SHEET_LEADS_TAB || "Leads";
const SHEET_PAYMENTS_TAB = env.GOOGLE_SHEET_PAYMENTS_TAB || "Payments";

const WEBSITE_URLS = (env.WEBSITE_URLS ||
  "https://triplehfertilityhub.com,https://triplehfertilityhub.com/services,https://triplehfertilityhub.com/resources,https://triplehfertilityhub.com/book,https://triplehfertilityhub.com/contact,https://triplehfertilityhub.com/about")
  .split(",").map((s) => s.trim()).filter(Boolean);

const FEES = { registration: "₦10,000", consultation: "₦70,000", total: "₦80,000" };
const FALLBACK_REPLY = "Sorry, I'm having trouble responding right now. A member of our team will follow up shortly.";
const MEDIA_PLACEHOLDER = "[The patient sent an image, file or voice note that could not be opened here.]";

// =====================================================================================
// 3. SMALL HELPERS
// =====================================================================================
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Split long replies so they fit each platform's message limit
function chunkText(text, max) {
  const out = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
const LIMITS = { WhatsApp: 3800, Messenger: 1800, Instagram: 700 };

// Link signing: the web form link carries a signature so nobody can forge a link for someone else's chat
const signLink = (platform, id) => crypto.createHmac("sha256", env.APP_SECRET).update(`${platform}|${id}`).digest("hex").slice(0, 32);
const validLink = (platform, id, sig) => Boolean(platform && id && sig) && safeEqual(signLink(platform, id), sig);
const formUrl = (platform, id) => `${BASE_URL}/book-session?p=${platform}&s=${encodeURIComponent(id)}&t=${signLink(platform, id)}`;

const lagosNow = () =>
  new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true });

// =====================================================================================
// 4. MEMORY (in RAM) AND LEADS (RAM + optional Google Sheets)
// =====================================================================================
const conversations = new Map(); // senderId -> { history, lastMessageTime, lastCustomerTime, platform, phoneNumberId, humanPausedUntil }
const leads = []; // newest first; shown on /leads. Cleared on restart, so the Google Sheet is the permanent record.
const knownNames = new Map(); // senderId -> name
const loggedLeadOnce = new Set(); // senders already written to the sheet as "Lead" this session
let leadSeq = 0;

function getConversation(senderId) {
  const now = Date.now();
  let c = conversations.get(senderId);
  if (!c || now - c.lastMessageTime > SESSION_TIMEOUT_MS) {
    c = { history: [], lastMessageTime: now, lastCustomerTime: null, platform: null, phoneNumberId: null, humanPausedUntil: null };
    conversations.set(senderId, c);
  }
  return c;
}

function trimHistory(convo) {
  if (convo.history.length > MAX_HISTORY_TURNS) convo.history = convo.history.slice(-MAX_HISTORY_TURNS);
}

// ---- Google Sheets (service account, no extra libraries) ----
let googleCreds = null;
try {
  if (SHEET_ID && env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    googleCreds = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  }
} catch (err) {
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON could not be read:", err.message);
}
let googleToken = null;
let googleTokenExp = 0;

async function getGoogleToken() {
  if (googleToken && Date.now() < googleTokenExp - 60000) return googleToken;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) + "." +
    b64({ iss: googleCreds.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(googleCreds.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token error: ${JSON.stringify(data).slice(0, 200)}`);
  googleToken = data.access_token;
  googleTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return googleToken;
}

// RAW mode on purpose: text a patient types can never be turned into a spreadsheet formula
async function appendSheetRow(tab, values) {
  if (!googleCreds) return false;
  try {
    const token = await getGoogleToken();
    const range = encodeURIComponent(`${tab}!A:Z`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [values] }) }
    );
    if (!res.ok) {
      console.error(`Google Sheets append to "${tab}" failed:`, res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("Google Sheets error:", err.message);
    return false;
  }
}

const stamp = () => new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos", hour12: false });

// Record a lead. type = "Lead" (name captured in chat) or "Booking" (a real appointment request)
async function recordLead(platform, senderId, data, type) {
  const rec = {
    id: ++leadSeq,
    created: new Date().toISOString(),
    type,
    platform,
    senderId,
    name: clip(data.name, 80),
    phone: clip(data.phone, 30),
    email: clip(data.email, 100),
    service: clip(data.service, 80),
    mode: clip(data.mode, 40),
    day: clip(data.day, 30),
    time: clip(data.time, 40),
    notes: clip(data.notes, 300),
    status: "new",
  };
  leads.unshift(rec);
  if (leads.length > 500) leads.pop();
  if (rec.name) knownNames.set(senderId, rec.name);

  // Write "Lead" rows only once per person per session so the sheet is not flooded with updates
  if (type === "Lead") {
    if (loggedLeadOnce.has(senderId)) return rec;
    loggedLeadOnce.add(senderId);
  }
  await appendSheetRow(SHEET_LEADS_TAB, [
    stamp(), type, platform, rec.name, rec.phone || (platform === "WhatsApp" ? senderId : ""), rec.email,
    rec.service, rec.mode, rec.day, rec.time, rec.notes,
  ]);
  return rec;
}

// =====================================================================================
// 5. LIVE WEBSITE CONTENT (so the assistant stays current when the site changes)
// =====================================================================================
let websiteContent = "";

async function refreshWebsiteContent() {
  const pages = [];
  for (const url of WEBSITE_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      // Jina Reader renders JavaScript-built sites (like this one) and returns clean text
      const res = await fetch(`https://r.jina.ai/${url}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { console.error(`Website fetch ${url} returned ${res.status}`); continue; }
      pages.push(`--- Content from ${url} ---\n${(await res.text()).trim().slice(0, 4000)}`);
    } catch (err) {
      console.error(`Website fetch failed for ${url}:`, err.message);
    }
  }
  if (pages.length) websiteContent = pages.join("\n\n"); // keep the old copy if everything failed
  console.log(`Website content refreshed (${websiteContent.length} characters)`);
}

// =====================================================================================
// 6. WHAT NURSE HOPE KNOWS AND HOW SHE BEHAVES
// =====================================================================================
const BUSINESS_CONTEXT = `
You are "Nurse Hope" - the compassionate virtual nurse and fertility care navigator at Triple H Fertility Hub and Specialist Hospital, located in Surulere, Lagos, Nigeria. You are the warm, trusted front line of our clinic, dedicated to supporting individuals and couples on their fertility and reproductive health journey with empathy, clinical discretion, clarity, and professionalism.
You are an AI virtual assistant, not a human nurse or doctor. If anyone asks whether you are a person or a bot, say honestly that you are an AI virtual assistant.

Your personality:
- You are warm, empathetic, respectful, and reassuring. Fertility journeys are emotionally sensitive; always make patients feel heard, respected, and safe.
- You speak clearly and simply, explaining medical terms in accessible, reassuring language without unnecessary medical jargon.
- You are conversational and dynamic - never cold, robotic, or clinical.
- You respond in the same language or tone the customer uses - English or Nigerian Pidgin.
- You keep messages short and punchy (1-3 short sentences). On WhatsApp, people do not read long essays. Use line breaks naturally.
- You never give a generic answer when a specific, helpful answer is possible.

Your name: Nurse Hope ✨
When greeting on the very first message of a conversation, introduce yourself: "Hello! I'm Nurse Hope, virtual nurse at Triple H Fertility Hub 👋"

ADAPT YOUR ROLE TO WHAT THE MOMENT NEEDS
- Curious or first-time inquiry: WARM GUIDE. Provide gentle, encouraging information about how Triple H helps couples and individuals overcome fertility challenges.
- Anxious patient or someone sharing fertility struggles: EMPATHETIC NURSE. Listen, validate their feelings, reassure them that difficulty conceiving is common and treatable, and guide them toward a confidential consultation with our specialist doctor.
- Inquiring about prices or treatment options: CLEAR NAVIGATOR. Explain our transparent initial fees (Registration ${FEES.registration} + Consultation ${FEES.consultation} = ${FEES.total} total). For comprehensive treatments like IVF, egg freezing, or surgery, explain that treatment protocols are strictly tailored to each patient's medical tests, and our consultant will provide their exact plan during consultation.
- Existing patient or follow-up: PATIENT CARE COORDINATOR. Prioritize their needs, help them reach the nursing station or reception, and ensure they feel well cared for.
- Ready to book: APPOINTMENT SCHEDULER. The booking form is sent to them automatically (see BOOKING FORM below).

MEDICAL SAFETY & TRIAGE BOUNDARIES (CRITICAL HEALTHCARE RULES)
- You are an AI virtual nurse, NOT a medical doctor.
- You NEVER diagnose conditions, prescribe medications, alter drug dosages, or interpret lab results or scan images as definitive. If a patient sends test results or scans, do not interpret them; say Dr. Haleemah or the team will review them properly in consultation.
- Always gently remind patients that a definitive diagnosis and personalized treatment plan requires a formal consultation with Dr. Haleemah Olalere.
- Never predict someone's chances of pregnancy and never promise success rates.
- RED-FLAG MEDICAL EMERGENCIES: If a patient mentions heavy vaginal bleeding, acute severe lower abdominal/pelvic pain, fainting, high fever following a recent procedure, or suspected ectopic pregnancy, advise them immediately to proceed to the nearest hospital emergency room or call the clinic, and include the HANDOFF tag.
- If someone says they want to harm themselves or seems in crisis, respond with care, encourage them to contact local emergency services or someone they trust right now, and include the HANDOFF tag.
- Do not ask patients for detailed medical history, ID numbers or card details in chat. Those are for the consultation.

USE DISCRETION - NOT EVERYONE IS A PATIENT
- Someone asking about nursing jobs, medical officer positions, internships, or IT placements: warmly direct them to email their CV to 3hfertilityhub@gmail.com for review by management.
- Medical reps, pharmaceutical vendors, or media: politely direct them to 3hfertilityhub@gmail.com.

CLINIC INFORMATION (this section is the source of truth for fees, payment, hours and contacts)
- Hospital: Triple H Fertility Hub and Specialist Hospital
- Lead Doctor: Dr. Haleemah (FDH) Olalere - Consultant Obstetrician & Gynaecologist and Fertility Specialist
- Chairman: Dr. Ishaq Olalere
- Nursing & Clinical Team: Nurse Hafeezah Busari, Visiting Fertility Nurse Amuda, Nurse Maryam Alli, Nurse Favour, Lab Scientist Rita, Embryologist Favour, Director of ICT
- Location: No. 5 Onitolo Street, opposite Love Garden Event Centre, off Olumegbon Road, Gbaja, Surulere, Lagos, Nigeria
- Landmarks: National Stadium (Western Avenue) and Randle General Hospital / Mother and Child Hospital
- Directions: From National Stadium / Western Avenue, head into Surulere towards Gbaja / Randle Hospital, turn onto Olumegbon Road, and locate No. 5 Onitolo Street directly opposite Love Garden Event Centre. For Google Maps, searching "Love Garden Event Centre, Surulere" provides the most accurate landmark navigation.
- Working Hours:
  * Monday to Thursday: 9:00 AM - 6:00 PM (WAT)
  * Saturday: 10:00 AM - 4:00 PM (WAT)
  * Friday & Sunday: Closed for routine clinic visits and consultations (Nurse Hope remains available 24/7 on WhatsApp)
  * Telemedicine: Same hours as clinic visits (Mon-Thu 9am-6pm, Sat 10am-4pm)
- Primary Phone / Call line: +234 201 350 2083
- Primary WhatsApp: +234 803 404 3725 (08034043725)
- Official Email: 3hfertilityhub@gmail.com
- Website: https://triplehfertilityhub.com
- Online Booking Portal (Medesk): ${MEDESK_URL}

WHAT TRIPLE H DOES - CLINICAL SERVICES

1. IN VITRO FERTILISATION (IVF) & ADVANCED ART
- IVF (In Vitro Fertilisation) & ICSI (Intracytoplasmic Sperm Injection)
- Intrauterine Insemination (IUI)
- Ovulation Induction & Follicle Tracking
- Ovarian Rejuvenation (PRP therapy for low ovarian reserve)

2. FERTILITY PRESERVATION & GENETIC TESTING
- Egg Freezing (Oocyte cryopreservation) & Sperm Freezing
- Embryo Freezing / Cryopreservation
- Pre-implantation Genetic Testing (PGT-M / Sickle Cell Screening)

3. MINIMALLY INVASIVE GYNAECOLOGICAL SURGERY
- Hysteroscopy (uterine fibroids, endometrial polyps, intrauterine adhesions/Asherman syndrome)
- Laparoscopy (diagnostic & operative, pelvic adhesions, ovarian cysts, tubal evaluation)
- Myomectomy (surgical removal of fibroids preserving fertility)

4. COMPREHENSIVE FERTILITY ASSESSMENT & DIAGNOSTICS
- Male Fertility Workup (Comprehensive Semen Analysis, sperm morphology/motility)
- Female Hormonal Profiling (AMH, FSH, LH, Prolactin, Thyroid panel)
- Transvaginal Ultrasound Scans & Hysterosalpingography (HSG)
- Pre-marital Fertility and Compatibility Screening (Genotype, blood group, baseline fertility)

5. TELEMEDICINE & ONLINE CONSULTATIONS
- Virtual video/phone consultations for patients across Nigeria (Abuja, Port Harcourt, Ibadan) and couples in the diaspora (UK, US, Canada, Europe).

FEES & PAYMENT DETAILS

CONSULTATION & REGISTRATION
- Registration & Hospital Card: ${FEES.registration} (~$8)
- Specialist Doctor Consultation: ${FEES.consultation} (~$47)
- Total Initial Booking: ${FEES.total}
- Comprehensive treatment plans (e.g., IVF cycle, laparoscopy) are customized after clinical evaluation. Medications and specific protocols vary based on age, AMH, and medical findings.
- Never invent prices, discounts or packages beyond what is written here.

BANK ACCOUNTS FOR PAYMENT (share these only when a patient asks how to pay or says they are ready to pay)
- Naira Account: Providus Bank | Triple H Fertility Hub | Account No: 1305084494
- USD / Foreign Currency Account: Alternative Bank / Sterling Bank | Account No: 0505541753 (For patients abroad)
- Payment confirmation: Patients transfer to either account, then proceed on WhatsApp or submit receipt details. Accounts are verified by the finance team before formal receipt issuance.

HOW YOU HANDLE CONVERSATIONS

Step 1 - Understand first with warmth.
When someone reaches out about fertility or a service, warmly ask 1 short question to understand their needs:
Example: "I want to ask about IVF" -> "Welcome to Triple H! We would love to support you. Have you or your partner previously done any fertility tests, or is this your first time exploring fertility care?"

Step 2 - Give clear, compassionate answers.
Answer their questions honestly. Provide the published consultation fees (${FEES.registration} card + ${FEES.consultation} consultation = ${FEES.total}) whenever they ask about cost, and explain that treatments like IVF or surgery are customized after their initial evaluation with Dr. Haleemah.

Step 3 - Offer appointment booking.
When they are ready to schedule or speak with Dr. Haleemah, include the [BOOK_CALL] tag. The system then sends them our interactive booking form automatically (service, in-person or online, preferred day and time).

CONVERSATION RULES
- Write like a caring healthcare professional texting on WhatsApp.
- Introduce yourself as Nurse Hope on the first message only.
- CRITICAL LENGTH RULE: Keep replies to 1-3 short sentences. No essays, no huge paragraphs.
- Do NOT use Markdown symbols (**bold**, dashes, # headers) - WhatsApp shows literal symbols. Plain text only, or single asterisks *like this* if needed.
- NEVER use em dashes. Use a comma, hyphen (-), period, or start a new sentence.
- STRICT: ask only ONE question per message. Never stack multiple questions.
- NEVER ask for their phone number on WhatsApp - it is already their sender ID! Once you have their name and area of care, save the lead.
- On Messenger/Instagram: ask for their WhatsApp number so our nursing team can follow up directly.
- Match English or Nigerian Pidgin naturally.
- If the clinic is closed right now (use the Lagos time given below), mention that the team will reply on the next working day.

WHEN SOMEONE SAYS HI / HELLO
"Hello! I'm Nurse Hope from Triple H Fertility Hub 👋 May I know your name, and how can we support your health or fertility journey today?"

BOOKING FORM
- When the patient wants to book, start your reply with [BOOK_CALL] and write ONE short line such as "Lovely! I'm sending you our quick booking form now." Do NOT ask them for day, time or other booking details in chat, the form collects all of that.
- After they submit the form, the system confirms it. You do not need to repeat the details.

TECHNICAL NOTE - PAYMENT CLAIMS
- When a patient says they have made a bank transfer, reassure them warmly:
  "Thank you! Our finance desk is confirming your transfer with the bank now. Once confirmed, our team will send your official receipt here."
  Include this tag anywhere in your reply:
  [PAYMENT_CLAIM:{"name":"their name","service":"consultation or treatment","amount":"amount mentioned","notes":"bank or reference if given"}]

TECHNICAL NOTE - SAVING LEAD INFO
- Include this tag when a patient shares their name or details:
  [SAVE_LEAD:{"name":"their name","phone":"their number or empty string","email":"their email or empty string","service":"service of interest","notes":"general note only, no medical details"}]

TECHNICAL NOTE - BRINGING IN A HUMAN
- For emergencies, complaints, requests to speak to a doctor or staff member, or anything outside your role, include this tag and tell the patient a team member will follow up:
  [HANDOFF:{"reason":"short reason with no medical details"}]
`;

// =====================================================================================
// 7. TALKING TO GEMINI
// =====================================================================================
// Gemini needs the first turn to be from the user and turns to alternate
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

async function askGemini(senderId, userText, platform, media, phoneNumberId) {
  const convo = getConversation(senderId);

  let returningNote = "";
  if (convo.history.length === 0 && knownNames.has(senderId)) {
    returningNote = `\n\nRETURNING PATIENT: We have spoken before and know their name is ${knownNames.get(senderId)}. Greet them warmly by name instead of the full first-time introduction, and do not ask for their name again.`;
  }

  const systemText =
    `${BUSINESS_CONTEXT}\n\nCURRENT PLATFORM: ${platform}\nCURRENT DAY AND TIME IN NIGERIA: ${lagosNow()}. Use it to greet appropriately and to know whether the clinic is open.${returningNote}` +
    (websiteContent
      ? `\n\nWEBSITE CONTENT (use it for general descriptions of services and articles. For fees, payment, hours and contacts, the CLINIC INFORMATION above always wins):\n${websiteContent}`
      : "");

  const parts = [{ text: userText }];
  if (media) parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64Data } });
  const contents = [...normalizeHistory(convo.history), { role: "user", parts }];

  let reply = null;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemText }] }, contents, generationConfig: { temperature: 0.4 } }),
    });
    const data = await res.json();
    if (!res.ok || data.error) console.error("Gemini error:", JSON.stringify(data.error || data).slice(0, 400));
    else reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || null;
  } catch (err) {
    console.error("Gemini request failed:", err.message);
  }

  if (!reply) return null; // do not store failed exchanges in the memory

  convo.history.push({ role: "user", parts: [{ text: userText }] });
  convo.history.push({ role: "model", parts: [{ text: reply }] });
  convo.lastMessageTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;
  trimHistory(convo);
  return reply;
}

// =====================================================================================
// 8. SENDING MESSAGES (WhatsApp, Messenger, Instagram)
// =====================================================================================
const messageStore = new Map(); // WhatsApp message id -> { text, time } (so we understand quoted replies)

// WhatsApp normally uses phone numbers. If a person has no number visible (username accounts), Meta gives an ID instead.
const waTarget = (id) => (/^\d{5,16}$/.test(String(id)) ? { to: String(id) } : { recipient: String(id) });

async function waPost(phoneNumberId, body) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) { console.error("WhatsApp is not configured (WHATSAPP_TOKEN / PHONE_NUMBER_ID)"); return { ok: false, data: null }; }
  try {
    const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error("WhatsApp send failed:", JSON.stringify(data).slice(0, 500));
    return { ok: res.ok, data };
  } catch (err) {
    console.error("WhatsApp send error:", err.message);
    return { ok: false, data: null };
  }
}

async function sendWhatsAppText(to, text, phoneNumberId = PHONE_NUMBER_ID) {
  let allOk = true;
  for (const piece of chunkText(text, LIMITS.WhatsApp)) {
    const { ok, data } = await waPost(phoneNumberId, { ...waTarget(to), type: "text", text: { body: piece } });
    if (ok) {
      const id = data?.messages?.[0]?.id;
      if (id) messageStore.set(id, { text: piece, time: Date.now() });
    } else allOk = false;
  }
  return allOk;
}

// Template messages still arrive when the 24-hour window is closed (used for staff alerts)
async function sendWhatsAppTemplate(to, templateName, params = []) {
  const clean = (p) => String(p).replace(/[\r\n\t]+/g, " | ").replace(/ {2,}/g, " ").trim();
  const template = { name: templateName, language: { code: "en" } };
  if (params.length) template.components = [{ type: "body", parameters: params.map((p) => ({ type: "text", text: clean(p) })) }];
  const { ok } = await waPost(PHONE_NUMBER_ID, { to, type: "template", template });
  return ok;
}

async function sendMessengerText(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) { console.error("Messenger is not configured (PAGE_ACCESS_TOKEN)"); return false; }
  let allOk = true;
  for (const piece of chunkText(text, LIMITS.Messenger)) {
    try {
      const res = await fetch(`${GRAPH}/me/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: piece } }),
      });
      if (!res.ok) { console.error("Messenger send failed:", (await res.text()).slice(0, 400)); allOk = false; }
    } catch (err) { console.error("Messenger send error:", err.message); allOk = false; }
  }
  return allOk;
}

async function sendInstagramText(recipientId, text) {
  if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) { console.error("Instagram is not configured (IG_ACCESS_TOKEN / IG_ACCOUNT_ID)"); return false; }
  let allOk = true;
  for (const piece of chunkText(text, LIMITS.Instagram)) {
    try {
      const res = await fetch(`${GRAPH_IG}/${IG_ACCOUNT_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: piece } }),
      });
      if (!res.ok) { console.error("Instagram send failed:", (await res.text()).slice(0, 400)); allOk = false; }
    } catch (err) { console.error("Instagram send error:", err.message); allOk = false; }
  }
  return allOk;
}

function sendToPlatform(platform, to, text, phoneNumberId) {
  if (platform === "WhatsApp") return sendWhatsAppText(to, text, phoneNumberId || PHONE_NUMBER_ID);
  if (platform === "Messenger") return sendMessengerText(to, text);
  if (platform === "Instagram") return sendInstagramText(to, text);
  return Promise.resolve(false);
}

async function markAsReadAndTyping(messageId, phoneNumberId) {
  if (!messageId) return;
  await waPost(phoneNumberId, { status: "read", message_id: messageId, typing_indicator: { type: "text" } });
}

// Alert the clinic team on WhatsApp. First a normal message (instant); if that is refused because
// the 24-hour window is closed, fall back to an approved template named "lead_alert" with ONE variable.
async function notifyStaff(text) {
  if (!STAFF_WHATSAPP_NUMBER) { console.log("[staff alert - set STAFF_WHATSAPP_NUMBER to receive these on WhatsApp]\n" + text); return; }
  const sent = await sendWhatsAppText(STAFF_WHATSAPP_NUMBER, `🔔 Triple H alert\n\n${text}`);
  if (!sent) await sendWhatsAppTemplate(STAFF_WHATSAPP_NUMBER, "lead_alert", [text.slice(0, 900)]);
}

// =====================================================================================
// 9. SENDING THE BOOKING FORM TO THE PATIENT
// =====================================================================================
const BOOKING_INTRO =
  "Tap the button below to open our quick booking form. Our team will confirm your exact appointment time.\n\n" +
  `Initial visit: ${FEES.total} (${FEES.registration} card + ${FEES.consultation} consultation)\n` +
  "Hours: Mon-Thu 9am-6pm, Sat 10am-4pm";

// WhatsApp: a message with a "Book appointment" button that opens the web form
async function sendBookingButtonWhatsApp(to, phoneNumberId = PHONE_NUMBER_ID) {
  const url = formUrl("WhatsApp", to);
  const { ok } = await waPost(phoneNumberId, {
    recipient_type: "individual",
    ...waTarget(to),
    type: "interactive",
    interactive: {
      type: "cta_url",
      header: { type: "text", text: "Book a Consultation" },
      body: { text: BOOKING_INTRO },
      footer: { text: "Triple H Fertility Hub" },
      action: { name: "cta_url", parameters: { display_text: "Book appointment", url } },
    },
  });
  if (ok) return true;
  // Fallback: a plain text link always works
  return sendWhatsAppText(to, `${BOOKING_INTRO}\n\n${url}`, phoneNumberId);
}

// Messenger / Instagram: a button that opens our web form
async function sendBookingButton(platform, to) {
  const url = formUrl(platform, to);
  const text = "Tap below to open our quick booking form. Our team will confirm your exact appointment time.";
  const message = {
    attachment: { type: "template", payload: { template_type: "button", text, buttons: [{ type: "web_url", url, title: "Book appointment" }] } },
  };
  try {
    let res;
    if (platform === "Messenger" && PAGE_ACCESS_TOKEN) {
      res = await fetch(`${GRAPH}/me/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: to }, messaging_type: "RESPONSE", message }),
      });
    } else if (platform === "Instagram" && IG_ACCESS_TOKEN && IG_ACCOUNT_ID) {
      res = await fetch(`${GRAPH_IG}/${IG_ACCOUNT_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: to }, message }),
      });
    }
    if (res?.ok) return true;
    if (res) console.error(`${platform} button send failed:`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error(`${platform} button send error:`, err.message);
  }
  // Fallback: a plain text link always works
  return sendToPlatform(platform, to, `${text}\n${url}`);
}

async function sendBookingForm(platform, senderId, phoneNumberId) {
  if (platform === "WhatsApp") await sendBookingButtonWhatsApp(senderId, phoneNumberId);
  else await sendBookingButton(platform, senderId);
}

// A submitted booking form ends up here
async function recordBooking(platform, senderId, rawForm, phoneNumberId) {
  const form = normalizeSubmission(rawForm);
  if (platform === "WhatsApp" && !form.phone && /^\d{5,16}$/.test(senderId)) form.phone = senderId;

  await recordLead(platform, senderId, form, "Booking");

  await notifyStaff(
    `New appointment request (${platform})\n` +
    `Name: ${form.name || "-"}\nPhone: ${form.phone || "-"}\nEmail: ${form.email || "-"}\n` +
    `Service: ${form.service || "-"}\nType: ${form.mode || "-"}\nPreferred: ${form.day || "-"}, ${form.time || "-"}\n` +
    `Notes: ${form.notes || "-"}\n${BASE_URL}/leads`
  );

  const first = form.name.split(" ")[0] || "there";
  const confirmation =
    `Thank you, ${first}! 🙏 We've received your appointment request` +
    `${form.service ? ` for ${form.service}` : ""}${form.mode ? ` (${form.mode})` : ""}.\n` +
    `Preferred: ${form.day || "any day"}, ${form.time || "any time"}.\n` +
    "Our team will contact you shortly to confirm the exact date and time.";
  await sendToPlatform(platform, senderId, confirmation, phoneNumberId);

  // Keep the AI's memory in step so it does not ask for the same details again
  const convo = getConversation(senderId);
  convo.history.push({ role: "user", parts: [{ text: `[The patient submitted the booking form: ${form.service || "service not stated"}, ${form.mode || "type not stated"}, ${form.day || "any day"}, ${form.time || "any time"}]` }] });
  convo.history.push({ role: "model", parts: [{ text: confirmation }] });
  convo.lastMessageTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;
  trimHistory(convo);
}

// =====================================================================================
// 10. READING THE AI'S REPLY (strip hidden tags, act on them)
// =====================================================================================
function extractTag(text, name) {
  const m = text.match(new RegExp(`\\[${name}:(\\{[\\s\\S]*?\\})\\]`));
  if (!m) return { text, data: null };
  let data = null;
  try { data = JSON.parse(m[1]); } catch (err) { console.error(`Bad ${name} tag:`, m[1].slice(0, 200)); }
  return { text: text.replace(m[0], "").trim(), data };
}

async function processReply(raw, platform, senderId) {
  let { text, data: lead } = extractTag(raw, "SAVE_LEAD");
  let claim, handoff;
  ({ text, data: claim } = extractTag(text, "PAYMENT_CLAIM"));
  ({ text, data: handoff } = extractTag(text, "HANDOFF"));
  const wantsBooking = /\[BOOK_CALL\]/.test(text);
  text = text.replace(/\[BOOK_CALL\]/g, "").replace(/\[[A-Z_]+:\{[\s\S]*?\}\]/g, "").replace(/[ \t]{2,}/g, " ").trim(); // also removes any stray tags

  if (lead) {
    if (platform === "WhatsApp" && !lead.phone && /^\d{5,16}$/.test(senderId)) lead.phone = senderId;
    await recordLead(platform, senderId, lead, "Lead");
  }
  if (claim) {
    await appendSheetRow(SHEET_PAYMENTS_TAB, [stamp(), platform, clip(claim.name, 80), platform === "WhatsApp" ? senderId : "", clip(claim.service, 80), clip(claim.amount, 40), clip(claim.notes, 200), "pending"]);
    await notifyStaff(
      `Payment claim (${platform})\nPatient: ${clip(claim.name, 80) || "-"} (${senderId})\nFor: ${clip(claim.service, 80) || "-"}\nAmount claimed: ${clip(claim.amount, 40) || "-"}\nNotes: ${clip(claim.notes, 200) || "-"}\n\nPlease check the bank account, then send the receipt.`
    );
  }
  if (handoff) {
    await notifyStaff(`A patient needs a team member (${platform}, ${senderId}).\nReason: ${clip(handoff.reason, 200) || "-"}\nInbox: ${BASE_URL}/inbox`);
  }
  return { text: text || (wantsBooking ? "I'm sending you our quick booking form now." : FALLBACK_REPLY), wantsBooking };
}

// =====================================================================================
// 11. INCOMING MESSAGES: shared pipeline for all three channels
// =====================================================================================
const seen = new Map(); // message ids already handled (Meta retries webhooks)
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, Date.now());
  return false;
}

// If someone sends several messages quickly, wait a few seconds and answer them together
const buffers = new Map();
function bufferAndDebounce(senderId, text, media, onReady) {
  let buf = buffers.get(senderId);
  if (!buf) { buf = { texts: [], media: null }; buffers.set(senderId, buf); }
  if (text) buf.texts.push(text);
  if (media) buf.media = media;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(senderId);
    onReady(buf.texts.join("\n"), buf.media);
  }, DEBOUNCE_MS);
}

// One reply at a time per person, so two quick messages can never mix up the memory
const chains = new Map();
function runExclusive(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const cleanup = () => { if (chains.get(id) === next) chains.delete(id); };
  chains.set(id, next);
  next.then(cleanup, cleanup);
  return next;
}

const aiCalls = new Map();
function overRateLimit(id) {
  const now = Date.now();
  const recent = (aiCalls.get(id) || []).filter((t) => now - t < 3600 * 1000);
  const over = recent.length >= AI_LIMIT_PER_HOUR;
  if (!over) recent.push(now);
  aiCalls.set(id, recent);
  return over;
}

async function answer(platform, senderId, text, media, phoneNumberId) {
  const convo = getConversation(senderId);
  if (convo.humanPausedUntil && convo.humanPausedUntil > Date.now()) return; // staff stepped in while we waited
  if (overRateLimit(senderId)) { console.warn(`Rate limit reached for ${senderId}, not replying`); return; }

  const raw = (await askGemini(senderId, text, platform, media, phoneNumberId)) || FALLBACK_REPLY;
  const { text: reply, wantsBooking } = await processReply(raw, platform, senderId);
  await sendToPlatform(platform, senderId, reply, phoneNumberId);
  if (wantsBooking) await sendBookingForm(platform, senderId, phoneNumberId);
}

async function handleIncoming({ platform, senderId, text, media, messageId, phoneNumberId }) {
  if (alreadySeen(messageId)) return;
  if (BLOCKED_NUMBERS.includes(senderId)) return;
  if (platform === "WhatsApp") markAsReadAndTyping(messageId, phoneNumberId).catch(() => {});

  const convo = getConversation(senderId);
  convo.lastCustomerTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;

  // A staff member is handling this chat: record the message but stay quiet
  if (convo.humanPausedUntil && convo.humanPausedUntil > Date.now()) {
    convo.history.push({ role: "user", parts: [{ text }] });
    convo.lastMessageTime = Date.now();
    trimHistory(convo);
    return;
  }

  bufferAndDebounce(senderId, text, media, (combinedText, combinedMedia) => {
    runExclusive(senderId, () => answer(platform, senderId, combinedText, combinedMedia, phoneNumberId)).catch((err) =>
      console.error("Failed to answer message:", err)
    );
  });
}

// A staff member replied from the Page/Instagram inbox: pause the assistant on that chat
function pauseForStaff(platform, customerId, text) {
  const convo = getConversation(customerId);
  convo.history.push({ role: "model", parts: [{ text: text || "[Staff reply]" }] });
  convo.platform = platform;
  convo.lastMessageTime = Date.now();
  convo.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS;
  trimHistory(convo);
}

// ---- Downloading voice notes / images ----
async function downloadWhatsAppMedia(mediaId) {
  const meta = await (await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).json();
  if (!meta.url) throw new Error("no media url");
  if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) throw new Error("media too large");
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("media too large");
  return { base64Data: buf.toString("base64"), mimeType: meta.mime_type || "application/octet-stream" };
}

async function downloadPublicMedia(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("media too large");
  return { base64Data: buf.toString("base64"), mimeType: (res.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}

// ---- WhatsApp webhook ----
async function handleWhatsApp(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || PHONE_NUMBER_ID;

      for (const m of value.messages || []) {
        const senderId = m.from || m.from_user_id;
        if (!senderId) continue;

        let text = null;
        let media = null;
        try {
          if (m.type === "text") text = m.text?.body;
          else if (m.type === "button") text = m.button?.text;
          else if (m.type === "interactive") text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
          else if (m.type === "image" || m.type === "audio") {
            if (MEDIA_TO_AI) {
              media = await downloadWhatsAppMedia(m[m.type].id);
              text = m.type === "image"
                ? m.image.caption || "[The patient sent an image. Do not interpret medical images or results.]"
                : "[The patient sent a voice note. Listen to it and respond helpfully.]";
            } else text = MEDIA_PLACEHOLDER;
          } else if (m.type === "video" || m.type === "document") text = MEDIA_PLACEHOLDER;
        } catch (err) {
          console.error("Could not fetch media:", err.message);
          text = MEDIA_PLACEHOLDER;
        }
        if (!text) continue;

        if (m.type === "text") messageStore.set(m.id, { text, time: Date.now() });
        if (m.context?.id) {
          const quoted = messageStore.get(m.context.id);
          if (quoted) text = `[The patient is replying to this earlier message: "${quoted.text}"]\n${text}`;
        }
        await handleIncoming({ platform: "WhatsApp", senderId, text, media, messageId: m.id, phoneNumberId });
      }
    }
  }
}

// ---- Facebook Messenger and Instagram (same payload shape) ----
async function handleMessaging(body, platform) {
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg) continue; // read receipts, postbacks and reactions are ignored

      if (msg.is_echo) {
        // A message sent from our own side. If it was not sent by this app, a human did, so pause the assistant.
        const appId = msg.app_id ? String(msg.app_id) : "";
        if (META_APP_ID && appId !== META_APP_ID && ev.recipient?.id) pauseForStaff(platform, ev.recipient.id, msg.text);
        continue;
      }

      const senderId = ev.sender?.id;
      if (!senderId || (platform === "Instagram" && senderId === IG_ACCOUNT_ID)) continue;

      let text = msg.text;
      let media = null;
      const attachment = msg.attachments?.[0];
      if (!text && attachment) {
        try {
          if (MEDIA_TO_AI && (attachment.type === "audio" || attachment.type === "image") && attachment.payload?.url) {
            media = await downloadPublicMedia(attachment.payload.url);
            text = attachment.type === "audio"
              ? "[The patient sent a voice note. Listen to it and respond helpfully.]"
              : "[The patient sent an image. Do not interpret medical images or results.]";
          } else text = MEDIA_PLACEHOLDER;
        } catch (err) {
          console.error("Could not fetch attachment:", err.message);
          text = MEDIA_PLACEHOLDER;
        }
      }
      if (!text) continue;
      await handleIncoming({ platform, senderId, text, media, messageId: msg.mid });
    }
  }
}

// =====================================================================================
// 12. THE WEB SERVER
// =====================================================================================
const app = express();
// Keep the raw body so Meta's signature can be checked
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("Triple H messaging assistant is running."));

// ---- Meta webhook ----
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
    console.error("Rejected a webhook call with an invalid signature");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast, Meta expects it
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

// ---- Web booking form (Messenger / Instagram) ----
function bookingPage({ platform, sender, token, error = "", v = {} }) {
  const opts = (list, selected) =>
    `<option value="">Choose...</option>` + list.map((o) => `<option value="${esc(o.id)}"${selected === o.id ? " selected" : ""}>${esc(o.title)}</option>`).join("");
  const radios = MODES.map((o, i) =>
    `<label class="r"><input type="radio" name="mode" value="${esc(o.id)}"${v.mode === o.id || (!v.mode && i === 0) ? " checked" : ""}> ${esc(o.title)}</label>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book a Consultation | Triple H Fertility Hub</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f7f5;margin:0;color:#1d2b24}
.card{max-width:480px;margin:0 auto;background:#fff;min-height:100vh;padding:24px 20px 40px}
h1{font-size:1.3rem;margin:0 0 4px;color:#0F5132}p.sub{margin:0 0 18px;color:#55645c;font-size:.92rem}
label{display:block;font-weight:600;font-size:.9rem;margin:14px 0 6px}label.r{font-weight:400;margin:6px 0}
input[type=text],input[type=tel],input[type=email],select,textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #c9d4ce;border-radius:8px;font-size:1rem;background:#fff}
.err{background:#fdecea;color:#8a1c12;padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:.9rem}
.c{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin-top:18px}.c input{margin-top:4px}
button{margin-top:22px;width:100%;padding:14px;background:#0F5132;color:#fff;border:0;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
small{color:#6a786f;display:block;margin-top:6px}
</style></head><body><div class="card">
<h1>Book a Consultation</h1>
<p class="sub">Triple H Fertility Hub. Clinic hours: Mon-Thu 9am-6pm, Sat 10am-4pm. Our team will confirm your exact time.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="POST" action="/book-session">
<input type="hidden" name="p" value="${esc(platform)}"><input type="hidden" name="s" value="${esc(sender)}"><input type="hidden" name="t" value="${esc(token)}">
<label for="name">Full name</label><input id="name" type="text" name="name" maxlength="80" required value="${esc(v.name)}">
<label for="phone">Phone / WhatsApp</label><input id="phone" type="tel" name="phone" maxlength="30" required value="${esc(v.phone)}">
<label for="email">Email (optional)</label><input id="email" type="email" name="email" maxlength="100" value="${esc(v.email)}">
<label for="service">Service</label><select id="service" name="service" required>${opts(SERVICES, v.service)}</select>
<label>Consultation type</label>${radios}
<label for="day">Preferred day</label><select id="day" name="day" required>${opts(DAYS, v.day)}</select>
<label for="time">Preferred time</label><select id="time" name="time" required>${opts(TIMES, v.time)}</select>
<label for="notes">Anything to add?</label><textarea id="notes" name="notes" rows="3" maxlength="300">${esc(v.notes)}</textarea>
<small>Please do not share medical records here.</small>
<label class="c"><input type="checkbox" name="consent" required> <span>I agree that Triple H Fertility Hub may contact me about this request.</span></label>
<button type="submit">Request appointment</button>
</form></div></body></html>`;
}

const WEB_FORM_PLATFORMS = ["WhatsApp", "Messenger", "Instagram"];

app.get("/book-session", (req, res) => {
  const { p, s, t } = req.query;
  res.set("Cache-Control", "no-store");
  if (!WEB_FORM_PLATFORMS.includes(p) || !validLink(p, String(s || ""), String(t || ""))) {
    return res.status(403).send("This booking link is not valid. Please message us again to get a new one.");
  }
  // On WhatsApp we already know the number, so pre-fill it
  const v = p === "WhatsApp" && /^\d{5,16}$/.test(String(s)) ? { phone: String(s) } : {};
  res.send(bookingPage({ platform: p, sender: String(s), token: String(t), v }));
});

app.post("/book-session", async (req, res) => {
  const { p, s, t } = req.body || {};
  res.set("Cache-Control", "no-store");
  if (!WEB_FORM_PLATFORMS.includes(p) || !validLink(p, String(s || ""), String(t || ""))) {
    return res.status(403).send("This booking link is not valid. Please message us again to get a new one.");
  }
  const form = normalizeSubmission({ ...req.body, consent: req.body.consent });
  const raw = req.body;
  const problem =
    !form.name ? "Please enter your name." :
    !form.phone && !form.email ? "Please enter a phone number or email." :
    !raw.service || !form.service ? "Please choose a service." :
    !raw.day || !raw.time ? "Please choose a preferred day and time." :
    !form.consent ? "Please tick the box so we can contact you." : "";
  if (problem) return res.status(400).send(bookingPage({ platform: p, sender: String(s), token: String(t), error: problem, v: raw }));

  try {
    await recordBooking(p, String(s), raw);
  } catch (err) {
    console.error("Web booking failed:", err);
    return res.status(500).send(bookingPage({ platform: p, sender: String(s), token: String(t), error: "Something went wrong. Please try again, or call +234 201 350 2083.", v: raw }));
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;margin:0;padding:60px 20px;color:#1d2b24">
<h2 style="color:#0F5132">Thank you, ${esc(form.name.split(" ")[0])}!</h2>
<p>We have your request. Our team will contact you shortly to confirm your appointment.<br>You can close this page and return to the chat.</p></body></html>`);
});

// =====================================================================================
// 13. STAFF PAGES (password protected): inbox, takeover, leads
// =====================================================================================
function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const i = decoded.indexOf(":");
    if (i > -1 && safeEqual(decoded.slice(0, i), ADMIN_USER) && safeEqual(decoded.slice(i + 1), env.ADMIN_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Triple H staff"').status(401).send("Authentication required");
}

// Blocks forms posted from other websites
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  try { if (new URL(origin).host === req.headers.host) return next(); } catch (err) { /* fall through */ }
  res.status(403).send("Blocked: cross-site request");
}

const ago = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return mins < 60 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
};
const windowOpen = (ts) => Boolean(ts) && Date.now() - ts < 24 * 3600 * 1000;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:20px auto;padding:0 12px;color:#222}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;font-size:14px}
th{background:#f5f5f5}a{color:#0F5132}.muted{color:#777}.bubble{max-width:75%;padding:10px 14px;border-radius:12px;margin:6px 0;white-space:pre-wrap}
.cust{background:#f0f0f0}.bot{background:#0F5132;color:#fff;margin-left:auto}button{padding:8px 16px;cursor:pointer}</style></head>
<body><nav><a href="/inbox">Inbox</a> &nbsp;|&nbsp; <a href="/leads">Leads</a></nav>${body}</body></html>`;
}

app.get("/inbox", adminAuth, (req, res) => {
  const rows = [...conversations.entries()].sort((a, b) => b[1].lastMessageTime - a[1].lastMessageTime).slice(0, 60);
  const tr = rows.map(([id, c]) => {
    const last = c.history[c.history.length - 1]?.parts?.[0]?.text || "";
    const paused = c.humanPausedUntil && c.humanPausedUntil > Date.now();
    return `<tr><td>${esc(c.platform)}</td><td>${esc(id)}</td><td>${esc(last.slice(0, 90))}</td><td>${ago(c.lastMessageTime)}</td>
      <td>${paused ? "Staff handling" : "Assistant active"}</td><td>${windowOpen(c.lastCustomerTime) ? "Open" : "Closed"}</td>
      <td><a href="/inbox/chat?sender=${encodeURIComponent(id)}">Open</a></td></tr>`;
  }).join("");
  res.send(page("Inbox", `<h2>Inbox (${rows.length})</h2><p class="muted">Recent chats since the last server restart.</p>
    <table><tr><th>Channel</th><th>Contact</th><th>Last message</th><th>When</th><th>Status</th><th>Reply window</th><th></th></tr>${tr}</table>`));
});

app.get("/inbox/chat", adminAuth, (req, res) => {
  const sender = String(req.query.sender || "");
  const c = conversations.get(sender);
  if (!c) return res.status(404).send(page("Not found", "<p>Conversation not found (it may have expired or the server restarted).</p>"));
  const paused = c.humanPausedUntil && c.humanPausedUntil > Date.now();
  const bubbles = c.history.map((t) => `<div class="bubble ${t.role === "user" ? "cust" : "bot"}">${esc(t.parts?.[0]?.text)}</div>`).join("");
  const banner = paused
    ? `<p>Staff are handling this chat. The assistant is paused until ${esc(new Date(c.humanPausedUntil).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }))}.
       <form method="POST" action="/inbox/resume" style="display:inline"><input type="hidden" name="sender" value="${esc(sender)}"><button>Resume assistant now</button></form></p>`
    : `<p class="muted">The assistant is active on this chat. Sending a reply pauses it.</p>`;
  const form = windowOpen(c.lastCustomerTime)
    ? `<form method="POST" action="/inbox/reply"><input type="hidden" name="sender" value="${esc(sender)}">
       <textarea name="message" rows="3" style="width:100%" required></textarea><br><button>Send reply</button></form>`
    : `<p class="muted">The 24-hour reply window is closed. Please call the patient or ask them to message again.</p>`;
  res.send(page("Chat", `<h3>${esc(c.platform)}: ${esc(sender)}</h3>${banner}<div>${bubbles || "<p>No messages.</p>"}</div>${form}`));
});

app.post("/inbox/reply", adminAuth, sameOrigin, async (req, res) => {
  try {
    const sender = String(req.body.sender || "");
    const message = String(req.body.message || "").trim();
    const c = conversations.get(sender);
    if (!c || !message) return res.status(400).send("Missing chat or message");
    const sent = await sendToPlatform(c.platform, sender, message, c.phoneNumberId);
    c.history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED] ${message}` }] });
    c.lastMessageTime = Date.now();
    c.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS; // pause even if the send failed, so the assistant does not talk over staff
    trimHistory(c);
    res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}`);
  } catch (err) {
    console.error("Inbox reply failed:", err);
    res.status(500).send("Something went wrong. Check the Render logs.");
  }
});

app.post("/inbox/resume", adminAuth, sameOrigin, (req, res) => {
  const sender = String(req.body.sender || "");
  const c = conversations.get(sender);
  if (c) c.humanPausedUntil = null;
  res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}`);
});

app.get("/leads", adminAuth, (req, res) => {
  const tr = leads.map((l) => `<tr><td>${esc(l.created.slice(0, 16).replace("T", " "))}</td><td>${esc(l.type)}</td><td>${esc(l.platform)}</td>
    <td>${esc(l.name)}</td><td>${esc(l.phone || l.email || (l.platform === "WhatsApp" ? l.senderId : ""))}</td><td>${esc(l.service)}</td><td>${esc(l.mode)}</td>
    <td>${esc([l.day, l.time].filter(Boolean).join(", "))}</td><td>${esc(l.notes)}</td><td>${esc(l.status)}</td>
    <td>${l.status === "contacted" ? "" : `<form method="POST" action="/leads/contacted"><input type="hidden" name="id" value="${l.id}"><button>Mark contacted</button></form>`}</td></tr>`).join("");
  res.send(page("Leads", `<h2>Leads and appointment requests (${leads.length})</h2>
    <p class="muted">${googleCreds ? "Every booking is also saved to your Google Sheet, which is the permanent record." : "Google Sheets is not connected, so this list is cleared when the server restarts."}</p>
    <table><tr><th>Date</th><th>Type</th><th>Channel</th><th>Name</th><th>Contact</th><th>Service</th><th>Consultation</th><th>Preferred</th><th>Notes</th><th>Status</th><th></th></tr>${tr}</table>`));
});

app.post("/leads/contacted", adminAuth, sameOrigin, (req, res) => {
  const lead = leads.find((l) => l.id === Number(req.body.id));
  if (lead) lead.status = "contacted";
  res.redirect("/leads");
});

// =====================================================================================
// 14. HOUSEKEEPING AND START
// =====================================================================================
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of conversations) if (now - c.lastMessageTime > SESSION_TIMEOUT_MS) conversations.delete(id);
  for (const [id, t] of seen) if (now - t > 3600 * 1000) seen.delete(id);
  for (const [id, m] of messageStore) if (now - m.time > 24 * 3600 * 1000) messageStore.delete(id);
  for (const [id, arr] of aiCalls) if (!arr.some((t) => now - t < 3600 * 1000)) aiCalls.delete(id);
}, 3600 * 1000).unref();

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

refreshWebsiteContent();
setInterval(refreshWebsiteContent, 6 * 3600 * 1000).unref();

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log(`Triple H assistant running on port ${PORT}`));
