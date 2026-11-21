// WhatsApp AI Auto-Responder - Test Backend
// Flow: WhatsApp message -> this server -> Gemini API -> reply sent back via WhatsApp

const express = require("express");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const app = express();
app.use(cors());
app.use(express.json());

// ====== FILL THESE IN (.env or directly here for quick testing) ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_test_verify_token_123"; // you make this up, used in Step 2 webhook setup
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "PASTE_YOUR_META_ACCESS_TOKEN_HERE";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "PASTE_YOUR_PHONE_NUMBER_ID_HERE";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "PASTE_YOUR_GEMINI_API_KEY_HERE";

// ====== BROADCAST PANEL ======
// A password you make up, used to access the /broadcast-panel page
const BROADCAST_SECRET = process.env.BROADCAST_SECRET || "PASTE_A_PASSWORD_HERE";

// ====== WHATSAPP FLOW (in-chat form) ======
// Get this ID after creating and publishing your Flow in WhatsApp Manager
const QUOTE_FLOW_ID = process.env.QUOTE_FLOW_ID || "PASTE_YOUR_FLOW_ID_HERE";

// ====== CUSTOM CRM (Supabase) ======
const SUPABASE_URL = process.env.SUPABASE_URL || "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";
const CRM_SECRET = process.env.CRM_SECRET || "PASTE_A_PASSWORD_HERE"; // for viewing the leads dashboard

// ====== ALERT YOU WHEN A HUMAN NEEDS TO STEP IN ======
const OWNER_WHATSAPP_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || "2348143594483";
const BASE_URL = process.env.BASE_URL || "https://meta-n4tt.onrender.com";
// If any of your approved templates have an IMAGE header, put a public image
// URL here (e.g. your logo on your website). Leave as-is if none need one.
const TEMPLATE_HEADER_IMAGE = process.env.TEMPLATE_HEADER_IMAGE || "";

const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbxzVu9vIlhRqJrOvPeX4Kxcno6Q-UlH3dT_-5P4J8YUiIXrx44SRlWhK1uhhKP9-x_Z/exec";

// ====== FACEBOOK MESSENGER ======
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "PASTE_YOUR_PAGE_ACCESS_TOKEN_HERE";

// ====== INSTAGRAM ======
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "PASTE_YOUR_INSTAGRAM_ACCESS_TOKEN_HERE";
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID || "PASTE_YOUR_INSTAGRAM_ACCOUNT_ID_HERE";

// ====== CONVERSATION MEMORY (per customer, persisted in Supabase so it ======
// ====== survives server restarts — not just kept in RAM) ======
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_HOURS || 48) * 60 * 60 * 1000;
const conversationCache = new Map(); // in-process cache, avoids hitting Supabase on every message in a fast back-and-forth

async function getConversation(senderId) {
  const now = Date.now();

  const cached = conversationCache.get(senderId);
  if (cached && now - cached.lastMessageTime < SESSION_TIMEOUT_MS) {
    return cached;
  }

  // Not in memory (likely a fresh server start) — check Supabase for a still-valid session
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(senderId)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    const row = rows?.[0];
    if (row && now - new Date(row.last_message_time).getTime() < SESSION_TIMEOUT_MS) {
      const restored = {
        history: row.history || [],
        lastMessageTime: new Date(row.last_message_time).getTime(),
        platform: row.platform || null,
        phoneNumberId: row.phone_number_id || null,
        humanPausedUntil: row.human_paused_until ? new Date(row.human_paused_until).getTime() : null,
      };
      conversationCache.set(senderId, restored);
      return restored;
    }
  } catch (err) {
    console.error("Failed to load conversation from Supabase:", err);
  }

  const fresh = { history: [], lastMessageTime: now, platform: null, phoneNumberId: null, humanPausedUntil: null };
  conversationCache.set(senderId, fresh);
  return fresh;
}

async function saveConversation(senderId, convo) {
  conversationCache.set(senderId, convo);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        sender_id: senderId,
        history: convo.history,
        last_message_time: new Date(convo.lastMessageTime).toISOString(),
        platform: convo.platform || null,
        phone_number_id: convo.phoneNumberId || null,
        human_paused_until: convo.humanPausedUntil ? new Date(convo.humanPausedUntil).toISOString() : null,
      }),
    });
  } catch (err) {
    console.error("Failed to save conversation to Supabase:", err);
  }
}

// Periodic cleanup of the in-process cache only — Supabase rows are cheap to keep
setInterval(() => {
  const now = Date.now();
  for (const [id, convo] of conversationCache) {
    if (now - convo.lastMessageTime > SESSION_TIMEOUT_MS) conversationCache.delete(id);
  }
}, 60 * 60 * 1000);

// ====== NUMBERS TO NEVER AUTO-RESPOND TO ======
// Add any number here (in international format, no + or spaces, e.g. "2348012345678")
// and the bot will completely ignore messages from it — no AI reply, no log of content.
const BLOCKED_NUMBERS = [
  // "2348012345678", // example: boss's number
];

// ====== WEBSITE PAGES TO PULL LIVE CONTENT FROM ======
// Add any URLs you want the AI to stay up to date on. It re-fetches these
// automatically every few hours, so editing your website updates the AI too.
const WEBSITE_URLS = [
   "https://triplehfertilityhub.com",
  "https://triplehfertilityhub.com/resources",
  "https://triplehfertilityhub.com/book",
  "https://triplehfertilityhub.com/contact",
  "https://triplehfertilityhub.com/about",
];

let cachedWebsiteContent = ""; // filled in automatically, don't edit

async function refreshWebsiteContent() {
  console.log("Refreshing website content...");
  const pages = [];
  for (const url of WEBSITE_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // rendering takes longer than a plain fetch

      // Route through Jina AI's free Reader API — it actually renders the
      // page (including JavaScript-built sites like React/Next.js) and
      // returns clean text, instead of us getting an empty HTML shell.
      const response = await fetch(`https://r.jina.ai/${url}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`Fetch ${url} returned status ${response.status}`);
        continue;
      }

      const text = (await response.text()).trim().slice(0, 4000); // cap length
      pages.push(`--- Content from ${url} ---\n${text}`);
      console.log(`Fetched ${text.length} characters from ${url}`);
    } catch (err) {
      console.error(`Failed to fetch ${url}:`, err.message);
    }
  }
  cachedWebsiteContent = pages.join("\n\n");
  console.log("Website content refreshed:", new Date().toISOString(), `(${cachedWebsiteContent.length} total characters cached)`);
}

// Fetch once on startup, then refresh every 6 hours
refreshWebsiteContent();
setInterval(refreshWebsiteContent, 6 * 60 * 60 * 1000);
/**
 * Sends the approved Meta template to the clinic owners
 */
async function sendPatientSummaryToOwners(summaryData) {
  const { name, phone, service, status, notes } = summaryData;
  const phoneNumberId = process.env.WABA_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
  const token = process.env.PERMANENT_META_TOKEN || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    console.error("Missing WABA_PHONE_NUMBER_ID or PERMANENT_META_TOKEN");
    return;
  }

  for (const ownerPhone of OWNER_PHONE_NUMBERS) {
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
                { type: "text", text: name || "Prospective Patient" },
                { type: "text", text: phone || "Not provided" },
                { type: "text", text: service || "General Fertility Inquiry" },
                { type: "text", text: status || "Inquiry / Needs Follow-up" },
                { type: "text", text: notes || "Chat ended without explicit booking." }
              ]
            }
          ]
        }
      };

      const response = await axios.post(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log(`Summary template sent to owner ${ownerPhone}:`, response.data);
    } catch (err) {
      console.error(`Failed to send summary template to ${ownerPhone}:`, err.response?.data || err.message);
    }
  }
}

// ====== YOUR BUSINESS INFO GOES HERE ======
// This is what the AI uses to answer questions. Edit this freely.
// ====== YOUR BUSINESS INFO GOES HERE ======
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

ADAPT YOUR ROLE TO WHAT THE MOMENT NEEDS
- Curious or first-time inquiry: WARM GUIDE. Provide gentle, encouraging information about how Triple H helps couples and individuals overcome fertility challenges.
- Anxious patient or someone sharing fertility struggles: EMPATHETIC NURSE. Listen, validate their feelings, reassure them that difficulty conceiving is common and treatable, and guide them toward a confidential consultation with our specialist doctor.
- Inquiring about prices or treatment options: CLEAR NAVIGATOR. Explain our transparent initial fees (Registration ₦10,000 + Consultation ₦70,000 = ₦80,000 total). For comprehensive treatments like IVF, egg freezing, or surgery, explain that treatment protocols are strictly tailored to each patient's medical tests, and our consultant will provide their exact plan during consultation.
- Existing patient or follow-up: PATIENT CARE COORDINATOR. Prioritize their needs, help them reach the nursing station or reception, and ensure they feel well cared for.
- Ready to book: APPOINTMENT SCHEDULER. Collect their preferred day and time (within clinic hours: Mon-Thu 9am-6pm, Sat 10am-4pm) or offer our Medesk patient portal link.

MEDICAL SAFETY & TRIAGE BOUNDARIES (CRITICAL HEALTHCARE RULES)
- You are an AI virtual nurse, NOT a medical doctor.
- You NEVER diagnose conditions, prescribe medications, alter drug dosages, or interpret lab results as definitive.
- Always gently remind patients that a definitive diagnosis and personalized treatment plan requires a formal consultation with Dr. Haleemah Olalere.
- RED-FLAG MEDICAL EMERGENCIES: If a patient mentions heavy vaginal bleeding, acute severe lower abdominal/pelvic pain, fainting, high fever following a recent procedure, or suspected ectopic pregnancy, advise them immediately to proceed to the nearest hospital emergency room.

USE DISCRETION - NOT EVERYONE IS A PATIENT
- Someone asking about nursing jobs, medical officer positions, internships, or IT placements: warmly direct them to email their CV to 3hfertilityhub@gmail.com for review by management.
- Medical reps, pharmaceutical vendors, or media: politely direct them to 3hfertilityhub@gmail.com.

CLINIC INFORMATION
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
3. Ask for their preferred Day and Time within clinic working hours:
   - Monday to Thursday: 9:00 AM – 6:00 PM WAT
   - Saturday: 10:00 AM – 4:00 PM WAT
   - (Remind gently that the clinic is closed on Fridays and Sundays)
4. Mention the standard fees:
   - Registration / Card: ₦10,000 ($8)
   - Doctor Consultation: ₦70,000 ($47)
   - Bank: Providus Bank, Account: 1305084494 (Triple H Fertility Hub)
5. The moment you have their Name, Service, and Preferred Date/Time, output this exact hidden tag in your response:
   [SAVE_LEAD:{"name":"Patient Name","phone":"","email":"","service":"IVF","mode":"In-Person","date":"2026-11-25","time":"10:00 AM","notes":"Patient notes or symptoms"}]
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
Answer their questions honestly. Provide the published consultation fees (₦10,000 card + ₦70,000 consultation = ₦80,000) whenever they ask about cost, and explain that treatments like IVF or surgery are customized after their initial evaluation with Dr. Haleemah.

Step 3 - Offer appointment booking.
When they are ready to schedule or speak with Dr. Haleemah, invite them:
"We can book a consultation slot for you (in-person at Surulere or via telemedicine online). Which day works best for you between Monday to Thursday (9am-6pm) or Saturday (10am-4pm)?"
If they are ready to proceed, include [BOOK_CALL] at the start of your message.

Step 4 - Direct booking option.
If they prefer self-scheduling online, they can also use our secure Medesk portal: https://app.medesk.net/patient/?e=654e537f7c6e2b0706f9c9c0&a=anonymous

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
- Include this tag when a patient shares their name or details:
  [SAVE_LEAD:{"name":"their name","phone":"their number or empty string","email":"their email or empty string","service":"service of interest","notes":"in-person or telemedicine, preferred day/time, etc."}]
`;

async function getKnownName(senderId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?sender_id=eq.${encodeURIComponent(senderId)}&name=not.is.null&order=created_at.desc&limit=1&select=name`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    return rows?.[0]?.name || null;
  } catch (err) {
    console.error("Failed to look up known name:", err);
    return null;
  }
}
async function saveLead(platform, senderId, leadData) {
  try {
    const payload = {
      name: leadData.name || "WhatsApp Patient",
      phone: leadData.phone || senderId,
      email: leadData.email || "",
      service: leadData.service || "Fertility Consultation",
      mode: leadData.mode || "In-Person",
      date: leadData.date || "",
      time: leadData.time || "",
      source: "WhatsApp Bot",
      notes: leadData.notes || ""
    };

    console.log(`[Google Sheet] Logging lead for ${senderId}:`, payload);

    const response = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.text();
    console.log(`[Google Sheet] Response:`, result);
  } catch (err) {
    console.error("[Google Sheet] Failed to log lead:", err.message);
  }
}

async function saveLead(platform, senderId, leadData) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        platform,
        sender_id: senderId,
        name: leadData.name || null,
        phone: leadData.phone || null,
        email: leadData.email || null,
        service_interest: leadData.service || null,
        notes: leadData.notes || null,
      }),
    });
    if (!response.ok) console.error("Failed to save lead:", await response.text());
    else console.log(`Lead saved for ${senderId}`);
  } catch (err) {
    console.error("Error saving lead:", err);
  }
}

// ====== Summarize a full conversation for the owner alert (not just the last message) ======
async function summarizeConversation(senderId) {
  const convo = await getConversation(senderId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  const summaryInstruction =
    "Summarize this customer conversation in 3-5 short sentences for a busy business owner. " +
    "Include: what they need/want, any key requirements or details they mentioned, budget or " +
    "timeline if discussed, and their name/contact info if they gave it. Be specific, not generic. " +
    "Write in PLAIN TEXT ONLY — no Markdown, no **bold**, no bullet points with asterisks or dashes, " +
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
    return summary || "Could not generate summary — check the leads dashboard or Render logs for the full conversation.";
  } catch (err) {
    console.error("Failed to summarize conversation:", err);
    return "Could not generate summary — check the leads dashboard or Render logs for the full conversation.";
  }
}

// ====== Process an AI reply: strip special tags, act on them, return clean text ======
async function processAIReply(aiReply, platform, senderId, userMessage, phoneNumberId = PHONE_NUMBER_ID) {
  let cleanReply = aiReply;
  let shouldBookCall = false;

  const saveLeadMatch = cleanReply.match(/\[SAVE_LEAD:(\{.*?\})\]/);
  if (saveLeadMatch) {
    try {
      const leadData = JSON.parse(saveLeadMatch[1]);
      // On WhatsApp, the sender ID IS their phone number — always use it,
      // never rely on the AI having asked for it separately.
      if (platform === "WhatsApp" && !leadData.phone) {
        leadData.phone = senderId;
      }
      await saveLead(platform, senderId, leadData);
    } catch (err) {
      console.error("Failed to parse SAVE_LEAD tag:", err);
    }
    cleanReply = cleanReply.replace(saveLeadMatch[0], "").trim();
  }

  const paymentClaimMatch = cleanReply.match(/\[PAYMENT_CLAIM:(\{.*?\})\]/);
  if (paymentClaimMatch) {
    try {
      const claimData = JSON.parse(paymentClaimMatch[1]);
      await savePaymentClaim(platform, senderId, claimData, phoneNumberId);
      await notifyOwner(
        `Payment claim (${platform})\nCustomer: ${senderId}\nName: ${claimData.name || "-"}\nService: ${claimData.service || "-"}\nAmount claimed: ${claimData.amount || "-"}\n\nCheck your bank, then confirm at: ${BASE_URL}/pending-payments`
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
      `Platform: ${platform}\nCustomer: ${senderId}\n\n${summary}\n\nThey're ready to move forward — check the leads dashboard for full details.`
    );
  }

  return { cleanReply, shouldBookCall };
}

// ====== Booking form — Messenger/Instagram equivalent of WhatsApp's in-chat Flow ======
app.get("/book-session", (req, res) => {
  const { platform, sender } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px;">
      <h2>Book a Session with Our Tech Team</h2>
      <p>Fill this quick form and we'll follow up with a full quote.</p>
      <form method="POST" action="/book-session">
        <input type="hidden" name="platform" value="${platform || ""}">
        <input type="hidden" name="sender" value="${sender || ""}">
        <label>Name<br><input type="text" name="name" style="width:100%; padding:8px;" required></label><br><br>
        <label>WhatsApp Number<br><input type="text" name="phone" style="width:100%; padding:8px;" placeholder="e.g. 2348012345678"></label><br><br>
        <label>Email (if no WhatsApp number)<br><input type="email" name="email" style="width:100%; padding:8px;"></label><br><br>
        <label>What do you need?<br><input type="text" name="service" style="width:100%; padding:8px;" required></label><br><br>
        <label>Anything else to add?<br><textarea name="notes" rows="4" style="width:100%; padding:8px;"></textarea></label><br><br>
        <button type="submit" style="padding:10px 20px;">Submit</button>
      </form>
    </body></html>
  `);
});

app.post("/book-session", express.urlencoded({ extended: true }), async (req, res) => {
  const { platform, sender, name, phone, email, service, notes } = req.body;

  await saveLead(platform || "Web Form", sender || "unknown", { name, phone, email, service, notes });
  await notifyOwner(
    `Booking form submitted (${platform || "Web"})\nName: ${name}\nPhone: ${phone || "-"}\nEmail: ${email || "-"}\nService: ${service}\nNotes: ${notes || "-"}`
  );

  // Confirm to the customer in their original chat, if we know the platform/sender
  const confirmMsg = "Thanks! We've got your details — our team will follow up shortly 🙏";
  if (platform === "Messenger") await sendMessengerMessage(sender, confirmMsg);
  else if (platform === "Instagram") await sendInstagramMessage(sender, confirmMsg);

  res.send(`<body style="font-family: sans-serif; text-align:center; margin-top:60px;"><h2>Thanks, ${name}! 🎉</h2><p>Our team will follow up with you shortly.</p></body>`);
});

// ====== Leads dashboard — simple password-protected page to view your CRM ======
// ====== Generate a payment receipt PDF ======
function generateReceiptPDF({ customerName, service, amount, date, receiptNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const brandGreen = "#0F5132";
    const pageWidth = doc.page.width;

    // Header band
    doc.rect(0, 0, pageWidth, 130).fill(brandGreen);
    doc.fillColor("#FFFFFF").fontSize(26).font("Helvetica-Bold").text("Nuvanta Africa", 50, 40);
    doc.fontSize(10).font("Helvetica").text("NVA Africa Ltd  |  RC No: 9666156  |  nuvanta.africa", 50, 75);
    doc.fontSize(20).font("Helvetica-Bold").text("RECEIPT", pageWidth - 200, 45, { width: 150, align: "right" });

    // Receipt meta box
    let y = 160;
    doc.fillColor("#000000").fontSize(10).font("Helvetica");
    doc.text(`Receipt No:`, 50, y);
    doc.font("Helvetica-Bold").text(receiptNumber, 150, y);
    doc.font("Helvetica").text(`Date:`, 350, y);
    doc.font("Helvetica-Bold").text(date, 400, y);

    y += 40;
    doc.moveTo(50, y).lineTo(pageWidth - 50, y).strokeColor("#DDDDDD").stroke();
    y += 25;

    // Billed to
    doc.fontSize(9).fillColor("#888888").font("Helvetica").text("RECEIVED FROM", 50, y);
    y += 15;
    doc.fontSize(13).fillColor("#000000").font("Helvetica-Bold").text(customerName || "Customer", 50, y);
    y += 35;

    // Line item table header
    doc.rect(50, y, pageWidth - 100, 28).fill("#F2F2F2");
    doc.fillColor("#555555").fontSize(9).font("Helvetica-Bold");
    doc.text("DESCRIPTION", 60, y + 9);
    doc.text("AMOUNT", pageWidth - 160, y + 9, { width: 100, align: "right" });
    y += 28;

    // Line item row
    doc.rect(50, y, pageWidth - 100, 32).strokeColor("#EEEEEE").stroke();
    doc.fillColor("#000000").fontSize(11).font("Helvetica");
    doc.text(service || "Services rendered", 60, y + 10, { width: pageWidth - 260 });
    doc.font("Helvetica-Bold").text(`₦${amount}`, pageWidth - 160, y + 10, { width: 100, align: "right" });
    y += 32;

    // Total band
    doc.rect(50, y, pageWidth - 100, 40).fill(brandGreen);
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold");
    doc.text("TOTAL PAID", 60, y + 13);
    doc.fontSize(14).text(`₦${amount}`, pageWidth - 160, y + 11, { width: 100, align: "right" });
    y += 70;

    // Paid stamp
    doc.save();
    doc.rotate(-15, { origin: [pageWidth - 150, y] });
    doc.fontSize(28).fillColor("#0F5132").opacity(0.25).font("Helvetica-Bold");
    doc.text("PAID", pageWidth - 220, y - 15);
    doc.restore();
    doc.opacity(1);

    // Footer
    const footerY = doc.page.height - 100;
    doc.moveTo(50, footerY).lineTo(pageWidth - 50, footerY).strokeColor("#DDDDDD").stroke();
    doc.fillColor("#888888").fontSize(9).font("Helvetica");
    doc.text("Thank you for your business!", 50, footerY + 15, { align: "center", width: pageWidth - 100 });
    doc.text("Nuvanta Africa  |  nuvanta.africa  |  08143594483  |  nuvantaafrica@gmail.com", 50, footerY + 30, {
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

// ====== Save a customer's payment claim as "pending" ======
async function savePaymentClaim(platform, senderId, claimData, phoneNumberId = PHONE_NUMBER_ID) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        platform,
        sender_id: senderId,
        phone: platform === "WhatsApp" ? senderId : claimData.phone || null,
        phone_number_id: phoneNumberId,
        customer_name: claimData.name || null,
        service: claimData.service || null,
        amount: claimData.amount || null,
        notes: claimData.notes || null,
        status: "pending",
      }),
    });
    if (!response.ok) console.error("Failed to save payment claim:", await response.text());
  } catch (err) {
    console.error("Error saving payment claim:", err);
  }
}

// ====== Look up this customer's most recent payment status, for context ======
async function getPaymentStatus(senderId) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?sender_id=eq.${encodeURIComponent(senderId)}&order=id.desc&limit=1&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    return rows?.[0] || null;
  } catch (err) {
    console.error("Failed to look up payment status:", err);
    return null;
  }
}

// ====== Pending payments admin page — see claims and confirm with one click ======
app.get("/pending-payments", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?status=eq.pending&order=id.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const pending = await response.json();

    if (!Array.isArray(pending)) {
      console.error("Supabase payments query error:", JSON.stringify(pending));
      return res.send(`
        <h2>Error loading pending payments</h2>
        <p>Supabase returned this instead of a list — likely a missing column or table issue:</p>
        <pre>${JSON.stringify(pending, null, 2)}</pre>
      `);
    }

    const rows = pending
      .map(
        (p) => `<tr>
          <td>${p.customer_name || "-"}</td>
          <td>${p.phone || p.sender_id}</td>
          <td>${p.service || "-"}</td>
          <td>₦${p.amount || "-"}</td>
          <td>${p.notes || "-"}</td>
          <td><a href="/confirm-payment?id=${p.id}&secret=${req.query.secret}" style="background:#0F5132;color:white;padding:6px 12px;text-decoration:none;border-radius:4px;">Confirm & Send Receipt</a></td>
        </tr>`
      )
      .join("");
    res.send(`
      <html><body style="font-family: sans-serif;">
        <h2>Pending Payments (${pending.length})</h2>
        <table border="1" cellpadding="8" style="border-collapse: collapse;">
          <tr><th>Name</th><th>Contact</th><th>Service</th><th>Amount</th><th>Notes</th><th>Action</th></tr>
          ${rows}
        </table>
      </body></html>
    `);
  } catch (err) {
    res.send("Error loading pending payments: " + err.message);
  }
});

// ====== Confirm a payment — generates and sends the receipt automatically ======
// ====== The actual receipt generation + send logic, reused by both the manual admin page AND the automatic Supabase webhook ======
async function processPaymentConfirmation(payment) {
  const receiptNumber = `NVA-${Date.now().toString().slice(-8)}`;
  const date = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" });
  const claimPhoneNumberId = payment.phone_number_id || PHONE_NUMBER_ID;

  const pdfBuffer = await generateReceiptPDF({
    customerName: payment.customer_name || "Customer",
    service: payment.service || "Services rendered",
    amount: payment.amount || "0",
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

  await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${payment.id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      sent
        ? { status: "confirmed", receipt_number: receiptNumber }
        : { status: "send_failed", notes: `${payment.notes || ""} [Receipt generation/send failed — retry manually]`.trim() }
    ),
  });

  return { sent, receiptNumber };
}

// ====== Manual admin page — one-click confirm ======
// ====== Generate a payment receipt PDF ======
function generateReceiptPDF({ customerName, service, amount, date, receiptNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const brandColor = "#761010"; // Triple H Crimson
    const pageWidth = doc.page.width;

    // Header band
    doc.rect(0, 0, pageWidth, 130).fill(brandColor);
    doc.fillColor("#FFFFFF").fontSize(24).font("Helvetica-Bold").text("Triple H Fertility Hub", 50, 38);
    doc.fontSize(12).font("Helvetica").text("& Specialist Hospital", 50, 66);
    doc.fontSize(9).font("Helvetica").text("No. 5 Onitolo Street, Gbaja, Surulere, Lagos  |  08034043725  |  3hfertilityhub@gmail.com", 50, 88);
    doc.fontSize(20).font("Helvetica-Bold").text("RECEIPT", pageWidth - 200, 45, { width: 150, align: "right" });

    // Receipt meta box
    let y = 160;
    doc.fillColor("#000000").fontSize(10).font("Helvetica");
    doc.text(`Receipt No:`, 50, y);
    doc.font("Helvetica-Bold").text(receiptNumber, 150, y);
    doc.font("Helvetica").text(`Date:`, 350, y);
    doc.font("Helvetica-Bold").text(date, 400, y);

    y += 40;
    doc.moveTo(50, y).lineTo(pageWidth - 50, y).strokeColor("#DDDDDD").stroke();
    y += 25;

    // Billed to
    doc.fontSize(9).fillColor("#888888").font("Helvetica").text("RECEIVED FROM", 50, y);
    y += 15;
    doc.fontSize(13).fillColor("#000000").font("Helvetica-Bold").text(customerName || "Patient", 50, y);
    y += 35;

    // Line item table header
    doc.rect(50, y, pageWidth - 100, 28).fill("#F2F2F2");
    doc.fillColor("#555555").fontSize(9).font("Helvetica-Bold");
    doc.text("DESCRIPTION", 60, y + 9);
    doc.text("AMOUNT", pageWidth - 160, y + 9, { width: 100, align: "right" });
    y += 28;

    // Line item row
    doc.rect(50, y, pageWidth - 100, 32).strokeColor("#EEEEEE").stroke();
    doc.fillColor("#000000").fontSize(11).font("Helvetica");
    doc.text(service || "Fertility Consultation / Clinical Service", 60, y + 10, { width: pageWidth - 260 });
    doc.font("Helvetica-Bold").text(`₦${amount}`, pageWidth - 160, y + 10, { width: 100, align: "right" });
    y += 32;

    // Total band
    doc.rect(50, y, pageWidth - 100, 40).fill(brandColor);
    doc.fillColor("#FFFFFF").fontSize(12).font("Helvetica-Bold");
    doc.text("TOTAL PAID", 60, y + 13);
    doc.fontSize(14).text(`₦${amount}`, pageWidth - 160, y + 11, { width: 100, align: "right" });
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

// ====== Inbox — see active conversations and reply directly, no template needed ======
app.get("/inbox", async (req, res) => {
  if (req.query.secret !== BROADCAST_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?platform=eq.WhatsApp&order=last_message_time.desc&limit=50`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const conversations = await response.json();

    if (!Array.isArray(conversations)) {
      return res.send(`<h2>Error</h2><pre>${JSON.stringify(conversations, null, 2)}</pre>`);
    }

    const rows = conversations
      .map((c) => {
        const lastMsg = c.history?.[c.history.length - 1]?.parts?.[0]?.text || "(no messages)";
        const hoursAgo = Math.round((Date.now() - new Date(c.last_message_time).getTime()) / 3600000);
        const windowOpen = hoursAgo < 24;
        const isPaused = c.human_paused_until && new Date(c.human_paused_until).getTime() > Date.now();
        return `<tr>
          <td>${isPaused ? "🟡" : "🟢"} ${c.sender_id}</td>
          <td style="max-width:400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${lastMsg}</td>
          <td>${hoursAgo}h ago</td>
          <td style="color:${windowOpen ? "green" : "#999"};">${windowOpen ? "Open ✓" : "Closed (needs template)"}</td>
          <td><a href="/inbox/chat?sender=${encodeURIComponent(c.sender_id)}&secret=${req.query.secret}">Open chat</a></td>
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
  } catch (err) {
    res.send("Error loading inbox: " + err.message);
  }
});

app.get("/inbox/chat", async (req, res) => {
  const { sender, secret } = req.query;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await response.json();
    const convo = rows?.[0];
    if (!convo) return res.send("Conversation not found.");

    const hoursAgo = Math.round((Date.now() - new Date(convo.last_message_time).getTime()) / 3600000);
    const windowOpen = hoursAgo < 24;

    const pausedUntil = convo.human_paused_until ? new Date(convo.human_paused_until).getTime() : null;
    const isPaused = pausedUntil && pausedUntil > Date.now();
    const pauseMinutesLeft = isPaused ? Math.round((pausedUntil - Date.now()) / 60000) : 0;

    const bubbles = (convo.history || [])
      .map((turn) => {
        const text = turn.parts?.[0]?.text || "";
        const isCustomer = turn.role === "user";
        return `<div style="display:flex; justify-content:${isCustomer ? "flex-start" : "flex-end"}; margin:8px 0;">
          <div style="max-width:70%; padding:10px 14px; border-radius:12px; background:${isCustomer ? "#f0f0f0" : "#0F5132"}; color:${isCustomer ? "#000" : "#fff"};">
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
                🟡 AI paused — you're handling this chat (resumes automatically in ~${pauseMinutesLeft} min)
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
            : `<p style="color:#999; margin-top:16px;">Reply window closed (24h+ since their last message) — use <a href="/send-message">Send Message</a> with an approved template instead.</p>`
        }
      </body></html>
    `);
  } catch (err) {
    res.send("Error loading chat: " + err.message);
  }
});

app.post("/inbox/reply", express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, sender, message } = req.body;
  if (secret !== BROADCAST_SECRET) return res.send("Wrong password.");

  console.log(`[INBOX REPLY] Attempting manual reply to ${sender}: ${message}`);

  const HUMAN_PAUSE_MS = 2 * 60 * 60 * 1000; // 2 hours — tweak as you like

  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await getRes.json();
    const convo = rows?.[0];
    const phoneNumberId = convo?.phone_number_id || PHONE_NUMBER_ID;

    const sent = await sendWhatsAppMessage(sender, message, phoneNumberId);

    // Pause the AI regardless of send success — you tried to take over this
    // conversation, so Nurse Hope should stay quiet either way. If the send
    // failed, you'll see that below and can retry, but the pause still holds.
    const history = convo?.history || [];
    history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED — attempted]: ${message}` }] });
    conversationCache.set(sender, {
      history,
      lastMessageTime: Date.now(),
      platform: "WhatsApp",
      phoneNumberId,
      humanPausedUntil: Date.now() + HUMAN_PAUSE_MS,
    });
    await saveConversation(sender, conversationCache.get(sender));

    if (!sent) {
      return res.send(
        `⚠️ The message may not have delivered (check Render logs for the exact error), but Nurse Hope is paused on this chat regardless — you can retry sending. <br><a href="/inbox/chat?sender=${encodeURIComponent(sender)}&secret=${secret}">Back to chat</a>`
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

  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await getRes.json();
    const convo = rows?.[0];
    if (convo) {
      conversationCache.set(sender, {
        history: convo.history || [],
        lastMessageTime: Date.now(),
        platform: convo.platform || "WhatsApp",
        phoneNumberId: convo.phone_number_id || PHONE_NUMBER_ID,
        humanPausedUntil: null,
      });
      await saveConversation(sender, conversationCache.get(sender));
    }
    res.redirect(`/inbox/chat?sender=${encodeURIComponent(sender)}&secret=${secret}`);
  } catch (err) {
    console.error("Resume AI failed:", err);
    res.send("Something went wrong. Check Render logs.");
  }
});

app.get("/leads", async (req, res) => {
  if (req.query.secret !== CRM_SECRET) {
    return res.send('<form>Password: <input type="password" name="secret"><button>View</button></form>');
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/leads?order=created_at.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const leads = await response.json();
    const rows = leads
      .map(
        (l) =>
          `<tr><td>${l.created_at?.slice(0, 16)}</td><td>${l.platform}</td><td>${l.name || ""}</td><td>${l.phone || ""}</td><td>${l.email || ""}</td><td>${l.service_interest || ""}</td><td>${l.notes || ""}</td></tr>`
      )
      .join("");
    res.send(`
      <html><body style="font-family: sans-serif;">
        <h2>Leads (${leads.length})</h2>
        <table border="1" cellpadding="8" style="border-collapse: collapse;">
          <tr><th>Date</th><th>Platform</th><th>Name</th><th>Phone</th><th>Email</th><th>Service</th><th>Notes</th></tr>
          ${rows}
        </table>
      </body></html>
    `);
  } catch (err) {
    res.send("Error loading leads: " + err.message);
  }
});

// ====== JSON API — call this from your Lovable dashboard to send a broadcast ======
// ====== JSON API — send a single message to one customer from your dashboard ======
// ====== JSON API — send a free-text reply from your Lovable chat UI, pauses Nurse Hope on that chat ======
app.post("/api/inbox-reply", async (req, res) => {
  const { secret, sender, message } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.status(401).json({ error: "Wrong password" });
  }
  if (!sender || !message) {
    return res.status(400).json({ error: "Missing sender or message" });
  }

  console.log(`[INBOX REPLY - API] Attempting manual reply to ${sender}: ${message}`);
  const HUMAN_PAUSE_MS = 2 * 60 * 60 * 1000;

  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await getRes.json();
    const convo = rows?.[0];
    const phoneNumberId = convo?.phone_number_id || PHONE_NUMBER_ID;

    const sent = await sendWhatsAppMessage(sender, message, phoneNumberId);

    const history = convo?.history || [];
    history.push({ role: "model", parts: [{ text: sent ? message : `[SEND FAILED — attempted]: ${message}` }] });
    conversationCache.set(sender, {
      history,
      lastMessageTime: Date.now(),
      platform: "WhatsApp",
      phoneNumberId,
      humanPausedUntil: Date.now() + HUMAN_PAUSE_MS,
    });
    await saveConversation(sender, conversationCache.get(sender));

    res.json({ success: sent, paused: true });
  } catch (err) {
    console.error("API inbox reply failed:", err);
    res.status(500).json({ error: "Something went wrong, check Render logs" });
  }
});

// ====== JSON API — resume Nurse Hope on a paused conversation, from Lovable ======
app.post("/api/inbox-resume", async (req, res) => {
  const { secret, sender } = req.body;

  if (secret !== BROADCAST_SECRET) {
    return res.status(401).json({ error: "Wrong password" });
  }
  if (!sender) {
    return res.status(400).json({ error: "Missing sender" });
  }

  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?sender_id=eq.${encodeURIComponent(sender)}&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await getRes.json();
    const convo = rows?.[0];
    if (convo) {
      conversationCache.set(sender, {
        history: convo.history || [],
        lastMessageTime: Date.now(),
        platform: convo.platform || "WhatsApp",
        phoneNumberId: convo.phone_number_id || PHONE_NUMBER_ID,
        humanPausedUntil: null,
      });
      await saveConversation(sender, conversationCache.get(sender));
    }
    res.json({ success: true });
  } catch (err) {
    console.error("API inbox resume failed:", err);
    res.status(500).json({ error: "Something went wrong, check Render logs" });
  }
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

// ====== Broadcast panel — a simple password-protected page to send to many numbers ======
// ====== Send a single message to one specific customer (not a broadcast) ======
app.get("/send-message", (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 500px; margin: 40px auto;">
      <h2>Send a Message</h2>
      <p style="color:#666;">For someone outside the 24-hour reply window, this uses an approved template (like broadcast). If they've messaged recently, plain text works too.</p>
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
      : `Failed — check Render logs for the exact error. <br><a href="/send-message">Try again</a>`
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

// Template parameters can't contain line breaks, tabs, or 4+ consecutive
// spaces — WhatsApp rejects those outright. Clean automatically so every
// caller doesn't need to remember this.
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

// ====== Alert the owner via WhatsApp when a human needs to step in ======
// Tries a normal message first (instant, works if you've messaged the bot
// recently); falls back to an approved template if that fails (guarantees
// delivery even outside the 24h window). Requires a template named
// "lead_alert" with one body variable, e.g.: "New lead alert: {{1}}"
async function notifyOwner(summary) {
  const sent = await sendWhatsAppMessage(OWNER_WHATSAPP_NUMBER, `🔔 Human needed:\n\n${summary}`);
  if (!sent) {
    console.log("Instant alert failed, falling back to template...");
    await sendWhatsAppTemplate(OWNER_WHATSAPP_NUMBER, "lead_alert", [summary.slice(0, 1000)], TEMPLATE_HEADER_IMAGE || null);
  }
}

// ====== Send the interactive quote-request Flow (form) to a customer ======
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
        header: { type: "text", text: "Get a Quote" },
        body: { text: "Fill this quick form and our team will get back to you with a full quote." },
        footer: { text: "Nuvanta Africa" },
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

// ====== 1. Webhook verification (Meta calls this once when you set up the webhook) ======
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
  res.sendStatus(200); // acknowledge immediately, Meta expects a fast response

  try {
    const platform = req.body.object; // "whatsapp_business_account" | "page" | "instagram"

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

  // Inside your incoming WhatsApp message handler, right after receiving a message from `senderId`:

// Clear any existing timer for this patient
if (conversationTimers.has(senderId)) {
  clearTimeout(conversationTimers.get(senderId));
}

// Start a new 5-minute inactivity countdown (300,000 ms)
const timer = setTimeout(async () => {
  conversationTimers.delete(senderId);

  try {
    console.log(`Patient ${senderId} inactive for 5 minutes. Generating summary...`);
    
    // Retrieve conversation history for this sender
    const history = getConversationHistory(senderId); // your existing history lookup
    
    if (!history || history.length < 2) return; // Don't alert on empty or single-message chats

    // Generate quick summary using your OpenAI / LLM call
    const summaryCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an assistant summarizing a clinical fertility chat for clinic managers.
Return a valid JSON object only with these exact keys:
{
  "name": "patient's name or Prospective Patient",
  "service": "primary topic or service discussed",
  "status": "Inquiry / Asked Fees / Wants Appointment / Booked",
  "notes": "2-sentence summary of what was discussed and what follow-up is needed"
}`
        },
        {
          role: "user",
          content: `Conversation:\n${history.map(m => `${m.role}: ${m.content}`).join("\n")}`
        }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(summaryCompletion.choices[0].message.content);

    // 1. Send template alert to owners on WhatsApp
    await sendPatientSummaryToOwners({
      name: parsed.name,
      phone: senderId,
      service: parsed.service,
      status: parsed.status,
      notes: parsed.notes
    });

    // 2. Also log to your Google Sheet webhook
    await saveLead("WhatsApp Chat", senderId, {
      fullName: parsed.name,
      phone: senderId,
      service: parsed.service,
      notes: parsed.notes
    });

  } catch (err) {
    console.error("Error in inactivity summary task:", err);
  }
}, 5 * 60 * 1000); // 5 minutes

conversationTimers.set(senderId, timer);
});

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
// ====== Wait for a pause before replying (proxy for "they might still be typing") ======
// WhatsApp/Messenger/Instagram don't expose real typing status to businesses,
// so this waits a few seconds after each message — if more messages arrive
// in that window, they're combined into one before the AI replies.
const messageBuffers = new Map(); // senderId -> { texts: [], media, timer }
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
    onReady(combinedText, combinedMedia);
  }, DEBOUNCE_MS);
}

async function handleWhatsApp(body) {
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  // Which of your numbers actually received this — always reply from THIS
  // one, not whatever's globally set in PHONE_NUMBER_ID, so a message to
  // your old test number doesn't get answered "from" your new number.
  const receivingPhoneNumberId = change?.value?.metadata?.phone_number_id || PHONE_NUMBER_ID;

  const from = message.from;
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
    await sendWhatsAppMessage(from, "Thanks! We've got your details — our team will follow up shortly with your quote 🙏", receivingPhoneNumberId);
    return;
  }

  if (message.type === "image") {
    media = await downloadWhatsAppMedia(message.image.id);
    text = message.image.caption || "[Customer sent an image — look at it and respond helpfully.]";
  } else if (message.type === "audio") {
    media = await downloadWhatsAppMedia(message.audio.id);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported message type (video, sticker, etc.)

  // Store this incoming message's raw text (before any augmentation) so it
  // can itself be looked up later if the customer quotes it in a future message
  if (text) messageStore.set(message.id, { text, time: Date.now() });

  // If they replied/quoted an earlier message — whether it was Nurse Hope's or
  // their own — tell the AI exactly what was quoted
  if (message.context?.id) {
    const quoted = messageStore.get(message.context.id);
    if (quoted) {
      text = `[The customer is replying directly to this earlier message: "${quoted.text}"]\n${text}`;
    }
  }

  console.log(`WhatsApp message from ${from} (to number ${receivingPhoneNumberId}): ${text}`);
  await markAsReadAndTyping(message.id, receivingPhoneNumberId);

  // If a human is actively handling this conversation, record the message
  // so it shows in the inbox, but don't let Nurse Hope auto-reply on top of them
  const convo = await getConversation(from);
  if (convo.humanPausedUntil && convo.humanPausedUntil > Date.now()) {
    console.log(`AI paused on ${from} (human handling) — recording message only`);
    convo.history.push({ role: "user", parts: [{ text }] });
    convo.lastMessageTime = Date.now();
    convo.platform = "WhatsApp";
    convo.phoneNumberId = receivingPhoneNumberId;
    await saveConversation(from, convo);
    return;
  }

  bufferAndDebounce(from, text, media, async (combinedText, combinedMedia) => {
    const aiReply = await askGemini(from, combinedText, "WhatsApp", combinedMedia, receivingPhoneNumberId);
    const { cleanReply, shouldBookCall } = await processAIReply(aiReply, "WhatsApp", from, combinedText, receivingPhoneNumberId);
    await sendWhatsAppMessage(from, cleanReply, receivingPhoneNumberId);
    if (shouldBookCall) await sendQuoteFlow(from, receivingPhoneNumberId);
  });
}

// ====== Download an image/audio file Messenger or Instagram sent us (direct URL, no auth needed) ======
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

  // Ignore echoes of our own sent messages — Meta sends these back to us
  // for sync purposes, they aren't new customer messages
  if (messaging?.message?.is_echo) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image — look at it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported attachment type (video, file, etc.)

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

  // Ignore echoes of our own sent messages — Meta sends these back to us
  // for sync purposes, they aren't new customer messages
  if (messaging?.message?.is_echo) return;

  let text = messaging?.message?.text;
  let media = null;

  const attachment = messaging?.message?.attachments?.[0];
  if (attachment?.type === "audio") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent a voice note — listen to it and respond helpfully.]";
  } else if (attachment?.type === "image") {
    media = await downloadMetaMedia(attachment.payload.url);
    text = "[Customer sent an image — look at it and respond helpfully.]";
  }

  if (!text && !media) return; // unsupported attachment type (video, file, etc.)

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

  let knownNameNote = "";
  if (convo.history.length === 0) {
    const knownName = await getKnownName(senderId);
    if (knownName) {
      knownNameNote = `\n\nRETURNING CUSTOMER: This is a new session, but we've spoken with this customer before and know their name is ${knownName}. Greet them warmly by name (e.g. "Hey ${knownName}, welcome back! 👋") instead of your full generic first-time introduction, and don't ask for their name again since we already have it.`;
    }
  }

  let paymentStatusNote = "";
  const paymentStatus = await getPaymentStatus(senderId);
  if (paymentStatus) {
    if (paymentStatus.status === "pending") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer has a PENDING payment claim (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) awaiting confirmation. If they ask about it, reassure them it's being checked and they'll get their receipt automatically once confirmed — don't create a new [PAYMENT_CLAIM] tag for this same one.`;
    } else if (paymentStatus.status === "confirmed") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer's most recent payment (${paymentStatus.service || "unspecified"}, ₦${paymentStatus.amount || "unspecified"}) is CONFIRMED, receipt ${paymentStatus.receipt_number} was already sent. If they ask, let them know it's confirmed and their receipt was sent — don't create a new claim.`;
    } else if (paymentStatus.status === "send_failed") {
      paymentStatusNote = `\n\nPAYMENT STATUS: This customer's payment was confirmed by the team, but the receipt failed to send due to a technical issue on our end — NOT their fault. If they ask, apologize briefly and say the team is resolving it and will get the receipt to them shortly. Do NOT claim a receipt was already sent.`;
    }
  }

  const nigeriaTime = new Date().toLocaleString("en-US", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const fullContext = `${BUSINESS_CONTEXT}\n\nCURRENT PLATFORM: ${platform}\n\nCURRENT DATE/TIME IN NIGERIA: ${nigeriaTime}. Use this to greet appropriately (good morning/afternoon/evening/night) and never say something time-inappropriate like "have a great day" in the evening.${knownNameNote}${paymentStatusNote}\n\nLIVE WEBSITE CONTENT (most current info — prefer this over anything above if they conflict):\n${cachedWebsiteContent}`;

  const currentParts = [{ text: userMessage }];
  if (media) {
    currentParts.push({ inlineData: { mimeType: media.mimeType, data: media.base64Data } });
  }

  const contents = [
    ...convo.history,
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
    return "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";
  }

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const finalReply = reply || "Sorry, I'm having trouble responding right now — a team member will follow up shortly.";

  // Save this exchange — both to the fast in-process cache and persisted to
  // Supabase, so it survives a server restart
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
// ====== Track every message (both directions) so we can identify what's being quoted/replied to ======
const messageStore = new Map(); // WhatsApp message ID -> { text, time }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const axios = require('axios');

const GRAPH_API_URL = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH_HEADER = {
  headers: {
    Authorization: `Bearer ${process.env.PERMANENT_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

/**
 * Sends a rich interactive booking banner with logo and action buttons
 */
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
        image: {
          // Direct public URL to Triple H clinic logo or banner
          link: "https://triplehfertilityhub.com/favicon.png"
        }
      },
      body: {
        text: 
          "*Triple H Fertility Hub & Specialist Hospital*\n" +
          "_Care, Compassion & Clinical Excellence_\n\n" +
          "To book your consultation with *Dr. Haleemah Olalere* and our fertility team:\n\n" +
          "📋 *Registration/Card:* ₦10,000\n" +
          "🩺 *Consultation:* ₦70,000\n" +
          "🕒 *Hours:* Mon–Thu 9am–6pm | Sat 10am–4pm\n" +
          "📍 *Location:* No. 5 Onitolo Street, Gbaja, Surulere"
      },
      footer: {
        text: "Select an option below to proceed"
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "btn_book_chat",
              title: "Book Here in Chat 📝"
            }
          },
          {
            type: "reply",
            reply: {
              id: "btn_book_online",
              title: "Open Booking Form 🌐"
            }
          }
        ]
      }
    }
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
      body: "Please complete your booking details directly on our mobile portal:\n👉 https://triplehfertilityhub.com/book\n\nOnce completed, our coordinator will receive your details immediately!"
    }
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
      header: {
        type: "text",
        text: "Select a Consultation Service"
      },
      body: {
        text: "Choose the service you wish to schedule an appointment for:"
      },
      footer: {
        text: "Triple H Care Services"
      },
      action: {
        button: "Choose Service",
        sections: [
          {
            title: "Consultations",
            rows: [
              { id: "svc_ivf", title: "IVF & Fertility Care", description: "Comprehensive reproductive assessment" },
              { id: "svc_gynae", title: "Gynaecology Care", description: "Fibroids, PCOS, pelvic health" },
              { id: "svc_telemedicine", title: "Telemedicine (Online)", description: "Virtual consultation via video/call" },
              { id: "svc_scan", title: "Pelvic Ultrasound Scan", description: "Follicular tracking & pelvic imaging" }
            ]
          }
        ]
      }
    }
  };
  await axios.post(GRAPH_API_URL, payload, AUTH_HEADER);
}
