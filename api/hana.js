import { SYSTEM_PROMPT } from './prompt.js';
import fs from 'fs';
import path from 'path';

function loadLocalEnv() {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) return;
  for (const file of ['.env.local', '.env']) {
    try {
      const fullPath = path.resolve(process.cwd(), file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const match = trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            const val = match[2].trim().replace(/^["'](.*)["']$/, '$1');
            if (!process.env[key]) process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}
loadLocalEnv();

/**
 * In-Memory Rate Limiter
 * 
 * NOTE ON SERVERLESS EXECUTION:
 * Vercel Serverless Functions are stateless and execute in isolated, ephemeral 
 * container instances that spin down after periods of inactivity ("cold starts").
 * This in-memory Map rate-limits requests hitting the SAME container instance.
 * It provides basic protection against rapid hammering of an active container,
 * but rate limits do not persist across instance re-creations or across concurrent
 * instances in different regions.
 * 
 * RECOMMENDED DURABLE UPGRADE:
 * For persistent, multi-instance, global rate limiting, upgrade to Upstash Redis:
 *   import { Ratelimit } from "@upstash/ratelimit";
 *   import { Redis } from "@upstash/redis";
 *   const ratelimit = new Ratelimit({
 *     redis: Redis.fromEnv(),
 *     limiter: Ratelimit.slidingWindow(10, "1 m"),
 *   });
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 15; // 15 requests per minute per IP
const rateLimitStore = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const clientRecord = rateLimitStore.get(ip);

  if (!clientRecord || now > clientRecord.resetTime) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  clientRecord.count += 1;
  if (clientRecord.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  return false;
}

// Clean up expired rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref?.();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const rawIp = typeof forwarded === 'string' ? forwarded : forwarded[0];
    return rawIp.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '127.0.0.1';
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  const rawAllowed = process.env.ALLOWED_ORIGIN;
  const allowedList = rawAllowed
    ? rawAllowed.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : [];

  if (!origin) {
    // Direct or same-origin request without Origin header
    return true;
  }

  const normalizedOrigin = origin.toLowerCase();
  const isLocal =
    normalizedOrigin.startsWith('http://localhost:') ||
    normalizedOrigin.startsWith('http://127.0.0.1:') ||
    normalizedOrigin === 'http://localhost' ||
    normalizedOrigin === 'http://127.0.0.1';

  let isAllowed = false;
  if (allowedList.length > 0) {
    isAllowed = allowedList.includes(normalizedOrigin) || isLocal;
  } else {
    // If ALLOWED_ORIGIN is not yet configured, allow origin to prevent breaking setup
    isAllowed = true;
  }

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return true;
  }

  return false;
}

export default async function handler(req, res) {
  // 1. Handle CORS Preflight
  const corsAllowed = handleCors(req, res);

  if (req.method === 'OPTIONS') {
    if (!corsAllowed) {
      return res.status(403).json({ error: 'CORS forbidden: Origin not permitted.' });
    }
    return res.status(204).end();
  }

  // 2. Reject Disallowed Origins for other methods
  if (!corsAllowed) {
    return res.status(403).json({ error: 'CORS forbidden: Origin not permitted.' });
  }

  // 3. Method validation
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
  }

  // 4. Rate Limiting (per-IP)
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Rate limit exceeded: Too many messages sent. Please wait a minute before trying again.'
    });
  }

  // 5. Body & Payload Validation
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Malformed request: Body must be valid JSON.' });
    }
  }

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Malformed request: Missing JSON body.' });
  }

  const { messages } = body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid payload: "messages" field must be an array.' });
  }

  if (messages.length === 0) {
    return res.status(400).json({ error: 'Invalid payload: "messages" array cannot be empty.' });
  }

  if (messages.length > 30) {
    return res.status(400).json({
      error: 'Conversation limit exceeded: Maximum of 30 messages allowed per conversation.'
    });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ error: `Message at index ${i} is invalid.` });
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      return res.status(400).json({
        error: `Message at index ${i} has invalid role "${msg.role}". Must be "user" or "assistant".`
      });
    }
    if (typeof msg.content !== 'string' || msg.content.trim() === '') {
      return res.status(400).json({
        error: `Message at index ${i} has empty or invalid content. Must be a non-empty string.`
      });
    }
    if (msg.content.length > 4000) {
      return res.status(400).json({
        error: `Message at index ${i} exceeds maximum character limit of 4000.`
      });
    }
  }

  // 6. Environment & Secret Verification
  loadLocalEnv();
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    console.error('[HANA Backend Error] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is configured.');
    return res.status(500).json({
      error: 'Server configuration error: AI API key is not configured.'
    });
  }

  // 7. Call Google Gemini (100% Free Tier) if GEMINI_API_KEY is set
  if (geminiKey) {
    try {
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: SYSTEM_PROMPT }]
            },
            contents: messages.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content.trim() }]
            })),
            generationConfig: {
              maxOutputTokens: 1000,
              temperature: 0.7
            }
          })
        }
      );

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        console.error(`[HANA Backend Error] Gemini API returned HTTP ${geminiResponse.status}:`, errorText);
        if (!anthropicKey) {
          return res.status(500).json({
            error: 'Failed to communicate with AI assistant. Please try again in a moment.'
          });
        }
        console.warn('[HANA Backend] Falling back to Anthropic Claude API...');
      } else {
        const data = await geminiResponse.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return res.status(200).json({ reply });
      }
    } catch (err) {
      console.error('[HANA Backend Error] Network/fetch failure contacting Gemini:', err);
      if (!anthropicKey) {
        return res.status(500).json({
          error: 'Service temporarily unavailable. Please try again later.'
        });
      }
      console.warn('[HANA Backend] Falling back to Anthropic Claude API...');
    }
  }

  // 8. Call Anthropic Messages API (Fallback if ANTHROPIC_API_KEY is set)
  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content.trim()
        }))
      })
    });

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text();
      console.error(`[HANA Backend Error] Anthropic API returned HTTP ${anthropicResponse.status}:`, errorText);
      return res.status(500).json({
        error: 'Failed to communicate with AI assistant. Please try again in a moment.'
      });
    }

    const data = await anthropicResponse.json();
    const reply = data.content?.[0]?.text || '';

    // Return clean response to client
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('[HANA Backend Error] Network/fetch failure contacting Anthropic:', err);
    return res.status(500).json({
      error: 'Service temporarily unavailable. Please try again later.'
    });
  }
}
