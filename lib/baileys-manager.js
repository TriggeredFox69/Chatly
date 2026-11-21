'use strict';

/**
 * Chatly Baileys WhatsApp Engine
 * Powered by @whiskeysockets/baileys
 * 
 * Bulletproof Features:
 * 1. Zero "Waiting for this message": Uses useMultiFileAuthState, custom getMessage proto cache, and retryCache.
 * 2. Zero "Single Tick Hanging": Strict phone normalization, pre-send presence simulation, connection monitoring.
 * 3. Strict Chat Isolation: syncFullHistory: false, ignores messaging-history.set/chats.set, ONLY ingests Chatly campaign leads.
 * 4. Multi-Closer Pool: Each TM/TL has an isolated persistent session folder.
 */

const path = require('node:path');
const fs = require('node:fs');
const QRCode = require('qrcode');
const pino = require('pino');
const db = require('./db');
const normalizer = require('./normalizer');
const wsManager = require('./websocket');

const SESSIONS_DIR = path.resolve(__dirname, '../sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory retry counter cache for Signal protocol
class MemoryRetryCache {
  constructor(ttlMs = 3600000) {
    this.map = new Map();
    this.ttl = ttlMs;
  }
  get(key) {
    const item = this.map.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expires) {
      this.map.delete(key);
      return undefined;
    }
    return item.value;
  }
  set(key, value) {
    this.map.set(key, { value, expires: Date.now() + this.ttl });
  }
  del(key) {
    this.map.delete(key);
  }
  flushAll() {
    this.map.clear();
  }
}

class BaileysManager {
  constructor() {
    this.clients = new Map(); // closerId -> { sock, status, qr, phone, retryCache }
    this.baileys = null;
    this.logger = pino({ level: 'silent' });
  }

  async initBaileysModule() {
    if (!this.baileys) {
      this.baileys = await import('@whiskeysockets/baileys');
    }
    return this.baileys;
  }

  getCloserSessionDir(closerId) {
    const cleanId = String(closerId).replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(SESSIONS_DIR, `closer_${cleanId}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  preloadLidMappings(closerId) {
    try {
      const sessionDir = this.getCloserSessionDir(closerId);
      if (!fs.existsSync(sessionDir)) return;
      const files = fs.readdirSync(sessionDir);
      for (const file of files) {
        if (file.startsWith('lid-mapping-') && file.endsWith('_reverse.json')) {
          const lid = file.slice('lid-mapping-'.length, -'_reverse.json'.length);
          try {
            const content = fs.readFileSync(path.join(sessionDir, file), 'utf8');
            const phone = JSON.parse(content);
            if (lid && phone) {
              db.saveLidMapping(lid, phone, closerId);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  async resolvePhone(sock, closerId, jid, altJid = null) {
    // 1. Check altJid if it's standard phone
    if (altJid && typeof altJid === 'string' && !altJid.endsWith('@lid') && !altJid.includes('@hosted.lid')) {
      const p = normalizer.jidToPhone(altJid);
      if (p && p.length >= 9) return p;
    }

    // 2. Check primary jid if standard phone
    if (jid && typeof jid === 'string' && !jid.endsWith('@lid') && !jid.includes('@hosted.lid')) {
      const p = normalizer.jidToPhone(jid);
      if (p && p.length >= 9) return p;
    }

    // 3. JID is an LID (e.g. 50771664105677@lid)
    const targetLid = (jid && typeof jid === 'string' && (jid.endsWith('@lid') || jid.includes('@hosted.lid')))
      ? jid
      : (altJid && typeof altJid === 'string' && (altJid.endsWith('@lid') || altJid.includes('@hosted.lid')) ? altJid : null);

    if (!targetLid) return '';

    const lidUser = String(targetLid).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!lidUser) return '';

    // 3a. SQLite cached lid_mappings
    const dbPhone = db.getPhoneForLid(lidUser);
    if (dbPhone) return dbPhone;

    // 3b. Baileys signalRepository lookup
    if (sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pnJid = await sock.signalRepository.lidMapping.getPNForLID(targetLid);
        if (pnJid) {
          const p = normalizer.jidToPhone(pnJid);
          if (p && p.length >= 9) {
            db.saveLidMapping(lidUser, p, closerId);
            return p;
          }
        }
      } catch (_) {}
    }

    // 3c. Reverse file from disk
    try {
      const sessionDir = this.getCloserSessionDir(closerId);
      const revPath = path.join(sessionDir, `lid-mapping-${lidUser}_reverse.json`);
      if (fs.existsSync(revPath)) {
        const content = fs.readFileSync(revPath, 'utf8');
        const parsed = JSON.parse(content);
        const p = normalizer.normalizePhone(parsed);
        if (p && p.length >= 9) {
          db.saveLidMapping(lidUser, p, closerId);
          return p;
        }
      }
    } catch (_) {}

    // 3d. Fallback: check all known conversations / leads to match LID via getLIDForPN
    if (sock?.signalRepository?.lidMapping?.getLIDForPN) {
      try {
        const convos = db.getConversations();
        for (const c of convos) {
          if (!c.phone) continue;
          const phoneJid = normalizer.phoneToJid(c.phone);
          const contactLid = await sock.signalRepository.lidMapping.getLIDForPN(phoneJid);
          if (contactLid) {
            const cleanContactLid = String(contactLid).split('@')[0].split(':')[0].replace(/\D/g, '');
            db.saveLidMapping(cleanContactLid, c.phone, closerId);
            if (cleanContactLid === lidUser) {
              return c.phone;
            }
          }
        }
      } catch (_) {}
    }

    return normalizer.normalizePhone(lidUser);
  }

  isCloserConnected(closerId) {
    const client = this.clients.get(closerId);
    return Boolean(client && client.status === 'connected' && client.sock);
  }

  getCloserStatus(closerId) {
    const client = this.clients.get(closerId);
    if (!client) {
      const row = db.getCloserById(closerId);
      return {
        id: closerId,
        status: row?.status || 'disconnected',
        phone: row?.phone || '',
        qr: row?.qr_code || ''
      };
    }
    return {
      id: closerId,
      status: client.status,
      phone: client.phone,
      qr: client.qr
    };
  }

  async connectCloser(closerId) {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      Browsers,
      proto
    } = await this.initBaileysModule();

    // If already running or connecting, return current status
    const existing = this.clients.get(closerId);
    if (existing && existing.sock && (existing.status === 'connected' || existing.status === 'qr_ready')) {
      return this.getCloserStatus(closerId);
    }

    const sessionDir = this.getCloserSessionDir(closerId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const retryCache = new MemoryRetryCache();

    // Preload known reverse LID mappings from session folder into DB
    this.preloadLidMappings(closerId);

    // Update DB & state
    db.updateCloserStatus(closerId, 'connecting', null, '');
    wsManager.sendToCloser(closerId, 'closer_status', {
      closerId,
      status: 'connecting',
      phone: '',
      qr: ''
    });

    const closer = db.getCloserById(closerId);
    const clientState = {
      sock: null,
      status: 'connecting',
      qr: '',
      phone: '',
      connectedAt: closer?.linked_at || Date.now(),
      retryCache
    };
    this.clients.set(closerId, clientState);

    // Create Baileys Socket with maximum resilience settings
    const sock = makeWASocket({
      auth: state,
      logger: this.logger,
      browser: Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      // CRITICAL: Tells WhatsApp NOT to download gigabytes of old message history!
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      msgRetryCounterCache: retryCache,

      // CRITICAL FIX FOR "Waiting for this message":
      // WhatsApp Signal protocol requests message retry if key was lost.
      // Returning the raw message proto satisfies Signal protocol retry-receipts!
      getMessage: async (key) => {
        if (!key?.id) return undefined;
        const raw = db.getRawMessage(key.id);
        if (raw) {
          try {
            return proto.Message.fromObject(raw);
          } catch (_) {}
        }
        return undefined;
      }
    });

    clientState.sock = sock;

    // Credentials persistence
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
          clientState.status = 'qr_ready';
          clientState.qr = qrDataUrl;
          db.updateCloserStatus(closerId, 'qr_ready', null, qrDataUrl);

          wsManager.sendToCloser(closerId, 'closer_qr', {
            closerId,
            qr: qrDataUrl
          });
          wsManager.sendToCloser(closerId, 'closer_status', {
            closerId,
            status: 'qr_ready',
            qr: qrDataUrl
          });
        } catch (err) {
          console.error(`[Baileys ${closerId}] QR Error:`, err);
        }
      }

      if (connection === 'open') {
        const userJid = sock.user?.id || '';
        const phone = normalizer.jidToPhone(userJid);
        clientState.status = 'connected';
        clientState.phone = phone;
        clientState.qr = '';
        clientState.connectedAt = Date.now();

        db.updateCloserStatus(closerId, 'connected', phone, '');

        wsManager.sendToCloser(closerId, 'closer_status', {
          closerId,
          status: 'connected',
          phone,
          qr: ''
        });

        wsManager.broadcast('dashboard_update', {
          closerId,
          status: 'connected',
          stats: db.getDashboardStats()
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        clientState.qr = '';

        if (!shouldReconnect) {
          // Permanently logged out from phone
          clientState.status = 'disconnected';
          clientState.phone = '';
          db.updateCloserStatus(closerId, 'disconnected', '', '');

          // Clean session directory
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (_) {}

          wsManager.sendToCloser(closerId, 'closer_status', {
            closerId,
            status: 'disconnected',
            phone: '',
            qr: ''
          });
        } else {
          // Temporary network drop: reconnect automatically
          clientState.status = 'connecting';
          db.updateCloserStatus(closerId, 'connecting', clientState.phone, '');

          wsManager.sendToCloser(closerId, 'closer_status', {
            closerId,
            status: 'connecting',
            phone: clientState.phone,
            qr: ''
          });

          setTimeout(() => {
            this.connectCloser(closerId).catch(console.error);
          }, 3000);
        }
      }
    });

    // Keep track of real-time LID-to-Phone mappings emitted by Baileys
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) {
        const cleanLid = String(lid).split('@')[0].split(':')[0].replace(/\D/g, '');
        const cleanPhone = normalizer.jidToPhone(pn);
        if (cleanLid && cleanPhone) {
          db.saveLidMapping(cleanLid, cleanPhone, closerId);
        }
      }
    });

    // Delivery Status (Single Tick -> Double Tick -> Blue Tick)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (!update.key?.id) continue;
        const baileysId = update.key.id;
        const status = update.update?.status;

        // WhatsApp status codes:
        // 2 = SERVER_ACK (sent / single tick)
        // 3 = DELIVERY_ACK (delivered / double tick)
        // 4 = READ (read / blue tick)
        // 5 = PLAYED (voice played)
        if (status) {
          let ack = 1;
          if (status >= 4) ack = 3;
          else if (status === 3) ack = 2;

          db.updateMessageAck(baileysId, ack);

          // Get phone from existing message in DB or resolve from update key
          const existingMsg = db.getMessageByBaileysId(baileysId);
          let remotePhone = existingMsg?.lead_phone;
          if (!remotePhone && update.key.remoteJid) {
            remotePhone = await this.resolvePhone(sock, closerId, update.key.remoteJid, update.key.remoteJidAlt);
          }

          if (remotePhone) {
            const lead = db.getLeadByNormalizedPhone(remotePhone);
            if (lead) {
              if (ack === 3 && lead.status !== 'replied') {
                db.updateLeadStatus(lead.id, 'read');
                if (lead.campaign_id) db.updateCampaignCounts(lead.campaign_id, { read_count: 1 });
              } else if (ack === 2 && lead.status === 'sent') {
                db.updateLeadStatus(lead.id, 'delivered');
                if (lead.campaign_id) db.updateCampaignCounts(lead.campaign_id, { delivered_count: 1 });
              }
            }
          }

          wsManager.broadcast('message_ack', {
            baileysMsgId: baileysId,
            ack,
            leadPhone: remotePhone,
            closerId
          });
        }
      }
    });

    // Real-Time Incoming & Outgoing Messages (Full Duplex)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        try {
          if (!msg.message || !msg.key) continue;

          // Save raw proto for Signal retry-receipts
          if (msg.key.id && msg.message) {
            db.saveRawMessage(msg.key.id, msg.message);
          }

          const remoteJid = msg.key.remoteJid;
          // Ignore groups, broadcasts, status updates, newsletters
          if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast') || remoteJid.includes('@newsletter')) {
            continue;
          }

          // Unwrap ephemeral / viewOnce messages
          let innerMsg = msg.message;
          if (innerMsg.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
          if (innerMsg.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
          if (innerMsg.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;
          if (innerMsg.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

          // Resolve remote phone number (handles both standard phone JID and @lid JID!)
          const leadPhone = await this.resolvePhone(sock, closerId, remoteJid, msg.key.remoteJidAlt);
          if (!leadPhone) continue;

          // =========================================================================
          // STRICT TIMESTAMP & HISTORY ISOLATION:
          // DO NOT sync old chats or historical messages!
          // Only messages from the moment the QR was scanned / connected onwards!
          // =========================================================================
          if (type !== 'notify') {
            continue; // Skip historical append sync batches
          }

          const msgTimestampSec = Number(msg.messageTimestamp) || 0;
          const msgTimeMs = msgTimestampSec * 1000;
          const sessionStartTime = clientState.connectedAt || (Date.now() - 30000);

          if (msgTimeMs > 0 && msgTimeMs < (sessionStartTime - 15000)) {
            // This message was sent before this connection / QR scan.
            // Ignore completely: "only chats from now and then onwards, don't sync old chats of closers"
            continue;
          }

          let existingLead = db.getLeadByNormalizedPhone(leadPhone);

          const closer = db.getCloserById(closerId);
          const closerRole = (closer?.role || '').toLowerCase();
          const isTM = closerRole === 'tm' || closerRole === 'member' || closerRole === 'closer';

          // =========================================================================
          // TM CAMPAIGN ISOLATION:
          // Team Members (TMs) must ONLY receive and view messages for Chatly campaigns!
          // Non-campaign/personal chats outside of campaigns are completely ignored for TMs.
          // TLs (Team Leaders) and Admins retain full duplex sync for both campaign and direct chats.
          // =========================================================================
          if (isTM) {
            if (!existingLead || !existingLead.campaign_id) {
              continue; // Skip non-campaign personal chats on TM's WhatsApp
            }
            if (existingLead.closer_id && existingLead.closer_id !== closerId) {
              continue; // Not assigned to this TM
            }
          }

          if (!existingLead) {
            // Only TLs (Team Leaders) and Admins create ad-hoc leads for direct WhatsApp chats
            db.insertLeads([{
              phone: leadPhone,
              normalized_phone: leadPhone,
              name: 'Contact ' + leadPhone.slice(-4),
              closer_id: closerId,
              status: 'ongoing'
            }]);
            existingLead = db.getLeadByNormalizedPhone(leadPhone);
          }

          const fromMe = Boolean(msg.key.fromMe);
          const text = innerMsg.conversation ||
            innerMsg.extendedTextMessage?.text ||
            innerMsg.imageMessage?.caption ||
            innerMsg.videoMessage?.caption ||
            innerMsg.buttonsResponseMessage?.selectedDisplayText ||
            innerMsg.templateButtonReplyMessage?.selectedDisplayText ||
            '';

          const mediaType = innerMsg.imageMessage ? 'image' :
            innerMsg.audioMessage ? 'audio' :
            innerMsg.videoMessage ? 'video' :
            innerMsg.documentMessage ? 'document' : 'text';

          let mediaUrl = '';
          let fileName = '';

          // Download media attachment if present
          if (mediaType !== 'text') {
            try {
              if (innerMsg.documentMessage?.fileName) {
                fileName = `${Date.now()}_${innerMsg.documentMessage.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
              } else if (mediaType === 'audio') {
                fileName = `vm_${Date.now()}.ogg`;
              } else if (mediaType === 'image') {
                fileName = `img_${Date.now()}.jpg`;
              } else if (mediaType === 'video') {
                fileName = `vid_${Date.now()}.mp4`;
              }

              const baileys = await this.initBaileysModule();
              const buffer = await baileys.downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                  logger: this.logger,
                  reuploadRequest: sock.updateMediaMessage
                }
              );

              if (buffer && buffer.length > 0) {
                const uploadsDir = path.resolve(__dirname, '../data/uploads');
                if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                const localPath = path.join(uploadsDir, fileName);
                fs.writeFileSync(localPath, buffer);
                mediaUrl = `/uploads/${fileName}`;
              }
            } catch (mediaErr) {
              console.warn(`[Baileys ${closerId}] Media download failed:`, mediaErr.message);
            }
          }

          const closerPhone = clientState.phone;
          const senderPhone = fromMe ? closerPhone : leadPhone;
          const receiverPhone = fromMe ? leadPhone : closerPhone;

          const savedMsgId = db.insertMessage({
            baileys_msg_id: msg.key.id,
            remote_jid: remoteJid,
            lead_phone: leadPhone,
            closer_id: closerId,
            from_me: fromMe,
            sender_phone: senderPhone,
            receiver_phone: receiverPhone,
            text,
            media_type: mediaType,
            media_url: mediaUrl,
            file_name: fileName,
            status: fromMe ? 'sent' : 'delivered',
            ack: fromMe ? 1 : 2,
            timestamp: Number(msg.messageTimestamp) * 1000 || Date.now()
          });

          // If incoming message from lead:
          if (!fromMe && existingLead) {
            if (existingLead.status !== 'replied') {
              db.updateLeadStatus(existingLead.id, 'replied');
              if (existingLead.campaign_id) {
                db.updateCampaignCounts(existingLead.campaign_id, { replied_count: 1 });
              }
            }
          }

          // Broadcast real-time message to ALL connected browser clients
          const msgPayload = {
            id: savedMsgId,
            baileysMsgId: msg.key.id,
            leadPhone,
            leadName: existingLead?.name || '',
            closerId,
            fromMe,
            text,
            mediaType,
            mediaUrl,
            fileName,
            timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
            ack: fromMe ? 1 : 2
          };

          wsManager.broadcast('new_message', msgPayload);
          wsManager.broadcast('conversations_updated', {
            leadPhone,
            closerId
          });

        } catch (err) {
          console.error(`[Baileys ${closerId}] Error handling message:`, err);
        }
      }
    });

    return this.getCloserStatus(closerId);
  }

  async disconnectCloser(closerId, wipe = true) {
    const client = this.clients.get(closerId);
    if (client) {
      try {
        if (client.sock) {
          if (wipe) {
            await client.sock.logout().catch(() => {});
          }
          client.sock.end(undefined);
        }
      } catch (_) {}
      this.clients.delete(closerId);
    }

    if (wipe) {
      const sessionDir = this.getCloserSessionDir(closerId);
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (_) {}
      db.updateCloserStatus(closerId, 'disconnected', '', '');
    } else {
      db.updateCloserStatus(closerId, 'disconnected', null, '');
    }

    wsManager.sendToCloser(closerId, 'closer_status', {
      closerId,
      status: 'disconnected',
      phone: '',
      qr: ''
    });

    return { success: true };
  }

  // Send real-time message via closer's connected WhatsApp
  async sendMessage({ closerId, toPhone, text, mediaUrl = null, mediaType = 'text', fileName = null }) {
    const client = this.clients.get(closerId);
    if (!client || client.status !== 'connected' || !client.sock) {
      throw new Error(`Closer WhatsApp is not connected.`);
    }

    const normPhone = normalizer.normalizePhone(toPhone);
    if (!normPhone) {
      throw new Error(`Invalid phone number: ${toPhone}`);
    }

    const jid = normalizer.phoneToJid(normPhone);

    // Simulate typing or recording for anti-ban realism
    try {
      await client.sock.presenceSubscribe(jid).catch(() => {});
      if (mediaType === 'audio') {
        await client.sock.sendPresenceUpdate('recording', jid).catch(() => {});
      } else {
        await client.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 450));
      await client.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    } catch (_) {}

    // Resolve local file path if mediaUrl is provided
    let localFilePath = null;
    if (mediaUrl) {
      if (typeof mediaUrl === 'string' && mediaUrl.startsWith('/uploads/')) {
        localFilePath = path.resolve(__dirname, '../data', mediaUrl.substring(1));
      } else if (typeof mediaUrl === 'string' && fs.existsSync(mediaUrl)) {
        localFilePath = mediaUrl;
      }
    }

    // Send payload
    let sentResult;
    if (localFilePath && fs.existsSync(localFilePath)) {
      const fileBuffer = fs.readFileSync(localFilePath);
      if (mediaType === 'audio') {
        // High quality voice message (PTT waveform)
        sentResult = await client.sock.sendMessage(jid, {
          audio: fileBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      } else if (mediaType === 'image') {
        sentResult = await client.sock.sendMessage(jid, {
          image: fileBuffer,
          caption: text || ''
        });
      } else if (mediaType === 'document') {
        sentResult = await client.sock.sendMessage(jid, {
          document: fileBuffer,
          mimetype: 'application/octet-stream',
          fileName: fileName || path.basename(localFilePath),
          caption: text || ''
        });
      } else {
        sentResult = await client.sock.sendMessage(jid, { text: text || '' });
      }
    } else if (mediaUrl && mediaType === 'image') {
      sentResult = await client.sock.sendMessage(jid, {
        image: { url: mediaUrl },
        caption: text || ''
      });
    } else {
      sentResult = await client.sock.sendMessage(jid, {
        text: text || ''
      });
    }

    const baileysId = sentResult?.key?.id;

    // Learn and cache LID mapping for this recipient if available
    if (client.sock?.signalRepository?.lidMapping?.getLIDForPN) {
      try {
        const recipientLid = await client.sock.signalRepository.lidMapping.getLIDForPN(jid);
        if (recipientLid) {
          const cleanLid = String(recipientLid).split('@')[0].split(':')[0].replace(/\D/g, '');
          db.saveLidMapping(cleanLid, normPhone, closerId);
        }
      } catch (_) {}
    }

    // Save in DB
    const msgId = db.insertMessage({
      baileys_msg_id: baileysId,
      remote_jid: jid,
      lead_phone: normPhone,
      closer_id: closerId,
      from_me: true,
      sender_phone: client.phone,
      receiver_phone: normPhone,
      text,
      media_type: mediaType,
      media_url: mediaUrl || '',
      file_name: fileName || '',
      status: 'sent',
      ack: 1,
      timestamp: Date.now()
    });

    // Save raw proto for Signal retry cache
    if (baileysId && sentResult.message) {
      db.saveRawMessage(baileysId, sentResult.message);
    }

    return {
      success: true,
      id: msgId,
      baileysMsgId: baileysId,
      timestamp: Date.now()
    };
  }

  // Restore all previously connected sessions on server boot
  async restoreAllSessions() {
    const closers = db.getClosers();
    for (const c of closers) {
      const sessionDir = this.getCloserSessionDir(c.id);
      const credsFile = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsFile)) {
        console.log(`[Baileys] Restoring saved session for closer ${c.name} (${c.id})...`);
        this.connectCloser(c.id).catch(err => {
          console.warn(`[Baileys] Session restore for ${c.id} failed:`, err.message);
        });
      }
    }
  }
}

const baileysManager = new BaileysManager();
module.exports = baileysManager;
