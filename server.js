'use strict';

/**
 * Chatly — Next-Gen WhatsApp Marketing & Closer Communication Platform
 * Remade from scratch for 100% Reliability, Full-Duplex Speed, and Clean Simplicity.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const db = require('./lib/db');
const normalizer = require('./lib/normalizer');
const wsManager = require('./lib/websocket');
const baileysManager = require('./lib/baileys-manager');
const dispatcher = require('./lib/campaign-dispatcher');
const { setupApiAdapter } = require('./lib/chatly-api-adapter');

const app = express();
const server = http.createServer(app);

// Initialize WebSockets
wsManager.initialize(server);

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Ensure upload directory exists
const UPLOADS_DIR = path.resolve(__dirname, 'data/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// Mount Authentic Chatly API Compatibility Adapter
setupApiAdapter(app, {
  db,
  baileysManager,
  normalizer,
  wsManager,
  uploadsDir: UPLOADS_DIR
});

// Root & Auth Routing: Always serve the marketing homepage (login.html) on /
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/login.html'));
});

// Static assets (disable auto index.html to allow / to serve homepage)
app.use(express.static(path.resolve(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ==========================================
// REST API ROUTES
// ==========================================

// 1. Health & Dashboard Stats
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    name: 'Chatly WhatsApp Marketing Platform',
    version: '2.0.0',
    engine: 'Baileys Pure WebSocket (No Chromium)',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getDashboardStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Closer / TM / TL Management
app.get('/api/closers', (req, res) => {
  try {
    const closers = db.getClosers().map(c => {
      const liveStatus = baileysManager.getCloserStatus(c.id);
      return {
        ...c,
        status: liveStatus.status || c.status,
        phone: liveStatus.phone || c.phone,
        qr_code: liveStatus.qr || c.qr_code
      };
    });
    res.json({ success: true, closers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/closers', (req, res) => {
  try {
    const { name, email, role } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' });
    }
    const id = db.addCloser({ name, email, role });
    res.json({ success: true, id, message: 'Closer registered successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/closers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await baileysManager.disconnectCloser(id, true);
    db.deleteCloser(id);
    res.json({ success: true, message: 'Closer removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. WhatsApp Baileys Linking for Closers (QR Code Scan)
app.post('/api/closers/:id/connect', async (req, res) => {
  try {
    const { id } = req.params;
    const closer = db.getCloserById(id);
    if (!closer) {
      return res.status(404).json({ success: false, message: 'Closer not found.' });
    }
    const status = await baileysManager.connectCloser(id);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/closers/:id/disconnect', async (req, res) => {
  try {
    const { id } = req.params;
    const wipe = req.body.wipe !== false;
    await baileysManager.disconnectCloser(id, wipe);
    res.json({ success: true, message: 'Closer WhatsApp disconnected.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/closers/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const status = baileysManager.getCloserStatus(id);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Campaign Dispatcher
app.get('/api/campaigns', (req, res) => {
  try {
    const campaigns = db.getCampaigns();
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/campaigns/:id', (req, res) => {
  try {
    const campaign = db.getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    const leads = db.getLeadsByCampaign(req.params.id);
    res.json({ success: true, campaign, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create campaign & import leads
app.post('/api/campaigns', (req, res) => {
  try {
    const { name, messageTemplate, rawNumbers, mediaUrl, pacingDelayMs } = req.body;
    if (!name || !messageTemplate) {
      return res.status(400).json({ success: false, message: 'Campaign name and message template are required.' });
    }

    const parsedLeads = dispatcher.parseNumbersInput(rawNumbers || '');
    if (parsedLeads.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid phone numbers found in the input.' });
    }

    const campaignId = db.createCampaign({
      name,
      messageTemplate,
      mediaUrl: mediaUrl || '',
      pacingDelayMs: Number(pacingDelayMs) || 4000
    });

    // Attach campaign_id to parsed leads
    for (const lead of parsedLeads) {
      lead.campaign_id = campaignId;
    }

    db.insertLeads(parsedLeads);
    db.updateCampaignCounts(campaignId, { total_leads: parsedLeads.length });

    res.json({
      success: true,
      campaignId,
      totalLeads: parsedLeads.length,
      message: `Campaign created with ${parsedLeads.length} valid target leads!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start campaign dispatcher
app.post('/api/campaigns/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await dispatcher.startCampaign(id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Pause campaign dispatcher
app.post('/api/campaigns/:id/pause', (req, res) => {
  try {
    const { id } = req.params;
    const result = dispatcher.pauseCampaign(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Full Duplex Conversations & Real-Time Inbox
// STRICT FILTER: Returns ONLY leads from Chatly campaigns/conversations!
app.get('/api/conversations', (req, res) => {
  try {
    const closerId = req.query.closer_id || null;
    const conversations = db.getConversations(closerId);
    res.json({ success: true, conversations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Message history with a lead
app.get('/api/conversations/:phone/messages', (req, res) => {
  try {
    const { phone } = req.params;
    const normPhone = normalizer.normalizePhone(phone);
    const closerId = req.query.closer_id || null;
    const messages = db.getMessagesForLead(normPhone, closerId);
    const lead = db.getLeadByNormalizedPhone(normPhone);

    res.json({
      success: true,
      lead: lead || { phone: normPhone, name: 'Lead' },
      messages
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Send a direct message to a lead via Closer's WhatsApp
app.post('/api/messages/send', async (req, res) => {
  try {
    const { closerId, toPhone, text, mediaUrl, mediaType, fileName } = req.body;
    if (!closerId || !toPhone || (!text && !mediaUrl)) {
      return res.status(400).json({ success: false, message: 'Closer ID, destination phone, and message text/media are required.' });
    }

    const normPhone = normalizer.normalizePhone(toPhone);

    // Ensure lead exists in Chatly leads table so replies are tracked
    let lead = db.getLeadByNormalizedPhone(normPhone);
    if (!lead) {
      db.insertLeads([{
        phone: toPhone,
        normalized_phone: normPhone,
        name: 'Manual Contact',
        closer_id: closerId
      }]);
    }

    const result = await baileysManager.sendMessage({
      closerId,
      toPhone: normPhone,
      text,
      mediaUrl,
      mediaType: mediaType || (mediaUrl ? 'image' : 'text'),
      fileName: fileName || null
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Lead CRM endpoints (Status matrix, deal value, tier, notes, rename)
app.put('/api/leads/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    const normPhone = normalizer.normalizePhone(phone);
    const updated = db.updateLeadDetails(normPhone, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    wsManager.broadcast('conversations_updated', { leadPhone: normPhone });
    res.json({ success: true, lead: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/leads/:phone/notes', (req, res) => {
  try {
    const { phone } = req.params;
    const { notes } = req.body;
    const normPhone = normalizer.normalizePhone(phone);
    const updated = db.updateLeadDetails(normPhone, { notes });
    res.json({ success: true, lead: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/conversations/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    const normPhone = normalizer.normalizePhone(phone);
    db.deleteConversation(normPhone);
    wsManager.broadcast('conversations_updated', { leadPhone: normPhone, deleted: true });
    res.json({ success: true, message: 'Conversation deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// File upload endpoint for campaign images, voice notes, and document attachments
app.post('/api/upload', upload.single('media'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, fileUrl, filename: req.file.filename, originalname: req.file.originalname });
});

// Dedicated Company Admin (/cc) & Super Admin (/ss) Portal Routes
app.get(['/cc', '/admin', '/cc.html', '/admin.php'], (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/cc.html'));
});

app.get(['/ss', '/sadmin', '/ss.html', '/sadmin.php'], (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/ss.html'));
});

// Closer quota limit update (for /cc company admin)
app.put('/api/closers/:id/limit', (req, res) => {
  try {
    const { id } = req.params;
    const { limit } = req.body;
    // Store in settings or memory
    res.json({ success: true, closerId: id, limit: Number(limit) || 150 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Homepage, Landing & Login Routes
app.get(['/login', '/login.html', '/login.php', '/home', '/logout'], (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/login.html'));
});

// Workspace, Sales Desk & Inbox Routes
app.get(['/desk', '/app', '/inbox', '/inbox.html', '/index.html', '/index.php'], (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/index.html'));
});

// Fallback: If no other route matches, serve homepage login.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public/login.html'));
});

// Server Initialization
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`  ⚡ CHATLY 2.0 — HIGH-SPEED WHATSAPP MARKETING CRM   `);
  console.log(`  🚀 Server listening on http://localhost:${PORT}     `);
  console.log(`  🔌 WebSockets ready on ws://localhost:${PORT}/ws   `);
  console.log(`  📱 Baileys Engine: Pure WebSocket (Zero Chromium)  `);
  console.log(`======================================================\n`);

  // Auto-restore previous sessions
  baileysManager.restoreAllSessions().catch(console.error);
});

// Process crash safety
process.on('uncaughtException', (err) => {
  console.error('[Chatly Server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Chatly Server] Unhandled Rejection:', reason);
});
