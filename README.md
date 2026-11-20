# Triple H Fertility Hub: Messaging Assistant

A small Node.js server that answers messages on **WhatsApp, Facebook Messenger and Instagram** for Triple H Fertility Hub and Specialist Hospital (Surulere, Lagos).

```
Customer message -> Meta webhook -> this server -> Gemini -> reply sent back
                                        |
                                        +-> Supabase (conversation memory, appointment requests)
                                        +-> WhatsApp alert to clinic staff
                                        +-> /inbox and /leads pages for staff
```

## What it does

- Answers general questions: services, opening hours, location, how to book.
- Collects **appointment requests** (name, reason in general terms, in-person or online, preferred time). The team confirms the time. The assistant never confirms a booking itself.
- Alerts staff on WhatsApp for new requests and when a person needs a human.
- Staff can take over any chat from `/inbox`. The assistant pauses while staff are handling it (default 2 hours).
- Pulls fresh content from the Triple H website every 6 hours.

## Safety and privacy choices (different from a normal sales bot)

- No diagnosis, medical advice, price quotes or success rates. Pricing is always "our team will confirm".
- Images, voice notes and documents are **never downloaded or sent to the AI**. The assistant tells the person it can't open files and hands over to staff.
- Meta's webhook signature is verified on every call (`APP_SECRET`).
- Staff pages use a password (HTTP Basic Auth), not a password in the URL. All patient text shown there is HTML-escaped.
- Supabase tables have row level security on, and the server uses the **service role key**. Never use the anon key for this project.
- Chat history is deleted automatically after `RETENTION_DAYS` (default 30). Leads are kept until you delete them.
- Keep this repository **private**. Put every secret in Render's environment variables only.

## Files

| File | Purpose |
|---|---|
| `server.js` | The whole app |
| `package.json` | Dependencies (only `express`) |
| `supabase-schema.sql` | Database tables, run once |
| `.env.example` | List of every setting |
| `.gitignore` | Keeps `node_modules` and secrets out of GitHub |

Run `npm install` once on your computer to create `package-lock.json`, then commit it. Do not commit `node_modules`.

## Setup

### 1. Supabase
1. Create a project, open **SQL Editor**, paste `supabase-schema.sql` and run it.
2. Copy the project URL and the **service_role** key (Settings > API).

### 2. GitHub and Render
1. Create a **private** GitHub repo and upload these files.
2. In Render: **New > Web Service**, connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance: use a **paid** instance. Free instances sleep and Meta webhooks will fail.
3. Add the environment variables from `.env.example`. The server will not start if a required one is missing.
4. After the first deploy, set `BASE_URL` to your Render URL.

### 3. Meta developer app
1. Create the app and add **WhatsApp**, **Messenger** and **Instagram** use cases.
2. Webhook callback URL: `https://YOUR-SERVICE.onrender.com/webhook`, verify token = your `VERIFY_TOKEN`.
3. Subscribe to these fields:
   - WhatsApp: `messages`
   - Page (Messenger): `messages`
   - Instagram: `messages`
   - Only if you use WhatsApp coexistence: also `smb_message_echoes`, `history`, `smb_app_state_sync`
4. Create a system user in the clinic's Business Manager and generate a permanent token for `WHATSAPP_TOKEN` and `PAGE_ACCESS_TOKEN`.
5. Create an approved WhatsApp template named `lead_alert` with one body variable, for example `Triple H alert: {{1}}`. It lets staff alerts arrive even when the 24-hour window is closed.

### 4. Test
1. Message the WhatsApp number. You should get a reply within about 10 seconds.
2. Ask to book an appointment. Check `/leads` (log in with `ADMIN_USER` and `ADMIN_PASSWORD`) and your staff WhatsApp alert.
3. Open `/inbox`, reply as staff, and confirm the assistant goes quiet on that chat.

## Important notes

- **Coexistence:** Meta's coexistence feature (using the WhatsApp Business app and the API on the same number) is reported as unavailable for Nigerian (+234) numbers. If the clinic's main number is blocked, register a separate number for the assistant and keep the main number on the app.
- **Instagram:** `sendInstagram` uses the Instagram API with Instagram Login (`graph.instagram.com`). If you connect Instagram through a Facebook Page token instead, change that endpoint to `https://graph.facebook.com/v21.0/PAGE_ID/messages` with the page token.
- **Gemini model:** set `GEMINI_MODEL` if the default model name is retired.
- **Compliance:** this system handles health-related personal data. Review the clinic's consent notice and data protection obligations under Nigeria's NDPA, and tell patients they are chatting with an automated assistant.
- Edit the assistant's knowledge and rules in `buildBusinessContext()` inside `server.js`.
