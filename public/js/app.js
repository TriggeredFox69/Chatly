'use strict';

/**
 * Chatly — Next-Gen Full-Duplex Closing Platform
 * Complete client application powering:
 * 1. Full-Duplex WebSocket Live Inbox (Instant incoming/outgoing, delivery ticks, no page refresh)
 * 2. High-Quality Audio VMs (MediaRecorder opus recording, WhatsApp waveform audio player, 1x/1.5x/2x speed)
 * 3. File Attachments (Images with full-res Lightbox modal, documents with download cards)
 * 4. 3-Pane Messenger with Lead CRM Dossier Drawer & Private Notes
 * 5. Campaign Dispatcher (Multi-device simultaneous batch sending)
 * 6. Executive My Stats (Bento KPIs, live WhatsApp QR linking)
 * 7. 4-Role Gateway (/cc Company Admin, /ss Super Admin, TMs Closers, TLs Team Leaders)
 */

const state = {
  activeRole: 'closer',
  activeCloserId: null,
  activeLeadPhone: null,
  activeLead: null,
  conversations: [],
  currentFilter: 'all',
  searchQuery: '',
  campaigns: [],
  closers: [],
  ws: null,
  audioRecorder: null,
  audioChunks: [],
  recordingInterval: null,
  recordingSeconds: 0,
  currentAudioObj: null,
  currentPlayBtn: null,
  notesSaveTimer: null
};

// ==========================================
// 1. WEBSOCKET REAL-TIME ENGINE
// ==========================================
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    console.log('⚡ Chatly Full-Duplex WebSocket Connected');
    sendWsSubscription();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (e) {
      console.error('WS Parse Error:', e);
    }
  };

  ws.onclose = () => {
    console.warn('WS Disconnected. Auto-reconnecting in 2.5s...');
    setTimeout(initWebSocket, 2500);
  };
}

function sendWsSubscription() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'subscribe',
      role: state.activeRole,
      closerId: state.activeCloserId
    }));
  }
}

function handleWsEvent({ type, payload }) {
  switch (type) {
    case 'closer_qr':
      renderQrModal(payload.qr);
      break;

    case 'closer_status':
      updateConnectedPill(payload.status, payload.phone);
      loadClosers();
      break;

    case 'new_message':
      handleIncomingLiveMessage(payload);
      break;

    case 'message_ack':
      handleMessageAck(payload);
      break;

    case 'conversations_updated':
      loadConversations();
      break;

    case 'campaign_progress':
      appendCampaignLog(`[DISPATCH] Sent to +${payload.phone} (Batch: ${payload.sent}/${payload.total})`);
      break;
  }
}

// ==========================================
// 2. LIVE INBOX & MESSAGES
// ==========================================
async function loadConversations() {
  try {
    const url = state.activeCloserId
      ? `/api/conversations?closer_id=${encodeURIComponent(state.activeCloserId)}`
      : '/api/conversations';
    const res = await fetch(url).then(r => r.json());
    if (res.success) {
      state.conversations = res.conversations || [];
      renderConversationsList();
      updateUnreadBadge();
    }
  } catch (err) {
    console.error('Error loading conversations:', err);
  }
}

function renderConversationsList() {
  const container = document.getElementById('conversationsScroll');
  if (!container) return;

  let filtered = state.conversations;

  // Filter pills
  if (state.currentFilter === 'fresh') {
    filtered = filtered.filter(c => (c.lead_status || 'fresh') === 'fresh');
  } else if (state.currentFilter === 'ongoing') {
    filtered = filtered.filter(c => c.lead_status === 'ongoing' || c.lead_status === 'replied');
  } else if (state.currentFilter === 'pending_verification') {
    filtered = filtered.filter(c => c.lead_status === 'pending_verification');
  } else if (state.currentFilter === 'paid') {
    filtered = filtered.filter(c => c.lead_status === 'paid');
  } else if (state.currentFilter === 'useless') {
    filtered = filtered.filter(c => c.lead_status === 'useless');
  } else if (state.currentFilter === 'mine') {
    if (state.activeCloserId) {
      filtered = filtered.filter(c => c.closer_id === state.activeCloserId);
    }
  }

  // Search query
  if (state.searchQuery.trim()) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(c => (c.phone && c.phone.includes(q)) || (c.lead_name && c.lead_name.toLowerCase().includes(q)));
  }

  document.getElementById('convTotalBadge').textContent = `${filtered.length} Leads`;
  const ongoingCount = state.conversations.filter(c => c.lead_status === 'ongoing' || c.lead_status === 'replied').length;
  document.getElementById('myOngoingCountBadge').textContent = ongoingCount;

  if (filtered.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:12px;">No leads found in this view.</div>`;
    return;
  }

  container.innerHTML = filtered.map(c => {
    const isSelected = state.activeLeadPhone === c.phone;
    const initials = (c.lead_name || 'Lead').substring(0, 2).toUpperCase();
    const status = c.lead_status || 'ongoing';
    const statusClass = status === 'paid' ? 'status-paid' : status === 'replied' || status === 'ongoing' ? 'status-ongoing' : status === 'fresh' ? 'status-fresh' : 'status-pending';

    let lastText = c.last_message_text || 'No messages yet';
    if (c.last_message_media_type === 'audio') lastText = '🎙️ Voice note';
    else if (c.last_message_media_type === 'image') lastText = '📷 Photo';
    else if (c.last_message_media_type === 'document') lastText = '📄 Document';

    let ackHtml = '';
    if (c.last_message_from_me) {
      const ack = c.last_message_ack || 1;
      if (ack >= 3) ackHtml = `<span style="color:#38bdf8; font-size:11px; margin-right:3px;">✓✓</span>`;
      else if (ack === 2) ackHtml = `<span style="color:#94a3b8; font-size:11px; margin-right:3px;">✓✓</span>`;
      else ackHtml = `<span style="color:#94a3b8; font-size:11px; margin-right:3px;">✓</span>`;
    }

    const timeStr = c.last_message_time ? formatMessageTime(c.last_message_time) : '';

    return `
      <div class="conv-item ${isSelected ? 'selected' : ''}" onclick="selectConversation('${c.phone}')" style="cursor:pointer;">
        <div class="conv-avatar-wrap" style="position:relative;">
          <span class="avatar-initials">${initials}</span>
          <div class="lead-status-dot ${statusClass}"></div>
        </div>
        <div class="conv-body">
          <div class="conv-top-row">
            <span class="conv-name">+${escapeHtml(c.phone)}</span>
            <span class="conv-time">${timeStr}</span>
          </div>
          <div class="conv-snippet-row">
            <span class="conv-snippet">${ackHtml}${escapeHtml(lastText)}</span>
            ${c.unread_count > 0 ? `<span class="badge-unread">${c.unread_count}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function selectConversation(phone) {
  state.activeLeadPhone = phone;
  renderConversationsList();

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/messages`).then(r => r.json());
    if (res.success) {
      state.activeLead = res.lead;
      renderActiveChat(res.lead, res.messages || []);
      populateLeadDossier(res.lead);
    }
  } catch (err) {
    console.error('Error opening conversation:', err);
  }
}

function renderActiveChat(lead, messages) {
  const area = document.getElementById('chatMessagesArea');
  if (!area) return;

  // Header Details
  document.getElementById('chatLeadName').textContent = lead.name || 'Lead';
  document.getElementById('chatLeadPhone').textContent = `+${lead.phone}`;
  document.getElementById('chatLeadAvatar').textContent = (lead.name || 'LD').substring(0, 2).toUpperCase();

  const statusBadge = document.getElementById('chatLeadStatusBadge');
  const status = lead.status || 'ongoing';
  statusBadge.textContent = status === 'paid' ? '🟢 Paid' : status === 'pending_verification' ? '⚪ Review' : status === 'useless' ? '🔵 Won\'t Pay' : status === 'fresh' ? '🔴 Fresh' : '🟡 Ongoing';
  statusBadge.className = `status-pill-clean ${status}`;

  if (messages.length === 0) {
    area.innerHTML = `<div style="text-align:center; margin:auto; color:var(--text-muted); font-size:12.5px;">No message history with +${lead.phone}. Type below to send a message.</div>`;
    return;
  }

  area.innerHTML = messages.map((m, idx) => renderMessageBubble(m, idx)).join('');
  area.scrollTop = area.scrollHeight;
}

function renderMessageBubble(msg, idx = 0) {
  const fromMe = Boolean(msg.from_me === 1 || msg.from_me === true || msg.fromMe);
  const bubbleClass = fromMe ? 'msg-bubble msg-outbound' : 'msg-bubble msg-inbound';
  const timeStr = formatMessageTime(msg.timestamp);

  let ackHtml = '';
  if (fromMe) {
    const ack = msg.ack || 1;
    if (ack >= 3) ackHtml = `<span class="msg-ack-icon" id="ack_${msg.baileys_msg_id || msg.id}" style="color:#38bdf8; font-weight:700;">✓✓</span>`;
    else if (ack === 2) ackHtml = `<span class="msg-ack-icon" id="ack_${msg.baileys_msg_id || msg.id}" style="color:#94a3b8; font-weight:700;">✓✓</span>`;
    else ackHtml = `<span class="msg-ack-icon" id="ack_${msg.baileys_msg_id || msg.id}" style="color:#94a3b8; font-weight:700;">✓</span>`;
  }

  // 1. Audio Voice Note (WhatsApp PTT with waveform player)
  if (msg.media_type === 'audio' || msg.mediaType === 'audio') {
    const audioUrl = msg.media_url || msg.mediaUrl || '';
    const barsId = `bars_${msg.id || idx}`;
    const timerId = `timer_${msg.id || idx}`;

    return `
      <div class="${bubbleClass} msg-audio-bubble" id="msg_${msg.id || idx}">
        <div class="voice-player">
          <button type="button" class="vn-play-btn" onclick="togglePlayAudio(this, '${audioUrl}', '${barsId}', '${timerId}')">
            ▶
          </button>
          <div class="vn-body">
            <div class="vn-waveform-track">
              <div class="vn-waveform-bars" id="${barsId}">
                ${generateWaveformBars()}
              </div>
            </div>
            <div class="vn-info-row">
              <span class="vn-timer" id="${timerId}">0:00</span>
              <button type="button" class="vn-speed-btn" onclick="toggleAudioSpeed(this)">1x</button>
            </div>
          </div>
          <div class="vn-mic-badge-wrap">
            <span style="font-size:18px;">🎙️</span>
          </div>
        </div>
        <div class="msg-meta" style="display:flex; justify-content:flex-end; align-items:center; gap:4px; margin-top:2px; font-size:10.5px; opacity:0.75;">
          <span>${timeStr}</span>
          ${ackHtml}
        </div>
      </div>
    `;
  }

  // 2. Image Attachment
  if (msg.media_type === 'image' || msg.mediaType === 'image') {
    const imgUrl = msg.media_url || msg.mediaUrl || '';
    return `
      <div class="${bubbleClass}" id="msg_${msg.id || idx}" style="padding:6px; max-width:320px;">
        <img src="${imgUrl}" alt="Photo" onclick="openImageLightbox('${imgUrl}')" style="width:100%; border-radius:8px; cursor:pointer; display:block; box-shadow:0 2px 8px rgba(0,0,0,0.2);">
        ${msg.text ? `<div style="padding:6px 6px 2px; font-size:13px; line-height:1.4;">${escapeHtml(msg.text)}</div>` : ''}
        <div class="msg-meta" style="display:flex; justify-content:flex-end; align-items:center; gap:4px; padding:2px 4px 0; font-size:10.5px; opacity:0.75;">
          <span>${timeStr}</span>
          ${ackHtml}
        </div>
      </div>
    `;
  }

  // 3. Document Attachment
  if (msg.media_type === 'document' || msg.mediaType === 'document') {
    const docUrl = msg.media_url || msg.mediaUrl || '';
    const fileName = msg.file_name || msg.fileName || 'Attachment Document';
    return `
      <div class="${bubbleClass}" id="msg_${msg.id || idx}" style="max-width:340px;">
        <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.15); padding:8px 12px; border-radius:8px;">
          <span style="font-size:24px;">📄</span>
          <div style="flex:1; min-width:0;">
            <div style="font-size:12.5px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(fileName)}</div>
            <a href="${docUrl}" download="${fileName}" style="color:var(--accent-brand, #1fe08a); font-size:11px; text-decoration:none; font-weight:700;">⬇ Download File</a>
          </div>
        </div>
        ${msg.text ? `<div style="margin-top:6px; font-size:13px; line-height:1.4;">${escapeHtml(msg.text)}</div>` : ''}
        <div class="msg-meta" style="display:flex; justify-content:flex-end; align-items:center; gap:4px; margin-top:4px; font-size:10.5px; opacity:0.75;">
          <span>${timeStr}</span>
          ${ackHtml}
        </div>
      </div>
    `;
  }

  // 4. Standard Text Message
  return `
    <div class="${bubbleClass}" id="msg_${msg.id || idx}">
      <div class="msg-text" style="font-size:13px; line-height:1.45; white-space:pre-wrap; word-break:break-word;">${escapeHtml(msg.text || '')}</div>
      <div class="msg-meta" style="display:flex; justify-content:flex-end; align-items:center; gap:4px; margin-top:3px; font-size:10.5px; opacity:0.75;">
        <span>${timeStr}</span>
        ${ackHtml}
      </div>
    </div>
  `;
}

function generateWaveformBars() {
  const heights = [12, 18, 8, 22, 14, 26, 16, 20, 10, 24, 18, 12, 28, 14, 20, 8, 16, 22, 18, 10, 24, 14, 20, 12, 18, 8, 14, 10];
  return heights.map(h => `<span class="vn-bar" style="height:${h}px;"></span>`).join('');
}

// Live full-duplex incoming handler
function handleIncomingLiveMessage(payload) {
  playChime();

  if (state.activeLeadPhone && state.activeLeadPhone === payload.leadPhone) {
    const area = document.getElementById('chatMessagesArea');
    if (area) {
      const bubbleHtml = renderMessageBubble({
        id: payload.id,
        baileys_msg_id: payload.baileysMsgId,
        from_me: payload.fromMe ? 1 : 0,
        text: payload.text,
        media_type: payload.mediaType,
        media_url: payload.mediaUrl,
        file_name: payload.fileName,
        timestamp: payload.timestamp,
        ack: payload.ack
      });
      area.insertAdjacentHTML('beforeend', bubbleHtml);
      area.scrollTop = area.scrollHeight;
    }
  }

  loadConversations();
}

// Real-time delivery tick update
function handleMessageAck(payload) {
  const ackEl = document.getElementById(`ack_${payload.baileysMsgId}`);
  if (ackEl) {
    if (payload.ack >= 3) {
      ackEl.textContent = '✓✓';
      ackEl.style.color = '#38bdf8';
    } else if (payload.ack === 2) {
      ackEl.textContent = '✓✓';
      ackEl.style.color = '#94a3b8';
    }
  }
}

// ==========================================
// 3. MESSAGE SENDING (TEXT, VOICE NOTES, FILES)
// ==========================================
async function sendTextMessage() {
  const input = document.getElementById('chatInput');
  const text = (input?.value || '').trim();
  if (!text || !state.activeLeadPhone) return;

  input.value = '';

  const closerId = getActiveOrFirstConnectedCloserId();
  if (!closerId) {
    alert('No WhatsApp device is connected. Scan QR code to connect your phone.');
    openConnectWaModal();
    return;
  }

  try {
    const res = await fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        closerId,
        toPhone: state.activeLeadPhone,
        text,
        mediaType: 'text'
      })
    }).then(r => r.json());

    if (res.success) {
      // Append optimistically
      const area = document.getElementById('chatMessagesArea');
      if (area) {
        area.insertAdjacentHTML('beforeend', renderMessageBubble({
          id: res.id,
          baileys_msg_id: res.baileysMsgId,
          from_me: 1,
          text,
          media_type: 'text',
          timestamp: Date.now(),
          ack: 1
        }));
        area.scrollTop = area.scrollHeight;
      }
      loadConversations();
    } else {
      alert('Could not send message: ' + res.message);
    }
  } catch (err) {
    console.error('Send error:', err);
  }
}

async function sendMediaMessage(mediaUrl, mediaType, fileName = null) {
  if (!state.activeLeadPhone) return;
  const closerId = getActiveOrFirstConnectedCloserId();
  if (!closerId) {
    alert('Please connect your WhatsApp device before sending media.');
    openConnectWaModal();
    return;
  }

  try {
    const res = await fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        closerId,
        toPhone: state.activeLeadPhone,
        text: '',
        mediaUrl,
        mediaType,
        fileName
      })
    }).then(r => r.json());

    if (res.success) {
      const area = document.getElementById('chatMessagesArea');
      if (area) {
        area.insertAdjacentHTML('beforeend', renderMessageBubble({
          id: res.id,
          baileys_msg_id: res.baileysMsgId,
          from_me: 1,
          text: '',
          media_type: mediaType,
          media_url: mediaUrl,
          file_name: fileName,
          timestamp: Date.now(),
          ack: 1
        }));
        area.scrollTop = area.scrollHeight;
      }
      loadConversations();
    } else {
      alert('Error sending attachment: ' + res.message);
    }
  } catch (err) {
    console.error('Media send error:', err);
  }
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
}

function sendQuickReply(text) {
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = text;
    sendTextMessage();
  }
}

// ==========================================
// 4. HIGH-QUALITY AUDIO VM RECORDING & PLAYBACK
// ==========================================
async function toggleVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.audioRecorder = new MediaRecorder(stream);

    state.audioRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.audioRecorder.start();
    state.recordingSeconds = 0;
    document.getElementById('recordingTimer').textContent = '0:00';
    document.getElementById('composerNormalView').style.display = 'none';
    document.getElementById('composerRecordingView').style.display = 'flex';

    state.recordingInterval = setInterval(() => {
      state.recordingSeconds++;
      const mins = Math.floor(state.recordingSeconds / 60);
      const secs = String(state.recordingSeconds % 60).padStart(2, '0');
      document.getElementById('recordingTimer').textContent = `${mins}:${secs}`;
    }, 1000);
  } catch (err) {
    alert('Microphone access is required to record voice notes: ' + err.message);
  }
}

function discardVoiceRecording() {
  if (state.audioRecorder && state.audioRecorder.state !== 'inactive') {
    state.audioRecorder.stop();
    state.audioRecorder.stream.getTracks().forEach(t => t.stop());
  }
  clearInterval(state.recordingInterval);
  document.getElementById('composerRecordingView').style.display = 'none';
  document.getElementById('composerNormalView').style.display = 'flex';
}

async function stopAndSendVoiceRecording() {
  if (!state.audioRecorder || state.audioRecorder.state === 'inactive') return;

  state.audioRecorder.onstop = async () => {
    const audioBlob = new Blob(state.audioChunks, { type: 'audio/ogg; codecs=opus' });
    const formData = new FormData();
    formData.append('media', audioBlob, `vm_${Date.now()}.ogg`);

    try {
      const upRes = await fetch('/api/upload', { method: 'POST', body: formData }).then(r => r.json());
      if (upRes.success) {
        await sendMediaMessage(upRes.fileUrl, 'audio', upRes.filename);
      }
    } catch (e) {
      console.error('Upload voice note error:', e);
    }
  };

  state.audioRecorder.stop();
  state.audioRecorder.stream.getTracks().forEach(t => t.stop());
  clearInterval(state.recordingInterval);
  document.getElementById('composerRecordingView').style.display = 'none';
  document.getElementById('composerNormalView').style.display = 'flex';
}

function togglePlayAudio(btn, audioUrl, barsId, timerId) {
  if (!audioUrl) return;

  if (state.currentAudioObj && state.currentPlayBtn === btn) {
    if (!state.currentAudioObj.paused) {
      state.currentAudioObj.pause();
      btn.innerHTML = '▶';
      return;
    } else {
      state.currentAudioObj.play();
      btn.innerHTML = '⏸';
      return;
    }
  }

  if (state.currentAudioObj) {
    state.currentAudioObj.pause();
    if (state.currentPlayBtn) state.currentPlayBtn.innerHTML = '▶';
  }

  const audio = new Audio(audioUrl);
  state.currentAudioObj = audio;
  state.currentPlayBtn = btn;
  btn.innerHTML = '⏸';

  audio.ontimeupdate = () => {
    const progress = audio.currentTime / (audio.duration || 1);
    const bars = document.querySelectorAll(`#${barsId} .vn-bar`);
    const playedCount = Math.floor(progress * bars.length);
    bars.forEach((bar, idx) => {
      if (idx <= playedCount) bar.classList.add('played');
      else bar.classList.remove('played');
    });
    if (timerId) {
      const mins = Math.floor(audio.currentTime / 60);
      const secs = String(Math.floor(audio.currentTime % 60)).padStart(2, '0');
      document.getElementById(timerId).textContent = `${mins}:${secs}`;
    }
  };

  audio.onended = () => {
    btn.innerHTML = '▶';
    const bars = document.querySelectorAll(`#${barsId} .vn-bar`);
    bars.forEach(bar => bar.classList.remove('played'));
  };

  audio.play().catch(console.error);
}

function toggleAudioSpeed(btn) {
  if (!state.currentAudioObj) return;
  if (state.currentAudioObj.playbackRate === 1) {
    state.currentAudioObj.playbackRate = 1.5;
    btn.textContent = '1.5x';
  } else if (state.currentAudioObj.playbackRate === 1.5) {
    state.currentAudioObj.playbackRate = 2;
    btn.textContent = '2x';
  } else {
    state.currentAudioObj.playbackRate = 1;
    btn.textContent = '1x';
  }
}

// ==========================================
// 5. FILE ATTACHMENTS & LIGHTBOX
// ==========================================
function triggerFileInput() {
  document.getElementById('composerFileInput').click();
}

async function handleFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('media', file);

  try {
    const upRes = await fetch('/api/upload', { method: 'POST', body: formData }).then(r => r.json());
    if (upRes.success) {
      const isImg = file.type.startsWith('image/');
      const isAudio = file.type.startsWith('audio/');
      const mediaType = isImg ? 'image' : isAudio ? 'audio' : 'document';
      await sendMediaMessage(upRes.fileUrl, mediaType, file.name);
    }
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

function openImageLightbox(imgUrl) {
  const modal = document.getElementById('imageLightboxModal');
  const img = document.getElementById('lightboxImageEl');
  const dl = document.getElementById('lightboxDownloadBtn');
  img.src = imgUrl;
  dl.href = imgUrl;
  modal.style.display = 'flex';
}

function closeImageLightbox() {
  document.getElementById('imageLightboxModal').style.display = 'none';
}

// ==========================================
// 6. LEAD CRM DOSSIER DRAWER
// ==========================================
function toggleDossierDrawer() {
  const col = document.getElementById('leadDossierCol');
  const backdrop = document.getElementById('dossierBackdrop');
  if (!col) return;
  col.classList.toggle('active');
  if (backdrop) backdrop.classList.toggle('active');
}

function populateLeadDossier(lead) {
  if (!lead) return;
  document.getElementById('dossierOwner').textContent = lead.closer_name || 'Closer Specialist';
  document.getElementById('dossierInterest').textContent = lead.deal_tier || 'Nunno Pro';
  document.getElementById('dossierDealValue').textContent = `PKR ${(lead.deal_value || 5000).toLocaleString()}`;
  document.getElementById('dossierNotes').value = lead.notes || '';

  const pill = document.getElementById('dossierStatusPill');
  const s = lead.status || 'ongoing';
  pill.textContent = s === 'paid' ? '🟢 Paid' : s === 'pending_verification' ? '⚪ Review' : s === 'useless' ? '🔵 Won\'t Pay' : s === 'fresh' ? '🔴 Fresh' : '🟡 Ongoing';
  pill.className = `status-pill-clean ${s}`;
}

async function setLeadStatus(status) {
  if (!state.activeLeadPhone) return;
  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(state.activeLeadPhone)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    }).then(r => r.json());

    if (res.success) {
      state.activeLead = res.lead;
      populateLeadDossier(res.lead);
      loadConversations();
    }
  } catch (err) {
    console.error('Error updating status:', err);
  }
}

function handleNotesChanged() {
  clearTimeout(state.notesSaveTimer);
  const ind = document.getElementById('notesSavedIndicator');
  if (ind) ind.textContent = 'Saving…';

  state.notesSaveTimer = setTimeout(async () => {
    if (!state.activeLeadPhone) return;
    const notes = document.getElementById('dossierNotes').value;
    try {
      await fetch(`/api/leads/${encodeURIComponent(state.activeLeadPhone)}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      if (ind) ind.textContent = 'Auto-saved';
    } catch (_) {}
  }, 800);
}

function appendNoteTag(tagText) {
  const notesArea = document.getElementById('dossierNotes');
  if (!notesArea) return;
  const current = notesArea.value.trim();
  notesArea.value = current ? `${current}\n• ${tagText}` : `• ${tagText}`;
  handleNotesChanged();
}

function renameCurrentLead() {
  if (!state.activeLeadPhone) return;
  const newName = prompt('Enter Contact Name:', state.activeLead?.name || '');
  if (newName === null) return;
  fetch(`/api/leads/${encodeURIComponent(state.activeLeadPhone)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  }).then(r => r.json()).then(res => {
    if (res.success) {
      document.getElementById('chatLeadName').textContent = newName;
      loadConversations();
    }
  });
}

function deleteCurrentChat() {
  if (!state.activeLeadPhone) return;
  if (!confirm(`Are you sure you want to permanently delete chat with +${state.activeLeadPhone}?`)) return;

  fetch(`/api/conversations/${encodeURIComponent(state.activeLeadPhone)}`, {
    method: 'DELETE'
  }).then(r => r.json()).then(res => {
    if (res.success) {
      state.activeLeadPhone = null;
      document.getElementById('chatMessagesArea').innerHTML = `<div style="text-align:center; margin:auto; color:var(--text-muted); font-size:13px;">Chat deleted. Select another conversation.</div>`;
      loadConversations();
    }
  });
}

// Mark Paid Modal
function openMarkPaidModal() {
  if (!state.activeLeadPhone) return;
  document.getElementById('paidModalPhone').value = `+${state.activeLeadPhone}`;
  document.getElementById('markPaidModal').style.display = 'flex';
}

function closeMarkPaidModal() {
  document.getElementById('markPaidModal').style.display = 'none';
}

async function submitMarkPaid() {
  if (!state.activeLeadPhone) return;
  const tier = document.getElementById('paidModalTier').value;
  const amount = Number(document.getElementById('paidModalAmount').value) || 5000;

  await fetch(`/api/leads/${encodeURIComponent(state.activeLeadPhone)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'paid',
      deal_tier: tier,
      deal_value: amount
    })
  });

  closeMarkPaidModal();
  selectConversation(state.activeLeadPhone);
  loadConversations();
}

function markLeadUseless() {
  setLeadStatus('useless');
}

// ==========================================
// 7. NAVIGATION & TAB SWITCHING
// ==========================================
function switchNavTab(tabName) {
  document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('viewInbox').style.display = tabName === 'inbox' ? 'flex' : 'none';
  document.getElementById('viewCampaign').style.display = tabName === 'campaign' ? 'block' : 'none';
  document.getElementById('viewEmployee').style.display = tabName === 'employee' ? 'block' : 'none';

  if (tabName === 'inbox') {
    document.getElementById('tabInbox').classList.add('active');
  } else if (tabName === 'campaign') {
    document.getElementById('tabCampaign').classList.add('active');
    loadCampaignSenders();
    updateCampaignPreview();
  } else if (tabName === 'employee') {
    document.getElementById('tabEmployee').classList.add('active');
    loadEmployeeStats();
  }
}

function setInboxFilter(filter, btn) {
  state.currentFilter = filter;
  document.querySelectorAll('.inbox-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderConversationsList();
}

function filterByState(filter) {
  const btn = document.querySelector(`.inbox-filter-btn[data-filter="${filter}"]`);
  if (btn) setInboxFilter(filter, btn);
}

function filterConversations() {
  state.searchQuery = document.getElementById('convSearchInput').value;
  renderConversationsList();
}

function updateUnreadBadge() {
  const totalUnread = state.conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0);
  const badge = document.getElementById('unreadGlobalBadge');
  if (badge) {
    badge.textContent = totalUnread;
    badge.style.display = totalUnread > 0 ? 'inline-flex' : 'none';
  }
}

// ==========================================
// 8. WHATSAPP QR LINKING & CLOSERS
// ==========================================
async function loadClosers() {
  try {
    const res = await fetch('/api/closers').then(r => r.json());
    if (res.success) {
      state.closers = res.closers || [];
      const connected = state.closers.find(c => c.status === 'connected');
      if (connected) {
        updateConnectedPill('connected', connected.phone);
      } else {
        const firstCloser = state.closers[0];
        updateConnectedPill(firstCloser?.status || 'disconnected', firstCloser?.phone);
      }
    }
  } catch (_) {}
}

function getActiveOrFirstConnectedCloserId() {
  if (state.activeCloserId) return state.activeCloserId;
  const connected = state.closers.find(c => c.status === 'connected');
  if (connected) return connected.id;
  return state.closers[0]?.id || 'closer_1';
}

function updateConnectedPill(status, phone) {
  const circle = document.getElementById('connectedPulseCircle');
  const text = document.getElementById('connectedNumberText');
  const empBadge = document.getElementById('empDevBadge');
  const empText = document.getElementById('empDevText');

  if (status === 'connected') {
    if (circle) circle.style.background = '#10b981';
    if (text) text.textContent = `+${phone} · Connected`;
    if (empBadge) {
      empBadge.textContent = '● CONNECTED';
      empBadge.style.background = 'rgba(16,185,129,0.18)';
      empBadge.style.color = '#34d399';
    }
    if (empText) empText.innerHTML = `Linked to <strong style="color:#fff;font-family:monospace;">+${phone}</strong>. High-speed WebSocket live.`;
  } else {
    if (circle) circle.style.background = '#ef4444';
    if (text) text.textContent = 'WhatsApp Disconnected · Click to Link';
    if (empBadge) {
      empBadge.textContent = 'NOT LINKED';
      empBadge.style.background = 'rgba(239,68,68,0.15)';
      empBadge.style.color = '#f87171';
    }
    if (empText) empText.textContent = 'Scan QR code to link your phone for high-speed campaign dispatching.';
  }
}

function openConnectWaModal() {
  const closerId = getActiveOrFirstConnectedCloserId();
  document.getElementById('connectWaModal').style.display = 'flex';
  document.getElementById('waQrLoadingText').textContent = 'Generating secure Baileys QR code…';
  document.getElementById('waQrImageEl').style.display = 'none';

  // Request connection
  fetch(`/api/closers/${closerId}/connect`, { method: 'POST' }).then(r => r.json()).then(res => {
    if (res.status?.qr) {
      renderQrModal(res.status.qr);
    }
  });
}

function closeConnectWaModal() {
  document.getElementById('connectWaModal').style.display = 'none';
}

function renderQrModal(qrDataUrl) {
  const img = document.getElementById('waQrImageEl');
  const text = document.getElementById('waQrLoadingText');
  if (img && qrDataUrl) {
    img.src = qrDataUrl;
    img.style.display = 'block';
    if (text) text.style.display = 'none';
  }
}

function requestFreshQr() {
  const closerId = getActiveOrFirstConnectedCloserId();
  fetch(`/api/closers/${closerId}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wipe: true })
  }).then(() => {
    openConnectWaModal();
  });
}

// ==========================================
// 9. 4-ROLE GATEWAY & IDENTITY SWITCHER
// ==========================================
function openRoleGatewayModal() {
  document.getElementById('roleGatewayModal').style.display = 'flex';
}

function closeRoleGatewayModal() {
  document.getElementById('roleGatewayModal').style.display = 'none';
}

function selectRole(role) {
  state.activeRole = role;
  document.getElementById('currentRoleLabel').textContent = role === 'tl' ? 'Team Lead' : 'Closer';
  closeRoleGatewayModal();
  sendWsSubscription();
  loadConversations();
}

// Team Leader Modal
function openTlModal() {
  document.getElementById('tlProvisionModal').style.display = 'flex';
}

function closeTlModal() {
  document.getElementById('tlProvisionModal').style.display = 'none';
}

async function submitRecruitTm(e) {
  e.preventDefault();
  const name = document.getElementById('newTmName').value;
  const email = document.getElementById('newTmEmail').value;
  if (!name || !email) return;

  const res = await fetch('/api/closers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, role: 'closer' })
  }).then(r => r.json());

  if (res.success) {
    alert(`Team Member ${name} registered! Rs. 500 commission logged.`);
    closeTlModal();
    loadClosers();
  }
}

// ==========================================
// 10. CAMPAIGN STUDIO
// ==========================================
function loadCampaignSenders() {
  const container = document.getElementById('campaignSendersPoolContainer');
  if (!container) return;
  container.innerHTML = state.closers.map(c => `
    <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 14px;">
      <div style="font-weight:750; font-size:13px; color:#fff;">${c.name}</div>
      <div style="font-size:11px; font-family:monospace; color:var(--accent-brand);">${c.phone ? '+' + c.phone : 'Not Linked'}</div>
      <span style="font-size:10px; padding:2px 6px; border-radius:4px; font-weight:700; background:${c.status === 'connected' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}; color:${c.status === 'connected' ? '#34d399' : '#f87171'}; margin-top:4px; display:inline-block;">
        ${c.status.toUpperCase()}
      </span>
    </div>
  `).join('');
}

function setVariation(variation) {
  document.querySelectorAll('.btn-var-select').forEach(b => b.classList.remove('active'));
  if (variation === 'text') document.getElementById('btnVarText').classList.add('active');
  else if (variation === 'text_image') document.getElementById('btnVarTextImage').classList.add('active');
  else if (variation === 'audio') document.getElementById('btnVarAudio').classList.add('active');
  updateCampaignPreview();
}

function insertCampTag(tag) {
  const area = document.getElementById('campaignCustomMsg');
  if (area) {
    area.value += ' ' + tag;
    updateCampaignPreview();
  }
}

function parseCampaignNumbers() {
  const raw = document.getElementById('campaignPasteArea').value;
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  document.getElementById('campaignAudienceBadge').textContent = `${lines.length} Contacts`;
}

function updateCampaignPreview() {
  const txt = document.getElementById('campaignCustomMsg')?.value || '';
  const preview = document.getElementById('campaignBubblePreview');
  if (preview) {
    preview.textContent = txt.replace('{name}', 'Ali Bhai').replace('{phone}', '+923001234567');
  }
}

async function launchCampaign() {
  const name = document.getElementById('campaignNameInput').value;
  const rawNumbers = document.getElementById('campaignPasteArea').value;
  const messageTemplate = document.getElementById('campaignCustomMsg').value;

  if (!name || !rawNumbers || !messageTemplate) {
    alert('Please enter a campaign name, drop phone numbers, and enter a message.');
    return;
  }

  appendCampaignLog(`[START] Creating campaign "${name}"...`);

  try {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rawNumbers, messageTemplate })
    }).then(r => r.json());

    if (res.success) {
      appendCampaignLog(`[READY] Campaign created with ${res.totalLeads} leads. Starting dispatch...`);
      await fetch(`/api/campaigns/${res.campaignId}/start`, { method: 'POST' });
      appendCampaignLog(`[DISPATCH] Campaign dispatched successfully!`);
      document.getElementById('campaignStatusBadge').textContent = '🟢 Running Batches';
    } else {
      appendCampaignLog(`[ERROR] ${res.message}`);
    }
  } catch (err) {
    appendCampaignLog(`[ERROR] Dispatch failed: ${err.message}`);
  }
}

function appendCampaignLog(msg) {
  const logEl = document.getElementById('campaignTerminalLog');
  if (logEl) {
    const div = document.createElement('div');
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// ==========================================
// 11. EMPLOYEE STATS VIEW
// ==========================================
async function loadEmployeeStats() {
  try {
    const statsRes = await fetch('/api/stats').then(r => r.json());
    if (statsRes.success) {
      const s = statsRes.stats;
      document.getElementById('empStatRevenue').textContent = ((s.sentLeads || 0) * 50).toLocaleString();
      document.getElementById('empStatOngoing').textContent = s.repliedLeads || 0;
      document.getElementById('empStatClosedDeals').textContent = `${s.readLeads || 0} client interactions`;
      document.getElementById('empStatConversion').textContent = `${s.replyRate || 0}%`;
    }
  } catch (_) {}
}

// ==========================================
// 12. UTILITIES
// ==========================================
function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (_) {}
}

function toggleTheme() {
  document.body.classList.toggle('theme-dark');
}

// Initialization on DOM Load
document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  loadClosers();
  loadConversations();
});
