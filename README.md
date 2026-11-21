# ⚡ Chatly 2.0 — Next-Gen WhatsApp Marketing & Closer CRM

A fast, clean, and reliable WhatsApp marketing platform built with **Baileys Pure WebSocket API**, **Node.js**, **SQLite**, and **Full-Duplex WebSockets**.

---

## 🚀 Key Improvements & Architectural Fixes

### 1. Zero "Waiting for this message" Errors
- **The Cause**: WhatsApp Signal Protocol requires the client to supply original message contents when an end-to-end decryption retry is requested.
- **The Solution**: 
  - Integrated `useMultiFileAuthState` with isolated sessions per closer (`sessions/closer_<id>/`).
  - Added `getMessage(key)` hook hooked into our SQLite `raw_message_store` so Baileys can re-transmit raw protobuf payloads on retry requests.
  - Added in-memory `msgRetryCounterCache` with TTL.

### 2. Zero "Single Tick Hanging"
- **The Cause**: Numbers sent with missing country codes (e.g. `0300...` instead of `92300...`) or unhandled connection state transitions.
- **The Solution**:
  - Pakistani and international phone normalizer converts all formats (`03xx`, `0092xx`, `+92xx`) to standard E.164 digits.
  - Human presence simulation (`sendPresenceUpdate('composing')`) before dispatching.
  - Strict delivery status tracking (`messages.update` listeners for Server Ack / Single Tick `✓`, Delivery Ack / Double Tick `✓✓`, and Read / Blue Double Tick `✓✓`).

### 3. Strict Chat Isolation (No Past Chats Synced)
- **The Cause**: Older implementations ingested the closer's entire personal chat history (`messaging-history.set`).
- **The Solution**:
  - `syncFullHistory: false` passed to `makeWASocket`.
  - Ignores `messaging-history.set` and `chats.set` completely.
  - **Strict Lead Filter**: In `messages.upsert`, Chatly ONLY ingests messages if the remote number belongs to a lead created or dispatched through Chatly. Random family/friend WhatsApp messages on the closer's personal number are never saved or displayed in Chatly.

### 4. Smart Campaign Dispatcher
- Company Admins paste or upload phone numbers list (with optional names: `03001234567, Ali`).
- Automatic deduplication and number validation.
- Auto-balances leads **round-robin** across all active connected Closers / TMs / TLs.
- Anti-ban pacing (configurable delay between 2.5s and 6s per device).
- Real-time live progress updates over WebSockets without page reload.

### 5. Full-Duplex Real-Time Inbox
- Real-time two-way messaging: outbound messages dispatch instantly, inbound customer replies pop up immediately with audio chime.
- Canned quick-reply buttons for fast closings.
- Role switching between Company Admin and individual Closers / Team Leads.

---

## 💻 How to Run Locally

```bash
# 1. Open directory
cd D:\Chatly

# 2. Start the server (runs on http://localhost:3000)
npm start
# or double click start.cmd on Windows
```

Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🌐 How to Link WhatsApp (Closer / TM / TL)
1. In Chatly, open the **Closers & WhatsApp Linking** tab.
2. Click **Scan QR** next to any closer name.
3. Open WhatsApp on your phone > **Settings / ⋮** > **Linked Devices** > **Link a Device**.
4. Scan the QR code on screen.
5. The status turns to **Linked WhatsApp** instantly with full-duplex communication ready!
