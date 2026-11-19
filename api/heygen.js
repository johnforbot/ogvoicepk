// ============================================================================
// LEXIS FLOW PREMIUM - UNLIMITED KEY POOL BACKEND
// Loads keys from api/_keys.js (No 4KB Vercel Env Limit) + Optimized Sync
// ============================================================================

const HEYGEN_BASE_URL = 'https://api.heygen.com/v3/models/audio';

let FILE_KEYS = [];
try {
  FILE_KEYS = require('./_keys.js');
} catch (e) {
  FILE_KEYS = [];
}

if (!global.masterKeyPool) global.masterKeyPool = new Set();
if (!global.tokenIpBindings) global.tokenIpBindings = new Map();
if (!global.trialIpTimestamps) global.trialIpTimestamps = new Map();

function syncAllKeys() {
  // 1. Load from api/_keys.js
  if (Array.isArray(FILE_KEYS)) {
    FILE_KEYS.forEach(k => {
      const clean = String(k || '').trim();
      if (clean.length >= 10) global.masterKeyPool.add(clean);
    });
  }
  // 2. Also support any extra keys in Vercel Env (optional)
  const envKeys = (process.env.MASTER_KEY_POOL || '').split(',').map(k => k.trim()).filter(k => k.length >= 10);
  envKeys.forEach(k => global.masterKeyPool.add(k));
}

function cleanVoiceName(originalName) {
  if (!originalName) return "Studio Voice";
  let name = String(originalName).trim();
  if (name.length > 25) name = name.substring(0, 22) + "...";
  if (/^[a-z]+$/.test(name) && name.length > 8) return "Custom Neural Clone";
  return name.replace(/\b\w/g, char => char.toUpperCase());
}

async function fetchWithTimeout(url, options, timeoutMs = 4500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function aggregatePrivateVoices() {
  syncAllKeys();
  const keys = Array.from(global.masterKeyPool);
  if (keys.length === 0) return { error: 'System offline. Admin must configure Keys.' };

  const allVoices = [];
  const fetchPromises = keys.map(async (key) => {
    try {
      const response = await fetchWithTimeout(`${HEYGEN_BASE_URL}/voices`, {
        headers: { 'X-Api-Key': key, 'Accept': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        const voices = Array.isArray(data?.data?.voices) ? data.data.voices : (Array.isArray(data?.data) ? data.data : []);
        voices.forEach(v => {
          if (!v.status || v.status === 'ACTIVE') {
            v.display_name = cleanVoiceName(v.name || v.display_name);
            allVoices.push({ ...v, _mappedKey: key });
          }
        });
      }
    } catch (e) {}
  });

  await Promise.all(fetchPromises);

  const uniqueVoices = [];
  const seenIds = new Set();
  for (const v of allVoices) {
    const id = v.voice_id || v.id;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      uniqueVoices.push(v);
    }
  }
  return { voices: uniqueVoices };
}

// Public voices are identical across accounts — only ping until 1 key succeeds
async function fetchPublicVoices() {
  syncAllKeys();
  const keys = Array.from(global.masterKeyPool);
  for (const key of keys.slice(0, 10)) {
    try {
      const response = await fetchWithTimeout(`${HEYGEN_BASE_URL}/voices?type=public`, {
        headers: { 'X-Api-Key': key, 'Accept': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        const voices = Array.isArray(data?.data?.voices) ? data.data.voices : (Array.isArray(data?.data) ? data.data : []);
        return {
          voices: voices
            .filter(v => !v.status || v.status === 'ACTIVE')
            .map(v => ({ ...v, display_name: cleanVoiceName(v.name || v.display_name), _mappedKey: '' }))
        };
      }
    } catch (e) {}
  }
  return { voices: [] };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown-ip';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  syncAllKeys();

  try {
    const { action, voiceId, mappedKey, text, language, accessToken } = req.body || {};
    const clientIp = getClientIp(req);
    const token = (accessToken || '').trim();

    const MASTER_UNLIMITED_TOKEN = process.env.ADMIN_UNLIMITED_TOKEN || 'pranav_master_99';
    const validTokens = (process.env.VALID_ACCESS_TOKENS || 'trial').split(',').map(t => t.trim());
    const isUnlimitedAdmin = (token === MASTER_UNLIMITED_TOKEN);

    if (!isUnlimitedAdmin && !validTokens.includes(token)) {
      return res.status(403).json({ error: 'Access Denied: Invalid or Expired Subscription Token.' });
    }

    if (!isUnlimitedAdmin) {
      if (token === 'trial') {
        const now = Date.now();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        if (!global.trialIpTimestamps.has(clientIp)) {
          global.trialIpTimestamps.set(clientIp, now);
        } else if (now - global.trialIpTimestamps.get(clientIp) > twentyFourHours) {
          return res.status(403).json({
            error: 'TRIAL_EXPIRED',
            message: 'Your 24-hour trial on this device has expired. Purchase a premium plan to enjoy unlimited voices.'
          });
        }
      } else {
        if (!global.tokenIpBindings.has(token)) global.tokenIpBindings.set(token, new Set());
        const boundIps = global.tokenIpBindings.get(token);
        if (!boundIps.has(clientIp)) {
          if (boundIps.size >= 3) {
            return res.status(403).json({
              error: 'Access Blocked: This token is locked. It has reached its maximum device/IP limit (3 devices).'
            });
          }
          boundIps.add(clientIp);
        }
      }
    }

    if (action === 'sync_library') {
      const [privateResult, publicResult] = await Promise.all([
        aggregatePrivateVoices(),
        fetchPublicVoices()
      ]);
      if (privateResult.error) return res.status(500).json(privateResult);
      return res.status(200).json({ privateVoices: privateResult.voices, publicVoices: publicResult.voices });
    }

    if (action === 'generate_tts') {
      if (!voiceId || !text) return res.status(400).json({ error: 'Missing voice ID or script.' });

      const keys = Array.from(global.masterKeyPool);
      // Random key rotation for public voices; exact mappedKey for private clones
      const executionKey = mappedKey || keys[Math.floor(Math.random() * keys.length)];
      if (!executionKey) return res.status(500).json({ error: 'Service unavailable.' });

      const payload = { model: 'heygen-voice-1-turbo-free', voice_id: String(voiceId).trim(), text: String(text).trim() };
      if (language && language !== 'auto') payload.language = language;

      const response = await fetch(`${HEYGEN_BASE_URL}/tts`, {
        method: 'POST',
        headers: { 'X-Api-Key': executionKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();

      if (!response.ok) return res.status(response.status).json({ error: data?.message || data?.error?.message || 'Generation failed.' });
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Gateway Error.' });
  }
};
