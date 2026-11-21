'use strict';

/**
 * Chatly SQLite Database Engine
 * Powered by Node.js native node:sqlite DatabaseSync
 * Zero compilation dependencies, fully ACID compliant, atomic writes.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.resolve(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'chatly.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema with WAL mode for high concurrency
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS closers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT DEFAULT '',
    role TEXT DEFAULT 'closer', -- 'admin', 'tl', 'closer'
    status TEXT DEFAULT 'disconnected', -- 'disconnected', 'connecting', 'qr_ready', 'connected'
    qr_code TEXT DEFAULT '',
    linked_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'draft', -- 'draft', 'running', 'paused', 'completed'
    message_template TEXT NOT NULL,
    media_url TEXT DEFAULT '',
    total_leads INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    read_count INTEGER DEFAULT 0,
    replied_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    pacing_delay_ms INTEGER DEFAULT 4000,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    closer_id TEXT,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL,
    name TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', -- 'pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed'
    error_message TEXT DEFAULT '',
    last_message_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(normalized_phone);
  CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_leads_closer ON leads(closer_id);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    baileys_msg_id TEXT UNIQUE,
    remote_jid TEXT NOT NULL,
    lead_phone TEXT NOT NULL,
    closer_id TEXT NOT NULL,
    from_me INTEGER NOT NULL, -- 1 = sent by closer, 0 = received from lead
    sender_phone TEXT NOT NULL,
    receiver_phone TEXT NOT NULL,
    text TEXT DEFAULT '',
    media_type TEXT DEFAULT 'text',
    media_url TEXT DEFAULT '',
    status TEXT DEFAULT 'sent', -- 'pending', 'sent', 'delivered', 'read', 'failed'
    ack INTEGER DEFAULT 1,      -- 1 = sent (single tick), 2 = delivered (double tick), 3 = read (blue tick)
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_phone);
  CREATE INDEX IF NOT EXISTS idx_messages_closer ON messages(closer_id);
  CREATE INDEX IF NOT EXISTS idx_messages_baileys ON messages(baileys_msg_id);

  -- Signal protocol raw message store to prevent "Waiting for this message"
  CREATE TABLE IF NOT EXISTS raw_message_store (
    msg_id TEXT PRIMARY KEY,
    raw_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- WhatsApp LID to Phone mapping store for seamless Full-Duplex syncing
  CREATE TABLE IF NOT EXISTS lid_mappings (
    lid TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    closer_id TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lid_phone ON lid_mappings(phone);
`);

// Safe migrations for media and dossier fields
try { db.exec("ALTER TABLE messages ADD COLUMN file_name TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN deal_tier TEXT DEFAULT 'Nunno Pro'"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN deal_value INTEGER DEFAULT 5000"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN deal_commission INTEGER DEFAULT 1500"); } catch (_) {}
try { db.exec("ALTER TABLE leads ADD COLUMN notes TEXT DEFAULT ''"); } catch (_) {}

// Seed default closers if empty
const countClosers = db.prepare('SELECT COUNT(*) as count FROM closers').get();
if (countClosers.count === 0) {
  const now = Date.now();
  const insertCloser = db.prepare(`
    INSERT INTO closers (id, name, email, phone, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCloser.run('closer_1', 'Bilal Tariq (Closer)', 'bilal@chatly.pk', '', 'closer', 'disconnected', now, now);
  insertCloser.run('closer_2', 'Hamza Sheikh (TL)', 'hamza@chatly.pk', '', 'tl', 'disconnected', now, now);
  insertCloser.run('closer_3', 'Zainab Noor (Closer)', 'zainab@chatly.pk', '', 'closer', 'disconnected', now, now);
}

// Database Helpers
const dbService = {
  // Closers
  getClosers: () => {
    return db.prepare('SELECT id, name, email, phone, role, status, qr_code, linked_at, updated_at FROM closers ORDER BY role DESC, name ASC').all();
  },

  getCloserById: (id) => {
    return db.prepare('SELECT * FROM closers WHERE id = ?').get(id);
  },

  getConnectedClosers: () => {
    return db.prepare("SELECT * FROM closers WHERE status = 'connected'").all();
  },

  addCloser: ({ id, name, email, role = 'closer' }) => {
    const now = Date.now();
    const closerId = id || `closer_${Date.now()}`;
    db.prepare(`
      INSERT INTO closers (id, name, email, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'disconnected', ?, ?)
    `).run(closerId, name, email, role, now, now);
    return closerId;
  },

  updateCloserStatus: (id, status, phone = null, qr = null) => {
    const now = Date.now();
    let query = 'UPDATE closers SET status = ?, updated_at = ?';
    const params = [status, now];

    if (phone !== null) {
      query += ', phone = ?';
      params.push(phone);
    }
    if (qr !== null) {
      query += ', qr_code = ?';
      params.push(qr);
    }
    if (status === 'connected') {
      query += ', linked_at = ?';
      params.push(now);
    }
    query += ' WHERE id = ?';
    params.push(id);
    db.prepare(query).run(...params);
  },

  deleteCloser: (id) => {
    db.prepare('DELETE FROM closers WHERE id = ?').run(id);
  },

  // Campaigns
  getCampaigns: () => {
    return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  },

  getCampaignById: (id) => {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  },

  createCampaign: ({ id, name, messageTemplate, mediaUrl = '', pacingDelayMs = 4000 }) => {
    const now = Date.now();
    const campId = id || `camp_${Date.now()}`;
    db.prepare(`
      INSERT INTO campaigns (id, name, message_template, media_url, pacing_delay_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(campId, name, messageTemplate, mediaUrl, pacingDelayMs, now, now);
    return campId;
  },

  updateCampaignStatus: (id, status) => {
    db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  },

  updateCampaignCounts: (id, deltas) => {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(deltas)) {
      if (['total_leads', 'sent_count', 'delivered_count', 'read_count', 'replied_count', 'failed_count'].includes(key)) {
        updates.push(`${key} = ${key} + ?`);
        params.push(Number(val) || 0);
      }
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(id);
      db.prepare(`UPDATE campaigns SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  },

  // Leads
  insertLeads: (leads) => {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO leads (id, campaign_id, closer_id, phone, normalized_phone, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    db.exec('BEGIN TRANSACTION');
    try {
      for (const l of leads) {
        insert.run(
          l.id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          l.campaign_id || null,
          l.closer_id || null,
          l.phone,
          l.normalized_phone,
          l.name || '',
          now,
          now
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },

  getLeadsByCampaign: (campaignId) => {
    return db.prepare('SELECT * FROM leads WHERE campaign_id = ? ORDER BY created_at ASC').all(campaignId);
  },

  getPendingLeadsForCampaign: (campaignId) => {
    return db.prepare("SELECT * FROM leads WHERE campaign_id = ? AND status = 'pending' ORDER BY created_at ASC").all(campaignId);
  },

  getLeadByNormalizedPhone: (phone) => {
    if (!phone) return null;
    let clean = String(phone).trim().replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.slice(2);
    if (clean.startsWith('03') && clean.length === 11) clean = '92' + clean.slice(1);
    if (!clean) return null;
    let lead = db.prepare('SELECT * FROM leads WHERE normalized_phone = ? OR phone = ? ORDER BY last_message_at DESC LIMIT 1').get(clean, phone);
    if (lead) return lead;
    if (clean.length >= 9) {
      const suffix = clean.slice(-9);
      lead = db.prepare("SELECT * FROM leads WHERE normalized_phone LIKE '%' || ? OR phone LIKE '%' || ? ORDER BY last_message_at DESC LIMIT 1").get(suffix, suffix);
    }
    return lead;
  },

  updateLeadStatus: (id, status, errorMsg = '') => {
    const now = Date.now();
    db.prepare(`
      UPDATE leads 
      SET status = ?, error_message = ?, updated_at = ?, last_message_at = CASE WHEN ? IN ('sent', 'delivered', 'replied') THEN ? ELSE last_message_at END
      WHERE id = ?
    `).run(status, errorMsg, now, status, now, id);
  },

  assignLeadToCloser: (leadId, closerId) => {
    db.prepare('UPDATE leads SET closer_id = ?, updated_at = ? WHERE id = ?').run(closerId, Date.now(), leadId);
  },

  // WhatsApp LID Mappings
  saveLidMapping: (lid, phone, closerId = '') => {
    if (!lid || !phone) return;
    const cleanLid = String(lid).split('@')[0].split(':')[0].replace(/\D/g, '');
    let cleanPhone = String(phone).trim().replace(/\D/g, '');
    if (cleanPhone.startsWith('00')) cleanPhone = cleanPhone.slice(2);
    if (cleanPhone.startsWith('03') && cleanPhone.length === 11) cleanPhone = '92' + cleanPhone.slice(1);
    if (!cleanLid || !cleanPhone) return;
    db.prepare('INSERT OR REPLACE INTO lid_mappings (lid, phone, closer_id, updated_at) VALUES (?, ?, ?, ?)').run(cleanLid, cleanPhone, closerId || '', Date.now());
  },

  getPhoneForLid: (lid) => {
    if (!lid) return null;
    const cleanLid = String(lid).split('@')[0].split(':')[0].replace(/\D/g, '');
    const row = db.prepare('SELECT phone FROM lid_mappings WHERE lid = ?').get(cleanLid);
    return row ? row.phone : null;
  },

  getLidForPhone: (phone) => {
    if (!phone) return null;
    let cleanPhone = String(phone).trim().replace(/\D/g, '');
    if (cleanPhone.startsWith('00')) cleanPhone = cleanPhone.slice(2);
    if (cleanPhone.startsWith('03') && cleanPhone.length === 11) cleanPhone = '92' + cleanPhone.slice(1);
    const row = db.prepare('SELECT lid FROM lid_mappings WHERE phone = ?').get(cleanPhone);
    return row ? row.lid : null;
  },

  getMessageByBaileysId: (baileysMsgId) => {
    if (!baileysMsgId) return null;
    return db.prepare('SELECT * FROM messages WHERE baileys_msg_id = ?').get(baileysMsgId);
  },

  updateLeadDetails: (phone, fields = {}) => {
    const lead = dbService.getLeadByNormalizedPhone(phone);
    if (!lead) return null;
    const allowed = ['name', 'status', 'deal_tier', 'deal_value', 'deal_commission', 'notes', 'closer_id'];
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key) && val !== undefined) {
        sets.push(`${key} = ?`);
        params.push(val === null ? null : val);
      }
    }
    if (sets.length === 0) return lead;
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(lead.id);
    db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return dbService.getLeadByNormalizedPhone(phone);
  },

  deleteConversation: (phone) => {
    if (!phone) return;
    let clean = String(phone).trim().replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.slice(2);
    if (clean.startsWith('03') && clean.length === 11) clean = '92' + clean.slice(1);
    const suffix = clean && clean.length >= 9 ? clean.slice(-9) : clean;
    db.prepare("DELETE FROM messages WHERE lead_phone = ? OR lead_phone LIKE ?").run(clean, `%${suffix}`);
    db.prepare("DELETE FROM leads WHERE normalized_phone = ? OR normalized_phone LIKE ?").run(clean, `%${suffix}`);
  },

  // Messages (Full Duplex Conversations)
  insertMessage: (msg) => {
    const id = msg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = msg.timestamp || Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, baileys_msg_id, remote_jid, lead_phone, closer_id, from_me,
        sender_phone, receiver_phone, text, media_type, media_url, file_name, status, ack, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      msg.baileys_msg_id || id,
      msg.remote_jid || (msg.lead_phone ? `${msg.lead_phone}@s.whatsapp.net` : ''),
      msg.lead_phone || '',
      msg.closer_id || null,
      msg.from_me ? 1 : 0,
      msg.sender_phone || '',
      msg.receiver_phone || '',
      msg.text || '',
      msg.media_type || 'text',
      msg.media_url || '',
      msg.file_name || '',
      msg.status || (msg.from_me ? 'sent' : 'received'),
      msg.ack || 1,
      now
    );

    // Update lead's last_message_at
    db.prepare('UPDATE leads SET last_message_at = ?, updated_at = ? WHERE normalized_phone = ?')
      .run(now, now, msg.lead_phone);

    return id;
  },

  updateMessageAck: (baileysMsgId, ack) => {
    const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
    const status = statusMap[ack] || 'sent';
    db.prepare('UPDATE messages SET ack = MAX(ack, ?), status = ? WHERE baileys_msg_id = ?').run(ack, status, baileysMsgId);
  },

  getMessagesForLead: (leadPhone, closerId = null) => {
    if (!leadPhone) return [];
    let clean = String(leadPhone).trim().replace(/\D/g, '');
    if (clean.startsWith('00')) clean = clean.slice(2);
    if (clean.startsWith('03') && clean.length === 11) clean = '92' + clean.slice(1);
    const suffix = clean && clean.length >= 9 ? clean.slice(-9) : clean;
    let query = 'SELECT * FROM messages WHERE (lead_phone = ? OR lead_phone LIKE ?)';
    const params = [clean, `%${suffix}`];
    if (closerId) {
      query += ' AND closer_id = ?';
      params.push(closerId);
    }
    query += ' ORDER BY timestamp ASC';
    return db.prepare(query).all(...params);
  },

  // Active Chatly Conversations List (STRICT FILTER: ONLY Chatly leads!)
  getConversations: (closerId = null) => {
    let query = `
      SELECT 
        l.id as lead_id,
        l.normalized_phone as phone,
        l.name as lead_name,
        l.status as lead_status,
        l.campaign_id,
        l.deal_tier,
        l.deal_value,
        l.deal_commission,
        l.notes,
        c.name as campaign_name,
        l.closer_id,
        cl.name as closer_name,
        m.text as last_message_text,
        m.media_type as last_message_media_type,
        m.file_name as last_message_file_name,
        m.timestamp as last_message_time,
        m.from_me as last_message_from_me,
        m.ack as last_message_ack,
        (SELECT COUNT(*) FROM messages unread WHERE unread.lead_phone = l.normalized_phone AND unread.from_me = 0 AND unread.ack < 3) as unread_count
      FROM leads l
      LEFT JOIN campaigns c ON l.campaign_id = c.id
      LEFT JOIN closers cl ON l.closer_id = cl.id
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE lead_phone = l.normalized_phone ORDER BY timestamp DESC LIMIT 1
      )
      WHERE l.status != 'pending' OR m.id IS NOT NULL
    `;
    const params = [];
    if (closerId) {
      query += ' AND l.closer_id = ?';
      params.push(closerId);
    }
    query += ' ORDER BY COALESCE(m.timestamp, l.last_message_at, l.created_at) DESC';
    return db.prepare(query).all(...params);
  },

  // Signal Retry Store (Protects against "Waiting for this message")
  saveRawMessage: (msgId, rawPayload) => {
    try {
      const serialized = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      db.prepare('INSERT OR REPLACE INTO raw_message_store (msg_id, raw_payload, created_at) VALUES (?, ?, ?)')
        .run(msgId, serialized, Date.now());
      // Prune messages older than 7 days
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM raw_message_store WHERE created_at < ?').run(weekAgo);
    } catch (_) {}
  },

  getRawMessage: (msgId) => {
    try {
      const row = db.prepare('SELECT raw_payload FROM raw_message_store WHERE msg_id = ?').get(msgId);
      if (row && row.raw_payload) {
        return JSON.parse(row.raw_payload);
      }
    } catch (_) {}
    return null;
  },

  // Stats for Admin Dashboard
  getDashboardStats: () => {
    const totalClosers = db.prepare('SELECT COUNT(*) as count FROM closers').get().count;
    const connectedClosers = db.prepare("SELECT COUNT(*) as count FROM closers WHERE status = 'connected'").get().count;
    const totalLeads = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
    const sentLeads = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status IN ('sent', 'delivered', 'read', 'replied')").get().count;
    const deliveredLeads = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status IN ('delivered', 'read', 'replied')").get().count;
    const readLeads = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status IN ('read', 'replied')").get().count;
    const repliedLeads = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'replied'").get().count;

    return {
      totalClosers,
      connectedClosers,
      totalLeads,
      sentLeads,
      deliveredLeads,
      readLeads,
      repliedLeads,
      deliveryRate: sentLeads > 0 ? Math.round((deliveredLeads / sentLeads) * 100) : 0,
      replyRate: sentLeads > 0 ? Math.round((repliedLeads / sentLeads) * 100) : 0
    };
  }
};

module.exports = dbService;
