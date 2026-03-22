'use strict';

/**
 * Reply Generator Module
 *
 * Genera respuestas contextuales a tweets usando GPT-4o.
 * Cada respuesta debe añadir valor real, sonar humana y posicionar
 * @TheProtocoMind como voz analítica en AI + crypto.
 */

const OpenAI = require('openai');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');

const log = createModuleLogger('ReplyGenerator');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── System prompt de identidad ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the voice behind @TheProtocoMind — an AI + crypto analyst account.
Your replies must attract attention and make people want to click your profile.

IDENTITY:
- Confident, sharp, analytical
- Slightly contrarian when warranted
- You have strong opinions backed by data/logic
- You never suck up to anyone or agree just to be agreeable

STYLE RULES:
- No emojis
- No hashtags
- No "great take!" or "interesting thread!" or filler phrases
- Never repeat what the original tweet said
- Never give buy/sell advice
- Max 240 characters — brevity is power
- Start with the substance, not a setup
- Sound like a person, not a bot

REPLY TYPES (rotate naturally):
1. INSIGHT — add a specific data point or mechanism they missed
2. CONTRARIAN — respectfully challenge the premise with a better frame
3. EXPAND — agree with one element and take it one step further
4. QUESTION — ask a sharp, non-obvious question that reframes the discussion

OUTPUT FORMAT:
Return ONLY the reply text. No quotes. No labels. No explanation.`;

// ─── Generación de respuesta ───────────────────────────────────────────────────

/**
 * Genera una respuesta contextual a un tweet.
 * @param {object} tweet - { text, authorHandle, authorFollowers, likes, retweets }
 * @returns {Promise<string|null>} Texto de respuesta o null si falla
 */
async function generateReply(tweet) {
  const userPrompt = buildUserPrompt(tweet);

  try {
    const response = await openai.chat.completions.create({
      model:       config.openai.model,
      max_tokens:  120,
      temperature: 0.85,  // más creatividad que los tweets normales
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    // Limpiar comillas externas si GPT las pone
    const reply = raw.replace(/^["']|["']$/g, '').trim();

    // Validar longitud
    if (reply.length < 20)  {
      log.warn('Respuesta demasiado corta, descartada');
      return null;
    }
    if (reply.length > 270) {
      // Truncar en el último espacio antes de 270
      const truncated = reply.substring(0, 268).replace(/\s+\S*$/, '').trim();
      log.warn(`Respuesta truncada: ${reply.length} → ${truncated.length} chars`);
      return truncated;
    }

    return reply;
  } catch (err) {
    log.error(`Error generando respuesta: ${err.message}`);
    return null;
  }
}

// ─── Construcción del prompt de usuario ────────────────────────────────────────

function buildUserPrompt(tweet) {
  const context = [
    `TWEET by @${tweet.authorHandle} (${formatNumber(tweet.authorFollowers)} followers):`,
    `"${tweet.text}"`,
    '',
    `Engagement: ${tweet.likes} likes, ${tweet.retweets} retweets`,
    '',
    'Write a reply that adds real value. Be specific, sharp, and memorable.',
    'The reply must make someone want to click @TheProtocoMind profile.',
  ].join('\n');

  return context;
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1)    + 'K';
  return String(n);
}

// ─── Filtro de calidad post-generación ─────────────────────────────────────────

const GENERIC_PATTERNS = [
  /^great (take|point|thread)/i,
  /^interesting/i,
  /^totally agree/i,
  /^well said/i,
  /^this is (so |very )?(true|accurate|spot on)/i,
  /^100%/,
  /^exactly/i,
];

/**
 * Verifica que la respuesta generada no sea genérica.
 */
function isGenericReply(text) {
  return GENERIC_PATTERNS.some(p => p.test(text));
}

/**
 * Genera y valida una respuesta. Reintenta hasta 2 veces si es genérica.
 */
async function generateValidReply(tweet, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const reply = await generateReply(tweet);
    if (!reply) continue;

    if (isGenericReply(reply)) {
      log.warn(`Attempt ${attempt + 1}: respuesta genérica detectada, reintentando...`);
      continue;
    }

    log.info(`Respuesta generada (${reply.length} chars): "${reply.substring(0, 80)}..."`);
    return reply;
  }

  log.warn('No se pudo generar una respuesta no-genérica después de todos los intentos');
  return null;
}

module.exports = { generateValidReply };
