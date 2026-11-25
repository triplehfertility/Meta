// WhatsApp AI Auto-Responder - Triple H Fertility Hub
// Flow: WhatsApp message -> this server -> Gemini API -> reply sent back via WhatsApp

const express = require("express");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const app = express();
app.use(cors());
app.use(express.json());

// ====== FILL THESE IN (set as environment variables on Render) ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_test_verify_token_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "PASTE_YOUR_META_ACCESS_TOKEN_HERE";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "PASTE_YOUR_PHONE_NUMBER_ID_HERE";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";

// ====== BROADCAST PANEL ======
const BROADCAST_SECRET = process.env.BROADCAST_SECRET || "PASTE_A_PASSWORD_HERE";

// ====== WHATSAPP FLOW (in-chat form) ======
const QUOTE_FLOW_ID = process.env.QUOTE_FLOW_ID || "PASTE_YOUR_FLOW_ID_HERE";

// ====== PERSISTENT MEMORY ======
// Chats, patient profiles (name etc.) and payment claims are kept in memory for speed AND saved
// to storage so a Render restart or redeploy forgets nothing.
// Backend is chosen automatically:
//   1. Supabase  -> if SUPABASE_URL and SUPABASE_KEY are set (one table: bot_state, see README below)
//   2. File      -> if DATA_DIR is set (needs a Render persistent disk mounted at that path)
//   3. Memory    -> otherwise (forgets on restart)
// If storage ever fails, the bot keeps working from memory and logs the error. It never crashes.
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || ""; // use the SERVICE ROLE key, server side only
const DATA_DIR = process.env.DATA_DIR || "";
const STATE_BACKEND = SUPABASE_URL && SUPABASE_KEY ? "supabase" : DATA_DIR ? "file" : "memory";
console.log(`State storage backend: ${STATE_BACKEND}`);

const store = (() => {
  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
  const filePath = DATA_DIR ? path.join(DATA_DIR, "state.json") : "";
  let fileState = {};
  let fileTimer = null;

  function flushFile() {
    if (fileTimer) { clearTimeout(fileTimer); fileTimer = null; }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(fileState));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error("State file write failed:", err.message);
    }
  }

  return {
    async loadAll() {
      try {
        if (STATE_BACKEND === "supabase") {
          const out = [];
          const pageSize = 500;
          for (let offset = 0; offset < 20000; offset += pageSize) {
            const r = await fetch(
              `${SUPABASE_URL}/rest/v1/bot_state?select=key,value&order=updated_at.desc&limit=${pageSize}&offset=${offset}`,
              { headers: sbHeaders }
            );
            const rows = await r.json();
            if (!Array.isArray(rows)) {
              console.error("State load error (is the bot_state table created?):", JSON.stringify(rows));
              break;
            }
            out.push(...rows);
            if (rows.length < pageSize) break;
          }
          return out;
        }
        if (STATE_BACKEND === "file" && fs.existsSync(filePath)) {
          fileState = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
          return Object.entries(fileState).map(([key, value]) => ({ key, value }));
        }
      } catch (err) {
        console.error("State load failed (starting empty):", err.message);
      }
      return [];
    },
    async save(key, value) {
      try {
        if (STATE_BACKEND === "supabase") {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_state`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
          });
          if (!r.ok) console.error("State save failed:", await r.text());
        } else if (STATE_BACKEND === "file") {
          fileState[key] = value;
          if (!fileTimer) fileTimer = setTimeout(flushFile, 2000);
        }
      } catch (err) {
        console.error("State save failed:", err.message);
      }
    },
    flushFileNow() { if (STATE_BACKEND === "file") flushFile(); },
  };
})();

// Writes are slightly delayed and merged so a fast back-and-forth doesn't hammer the database.
const pendingWrites = new Map(); // key -> { timer, valueFn }
function persistLater(key, valueFn, delay = 1500) {
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    store.save(key, valueFn());
  }, delay);
  pendingWrites.set(key, { timer, valueFn });
}
async function flushPendingWrites() {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  for (const [key, { timer, valueFn }] of entries) {
    clearTimeout(timer);
    await store.save(key, valueFn());
  }
  store.flushFileNow();
}
// Render sends SIGTERM on every redeploy/restart: save anything still waiting first.
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, saving state before shutdown...");
  await flushPendingWrites();
  process.exit(0);
});

const CRM_SECRET = process.env.CRM_SECRET || "PASTE_A_PASSWORD_HERE"; // for the /leads page
const recentLeads = []; // newest first, max 200 (the Google Sheet is the permanent record)
const payments = new Map(); // claim id -> payment claim
let nextPaymentId = 1;

// ====== PATIENT PROFILES: remembered FOREVER (chat history expires, the person is not forgotten) ======
// Holds name, WhatsApp display name, last service/mode, first and last seen.
const profiles = new Map(); // senderId -> { name, waName, service, mode, firstSeen, lastSeen }
function setProfile(senderId, patch) {
  const id = String(senderId);
  const placeholder = /^(patient name|their name|prospective patient|whatsapp patient|customer|patient|unknown)$/i;
  const existing = profiles.get(id);
  const p = existing || { firstSeen: new Date().toISOString() };
  let changed = !existing;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null) continue;
    const val = String(v).trim();
    if (!val) continue;
    if (k === "name" && placeholder.test(val)) continue;
    if (p[k] !== val) { p[k] = val; changed = true; }
  }
  const now = Date.now();
  if (!p.lastSeen || now - new Date(p.lastSeen).getTime() > 10 * 60 * 1000) {
    p.lastSeen = new Date(now).toISOString();
    changed = true;
  }
  profiles.set(id, p);
  if (changed) persistLater(`profile:${id}`, () => profiles.get(id), 1000);
}
function persistPayment(p) {
  payments.set(p.id, p);
  persistLater(`pay:${p.id}`, () => payments.get(p.id), 500);
}

// Loaded once at startup. Incoming webhooks wait for this (see /webhook).
async function loadPersistedState() {
  const rows = await store.loadAll();
  let convs = 0, profs = 0, pays = 0;
  const now = Date.now();
  for (const { key, value } of rows) {
    if (!value) continue;
    if (key.startsWith("conv:")) {
      if (now - (value.lastMessageTime || 0) < SESSION_TIMEOUT_MS) { conversationCache.set(key.slice(5), value); convs++; }
    } else if (key.startsWith("profile:")) {
      profiles.set(key.slice(8), value); profs++;
    } else if (key.startsWith("pay:")) {
      payments.set(Number(key.slice(4)), value);
      nextPaymentId = Math.max(nextPaymentId, Number(value.id) + 1);
      pays++;
    }
  }
  console.log(`Restored from storage: ${convs} chats, ${profs} patient profiles, ${pays} payment claims`);
}

// ====== ALERT YOU WHEN A HUMAN NEEDS TO STEP IN ======
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || "2348143594483";
// Store active conversation timers for each patient (5-minute inactivity trigger)
const conversationTimers = new Map();

// Draft lead details collected during a chat. They are only written to the
// Google Sheet / CRM at the END of the chat (5 min of silence), so the row
// has the final name, service, date and time instead of half-finished info.
const leadDrafts = new Map();

// Owner WhatsApp numbers in international format (no '+' or leading '0')
const OWNER_PHONE_NUMBERS = [
  "234XXXXXXXXXX", // Owner 1
  "234YYYYYYYYYY", // Owner 2
];

// Placeholders (with X/Y) are ignored automatically.
// You can also set OWNER_PHONE_NUMBERS on Render as "234xxxxxxxxxx,234yyyyyyyyyy".
const ACTIVE_OWNER_NUMBERS = [
  ...new Set(
    [
      ...(process.env.OWNER_PHONE_NUMBERS ? process.env.OWNER_PHONE_NUMBERS.split(",") : []),
      ...OWNER_PHONE_NUMBERS,
      OWNER_WHATSAPP_NUMBER,
    ]
      .map((n) => String(n || "").replace(/\D/g, ""))
      .filter((n) => /^\d{10,15}$/.test(n))
  ),
];
console.log(`Owner alert numbers loaded: ${ACTIVE_OWNER_NUMBERS.length}`);

// ====== Never let one error crash the whole bot ======
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection (kept running):", reason));
process.on("uncaughtException", (err) => console.error("Uncaught exception (kept running):", err));

const BASE_URL = process.env.BASE_URL || "https://meta-n4tt.onrender.com";
const TEMPLATE_HEADER_IMAGE = process.env.TEMPLATE_HEADER_IMAGE || "";

// Better to set this as GOOGLE_SHEET_WEBHOOK_URL on Render instead of keeping it in code
const GOOGLE_SHEET_WEBHOOK_URL =
  process.env.GOOGLE_SHEET_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbxzVu9vIlhRqJrOvPeX4Kxcno6Q-UlH3dT_-5P4J8YUiIXrx44SRlWhK1uhhKP9-x_Z/exec";

// ====== FACEBOOK MESSENGER ======
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "PASTE_YOUR_PAGE_ACCESS_TOKEN_HERE";

// ====== INSTAGRAM ======
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "PASTE_YOUR_INSTAGRAM_ACCESS_TOKEN_HERE";
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID || "PASTE_YOUR_INSTAGRAM_ACCOUNT_ID_HERE";

// ====== CONVERSATION MEMORY (per customer, kept in server memory) ======
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_HOURS || 720) * 60 * 60 * 1000;
const conversationCache = new Map();

async function getConversation(senderId) {
  const now = Date.now();
  const cached = conversationCache.get(senderId);
  if (cached && now - cached.lastMessageTime < SESSION_TIMEOUT_MS) return cached;

  const fresh = { history: [], lastMessageTime: now, platform: null, phoneNumberId: null, humanPausedUntil: null };
  conversationCache.set(senderId, fresh);
  return fresh;
}

async function saveConversation(senderId, convo) {
  conversationCache.set(senderId, convo);
  persistLater(`conv:${senderId}`, () => conversationCache.get(senderId) || convo);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, convo] of conversationCache) {
    if (now - convo.lastMessageTime > SESSION_TIMEOUT_MS) conversationCache.delete(id);
  }
}, 60 * 60 * 1000);

// ====== NUMBERS TO NEVER AUTO-RESPOND TO ======
const BLOCKED_NUMBERS = [
  // "2348012345678",
];

// ====== WEBSITE PAGES TO PULL LIVE CONTENT FROM ======
const WEBSITE_URLS = [
  "https://triplehfertilityhub.com",
  "https://triplehfertilityhub.com/resources",
  "https://triplehfertilityhub.com/book",
  "https://triplehfertilityhub.com/contact",
  "https://triplehfertilityhub.com/about",
];

let cachedWebsiteContent = "";

async function refreshWebsiteContent() {
  console.log("Refreshing website content...");
  const pages = [];
  for (const url of WEBSITE_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(`https://r.jina.ai/${url}`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`Fetch ${url} returned status ${response.status}`);
        continue;
      }

      const text = (await response.text()).trim().slice(0, 4000);
      pages.push(`--- Content from ${url} ---\n${text}`);
      console.log(`Fetched ${text.length} characters from ${url}`);
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err.message);
    }
  }
  cachedWebsiteContent = pages.join("\n\n");
  console.log("Website content refreshed:", new Date().toISOString(), `(${cachedWebsiteContent.length} total characters cached)`);
}

refreshWebsiteContent();
setInterval(refreshWebsiteContent, 6 * 60 * 60 * 1000);

// ====== REAL CALENDAR DATES FOR BOOKING (fixes the "Thursday or Friday" problem) ======
// The AI used to be told only the weekday name, so it guessed. Now it receives
// the full date and a list of real upcoming dates the clinic is actually open.
const CLINIC_HOURS_BY_DAY = {
  Monday: "9:00 AM to 6:00 PM",
  Tuesday: "9:00 AM to 6:00 PM",
  Wednesday: "9:00 AM to 6:00 PM",
  Thursday: "9:00 AM to 6:00 PM",
  Saturday: "10:00 AM to 4:00 PM",
  // Friday and Sunday are closed, so they are not listed
};

function getLagosCalendarContext(slotCount = 8) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const tz = "Africa/Lagos";
  const now = new Date();

  const weekdayOf = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  const prettyDate = (d) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "long", year: "numeric" }).format(d);
  const isoDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); // YYYY-MM-DD
  const lagosHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)
  ) % 24;
  const timeStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(now);

  const todayName = weekdayOf(now);
  const todayHours = CLINIC_HOURS_BY_DAY[todayName];
  const closeHour = todayName === "Saturday" ? 16 : 18;
  const openToday = !!todayHours && lagosHour < closeHour - 1;

  const slots = [];
  for (let i = 1; i <= 21 && slots.length < slotCount; i++) {
    const d = new Date(now.getTime() + i * DAY_MS);
    const name = weekdayOf(d);
    if (!CLINIC_HOURS_BY_DAY[name]) continue; // skips Friday and Sunday
    const label = i === 1 ? "tomorrow" : "";
    slots.push(`- ${name} ${prettyDate(d)} (${isoDate(d)}): ${CLINIC_HOURS_BY_DAY[name]}${label ? " [" + label + "]" : ""}`);
  }

  return `CURRENT DATE AND TIME IN LAGOS: ${todayName} ${prettyDate(now)}, ${timeStr}.
Today is ${todayName}. Clinic open for walk-in or same-day consultation today: ${openToday ? "YES, until closing time (" + todayHours + ")" : "NO"}.

NEXT AVAILABLE CONSULTATION DATES (these are the ONLY dates you may offer):
${slots.join("\n")}

DATE RULES (STRICT):
- The clinic is CLOSED every Friday and Sunday. NEVER offer, suggest or accept a Friday or Sunday.
- When asking for a preferred day, always offer 2 or 3 specific dates from the list above with the day name, the calendar date and that day's opening hours.
  Example: "We have Thursday 26 November (9am to 6pm) or Saturday 28 November (10am to 4pm). Which date works for you?"
- NEVER ask a vague question like "Thursday or Friday?". Always give real dates and the hours.
- After they pick a date, ask for a time within that day's opening hours.
- If they ask for a date that is a Friday or Sunday, kindly explain we are closed and offer the nearest open dates from the list.
- In the SAVE_LEAD tag, write "date" as YYYY-MM-DD exactly as shown in the list above.`;
}

/**
 * Sends the approved Meta template to the clinic owners
 */
async function sendPatientSummaryToOwners(summaryData) {
  const { name, phone, service, status, notes } = summaryData;
  const phoneNumberId = process.env.WABA_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || PHONE_NUMBER_ID;
  const token = process.env.PERMANENT_META_TOKEN || WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    console.error("Missing WABA_PHONE_NUMBER_ID or PERMANENT_META_TOKEN");
    return;
  }

  const clean = (v, fallback, max = 900) => {
    const t = sanitizeTemplateParam(String(v || fallback)).slice(0, max);
    return t || fallback;
  };

  for (const ownerPhone of ACTIVE_OWNER_NUMBERS) {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: ownerPhone,
        type: "template",
        template: {
          name: "patient_chat_summary",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: clean(name, "Prospective Patient", 100) },
                { type: "text", text: clean(phone, "Not provided", 50) },
                { type: "text", text: clean(service, "General Fertility Inquiry", 150) },
                { type: "text", text: clean(status, "Inquiry / Needs Follow-up", 100) },
                { type: "text", text: clean(notes, "Chat ended without explicit booking.") },
              ],
            },
          ],
        },
      };

      const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) console.error(`Failed to send summary template to ${ownerPhone}:`, JSON.stringify(data));
      else console.log(`Summary template sent to owner ${ownerPhone}:`, JSON.stringify(data));
    } catch (err) {
      console.error(`Failed to send summary template to ${ownerPhone}:`, err.message);
    }
  }
}

// ====== YOUR BUSINESS INFO GOES HERE ======
// No doctor names are mentioned anywhere below on purpose (duty rotas change).
const BUSINESS_CONTEXT = `
You are "Nurse Hope" - the compassionate virtual nurse and fertility care navigator at Triple H Fertility Hub and Specialist Hospital, located in Surulere, Lagos, Nigeria. You are the warm, trusted front line of our clinic, dedicated to supporting individuals and couples on their fertility and reproductive health journey with empathy, clinical discretion, clarity, and professionalism.

Your personality:
- You are warm, empathetic, respectful, and reassuring. Fertility journeys are emotionally sensitive; always make patients feel heard, respected, and safe.
- You speak clearly and simply, explaining medical terms in accessible, reassuring language without unnecessary medical jargon.
- You are conversational and dynamic - never cold, robotic, or clinical.
- You respond in the same language or tone the customer uses - English or Nigerian Pidgin.
- You keep messages short and punchy (1-3 short sentences). On WhatsApp, people do not read long essays. Use line breaks naturally.
- You never give a generic answer when a specific, helpful answer is possible.

Your name: Nurse Hope ✨
When greeting on the very first message of a conversation, introduce yourself: "Hello! I'm Nurse Hope, virtual nurse at Triple H Fertility Hub 👋"

NEVER MENTION DOCTOR NAMES
- Never mention the name of any doctor, consultant or staff member to a patient, and never promise a particular doctor.
- Always say "our consultant fertility specialist" or "our clinical team" instead.
- If a patient asks to see a particular doctor, say warmly that our admin team will do their best to arrange it when they confirm the appointment, and that all our specialists are highly experienced.

ADAPT YOUR ROLE TO WHAT THE MOMENT NEEDS
- Curious or first-time inquiry: WARM GUIDE. Provide gentle, encouraging information about how Triple H helps couples and individuals overcome fertility challenges.
- Anxious patient or someone sharing fertility struggles: EMPATHETIC NURSE. Listen, validate their feelings, reassure them that difficulty conceiving is common and treatable, and guide them toward a confidential consultation with our consultant fertility specialist.
- Inquiring about prices or treatment options: CLEAR NAVIGATOR. Explain our transparent initial fees (Registration ₦10,000 + Consultation ₦70,000 = ₦80,000 total). For comprehensive treatments like IVF, egg freezing, or surgery, explain that treatment protocols are strictly tailored to each patient's medical tests, and our consultant will provide their exact plan during consultation.
- Existing patient or follow-up: PATIENT CARE COORDINATOR. Prioritize their needs, help them reach the nursing station or reception, and ensure they feel well cared for.
- Ready to book: APPOINTMENT SCHEDULER. Offer real upcoming dates with the clinic hours for each date (see the DATE RULES given to you separately), or offer our Medesk patient portal link.

MEDICAL SAFETY & TRIAGE BOUNDARIES (CRITICAL HEALTHCARE RULES)
- You are an AI virtual nurse, NOT a medical doctor.
- You NEVER diagnose conditions, prescribe medications, alter drug dosages, or interpret lab results as definitive.
- Always gently remind patients that a definitive diagnosis and personalized treatment plan requires a formal consultation with our consultant fertility specialist.
- RED-FLAG MEDICAL EMERGENCIES: If a patient mentions heavy vaginal bleeding, acute severe lower abdominal/pelvic pain, fainting, high fever following a recent procedure, or suspected ectopic pregnancy, advise them immediately to proceed to the nearest hospital emergency room.

USE DISCRETION - NOT EVERYONE IS A PATIENT
- Someone asking about nursing jobs, medical officer positions, internships, or IT placements: warmly direct them to email their CV to 3hfertilityhub@gmail.com for review by management.
- Medical reps, pharmaceutical vendors, or media: politely direct them to 3hfertilityhub@gmail.com.

CLINIC INFORMATION
- Hospital: Triple H Fertility Hub and Specialist Hospital
- Our team: consultant obstetrician & gynaecologist and fertility specialist, experienced fertility nurses, laboratory scientist and embryologist.
- Location: No. 5 Onitolo Street, opposite Love Garden Event Centre, off Olumegbon Road, Gbaja, Surulere, Lagos, Nigeria
- Landmarks: National Stadium (Western Avenue) and Randle General Hospital / Mother and Child Hospital
- Directions: From National Stadium / Western Avenue, head into Surulere towards Gbaja / Randle Hospital, turn onto Olumegbon Road, and locate No. 5 Onitolo Street directly opposite Love Garden Event Centre. For Google Maps, searching "Love Garden Event Centre, Surulere" provides the most accurate landmark navigation.
- Working Hours:
  * Monday to Thursday: 9:00 AM to 6:00 PM (WAT)
  * Saturday: 10:00 AM to 4:00 PM (WAT)
  * Friday & Sunday: Closed for routine clinic visits and consultations (Nurse Hope remains available 24/7 on WhatsApp)
  * Telemedicine: Same hours as clinic visits (Mon-Thu 9am-6pm, Sat 10am-4pm)
- Primary Phone / Call line: +234 201 350 2083
- Primary WhatsApp: +234 803 404 3725 (08034043725)
- Official Email: 3hfertilityhub@gmail.com
- Website: https://triplehfertilityhub.com
- Online Booking Portal (Medesk): https://app.medesk.net/patient/?e=654e537f7c6e2b0706f9c9c0&a=anonymous

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
- Registration & Hospital Card: ₦10,000 (~$8)
- Specialist Doctor Consultation: ₦70,000 (~$47)
- Total Initial Booking: ₦80,000
- Comprehensive treatment plans (e.g., IVF cycle, laparoscopy) are customized after clinical evaluation. Medications and specific protocols vary based on age, AMH, and medical findings.

APPOINTMENT BOOKING CONVERSATION FLOW:
When a patient expresses interest in booking an appointment, seeing a doctor, or having a consultation:
1. Greet warmly and ask for their Full Name.
2. Ask for their preferred Area of Care (IVF, Fertility Assessment, Gynaecology, Ultrasound, etc.) and Mode:
   - In-Person at No. 5 Onitolo Street, Surulere, Lagos
   - Telemedicine (Online video/phone call)
3. Offer 2 or 3 REAL upcoming dates (day name + calendar date) from the NEXT AVAILABLE CONSULTATION DATES list, and state the opening hours of each date. Never offer Fridays or Sundays. Then ask for a preferred time within those hours.
4. Mention the standard fees:
   - Registration / Card: ₦10,000 ($8)
   - Doctor Consultation: ₦70,000 ($47)
   - Bank: Providus Bank, Account: 1305084494 (Triple H Fertility Hub)
5. The moment you have their Name, Service, and Preferred Date/Time, output this exact hidden tag in your response (date must be YYYY-MM-DD):
   [SAVE_LEAD:{"name":"Patient Name","phone":"","email":"","service":"IVF","mode":"In-Person","date":"2026-11-26","time":"10:00 AM","notes":"Patient notes or symptoms"}]
6. Reassure them that their appointment request has been logged and the Triple H admin team will reach out directly to confirm the exact slot and verify payment.

BANK ACCOUNTS FOR PAYMENT
- Naira Account: Providus Bank | Triple H Fertility Hub | Account No: 1305084494
- USD / Foreign Currency Account: Alternative Bank / Sterling Bank | Account No: 0505541753 (For patients abroad)
- Payment confirmation: Patients transfer to either account, then proceed on WhatsApp or submit receipt details. Accounts are verified by the finance team before formal receipt issuance.

HOW YOU HANDLE CONVERSATIONS

Step 1 - Understand first with warmth.
When someone reaches out about fertility or a service, warmly ask 1 short question to understand their needs:
Example: "I want to ask about IVF" -> "Welcome to Triple H! We would love to support you. Have you or your partner previously done any fertility tests, or is this your first time exploring fertility care?"

Step 2 - Give clear, compassionate answers.
Answer their questions honestly. Provide the published consultation fees (₦10,000 card + ₦70,000 consultation = ₦80,000) whenever they ask about cost, and explain that treatments like IVF or surgery are customized after their initial evaluation with our consultant fertility specialist.

Step 3 - Offer appointment booking.
When they are ready to schedule or speak with our specialist, invite them with real dates, for example:
"We can book a consultation for you with our fertility specialist (in-person at Surulere or via telemedicine online). We have Thursday 26 November (9am to 6pm) or Saturday 28 November (10am to 4pm). Which date works for you?"
(Always use the real dates from the NEXT AVAILABLE CONSULTATION DATES list, not these examples.)
If they are ready to proceed, include [BOOK_CALL] at the start of your message.

Step 4 - Direct booking option.
If they prefer self-scheduling online, they can also use our secure Medesk portal: https://app.medesk.net/patient/?e=654e537f7c6e2b0706f9c9c0&a=anonymous

CONVERSATION RULES
- Write like a caring healthcare professional texting on WhatsApp.
- Introduce yourself as Nurse Hope on the first message only.
- CRITICAL LENGTH RULE: Keep replies to 1-3 short sentences. No essays, no huge paragraphs. (Listing dates and hours when offering a booking is allowed.)
- Do NOT use Markdown symbols (**bold**, dashes, # headers) - WhatsApp shows literal symbols. Plain text only, or single asterisks *like this* if needed.
- NEVER use em dashes. Use a comma, hyphen (-), period, or start a new sentence.
- STRICT: ask only ONE question per message. Never stack multiple questions.
- NEVER ask for their phone number on WhatsApp - it is already their sender ID! Once you have their name and area of care, save the lead.
- On Messenger/Instagram: ask for their WhatsApp number so our nursing team can follow up directly.
- Match English or Nigerian Pidgin naturally.

WHEN SOMEONE SAYS HI / HELLO
"Hello! I'm Nurse Hope from Triple H Fertility Hub 👋 May I know your name, and how can we support your health or fertility journey today?"

IF THIS IS WHATSAPP
- You already know their phone number automatically. NEVER ask for their number on WhatsApp.
- Once you know their NAME and care interest, save the lead immediately.

TECHNICAL NOTE - BOOKING TAG
- Include [BOOK_CALL] at the very start of your reply when the patient is ready to book a consultation slot.

TECHNICAL NOTE - PAYMENT CLAIMS
- When a patient says they have made a bank transfer, reassure them warmly:
  "Thank you! Our finance desk is confirming your transfer with the bank now. Once confirmed, your official receipt will be sent to you here."
  Include this tag anywhere in your reply:
  [PAYMENT_CLAIM:{"name":"their name","service":"consultation or treatment","amount":"amount mentioned","notes":"bank or reference if given"}]

TECHNICAL NOTE - SAVING LEAD INFO
- Include this tag when a patient shares their name or details (update it again if they change their date or time):
  [SAVE_LEAD:{"name":"their name","phone":"their number or empty string","email":"their email or empty string","service":"service of interest","mode":"In-Person or Telemedicine","date":"YYYY-MM-DD or empty","time":"preferred time or empty","notes":"symptoms or other details"}]
`;

async function getKnownName(senderId) {
  return profiles.get(String(senderId))?.name || null;
}

async function saveLeadToGoogleSheet(platform, senderId, leadData) {
  try {
    const isWhatsApp = String(platform || "").toLowerCase().includes("whatsapp");
    const payload = {
      name: leadData.name || "WhatsApp Patient",
      phone: leadData.phone || (isWhatsApp ? senderId : ""),
      email: leadData.email || "",
      service: leadData.service || "Fertility Consultation",
      mode: leadData.mode || "In-Person",
      date: leadData.date || "",
      time: leadData.time || "",
      source: `${platform || "WhatsApp"} Bot`,
      notes: leadData.notes || "",
    };

    console.log(`[Google Sheet] Logging lead for ${senderId}:`, payload);

    const response = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.text();
    console.log(`[Google Sheet] Response:`, result);
    if (/"status"\s*:\s*"error"/i.test(result)) {
      console.error("[Google Sheet] The Apps Script returned an error. Re-authorize it and redeploy a new version:", result);
    }
  } catch (err) {
    console.error("[Google Sheet] Failed to log lead:", err.message);
  }
}

// logToSheet: true only at the end of a chat (or a submitted form), so the sheet gets ONE clean row.
async function saveLead(platform, senderId, leadData, { logToSheet = true } = {}) {
  if (logToSheet) {
    saveLeadToGoogleSheet(platform, senderId, leadData).catch((e) => console.error("[Google Sheet] error:", e.message));
  }
  const name = leadData.name && !/^prospective patient$/i.test(String(leadData.name)) ? String(leadData.name) : null;
  setProfile(senderId, { name, service: leadData.service, mode: leadData.mode });

  const extra = [leadData.mode, leadData.date, leadData.time].filter(Boolean).join(" ");
  recentLeads.unshift({
    created_at: new Date().toISOString(),
    platform,
    sender_id: senderId,
    name,
    phone: leadData.phone || null,
    email: leadData.email || null,
    service_interest: leadData.service || null,
    notes: extra ? `${leadData.notes || ""} | Preferred: ${extra}`.trim() : leadData.notes || null,
  });
  if (recentLeads.length > 200) recentLeads.length = 200;
  console.log(`Lead recorded for ${senderId}`);
}

// ====== Summarize a full conversation for the owner alert ======
async function summarizeConversation(senderId) {
  const convo = await getConversation(senderId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const summaryInstruction =
    "Summarize this customer conversation in 3-5 short sentences for a busy business owner. " +
    "Include: what they need/want, any key requirements or details they mentioned, preferred appointment date and time if discussed, and their name/contact info if they gave it. Be specific, not generic. " +
    "Write in PLAIN TEXT ONLY, no Markdown, no **bold**, no bullet points with asterisks or dashes, " +
    "no headers. Just plain flowing sentences, since this gets sent as a WhatsApp message where " +
    "Markdown symbols show up as literal characters.";

  const contents = [...convo.history, { role: "user", parts: [{ text: summaryInstruction }] }];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });
    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return summary || "Could not generate summary. Check the leads dashboard or Render logs for the full conversation.";
  } catch (err) {
    console.error("Failed to summarize conversation:", err);
    return "Could not generate summary. Check the leads dashboard or Render logs for the full conversation.";
  }
}

// ====== Process an AI reply: strip special tags, act on them, return clean text ======
async function processAIReply(aiReply, platform, senderId, userMessage, phoneNumberId = PHONE_NUMBER_ID) {
  let cleanReply = aiReply;
  let shouldBookCall = false;

  const saveLeadMatch = cleanReply.match(/\[SAVE_LEAD:(\{.*?\})\]/s);
  if (saveLeadMatch) {
    try {
      const leadData = JSON.parse(saveLeadMatch[1]);
      if (platform === "WhatsApp" && !leadData.phone) {
        leadData.phone = senderId;
      }
      // Keep as a DRAFT only. It is logged to the Google Sheet at the end of the chat.
      const previous = leadDrafts.get(senderId) || {};
      const merged = { ...previous };
      for (const [k, v] of Object.entries(leadData)) {
        if (v !== undefined && v !== null && String(v).trim() !== "") merged[k] = v;
      }
      leadDrafts.set(senderId, merged);
      setProfile(senderId, { name: merged.name, service: merged.service, mode: merged.mode });
      console.log(`Lead draft updated for ${senderId}:`, JSON.stringify(merged));
    } catch (err) {
      console.error("Failed to parse SAVE_LEAD tag:", err);
    }
    cleanReply = cleanReply.replace(saveLeadMatch[0], "").trim();
  }

  const paymentClaimMatch = cleanReply.match(/\[PAYMENT_CLAIM:(\{.*?\})\]/s);
  if (paymentClaimMatch) {
    try {
      const claimData = JSON.parse(paymentClaimMatch[1]);
      const claimId = await savePaymentClaim(platform, senderId, claimData, phoneNumberId);
      await notifyOwner(
        `Payment claim #${claimId ?? "?"} (${platform})\nCustomer: ${senderId}\nName: ${claimData.name || "-"}\nService: ${claimData.service || "-"}\nAmount claimed: ${claimData.amount || "-"}\n\nCheck your bank, then reply here:\nCONFIRM ${claimId ?? "ID"}\n(or CONFIRM ${senderId} 80000 to set the amount, this also works after a server restart)\nREJECT ${claimId ?? "ID"}`
      );
    } catch (err) {
      console.error("Failed to parse PAYMENT_CLAIM tag:", err);
    }
    cleanReply = cleanReply.replace(paymentClaimMatch[0], "").trim();
  }

  if (cleanReply.startsWith("[BOOK_CALL]")) {
    shouldBookCall = true;
    cleanReply = cleanReply.replace("[BOOK_CALL]", "").trim();

    if (platform !== "WhatsApp") {
      const formLink = `${BASE_URL}/book-session?platform=${platform}&sender=${senderId}`;
      cleanReply = `${cleanReply}\n\n${formLink}`;
    }

    const summary = await summarizeConversation(senderId);
    await notifyOwner(
      `Platform: ${platform}\nCustomer: ${senderId}\n\n${summary}\n\nThey're ready to move forward. Check the leads dashboard for full details.`
    );
  }

  return { cleanReply, shouldBookCall };
}

// ====== Booking form (Messenger/Instagram equivalent of WhatsApp's in-chat Flow) ======
app.get("/book-session", (req, res) => {
  const { platform, sender } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px;">
      <h2>Book a Consultation at Triple H Fertility Hub</h2>
      <p>Fill this quick form and our team will follow up to confirm your slot.</p>
      <form method="POST" action="/book-session">
        <input type="hidden" name="platform" value="${platform || ""}">
        <input type="hidden" name="sender" value="${sender || ""}">
        <label>Name<br><input type="text" name="name" style="width:100%; padding:8px;" required></label><br><br>
        <label>WhatsApp Number<br><input type="text" name="phone" style="width:100%; padding:8px;" placeholder="e.g. 2348012345678"></label><br><br>
        <label>Email (if no WhatsApp number)<br><input type="email" name="email" style="width:100%; padding:8px;"></label><br><br>
        <label>What do you need? (e.g. IVF, fertility assessment)<br><input type="text" name="service" style="width:100%; padding:8px;" required></label><br><br>
        <label>Preferred date and time (we are open Mon-Thu 9am-6pm, Sat 10am-4pm)<br><input type="text" name="datetime" style="width:100%; padding:8px;"></label><br><br>
        <label>Anything else to add?<br><textarea name="notes" rows="4" style="width:100%; padding:8px;"></textarea></label><br><br>
        <button type="submit" style="padding:10px 20px;">Submit</button>
      </form>
    </body></html>
  `);
});

app.post("/book-session", express.urlencoded({ extended: true }), async (req, res) => {
  const { platform, sender, name, phone, email, service, notes, datetime } = req.body;

  await saveLead(platform || "Web Form", sender || "unknown", {
    name,
    phone,
    email,
    service,
    notes: `${notes || ""}${datetime ? ` | Preferred: ${datetime}` : ""}`.trim(),
  });
  await notifyOwner(
    `Booking form submitted (${platform || "Web"})\nName: ${name}\nPhone: ${phone || "-"}\nEmail: ${email || "-"}\nService: ${service}\nPreferred: ${datetime || "-"}\nNotes: ${notes || "-"}`
  );

  const confirmMsg = "Thanks! We've got your details, our team will follow up shortly 🙏";
  if (platform === "Messenger") await sendMessengerMessage(sender, confirmMsg);
  else if (platform === "Instagram") await sendInstagramMessage(sender, confirmMsg);

  res.send(`<body style="font-family: sans-serif; text-align:center; margin-top:60px;"><h2>Thanks, ${String(name || "").replace(/</g, "&lt;")}! 🎉</h2><p>Our team will follow up with you shortly.</p></body>`);
});

// ====== Generate a payment receipt PDF (Triple H) ======
// Note: the standard PDF font cannot draw the naira symbol, so "NGN" is used in the PDF.
function generateReceiptPDF({ customerName, service, amount, date, receiptNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const brandColor = "#761010"; // Triple H Crimson
    const pageWidth = doc.page.width;
    const money = `NGN ${amount}`;

    // Header band
    doc.rect(0, 0, pageWidth, 130).fill(brandColor);
    doc.fillColor("#FFFFFF").fontSize(24).font("Helvetica-Bold").text("Triple H Fertility Hub", 50, 38);
    doc.fontSize(12).font("Helvetica").text("& Specialist Hospital", 50, 66);
    doc.fontSize(9).font("Helvetica").text("No. 5 Onitolo Street, Gbaja, Surulere, Lagos  |  08034043725  |  3hfertilityhub@gmail.com", 50, 88);
    doc.fontSize(20).font("Helvetica-Bold").text("RECEIPT", pageWidth - 200, 45, { width: 150, align: "right" });

    // Receipt meta
    let y = 160;
    doc.fillColor("#000000").fontSize(10).font("Helvetica");
    doc.text(`Receipt No:`, 50, y);
    doc.font("Helvetica-Bold").text(receiptNumber, 150, y);
    doc.font("Helvetica").text(`Date:`, 350, y);
    doc.font("Helvetica-Bold").text(date, 400, y);

    y += 40;
    doc.moveTo(50, y).lineTo(pageWidth - 50, y).strokeColor("#DDDDDD").stroke();
    y += 25;

    // Received from
    doc.fontSize(9).fillColor("#888888").font("Helvetica").text("RECEIVED FROM", 50, y);
    y += 15;
    doc.fontSize(13).fillColor("#000000").font("Helvetica-Bold").text(customerName || "Patient", 50, y);
    y += 35;

    // Table header
    doc.rect(50, y, pageWidth - 100, 28).fill("#F2F2F2");
    doc.fillColor("#555555").fontSize(9).font("Helvetica-Bold");
    doc.text("DESCRIPTION", 60, y + 9);
    doc.text("AMOUNT", pageWidth - 160, y + 9, { width: 100, align: "right" });
    y += 28;

    // Line item
    doc.rect(50, y, pageWidth - 100, 32).strokeColor("#EEEEEE").stroke();
    doc.fillColor("#000000").fontSize(11).font("Helvetica");
    doc.text(service || "Fertility Consultation / Clinical Service", 60, y + 10, { width: pageWidth - 260 });
    doc.font("Helvetica-Bold").text(money, pageWidth - 170, y + 10, { width: 110, align: "right" });
    y += 32;

    // Total band
    doc.rect(50, y, pageWidth - 100, 40).fill(brandColor);
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold");
    doc.text("TOTAL PAID", 60, y + 13);
    doc.fontSize(14).text(money, pageWidth - 170, y + 11, { width: 110, align: "right" });
    y += 70;

    // Paid stamp
    doc.save();
    doc.rotate(-15, { origin: [pageWidth - 150, y] });
    doc.fontSize(28).fillColor(brandColor).opacity(0.25).font("Helvetica-Bold");
    doc.text("PAID", pageWidth - 220, y - 15);
    doc.restore();
    doc.opacity(1);

    // Footer
    const footerY = doc.page.height - 100;
    doc.moveTo(50, footerY).lineTo(pageWidth - 50, footerY).strokeColor("#DDDDDD").stroke();
    doc.fillColor("#888888").fontSize(9).font("Helvetica");
    doc.text("Thank you for trusting Triple H Fertility Hub with your care!", 50, footerY + 15, { align: "center", width: pageWidth - 100 });
    doc.text("Triple H Fertility Hub  |  triplehfertilityhub.com  |  08034043725  |  3hfertilityhub@gmail.com", 50, footerY + 30, {
      align: "center",
      width: pageWidth - 100,
    });

    doc.end();
  });
}

// ====== Upload a file to WhatsApp so it can be sent as a document ======
async function uploadWhatsAppMedia(buffer, mimeType, filename, phoneNumberId = PHONE_NUMBER_ID) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("Media upload failed:", JSON.stringify(data));
    return null;
  }
  return data.id;
}

async function sendWhatsAppDocument(to, mediaId, filename, caption, phoneNumberId = PHONE_NUMBER_ID) {
  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Document send failed:", JSON.stringify(data));
  return response.ok;
}

// ====== Save a customer's payment claim as "pending" (in memory) ======
async function savePaymentClaim(platform, senderId, claimData, phoneNumberId = PHONE_NUMBER_ID) {
  const id = nextPaymentId++;
  payments.set(id, {
    id,
    platform,
    sender_id: senderId,
    phone: platform === "WhatsApp" ? senderId : claimData.phone || null,
    phone_number_id: phoneNumberId,
    customer_name: claimData.name || null,
    service: claimData.service || null,
    amount: claimData.amount || null,
    notes: claimData.notes || null,
    status: "pending",
    receipt_number: null,
    created_at: new Date().toISOString(),
  });
  persistPayment(payments.get(id));
  return id;
}

// ====== This customer's most recent payment claim, for context ======
async function getPaymentStatus(senderId) {
  let latest = null;
  for (const p of payments.values()) {
    if (String(p.sender_id) === String(senderId) && (!latest || p.id > latest.id)) latest = p;
  }
  return latest;
}

// ====== Pending payments admin page ======
app.get("/pending-payments", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  const pending = [...payments.values()].filter((p) => p.status === "pending").sort((a, b) => b.id - a.id);
  const rows = pending
    .map(
      (p) => `<tr>
        <td>#${p.id}</td>
        <td>${p.customer_name || "-"}</td>
        <td>${p.phone || p.sender_id}</td>
        <td>${p.service || "-"}</td>
        <td>₦${p.amount || "-"}</td>
        <td>${p.notes || "-"}</td>
        <td><a href="/confirm-payment?id=${p.id}&secret=${req.query.secret}" style="background:#761010;color:white;padding:6px 12px;text-decoration:none;border-radius:4px;">Confirm & Send Receipt</a></td>
      </tr>`
    )
    .join("");
  res.send(`
    <html><body style="font-family: sans-serif;">
      <h2>Pending Payments (${pending.length})</h2>
      <p style="color:#666;">You can also confirm on WhatsApp: reply CONFIRM &lt;id&gt; from an owner number.</p>
      <table border="1" cellpadding="8" style="border-collapse: collapse;">
        <tr><th>ID</th><th>Name</th><th>Contact</th><th>Service</th><th>Amount</th><th>Notes</th><th>Action</th></tr>
        ${rows}
      </table>
    </body></html>
  `);
});

// ====== The receipt generation + send logic ======
function formatAmount(raw) {
  const digits = String(raw ?? "").replace(/[^\d.]/g, "");
  const n = Number(digits);
  return digits && Number.isFinite(n) && n > 0 ? n.toLocaleString("en-NG") : null;
}

async function processPaymentConfirmation(payment) {
  const receiptNumber = `THH-${Date.now().toString().slice(-8)}`;
  const date = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" });
  const claimPhoneNumberId = payment.phone_number_id || PHONE_NUMBER_ID;

  const pdfBuffer = await generateReceiptPDF({
    customerName: payment.customer_name || "Patient",
    service: payment.service || "Fertility Consultation / Clinical Service",
    amount: formatAmount(payment.amount) || "0",
    date,
    receiptNumber,
  });
  const mediaId = await uploadWhatsAppMedia(pdfBuffer, "application/pdf", `Receipt-${receiptNumber}.pdf`, claimPhoneNumberId);

  let sent = false;
  if (mediaId && payment.platform === "WhatsApp") {
    sent = await sendWhatsAppDocument(
      payment.phone || payment.sender_id,
      mediaId,
      `Receipt-${receiptNumber}.pdf`,
      `Your payment has been confirmed! Here's your receipt, ${payment.customer_name || ""}. Thank you 🙏`,
      claimPhoneNumberId
    );
  }

  if (sent) {
    payment.status = "confirmed";
    payment.receipt_number = receiptNumber;
  } else {
    payment.status = "send_failed";
    payment.notes = `${payment.notes || ""} [Receipt generation/send failed, retry manually]`.trim();
  }
  persistPayment(payment);

  return { sent, receiptNumber };
}

// ====== Manual admin page: one-click confirm ======
app.get("/confirm-payment", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) return res.send("Wrong password.");
  const payment = payments.get(Number(req.query.id));
  if (!payment) return res.send("Payment claim not found (the server may have restarted). Confirm on WhatsApp with: CONFIRM <phone> <amount>");
  if (payment.status === "confirmed") {
    return res.send(`Already confirmed (receipt ${payment.receipt_number}). <br><a href="/pending-payments?secret=${req.query.secret}">Back</a>`);
  }
  if (!formatAmount(payment.amount)) {
    return res.send(`This claim has no usable amount. Confirm on WhatsApp with: CONFIRM ${payment.id} <amount>`);
  }
  try {
    const { sent, receiptNumber } = await processPaymentConfirmation(payment);
    res.send(
      sent
        ? `Confirmed. Receipt ${receiptNumber} sent to the patient. <br><a href="/pending-payments?secret=${req.query.secret}">Back to pending payments</a>`
        : `The receipt failed to send. Check Render logs. <br><a href="/pending-payments?secret=${req.query.secret}">Back</a>`
    );
  } catch (err) {
    console.error("Confirm payment failed:", err);
    res.send("Something went wrong confirming this payment. Check Render logs.");
  }
});

// ====== OWNER COMMANDS ON WHATSAPP ======
// An owner number messages the bot:
//   CONFIRM 12            -> confirms claim #12 and sends the receipt to the patient
//   CONFIRM 12 80000      -> same, but sets the exact amount first
//   CONFIRM 2348012345678 -> confirms that patient's latest pending claim
//   REJECT 12             -> marks claim #12 as rejected (nothing sent to patient)
//   PENDING               -> lists pending claims
// Only numbers in ACTIVE_OWNER_NUMBERS can use these. Returns true if the message was a command.
function findPendingPayment(ref) {
  const digits = String(ref).replace(/\D/g, "");
  if (digits.length >= 10) {
    let latest = null;
    for (const p of payments.values()) {
      if ((String(p.sender_id) === digits || String(p.phone) === digits) && (!latest || p.id > latest.id)) latest = p;
    }
    return latest;
  }
  return payments.get(Number(digits)) || null;
}

async function handleOwnerCommand(from, text, phoneNumberId) {
  if (!ACTIVE_OWNER_NUMBERS.includes(from)) return false;
  const match = String(text || "").trim().match(/^(confirm|reject|pending)\b\s*(.*)$/i);
  if (!match) return false;

  const command = match[1].toLowerCase();
  const args = match[2].trim().split(/\s+/).filter(Boolean);
  const reply = (msg) => sendWhatsAppMessage(from, msg, phoneNumberId);

  try {
    if (command === "pending") {
      const rows = [...payments.values()].filter((p) => p.status === "pending").sort((a, b) => b.id - a.id).slice(0, 15);
      if (rows.length === 0) {
        await reply("No pending payment claims right now.");
      } else {
        const lines = rows.map((p) => `#${p.id} ${p.customer_name || "-"} | ${p.phone || p.sender_id} | ${p.service || "-"} | ${p.amount || "no amount"}`);
        await reply(`Pending claims:\n${lines.join("\n")}\n\nReply CONFIRM <id> or REJECT <id>.`);
      }
      return true;
    }

    if (args.length === 0) {
      await reply(`Please include the claim number, for example: ${command.toUpperCase()} 12`);
      return true;
    }

    let payment = findPendingPayment(args[0]);
    const refDigits = String(args[0]).replace(/\D/g, "");

    // After a server restart claims are forgotten. CONFIRM <phone> <amount> still works.
    if (!payment && command === "confirm" && refDigits.length >= 10 && args[1]) {
      const id = nextPaymentId++;
      payment = {
        id,
        platform: "WhatsApp",
        sender_id: refDigits,
        phone: refDigits,
        phone_number_id: phoneNumberId,
        customer_name: profiles.get(refDigits)?.name || "Patient",
        service: "Consultation / Registration",
        amount: null,
        notes: "Confirmed directly by owner",
        status: "pending",
        receipt_number: null,
        created_at: new Date().toISOString(),
      };
      persistPayment(payment);
    }

    if (!payment) {
      await reply(`I could not find a payment claim for "${args[0]}". Send PENDING to see open claims, or use CONFIRM <phone> <amount>.`);
      return true;
    }
    if (payment.status === "confirmed") {
      await reply(`Claim #${payment.id} was already confirmed (receipt ${payment.receipt_number}).`);
      return true;
    }
    if (payment.status === "rejected") {
      await reply(`Claim #${payment.id} was already rejected.`);
      return true;
    }

    if (command === "reject") {
      payment.status = "rejected";
      persistPayment(payment);
      await reply(`Claim #${payment.id} (${payment.customer_name || payment.phone || payment.sender_id}) marked as rejected. Nothing was sent to the patient.`);
      return true;
    }

    if (args[1]) payment.amount = args[1];
    if (!formatAmount(payment.amount)) {
      await reply(`Claim #${payment.id} has no usable amount ("${payment.amount || ""}"). Reply with the amount, for example: CONFIRM ${payment.id} 80000`);
      return true;
    }
    if (payment.platform !== "WhatsApp") {
      await reply(`Claim #${payment.id} came from ${payment.platform}, so the receipt cannot be sent automatically. Please send it manually.`);
      return true;
    }

    await reply(`Confirming claim #${payment.id} for NGN ${formatAmount(payment.amount)}. Generating the receipt now...`);
    const { sent, receiptNumber } = await processPaymentConfirmation(payment);
    await reply(
      sent
        ? `Done. Receipt ${receiptNumber} sent to ${payment.customer_name || payment.phone || payment.sender_id}.`
        : `The receipt could not be sent (the patient may be outside the 24-hour window, or a technical error occurred). Check the Render logs. Claim #${payment.id} is marked send_failed.`
    );
    return true;
  } catch (err) {
    console.error("Owner command failed:", err);
    await reply("Something went wrong processing that command. Check the Render logs.");
    return true;
  }
}

// ====== Inbox: see active conversations and reply directly, no template needed ======
app.get("/inbox", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  const conversations = [...conversationCache.entries()]
    .filter(([, c]) => c.platform === "WhatsApp")
    .sort((a, b) => b[1].lastMessageTime - a[1].lastMessageTime)
    .slice(0, 50);

  const rows = conversations
    .map(([id, c]) => {
      const lastMsg = (c.history?.[c.history.length - 1]?.parts?.[0]?.text || "(no messages)").replace(/</g, "&lt;");
      const hoursAgo = Math.round((Date.now() - c.lastMessageTime) / 3600000);
      const windowOpen = hoursAgo < 24;
      const isPaused = c.humanPausedUntil && c.humanPausedUntil > Date.now();
      return `<tr>
        <td>${isPaused ? "🟡" : "🟢"} ${id}</td>
        <td style="max-width:400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${lastMsg}</td>
        <td>${hoursAgo}h ago</td>
        <td style="color:${windowOpen ? "green" : "#999"};">${windowOpen ? "Open ✓" : "Closed (needs template)"}</td>
        <td><a href="/inbox/chat?sender=${encodeURIComponent(id)}&secret=${req.query.secret}">Open chat</a></td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html><body style="font-family: sans-serif;">
      <h2>Inbox (${conversations.length})</h2>
      <p style="color:#666;">🟢 Nurse Hope active &nbsp;&nbsp; 🟡 You're handling this one</p>
      <table border="1" cellpadding="8" style="border-collapse: collapse;">
        <tr><th>Number</th><th>Last message</th><th>When</th><th>Reply window</th><th></th></tr>
        ${rows}
      </table>
    </body></html>
  `);
});

app.get("/inbox/chat", async (req, res) => {
  const { sender, secret } = req.query;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  const convo = conversationCache.get(sender);
  if (!convo) return res.send("Conversation not found (the server may have restarted).");

  const hoursAgo = Math.round((Date.now() - convo.lastMessageTime) / 3600000);
  const windowOpen = hoursAgo < 24;
  const isPaused = convo.humanPausedUntil && convo.humanPausedUntil > Date.now();
  const pauseMinutesLeft = isPaused ? Math.round((convo.humanPausedUntil - Date.now()) / 60000) : 0;

  const bubbles = (convo.history || [])
    .map((turn) => {
      const text = turn.parts?.[0]?.text || "";
      const isCustomer = turn.role === "user";
      return `<div style="display:flex; justify-content:${isCustomer ? "flex-start" : "flex-end"}; margin:8px 0;">
        <div style="max-width:70%; padding:10px 14px; border-radius:12px; background:${isCustomer ? "#f0f0f0" : "#761010"}; color:${isCustomer ? "#000" : "#fff"};">
          ${text.replace(/</g, "&lt;")}
        </div>
      </div>`;
    })
    .join("");

  res.send(`
    <html><body style="font-family: sans-serif; max-width: 600px; margin: 20px auto;">
      <a href="/inbox?secret=${secret}">&larr; Back to inbox</a>
      <h3>${sender}</h3>
      ${
        isPaused
          ? `<div style="background:#fff3cd; padding:10px; border-radius:6px; margin-bottom:10px;">
              🟡 AI paused. You're handling this chat (resumes automatically in ~${pauseMinutesLeft} min)
              <form method="POST" action="/inbox/resume" style="display:inline;">
                <input type="hidden" name="secret" value="${secret}">
                <input type="hidden" name="sender" value="${sender}">
                <button type="submit" style="margin-left:10px;">Resume AI now</button>
              </form>
            </div>`
          : `<div style="background:#d1e7dd; padding:10px; border-radius:6px; margin-bottom:10px;">🟢 Nurse Hope is active on this chat</div>`
      }
      <div style="border:1px solid #ddd; border-radius:8px; padding:16px; max-height:500px; overflow-y:auto;">
        ${bubbles || "<p>No messages yet.</p>"}
      </div>
      ${
        windowOpen
          ? `<form method="POST" action="/inbox/reply" style="margin-top:16px;">
              <input type="hidden" name="secret" value="${secret}">
              <input type="hidden" name="sender" value="${sender}">
              <textarea name="message" rows="3" style="width:100%; padding:8px;" placeholder="Type your reply... (this pauses Nurse Hope on this chat)" required></textarea>
              <button type="submit" style="margin-top:8px; padding:10px 20px;">Send</button>
            </form>`
          : `<p style="color:#999; margin-top:16px;">Reply window closed (24h+ since their last message). Use <a href="/send-message">Send Message</a> with an approved template instead.</p>`
      }
    </body></html>
  `);
});

app.post("/inbox/reply", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, sender, message } = req.body;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  console.log(`[INBOX REPLY] Attempting manual reply to ${sender}: ${message}`);
  const HUMAN_PAUSE_MS = 2 * 60 * 60 * 1000;

  try {
    const convo = await getConversation(sender);
    const phoneNumberId = convo.phoneNumberId || PHONE_NUMBER_ID;
    const sent = await sendWhatsAppMessage(sender, message, phoneNumberId);

    convo.history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED - attempted]: ${message}` }] });
    convo.lastMessageTime = Date.now();
    convo.platform = "WhatsApp";
    convo.phoneNumberId = phoneNumberId;
    convo.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS;
    await saveConversation(sender, convo);

    if (!sent) {
      return res.send(
        `⚠️ The message may not have delivered (check Render logs), but Nurse Hope is paused on this chat regardless. <br><a href="/inbox/chat?sender=${encodeURIComponent(sender)}&secret=${secret}">Back to chat</a>`
      );
    }
    res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}&secret=${secret}`);
  } catch (err) {
    console.error("Inbox reply failed:", err);
    res.send("Something went wrong sending your reply. Check Render logs.");
  }
});

app.post("/inbox/resume", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, sender } = req.body;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  const convo = conversationCache.get(sender);
  if (convo) {
    convo.humanPausedUntil = null;
    convo.lastMessageTime = Date.now();
    await saveConversation(sender, convo);
  }
  res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}&secret=${secret}`);
});

app.get("/leads", async (req, res) => {
  if (req.query.secret !== CRM_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  const rows = recentLeads
    .map(
      (l) =>
        `<tr><td>${l.created_at?.slice(0, 16)}</td><td>${l.platform}</td><td>${l.name || ""}</td><td>${l.phone || ""}</td><td>${l.email || ""}</td><td>${l.service_interest || ""}</td><td>${l.notes || ""}</td></tr>`
    )
    .join("");
  res.send(`
    <html><body style="font-family: sans-serif;">
      <h2>Recent leads (${recentLeads.length})</h2>
      <p style="color:#666;">Since the last server restart. The Google Sheet is the permanent record.</p>
      <table border="1" cellpadding="8" style="border-collapse: collapse;">
        <tr><th>Date</th><th>Platform</th><th>Name</th><th>Phone</th><th>Email</th><th>Service</th><th>Notes</th></tr>
        ${rows}
      </table>
    </body></html>
  `);
});

// ====== JSON API: send a free-text reply from your Lovable chat UI, pauses Nurse Hope on that chat ======
app.post("/api/inbox-reply", async (req, res) => {
  const { secret, sender, message } = req.body;

  if (secret !== BROADCAST_SECRET) return res.status(401).json({ error: "Wrong password" });
  if (!sender || !message) return res.status(400).json({ error: "Missing sender or message" });

  console.log(`[INBOX REPLY - API] Attempting manual reply to ${sender}: ${message}`);
  const HUMAN_PAUSE_MS = 2 * 60 * 60 * 1000;

  try {
    const convo = await getConversation(sender);
    const phoneNumberId = convo.phoneNumberId || PHONE_NUMBER_ID;
    const sent = await sendWhatsAppMessage(sender, message, phoneNumberId);

    convo.history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED - attempted]: ${message}` }] });
    convo.lastMessageTime = Date.now();
    convo.platform = "WhatsApp";
    convo.phoneNumberId = phoneNumberId;
    convo.humanPausedUntil = Date.now() + HUMAN_PAUSE_MS;
    await saveConversation(sender, convo);

    res.json({ success: sent, paused: true });
  } catch (err) {
    console.error("API inbox reply failed:", err);
    res.status(500).json({ error: "Something went wrong, check Render logs" });
  }
});

// ====== JSON API: resume Nurse Hope on a paused conversation ======
app.post("/api/inbox-resume", async (req, res) => {
  const { secret, sender } = req.body;

  if (secret !== BROADCAST_SECRET) return res.status(401).json({ error: "Wrong password" });
  if (!sender) return res.status(400).json({ error: "Missing sender" });

  const convo = conversationCache.get(sender);
  if (convo) {
    convo.humanPausedUntil = null;
    convo.lastMessageTime = Date.now();
    await saveConversation(sender, convo);
  }
  res.json({ success: true });
});

app.post("/api/send-message", async (req, res) => {
  const { secret, number, template, message } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.status(401).json({ error: "Wrong password" });
  }
  if (!number || !template) {
    return res.status(400).json({ error: "Missing number or template" });
  }

  const success = await sendWhatsAppTemplate(number.trim(), template, message ? [message] : [], TEMPLATE_HEADER_IMAGE || null);
  res.json({ success });
});

app.post("/api/broadcast", async (req, res) => {
  const { secret, template, message, numbers } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.status(401).json({ error: "Wrong password" });
  }
  if (!template || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "Missing template or numbers list" });
  }

  const results = [];
  for (const number of numbers) {
    const cleanNumber = number.trim();
    let personalizedMessage = message || "";
    if (personalizedMessage.includes("{{name}}")) {
      const knownName = await getKnownName(cleanNumber);
      personalizedMessage = personalizedMessage.replace(/\{\{name\}\}/gi, knownName || "there");
    }
    const bodyParams = personalizedMessage ? [personalizedMessage] : [];
    const success = await sendWhatsAppTemplate(cleanNumber, template, bodyParams, TEMPLATE_HEADER_IMAGE || null);
    results.push({ number: cleanNumber, success });
  }

  res.json({ sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results });
});

// ====== Send a single message to one specific customer (not a broadcast) ======
app.get("/send-message", (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 500px; margin: 40px auto;">
      <h2>Send a Message</h2>
      <p style="color:#666;">For someone outside the 24-hour reply window, this uses an approved template (like broadcast).</p>
      <form method="POST" action="/send-message">
        <label>Password<br><input type="password" name="secret" style="width:100%; padding:8px;" required></label><br><br>
        <label>Their WhatsApp number<br><input type="text" name="number" style="width:100%; padding:8px;" required placeholder="2348143594483"></label><br><br>
        <label>Template name<br><input type="text" name="template" style="width:100%; padding:8px;" required placeholder="weekly_update"></label><br><br>
        <label>Your message<br>
          <textarea name="message" rows="4" style="width:100%; padding:8px;" placeholder="Whatever you want to say to them..."></textarea>
        </label><br><br>
        <button type="submit" style="padding:10px 20px;">Send</button>
      </form>
    </body></html>
  `);
});

app.post("/send-message", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, number, template, message } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.send("Wrong password.");
  }

  const success = await sendWhatsAppTemplate(number.trim(), template, message ? [message] : [], TEMPLATE_HEADER_IMAGE || null);

  res.send(
    success
      ? `Sent to ${number}. <br><a href="/send-message">Send another</a>`
      : `Failed. Check Render logs for the exact error. <br><a href="/send-message">Try again</a>`
  );
});

app.get("/broadcast-panel", (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 500px; margin: 40px auto;">
      <h2>Send Broadcast</h2>
      <form method="POST" action="/broadcast">
        <label>Password<br><input type="password" name="secret" style="width:100%; padding:8px;" required></label><br><br>
        <label>Template name (e.g. weekly_update)<br><input type="text" name="template" style="width:100%; padding:8px;" required></label><br><br>
        <label>Your message this week (type {{name}} anywhere to personalize per recipient)<br>
          <textarea name="message" rows="4" style="width:100%; padding:8px;" placeholder="Hi {{name}}, exciting news this week..."></textarea>
        </label><br><br>
        <label>Phone numbers (one per line, international format, no + or spaces)<br>
          <textarea name="numbers" rows="8" style="width:100%; padding:8px;" required placeholder="2348143594483&#10;2348140458307"></textarea>
        </label><br><br>
        <button type="submit" style="padding:10px 20px;">Send Broadcast</button>
      </form>
    </body></html>
  `);
});

app.post("/broadcast", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, template, message, numbers } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.send("Wrong password.");
  }

  const numberList = numbers.split("\n").map((n) => n.trim()).filter(Boolean);
  const results = [];

  for (const number of numberList) {
    let personalizedMessage = message || "";
    if (personalizedMessage.includes("{{name}}")) {
      const knownName = await getKnownName(number);
      personalizedMessage = personalizedMessage.replace(/\{\{name\}\}/gi, knownName || "there");
    }
    const bodyParams = personalizedMessage ? [personalizedMessage] : [];
    const success = await sendWhatsAppTemplate(number, template, bodyParams, TEMPLATE_HEADER_IMAGE || null);
    results.push(`${number}: ${success ? "sent" : "FAILED"}`);
  }

  res.send(`<pre>${results.join("\n")}</pre><br><a href="/broadcast-panel">Send another</a>`);
});

// Template parameters can't contain line breaks, tabs, or 4+ consecutive spaces.
function sanitizeTemplateParam(text) {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

async function sendWhatsAppTemplate(to, templateName, bodyParams = [], headerImageUrl = null) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const template = { name: templateName, language: { code: "en" } };
  const components = [];

  if (headerImageUrl) {
    components.push({ type: "header", parameters: [{ type: "image", image: { link: headerImageUrl } }] });
  }
  if (bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((p) => ({ type: "text", text: sanitizeTemplateParam(p) })),
    });
  }
  if (components.length) template.components = components;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });
  const data = await response.json();
  if (!response.ok) console.error(`Template "${templateName}" send to ${to} failed:`, JSON.stringify(data));
  return response.ok;
}

// ====== Alert the owners via WhatsApp when a human needs to step in ======
// Requires a template named "lead_alert" with one body variable.
async function notifyOwner(summary) {
  for (const ownerNumber of ACTIVE_OWNER_NUMBERS) {
    const sent = await sendWhatsAppMessage(ownerNumber, `🔔 Human needed:\n\n${summary}`);
    if (!sent) {
      console.log(`Instant alert to ${ownerNumber} failed, falling back to template...`);
      await sendWhatsAppTemplate(ownerNumber, "lead_alert", [summary.slice(0, 1000)], TEMPLATE_HEADER_IMAGE || null);
    }
  }
}

// ====== Send the interactive booking Flow (form) to a customer ======
async function sendQuoteFlow(to, phoneNumberId = PHONE_NUMBER_ID) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "Book a Consultation" },
        body: { text: "Fill this quick form and our team will contact you to confirm your appointment." },
        footer: { text: "Triple H Fertility Hub" },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: QUOTE_FLOW_ID,
            flow_cta: "Fill Form",
            flow_action: "navigate",
            flow_action_payload: { screen: "QUOTE_FORM" },
          },
        },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Failed to send Flow:", JSON.stringify(data));
}

// ====== 1. Webhook verification ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ====== 2. Receiving incoming messages (WhatsApp, Messenger, or Instagram) ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  await stateReady; // make sure saved chats and profiles are loaded first

  try {
    const platform = req.body.object;

    if (platform === "whatsapp_business_account") {
      await handleWhatsApp(req.body);
    } else if (platform === "page") {
      await handleMessenger(req.body);
    } else if (platform === "instagram") {
      await handleInstagram(req.body);
    }
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

// ====== END OF CHAT: 5 minutes of silence -> ONE clean log + owner alert ======
// This is the only place the Google Sheet row is written (name, service, mode, date, time, notes),
// and where the template summary goes to both owners.
function startInactivitySummaryTimer(senderId) {
  if (conversationTimers.has(senderId)) clearTimeout(conversationTimers.get(senderId));

  const timer = setTimeout(async () => {
    conversationTimers.delete(senderId);
    try {
      console.log(`Patient ${senderId} inactive for 5 minutes. Generating summary...`);
      const convo = await getConversation(senderId);
      const history = convo?.history || [];
      if (history.length < 2) return;

      const transcript = history
        .map((m) => `${m.role === "model" ? "Nurse Hope" : "Patient"}: ${(m.parts || []).map((p) => p.text || "").join(" ")}`)
        .join("\n")
        .slice(-12000);

      const instruction =
        "You are summarizing a fertility clinic chat for clinic managers. Return ONLY a valid JSON object with exactly these keys: " +
        '{"name": "patient\'s name or Prospective Patient", "service": "primary topic or service discussed", ' +
        '"mode": "In-Person or Telemedicine or empty", "date": "preferred appointment date as YYYY-MM-DD or empty", ' +
        '"time": "preferred appointment time or empty", ' +
        '"status": "Inquiry / Asked Fees / Wants Appointment / Booked", ' +
        '"notes": "2-sentence plain-text summary of what was discussed and what follow-up is needed"}\n\nConversation:\n' + transcript;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instruction }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });
      const data = await response.json();
      let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      raw = raw.replace(/```json|```/g, "").trim();
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { parsed = { notes: raw.slice(0, 300) }; }

      // Merge: details the AI saved during the chat (draft) win over the summary guess
      const draft = leadDrafts.get(senderId) || {};
      const final = {
        name: draft.name || parsed.name,
        phone: senderId,
        email: draft.email || "",
        service: draft.service || parsed.service,
        mode: draft.mode || parsed.mode || "",
        date: draft.date || parsed.date || "",
        time: draft.time || parsed.time || "",
        status: parsed.status,
        notes: [draft.notes, parsed.notes].filter(Boolean).join(" | "),
      };

      const when = [final.date, final.time].filter(Boolean).join(" ");
      const ownerNotes = `${final.notes}${when ? ` Preferred slot: ${when}${final.mode ? " (" + final.mode + ")" : ""}.` : ""}`;

      // 1. Template alert to both owners on WhatsApp
      await sendPatientSummaryToOwners({
        name: final.name,
        phone: senderId,
        service: final.service,
        status: final.status,
        notes: ownerNotes,
      });

      // 2. One clean row in Google Sheet (+ email alert via Apps Script) and the in-memory leads list
      await saveLead("WhatsApp", senderId, final);

      leadDrafts.delete(senderId); // so the same chat is not logged twice
    } catch (err) {
      console.error("Error in inactivity summary task:", err);
    }
  }, 5 * 60 * 1000);

  conversationTimers.set(senderId, timer);
}

// ====== Download an image/audio file WhatsApp sent us ======
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const metaData = await metaRes.json();

  const fileRes = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");

  return { base64Data, mimeType: metaData.mime_type };
}

// ---- WhatsApp ----
// Wait a few seconds after each message; if more arrive in that window they are combined.
const messageBuffers = new Map();
const DEBOUNCE_MS = 6000;

function bufferAndDebounce(senderId, text, media, onReady) {
  let buf = messageBuffers.get(senderId);
  if (!buf) {
    buf = { texts: [], media: null };
    messageBuffers.set(senderId, buf);
  }
  if (text) buf.texts.push(text);
  if (media) buf.media = media;

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const combinedText = buf.texts.join("\n");
    const combinedMedia = buf.media;
    messageBuffers.delete(senderId);
    Promise.resolve(onReady(combinedText, combinedMedia)).catch((err) => console.error("Reply handler error:", err));
  }, DEBOUNCE_MS);
}

async function handleWhatsApp(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const receivingPhoneNumberId = change?.value?.metadata?.phone_number_id || PHONE_NUMBER_ID;

  const from = message.from;
  // WhatsApp tells us the person's profile name on every message: remember it for personalization
  const waName = change?.value?.contacts?.[0]?.profile?.name;
  setProfile(from, waName ? { waName } : {});
  if (BLOCKED_NUMBERS.includes(from)) {
    console.log(`Ignored WhatsApp message from blocked number ${from}`);
    return;
  }

  let text = message.text?.body;
  let media = null;

  // Capture a submitted Flow (form) response
  if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
    const formData = JSON.parse(message.interactive.nfm_reply.response_json);
    console.log(`Form submitted by ${from}:`, JSON.stringify(formData));
    await saveLead("WhatsApp", from, {
      name: formData.name,
      phone: formData.phone || from,
      service: formData.service,
      notes: formData.details,
    });
    await notifyOwner(
      `Form submitted on WhatsApp\nName: ${formData.name}\nPhone: ${formData.phone || from}\nService: ${formData.service}\nDetails: ${formData.details || "-"}`
    );
    await sendWhatsAppMessage(from, "Thanks! We've got your details, our team will follow up shortly to confirm your appointment 🙏", receivingPhoneNumberId);
    return;
  }

  if (message.type === "image") {
    media = await downloadWhatsAppMedia(message.image.id);
    text = message.image.caption || "[Customer sent an image. Look at it and respond helpfully.]";
  } else if (message.type === "audio") {
    media = await downloadWhatsAppMedia(message.audio.id);
    text = "[Customer sent a voice note. Listen to it and respond helpfully.]";
  }

  if (!text && !media) return;

  // Owner commands (CONFIRM / REJECT / PENDING) are handled here and never go to the AI
  if (text && (await handleOwnerCommand(from, text, receivingPhoneNumberId))) return;

  if (text) messageStore.set(message.id, { text, time: Date.now() });

  if (message.context?.id) {
    const quoted = messageStore.get(message.context.id);
    if (quoted) {
      text = `[The customer is replying directly to this earlier message: "${quoted.text}"]\n${text}`;
    }
  }

  console.log(`WhatsApp message from ${from} (to number ${receivingPhoneNumberId}): ${text}`);
  startInactivitySummaryTimer(from);
  await markAsReadAndTyping(message.id, receivingPhoneNumberId);

  const convo = await getConversation(from);
  if (convo.humanPausedUntil && convo.humanPausedUntil > Date.now()) {
    console.log(`AI paused on ${from} (human handling), recording message only`);
    convo.history.push({ role: "user", parts: [{ text }] });
    convo.lastMessageTime = Date.now();
    convo.platform = "WhatsApp";
    convo.phoneNumberId = receivingPhoneNumberId;
    await saveConversation(from, convo);
    return;
  }

  bufferAndDebounce(from, text, media, async (combinedText, combinedMedia) => {
    try {
      const aiReply = await askGemini(from, combinedText, "WhatsApp", combinedMedia, receivingPhoneNumberId);
      const { cleanReply, shouldBookCall } = await processAIReply(aiReply, "WhatsApp", from, combinedText, receivingPhoneNumberId);
      await sendWhatsAppMessage(from, cleanReply, receivingPhoneNumberId);
      if (shouldBookCall) await sendQuoteFlow(from, receivingPhoneNumberId);
    } catch (err) {
      console.error(`WhatsApp reply failed for ${from}:`, err);
    }
  });
}

// ====== Download an image/audio file Messenger or Instagram sent us ======
async function downloadMetaMedia(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  return { base64Data, mimeType };
}

// ---- Facebook Messenger ----
async function handleMessenger(body) {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  if (!senderId) return;

  if (messaging?.message?.is_echo) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note. Listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image. Look at it and respond helpfully.]";
  }

  if (!text && !media) return;

  console.log(`Messenger message from ${senderId}: ${text}`);
  bufferAndDebounce(senderId, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(senderId, combinedText, "Messenger", combinedMedia);
    const { cleanReply } = await processAIReply(aiReply, "Messenger", senderId, combinedText);
    await sendMessengerMessage(senderId, cleanReply);
  });
}

async function sendMessengerMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Messenger send failed:", JSON.stringify(data));
}

// ---- Instagram ----
async function handleInstagram(body) {
  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];
  const senderId = messaging?.sender?.id;
  if (!senderId) return;

  if (messaging?.message?.is_echo) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note. Listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image. Look at it and respond helpfully.]";
  }

  if (!text && !media) return;

  console.log(`Instagram message from ${senderId}: ${text}`);
  bufferAndDebounce(senderId, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(senderId, combinedText, "Instagram", combinedMedia);
    const { cleanReply } = await processAIReply(aiReply, "Instagram", senderId, combinedText);
    await sendInstagramMessage(senderId, cleanReply);
  });
}

async function sendInstagramMessage(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/${IG_ACCOUNT_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error("Instagram send failed:", JSON.stringify(data));
}

// ====== 3. Ask Gemini for a reply, using this customer's conversation history ======
async function askGemini(senderId, userMessage, platform, media = null, phoneNumberId = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const convo = await getConversation(senderId);

  const profile = profiles.get(String(senderId)) || {};
  let knownNameNote = "";
  if (profile.name) {
    const lastVisit = profile.lastSeen
      ? new Date(profile.lastSeen).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric" })
      : "";
    const details = [profile.service ? `last interest: ${profile.service}` : "", profile.mode ? `preferred mode: ${profile.mode}` : ""]
      .filter(Boolean)
      .join(", ");
    knownNameNote = `\n\nKNOWN PATIENT: Their name is ${profile.name}${details ? " (" + details + ")" : ""}. Never ask for their name again. Use their first name naturally now and then. Do not volunteer sensitive medical details unprompted; refer to their earlier interest only in general, gentle terms.`;
    if (convo.history.length === 0) {
      knownNameNote += ` This is a new session but they have spoken with us before${lastVisit ? " (last on " + lastVisit + ")" : ""}. Greet them warmly by name, e.g. "Hello ${profile.name}, welcome back! 👋", instead of your full first-time introduction.`;
    }
  } else if (profile.waName) {
    knownNameNote = `\n\nWHATSAPP DISPLAY NAME: ${profile.waName}. This is their WhatsApp profile name and may be a nickname or business name. You may greet them with it, but confirm how they would like to be addressed if it looks like a nickname.`;
  }

  let paymentStatusNote = "";
  const paymentStatus = await getPaymentStatus(senderId);
  if (paymentStatus) {
    if (paymentStatus.status === "pending") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer has a PENDING payment claim (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) awaiting confirmation. If they ask about it, reassure them it's being checked and they'll get their receipt automatically once confirmed. Don't create a new [PAYMENT_CLAIM] tag for this same one.`;
    } else if (paymentStatus.status === "confirmed") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer's most recent payment (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) is CONFIRMED, receipt ${paymentStatus.receipt_number} was already sent. If they ask, let them know it's confirmed and their receipt was sent. Don't create a new claim.`;
    } else if (paymentStatus.status === "send_failed") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer's payment was confirmed by the team, but the receipt failed to send due to a technical issue on our end, NOT their fault. If they ask, apologize briefly and say the team is resolving it and will get the receipt to them shortly. Do NOT claim a receipt was already sent.`;
    }
  }

  // Full calendar date + real upcoming open dates (replaces the old weekday-only time string)
  const calendarContext = getLagosCalendarContext();

  const fullContext = `${BUSINESS_CONTEXT}\n\n${calendarContext}\n\nCURRENT PLATFORM: ${platform}\n\nUse the current time to greet appropriately (good morning/afternoon/evening/night) and never say something time-inappropriate like "have a great day" in the evening.${knownNameNote}${paymentStatusNote}\n\nLIVE WEBSITE CONTENT (most current info, prefer this over anything above if they conflict, EXCEPT: never mention doctor names, and never offer Fridays or Sundays):\n${cachedWebsiteContent}`;

  const currentParts = [{ text: userMessage }];
  if (media) {
    currentParts.push({ inlineData: { mimeType: media.mimeType, data: media.base64Data } });
  }

  // Only the last 40 turns go to Gemini (long chats get slow and costly). Must start with a user turn.
  const recentHistory = convo.history.slice(-40);
  while (recentHistory.length && recentHistory[0].role !== "user") recentHistory.shift();
  const contents = [
    ...recentHistory,
    { role: "user", parts: currentParts },
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: fullContext }] },
      contents,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error("Gemini API error:", JSON.stringify(data.error || data));
    return "Sorry, I'm having trouble responding right now. A team member will follow up shortly.";
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finalReply = reply || "Sorry, I'm having trouble responding right now. A team member will follow up shortly.";

  convo.history.push({ role: "user", parts: [{ text: userMessage }] });
  convo.history.push({ role: "model", parts: [{ text: finalReply }] });
  convo.lastMessageTime = Date.now();
  convo.platform = platform;
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;
  await saveConversation(senderId, convo);

  return finalReply;
}

// ====== 3.5 Show blue ticks + typing indicator while we prepare a reply ======
async function markAsReadAndTyping(messageId, phoneNumberId = PHONE_NUMBER_ID) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  } catch (err) {
    console.error("Failed to mark as read / show typing:", err);
  }
}

// ====== 4. Send reply back via WhatsApp Cloud API ======
// Track every message (both directions) so we can identify what's being quoted/replied to
const messageStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of messageStore) {
    if (now - entry.time > 24 * 60 * 60 * 1000) messageStore.delete(id);
  }
}, 60 * 60 * 1000);

async function sendWhatsAppMessage(to, text, phoneNumberId = PHONE_NUMBER_ID) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("WhatsApp send failed:", JSON.stringify(data));
    return false;
  }

  const sentId = data.messages?.[0]?.id;
  if (sentId) messageStore.set(sentId, { text, time: Date.now() });

  console.log(`Reply sent to ${to}`);
  return true;
}

const stateReady = loadPersistedState().catch((err) => console.error("State restore failed:", err.message));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ====== Optional interactive helpers (not wired into the chat flow yet) ======
let axios;
try {
  axios = require("axios");
} catch (e) {
  axios = {
    post: async (url, body, cfg = {}) => {
      const r = await fetch(url, { method: "POST", headers: cfg.headers || {}, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const err = new Error(`HTTP ${r.status}`); err.response = { data }; throw err; }
      return { data };
    },
  };
}

const GRAPH_API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
const AUTH_HEADER = {
  headers: {
    Authorization: `Bearer ${process.env.PERMANENT_TOKEN || process.env.PERMANENT_META_TOKEN || WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

async function sendBookingInvitation(to) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      header: {
        type: "image",
        image: { link: "https://triplehfertilityhub.com/favicon.png" },
      },
      body: {
        text:
          "*Triple H Fertility Hub & Specialist Hospital*\n" +
          "_Care, Compassion & Clinical Excellence_\n\n" +
          "To book your consultation with our consultant fertility specialist and clinical team:\n\n" +
          "📋 *Registration/Card:* ₦10,000\n" +
          "🩺 *Consultation:* ₦70,000\n" +
          "🕒 *Hours:* Mon-Thu 9am-6pm | Sat 10am-4pm\n" +
          "📍 *Location:* No. 5 Onitolo Street, Gbaja, Surulere",
      },
      footer: { text: "Select an option below to proceed" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "btn_book_chat", title: "Book Here in Chat 📝" } },
          { type: "reply", reply: { id: "btn_book_online", title: "Open Booking Form 🌐" } },
        ],
      },
    },
  };

  try {
    await axios.post(GRAPH_API_URL, payload, AUTH_HEADER);
  } catch (error) {
    console.error("Error sending booking invitation:", error.response?.data || error.message);
  }
}

async function sendFormLink(to) {
  const textPayload = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: {
      preview_url: true,
      body: "Please complete your booking details directly on our mobile portal:\n👉 https://triplehfertilityhub.com/book\n\nOnce completed, our coordinator will receive your details immediately!",
    },
  };
  await axios.post(GRAPH_API_URL, textPayload, AUTH_HEADER);
}

async function sendServicePicker(to) {
  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Select a Consultation Service" },
      body: { text: "Choose the service you wish to schedule an appointment for:" },
      footer: { text: "Triple H Care Services" },
      action: {
        button: "Choose Service",
        sections: [
          {
            title: "Consultations",
            rows: [
              { id: "svc_ivf", title: "IVF & Fertility Care", description: "Comprehensive reproductive assessment" },
              { id: "svc_gynae", title: "Gynaecology Care", description: "Fibroids, PCOS, pelvic health" },
              { id: "svc_telemedicine", title: "Telemedicine (Online)", description: "Virtual consultation via video/call" },
              { id: "svc_scan", title: "Pelvic Ultrasound Scan", description: "Follicular tracking & pelvic imaging" },
            ],
          },
        ],
      },
    },
  };
  await axios.post(GRAPH_API_URL, payload, AUTH_HEADER);
}
