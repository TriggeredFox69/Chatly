'use strict';

/**
 * Chatly Phone Number Normalizer & WhatsApp JID Formatter
 * Handles Pakistani (03xx, 923xx, +923xx, 00923xx) and international formats.
 */

function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).trim().replace(/\D/g, '');
  if (!p) return '';

  // Strip international leading double zero
  if (p.startsWith('00')) {
    p = p.slice(2);
  }

  // Pakistan standard normalization:
  // 03001234567 (11 digits) -> 923001234567
  if (p.startsWith('03') && p.length === 11) {
    p = '92' + p.slice(1);
  }
  // 3001234567 (10 digits) -> 923001234567
  else if (p.startsWith('3') && p.length === 10) {
    p = '92' + p;
  }
  // 00923001234567 -> 923001234567
  else if (p.startsWith('0092')) {
    p = p.slice(2);
  }

  return p;
}

function phoneToJid(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return '';
  return `${norm}@s.whatsapp.net`;
}

function jidToPhone(jid) {
  if (!jid) return '';
  const clean = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  return normalizePhone(clean);
}

function samePhone(a, b) {
  const normA = normalizePhone(a);
  const normB = normalizePhone(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  // Match last 9 digits (handles country code mismatches)
  if (normA.length >= 9 && normB.length >= 9) {
    return normA.slice(-9) === normB.slice(-9);
  }
  return false;
}

function formatDisplayPhone(phone) {
  const norm = normalizePhone(phone);
  if (norm.startsWith('92') && norm.length === 12) {
    return `+92 ${norm.slice(2, 5)} ${norm.slice(5)}`;
  }
  return `+${norm}`;
}

module.exports = {
  normalizePhone,
  phoneToJid,
  jidToPhone,
  samePhone,
  formatDisplayPhone
};
