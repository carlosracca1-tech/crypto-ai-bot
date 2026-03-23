'use strict';

/**
 * promptOptimizer.js
 *
 * Analyzes high-performing tweets to extract structural/tonal patterns,
 * then rewrites the internal GPT prompt injections to replicate those patterns.
 *
 * Optimized prompts are stored in data/optimized_prompts.json
 * and injected into callGPT() in contentGenerator.js.
 */

const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai');
const { createModuleLogger } = require('../utils/logger');
const { withRetry }          = require('../utils/retry');
const { config }             = require('../config');
const { loadPerformanceLog } = require('./performanceEngine');

const log = createModuleLogger('PromptOptimizer');

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR      = path.join(process.cwd(), 'data');
const PROMPTS_FILE  = path.join(DATA_DIR, 'optimized_prompts.json');

// ─── Defaults (used if no analysis has been run yet) ─────────────────────────

const DEFAULT_PROMPTS = {
  hook_injection:       '',
  tone_injection:       '',
  structure_injection:  '',
  avoid_injection:      '',
  high_performers:      [],
  generated_at:         null,
};

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadOptimizedPrompts() {
  try {
    if (!fs.existsSync(PROMPTS_FILE)) return { ...DEFAULT_PROMPTS };
    return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
  } catch {
    return { ...DEFAULT_PROMPTS };
  }
}

function saveOptimizedPrompts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(data, null, 2));
}

// ─── Extract high-performing tweets ──────────────────────────────────────────

/**
 * Get top N tweets by engagement score from the log.
 * Requires at least 2 tweets to form patterns.
 */
function getHighPerformers(n = 10) {
  const entries = loadPerformanceLog();
  if (entries.length < 2) return [];

  return [...entries]
    .sort((a, b) => b.metrics.engagement_score - a.metrics.engagement_score)
    .slice(0, n)
    .filter(e => e.content && e.content.length > 10);
}

// ─── GPT-powered pattern extraction ──────────────────────────────────────────

/**
 * Ask GPT to analyze a set of high-performing tweets and extract:
 * - Common hook patterns
 * - Tone markers
 * - Structural elements
 * - What makes them stop the scroll
 */
async function extractPatternsWithGPT(tweets) {
  if (!tweets.length) return null;

  const openai    = new OpenAI({ apiKey: config.openai.apiKey });
  const tweetList = tweets
    .map((t, i) => `[${i + 1}] (score: ${t.metrics.engagement_score}) "${t.content}"`)
    .join('\n');

  const prompt = `You are analyzing a set of high-performing crypto Twitter posts. Your job is to extract what makes them effective — not describe them, but reverse-engineer the formula.

HIGH-PERFORMING TWEETS:
${tweetList}

Analyze these tweets and return a JSON object with:
{
  "hook_patterns": [
    "Short description of hook pattern 1",
    "Short description of hook pattern 2",
    "Short description of hook pattern 3"
  ],
  "tone_markers": [
    "phrase or tone element that appears across multiple tweets"
  ],
  "structural_elements": [
    "element that makes the structure effective"
  ],
  "opening_lines": [
    "3-5 word example opening that captures the hook style"
  ],
  "what_works": "One sentence: the core formula behind these tweets",
  "inject_into_prompt": "A 2-3 sentence instruction to add to a GPT system prompt to replicate this style"
}

Be specific. Extract the actual pattern, not generic advice like "be engaging". Look for tension, specific data placement, implicit vs explicit takes, line length contrast, etc.`;

  try {
    const response = await withRetry(async () => {
      const completion = await openai.chat.completions.create({
        model: config.openai.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 600,
      });
      return JSON.parse(completion.choices[0].message.content);
    }, { label: 'extractPatterns', retries: 2, delay: 2000 });

    return response;
  } catch (err) {
    log.error(`GPT pattern extraction failed: ${err.message}`);
    return null;
  }
}

// ─── Prompt injection builder ─────────────────────────────────────────────────

/**
 * Build prompt injection strings from extracted patterns.
 * These are prepended to the user prompt in callGPT().
 */
function buildPromptInjections(patterns) {
  if (!patterns) return { ...DEFAULT_PROMPTS };

  const hookInj = patterns.opening_lines?.length
    ? `PROVEN HOOKS (use these as inspiration, not verbatim):\n${patterns.opening_lines.map(h => `- "${h}"`).join('\n')}`
    : '';

  const toneInj = patterns.inject_into_prompt || '';

  const structInj = patterns.structural_elements?.length
    ? `STRUCTURAL ELEMENTS THAT WORK:\n${patterns.structural_elements.map(s => `- ${s}`).join('\n')}`
    : '';

  const avoidInj = `AVOID: generic openings, restating the obvious, explaining the take fully.`;

  return {
    hook_injection:       hookInj,
    tone_injection:       toneInj,
    structure_injection:  structInj,
    avoid_injection:      avoidInj,
    what_works:           patterns.what_works || '',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run full optimization cycle.
 * 1. Pull high performers
 * 2. GPT-analyze patterns
 * 3. Build + save prompt injections
 */
async function runPromptOptimizer() {
  log.info('Running prompt optimizer...');

  const topTweets = getHighPerformers(10);
  if (topTweets.length < 3) {
    log.info(`Not enough high-performers yet (${topTweets.length}) — skipping optimization`);
    return loadOptimizedPrompts();
  }

  log.info(`Analyzing ${topTweets.length} high-performing tweets...`);
  const patterns   = await extractPatternsWithGPT(topTweets);
  const injections = buildPromptInjections(patterns);

  const result = {
    ...injections,
    high_performers: topTweets.map(t => ({
      content: t.content,
      type:    t.type,
      score:   t.metrics.engagement_score,
    })),
    raw_patterns: patterns,
    generated_at: new Date().toISOString(),
  };

  saveOptimizedPrompts(result);

  log.info(`Prompt optimizer complete. What works: ${patterns?.what_works || 'N/A'}`);
  return result;
}

/**
 * Get the current optimized prompts.
 * Called by contentGenerator before every tweet.
 */
function getOptimizedPrompts() {
  return loadOptimizedPrompts();
}

/**
 * Build the full injection string to prepend to a GPT user prompt.
 * @param {string} tweetType
 * @returns {string}
 */
function buildInjectionForPrompt(tweetType) {
  const prompts = loadOptimizedPrompts();
  if (!prompts.generated_at) return ''; // No optimization data yet

  const parts = [
    prompts.tone_injection,
    prompts.hook_injection,
    prompts.structure_injection,
    prompts.avoid_injection,
  ].filter(Boolean);

  if (!parts.length) return '';
  return `\n\n--- PERFORMANCE-LEARNED STYLE RULES ---\n${parts.join('\n')}\n---\n`;
}

module.exports = {
  runPromptOptimizer,
  getOptimizedPrompts,
  buildInjectionForPrompt,
};
