'use strict';

/**
 * Chatly Smart Campaign Dispatcher
 * 
 * Features:
 * - Round-robin lead balancing across all active connected Closers/TMs/TLs.
 * - Anti-ban human pacing with randomized jitter (e.g. 3-6s delay).
 * - Variable interpolation: {name}, {phone}, {closer_name}.
 * - Live real-time progress broadcast via WebSockets.
 * - Graceful failure recovery: If a closer drops, redistributes or safely pauses.
 */

const db = require('./db');
const normalizer = require('./normalizer');
const baileysManager = require('./baileys-manager');
const wsManager = require('./websocket');

class CampaignDispatcher {
  constructor() {
    this.activeJobs = new Map(); // campaignId -> { isRunning, isPaused, timeoutId }
  }

  // Parse raw lead input (CSV text, newline-separated, tab-separated)
  parseNumbersInput(rawText) {
    if (!rawText) return [];
    const lines = rawText.split(/\r?\n/);
    const leads = [];
    const seen = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Check if line contains comma or tab (e.g., "03001234567, Ali")
      let phonePart = trimmed;
      let namePart = '';

      if (trimmed.includes(',')) {
        const parts = trimmed.split(',');
        phonePart = parts[0].trim();
        namePart = parts.slice(1).join(',').trim();
      } else if (trimmed.includes('\t')) {
        const parts = trimmed.split('\t');
        phonePart = parts[0].trim();
        namePart = parts.slice(1).join(' ').trim();
      }

      const normalized = normalizer.normalizePhone(phonePart);
      if (normalized && normalized.length >= 10 && !seen.has(normalized)) {
        seen.add(normalized);
        leads.push({
          phone: phonePart,
          normalized_phone: normalized,
          name: namePart
        });
      }
    }
    return leads;
  }

  // Launch or queue a campaign
  async startCampaign(campaignId) {
    const campaign = db.getCampaignById(campaignId);
    if (!campaign) throw new Error('Campaign not found.');

    const connectedClosers = db.getConnectedClosers().filter(c => baileysManager.isCloserConnected(c.id));
    if (connectedClosers.length === 0) {
      throw new Error('No closers are currently connected. At least one Closer/TM must scan their QR code first.');
    }

    // Fetch pending leads
    const pendingLeads = db.getPendingLeadsForCampaign(campaignId);
    if (pendingLeads.length === 0) {
      db.updateCampaignStatus(campaignId, 'completed');
      return { success: true, message: 'All leads for this campaign have already been processed.' };
    }

    // Distribute pending leads round-robin across connected closers
    for (let i = 0; i < pendingLeads.length; i++) {
      const closer = connectedClosers[i % connectedClosers.length];
      db.assignLeadToCloser(pendingLeads[i].id, closer.id);
      pendingLeads[i].closer_id = closer.id;
    }

    db.updateCampaignStatus(campaignId, 'running');
    wsManager.broadcast('campaign_status_changed', { campaignId, status: 'running' });

    // Start asynchronous worker loop
    const job = { isRunning: true, isPaused: false };
    this.activeJobs.set(campaignId, job);

    this.runDispatcherLoop(campaignId, job).catch(err => {
      console.error(`[Dispatcher ${campaignId}] Error:`, err);
    });

    return {
      success: true,
      campaignId,
      assignedClosers: connectedClosers.map(c => ({ id: c.id, name: c.name, phone: c.phone })),
      totalPending: pendingLeads.length
    };
  }

  pauseCampaign(campaignId) {
    const job = this.activeJobs.get(campaignId);
    if (job) {
      job.isPaused = true;
      job.isRunning = false;
      if (job.timeoutId) clearTimeout(job.timeoutId);
      this.activeJobs.delete(campaignId);
    }
    db.updateCampaignStatus(campaignId, 'paused');
    wsManager.broadcast('campaign_status_changed', { campaignId, status: 'paused' });
    return { success: true };
  }

  async runDispatcherLoop(campaignId, job) {
    const campaign = db.getCampaignById(campaignId);
    if (!campaign) return;

    const baseDelay = Number(campaign.pacing_delay_ms) || 4000;

    while (job.isRunning) {
      // Get next pending lead
      const pendingLeads = db.getPendingLeadsForCampaign(campaignId);
      if (pendingLeads.length === 0) {
        db.updateCampaignStatus(campaignId, 'completed');
        wsManager.broadcast('campaign_status_changed', { campaignId, status: 'completed' });
        this.activeJobs.delete(campaignId);
        break;
      }

      const lead = pendingLeads[0];

      // Verify closer is still connected
      let closerId = lead.closer_id;
      if (!closerId || !baileysManager.isCloserConnected(closerId)) {
        // Re-assign to an active connected closer
        const activeClosers = db.getConnectedClosers().filter(c => baileysManager.isCloserConnected(c.id));
        if (activeClosers.length === 0) {
          console.warn(`[Dispatcher ${campaignId}] All closers disconnected. Pausing campaign.`);
          this.pauseCampaign(campaignId);
          break;
        }
        closerId = activeClosers[0].id;
        db.assignLeadToCloser(lead.id, closerId);
        lead.closer_id = closerId;
      }

      const closer = db.getCloserById(closerId);

      // Prepare personalized message
      let messageText = campaign.message_template || '';
      messageText = messageText
        .replace(/\{name\}/gi, lead.name || 'there')
        .replace(/\{phone\}/gi, lead.phone || '')
        .replace(/\{closer_name\}/gi, closer?.name || 'our team');

      // Dispatch via closer's WhatsApp
      try {
        db.updateLeadStatus(lead.id, 'queued');

        const sendResult = await baileysManager.sendMessage({
          closerId,
          toPhone: lead.normalized_phone,
          text: messageText,
          mediaUrl: campaign.media_url || null,
          mediaType: campaign.media_url ? 'image' : 'text'
        });

        db.updateLeadStatus(lead.id, 'sent');
        db.updateCampaignCounts(campaignId, { sent_count: 1 });

        // Broadcast progress
        wsManager.broadcast('campaign_progress', {
          campaignId,
          leadId: lead.id,
          phone: lead.normalized_phone,
          closerId,
          status: 'sent',
          stats: db.getCampaignById(campaignId)
        });

      } catch (err) {
        console.error(`[Dispatcher] Failed to send to ${lead.phone}:`, err.message);
        db.updateLeadStatus(lead.id, 'failed', err.message);
        db.updateCampaignCounts(campaignId, { failed_count: 1 });

        wsManager.broadcast('campaign_progress', {
          campaignId,
          leadId: lead.id,
          phone: lead.normalized_phone,
          closerId,
          status: 'failed',
          error: err.message,
          stats: db.getCampaignById(campaignId)
        });
      }

      // Safe anti-ban jitter delay (e.g. 4000ms ± 1500ms)
      const jitter = Math.floor(Math.random() * 2000) - 1000;
      const sleepTime = Math.max(2500, baseDelay + jitter);

      await new Promise(resolve => {
        job.timeoutId = setTimeout(resolve, sleepTime);
      });
    }
  }
}

const dispatcher = new CampaignDispatcher();
module.exports = dispatcher;
