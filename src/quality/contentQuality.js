'use strict';

/**
 * Content Quality Gate
 *
 * Evalúa cada tweet antes de publicarlo usando GPT.
 * Si el tweet no cumple el estándar, lo regenera una vez.
 * Si aún falla, loggea el warning pero deja pasar (no bloquea el pipeline).
 *
 * Criterios de evaluación:
 *   - Claridad (¿se entiende sin contexto?)
 *   - Especificidad (¿tiene un dato o señal concreta?)
 *   - Valor (¿dice algo que no es obvio?)
 *   - Engagement (¿incentiva a leer el perfil o pensar?)
 *
 * Score 1-10. Umbral de rechazo: < 5.
 */

const OpenAI = require('openai');
const { config }             = require('../config');
const { createModuleLogger } = require('../utils/logger');

const log    = createModuleLogger('ContentQuality');
const openai = new OpenAI({ apiKey: config.openai.apiKey });

const QUALITY_THRESHOLD = 5; // score mínimo para publicar sin regenerar
const HARD_THRESHOLD    = 4; // score mínimo absoluto (si < 4, se loggea warning)

// ─── Evaluador ─────────────────────────────────────────────────────────────────

const QUALITY_SYSTEM = `You are a brutal quality editor for @TheProtocoMind, an AI + crypto analyst account.
Your job: rate tweets before they're posted. Be honest. Don't be nice.

SCORING CRITERIA (each 1-10):
1. CLARITY — Can someone understand this without extra context?
2. SPECIFICITY — Does it have a concrete signal, data point, or mechanism?
3. VALUE — Does it say something non-obvious? Would someone screenshot this?
4. ENGAGEMENT — Does it make you want to follow the account or think deeper?

RETURN FORMAT (JSON only, no extra text):
{"clarity": N, "specificity": N, "value": N, "engagement": N, "average": N, "weakness": "one-line reason if score < 6", "suggestion": "one concrete fix if score < 6"}

Where N is an integer 1-10 and average = (clarity + specificity + value + engagement) / 4, rounded to 1 decimal.`;

async function evaluateTweet(text, tweetType = '') {
  try {
    const prompt = `Tweet type: ${tweetType}\n\nTweet:\n"${text}"\n\nRate this tweet.`;

    const response = await openai.chat.completions.create({
      model:       config.openai.model,
      max_tokens:  120,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: QUALITY_SYSTEM },
        { role: 'user',   content: prompt },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    const scores = JSON.parse(raw);
    return scores;
  } catch (err) {
    log.warn(`Error evaluando calidad: ${err.message}`);
    return null;
  }
}

// ─── Gate principal ────────────────────────────────────────────────────────────

/**
 * Pasa el tweet por el quality gate.
 * @param {string}   text       - Contenido del tweet
 * @param {string}   tweetType  - Tipo (para loggear)
 * @param {Function} regenerate - Función async que genera un nuevo tweet
 * @returns {Promise<string>}   - Tweet aprobado (original o regenerado)
 */
async function qualityGate(text, tweetType, regenerate) {
  // 1. Evaluar tweet original
  const scores = await evaluateTweet(text, tweetType);

  if (!scores) {
    // Si el evaluador falla, dejar pasar el original
    log.warn(`[${tweetType}] Quality gate no disponible — publicando sin evaluar`);
    return text;
  }

  const avg = scores.average || ((scores.clarity + scores.specificity + scores.value + scores.engagement) / 4);
  log.info(`[${tweetType}] Quality score: ${avg.toFixed(1)}/10 (clarity:${scores.clarity} specificity:${scores.specificity} value:${scores.value} engagement:${scores.engagement})`);

  if (avg >= QUALITY_THRESHOLD) {
    log.info(`[${tweetType}] ✅ Quality gate passed (${avg.toFixed(1)})`);
    return text;
  }

  // 2. Score bajo — intentar regenerar
  log.warn(`[${tweetType}] ⚠️  Score bajo (${avg.toFixed(1)}): ${scores.weakness || 'weak tweet'}`);
  log.info(`[${tweetType}] Regenerando con hint: "${scores.suggestion || 'be more specific'}"`);

  if (typeof regenerate !== 'function') {
    log.warn(`[${tweetType}] Sin función de regeneración — publicando original`);
    return text;
  }

  try {
    const regenerated = await regenerate(scores.suggestion || 'be more specific and add a concrete signal');
    if (!regenerated) {
      log.warn(`[${tweetType}] Regeneración devolvió null — usando original`);
      return text;
    }

    // 3. Evaluar tweet regenerado
    const scores2 = await evaluateTweet(regenerated, tweetType);
    const avg2 = scores2 ? (scores2.average || ((scores2.clarity + scores2.specificity + scores2.value + scores2.engagement) / 4)) : 0;

    log.info(`[${tweetType}] Regenerado score: ${avg2.toFixed(1)}/10`);

    if (avg2 >= HARD_THRESHOLD) {
      log.info(`[${tweetType}] ✅ Usando tweet regenerado (${avg2.toFixed(1)})`);
      return regenerated;
    }

    // 4. Aún bajo el umbral duro — publicar el mejor
    const best = avg2 > avg ? regenerated : text;
    log.warn(`[${tweetType}] Ambos tweets bajo umbral — publicando el mejor (${Math.max(avg, avg2).toFixed(1)})`);
    return best;
  } catch (err) {
    log.error(`[${tweetType}] Error regenerando tweet: ${err.message}`);
    return text;
  }
}

module.exports = { qualityGate, evaluateTweet };
