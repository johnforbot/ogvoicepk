// ============================================================================
// LEXIS FLOW PREMIUM - ADVANCED AUTHENTICATION BACKEND
// Features: 3-IP Device Limit, 24-Hour Trial Expiry, and UNLIMITED ADMIN TOKEN
// ============================================================================

const HEYGEN_BASE_URL = 'https://api.heygen.com/v3/models/audio';

if (!global.masterKeyPool) global.masterKeyPool = new Set();
if (!global.tokenIpBindings) global.tokenIpBindings = new Map();
if (!global.trialIpTimestamps) global.trialIpTimestamps = new Map();

function syncEnvKeys() {
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

async function aggregateGlobalVoices(type = 'private') {
  syncEnvKeys();
  const keys = Array.from(global.masterKeyPool);
  if (keys.length === 0) return { error: 'System offline. Admin must configure Keys.' };

  const allVoices = [];
  const endpoint = type === 'public' ? '/voices?type=public' : '/voices';
  
  const fetchPromises = keys.map(async (key) => {
    try {
      const response = await fetch(`${HEYGEN_BASE_URL}${endpoint}`, { headers: { 'X-Api-Key': key, 'Accept': 'application/json' } });
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
  
  const uniqueVoices = []; const seenIds = new Set();
  for (const v of allVoices) { 
    const id = v.voice_id || v.id; 
    if (!seenIds.has(id)) { seenIds.add(id); uniqueVoices.push(v); } 
  }
  return { voices: uniqueVoices };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection.remoteAddress || 'unknown-ip';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  syncEnvKeys();

  try {
    const { action, voiceId, mappedKey, text, language, accessToken } = req.body || {};
    const clientIp = getClientIp(req);
    const token = (accessToken || '').trim();

    // ========================================================================
    // ADVANCED AUTHENTICATION LOGIC
    // ========================================================================
    const MASTER_UNLIMITED_TOKEN = process.env.ADMIN_UNLIMITED_TOKEN || 'pranav_master_99';
    const validTokens = (process.env.VALID_ACCESS_TOKENS || 'trial').split(',').map(t => t.trim());
    
    // Check if user is using the God Mode Unlimited Token
    const isUnlimitedAdmin = (token === MASTER_UNLIMITED_TOKEN);

    if (!isUnlimitedAdmin && !validTokens.includes(token)) {
      return res.status(403).json({ error: 'Access Denied: Invalid or Expired Subscription Token.' });
    }

    // APPLY RESTRICTIONS ONLY IF NOT USING THE UNLIMITED ADMIN TOKEN
    if (!isUnlimitedAdmin) {
      // 1. TRIAL LOGIC (24-Hour Expiry per IP)
      if (token === 'trial') {
        const now = Date.now();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        
        if (!global.trialIpTimestamps.has(clientIp)) {
          global.trialIpTimestamps.set(clientIp, now);
        } else {
          const trialStartTime = global.trialIpTimestamps.get(clientIp);
          if (now - trialStartTime > twentyFourHours) {
            return res.status(403).json({ 
              error: 'TRIAL_EXPIRED', 
              message: 'Your 24-hour trial on this device has expired. Purchase a premium plan to enjoy unlimited voices.' 
            });
          }
        }
      } 
      // 2. PREMIUM TOKEN LOGIC (Max 3 IPs per Token)
      else {
        if (!global.tokenIpBindings.has(token)) {
          global.tokenIpBindings.set(token, new Set());
        }
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
    // ========================================================================

    if (action === 'sync_library') {
      const privateResult = await aggregateGlobalVoices('private');
      const publicResult = await aggregateGlobalVoices('public');
      if (privateResult.error) return res.status(500).json(privateResult);
      return res.status(200).json({ privateVoices: privateResult.voices, publicVoices: publicResult.voices });
    }

    if (action === 'generate_tts') {
      if (!voiceId || !text) return res.status(400).json({ error: 'Missing voice ID or script.' });
      
      const executionKey = mappedKey || Array.from(global.masterKeyPool)[0];
      if (!executionKey) return res.status(500).json({ error: 'Service unavailable.' });
      
      const payload = { model: 'heygen-voice-1-turbo-free', voice_id: String(voiceId).trim(), text: String(text).trim() };
      if (language && language !== 'auto') payload.language = language;
      
      const response = await fetch(`${HEYGEN_BASE_URL}/tts`, { method: 'POST', headers: { 'X-Api-Key': executionKey, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      
      if (!response.ok) return res.status(response.status).json({ error: data?.message || data?.error?.message || 'Generation failed.' });
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) { 
    return res.status(500).json({ error: 'Internal Gateway Error.' }); 
  }
};
