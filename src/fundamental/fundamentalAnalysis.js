'use strict';

/**
 * Fundamental Analysis Module
 *
 * Obtiene datos fundamentales de cada token vía CoinGecko y genera
 * análisis profundo con GPT: narrativa, posicionamiento, developer activity,
 * adoption strength, y risk/opportunity framing.
 *
 * Datos usados:
 *   - descripción del proyecto
 *   - links (web, github, reddit)
 *   - developer_data (commits, PRs, stars)
 *   - community_data (seguidores)
 *   - market_data (mcap rank, volume/mcap ratio, circ supply %)
 */

const axios  = require('axios');
const OpenAI = require('openai');
const { config }             = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { sleep }              = require('../utils/retry');
const { formatPrice }        = require('../utils/helpers');

const log = createModuleLogger('FundamentalAnalysis');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── CoinGecko deep fetch ──────────────────────────────────────────────────────

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

async function fetchCoinDetails(coinId) {
  try {
    // Rate limiting — respetar el mismo rate limit que marketData.js
    await sleep(config.coingecko.rateLimit);

    const baseUrl = config.coingecko.apiKey
      ? config.coingecko.proBaseUrl
      : config.coingecko.baseUrl;
    const url    = `${baseUrl}/coins/${coinId}`;
    const params = {
      localization: false,
      tickers:      false,
      market_data:  true,
      community_data: true,
      developer_data: true,
      sparkline:    false,
    };
    const headers = config.coingecko.apiKey
      ? { 'x-cg-pro-api-key': config.coingecko.apiKey }
      : {};

    const res = await axios.get(url, { params, headers, timeout: 15000 });
    return res.data;
  } catch (err) {
    // Si es 429 (rate limit), esperar cooldown extra antes de retornar
    if (err.response?.status === 429 || err.message?.includes('429')) {
      const cooldown = config.coingecko.rateLimitCooldownMs || 15000;
      log.warn(`fetchCoinDetails(${coinId}): 429 rate limit — cooldown ${cooldown}ms`);
      await sleep(cooldown);
    }
    log.error(`fetchCoinDetails(${coinId}): ${err.message}`);
    return null;
  }
}

// ─── Data extraction ───────────────────────────────────────────────────────────

function extractFundamentals(raw) {
  if (!raw) return null;

  const name   = raw.name;
  const symbol = (raw.symbol || '').toUpperCase();

  // Description — truncate to 800 chars for GPT context
  const description = (raw.description?.en || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 800);

  // Market positioning
  const mcap      = raw.market_data?.market_cap?.usd          || 0;
  const volume24h = raw.market_data?.total_volume?.usd         || 0;
  const mcapRank  = raw.market_cap_rank                        || null;
  const circSupplyPct = raw.market_data?.circulating_supply && raw.market_data?.total_supply
    ? (raw.market_data.circulating_supply / raw.market_data.total_supply) * 100
    : null;
  const volumeToMcap = mcap > 0 ? (volume24h / mcap) * 100 : null;

  // ATH drawdown
  const athChangePercent = raw.market_data?.ath_change_percentage?.usd || null;

  // Developer activity
  const devData = raw.developer_data || {};
  const githubStars    = devData.stars           || 0;
  const forks          = devData.forks           || 0;
  const commits4weeks  = devData.commit_count_4_weeks || 0;
  const pullRequests   = devData.pull_requests_merged || 0;

  // Community
  const twitterFollowers = raw.community_data?.twitter_followers || 0;
  const redditSubs       = raw.community_data?.reddit_subscribers || 0;

  // Categories
  const categories = (raw.categories || []).filter(Boolean).slice(0, 5);

  // Links
  const website = raw.links?.homepage?.[0] || null;
  const github  = raw.links?.repos_url?.github?.[0] || null;

  return {
    name, symbol, description, mcapRank, mcap, volume24h,
    circSupplyPct, volumeToMcap, athChangePercent,
    githubStars, forks, commits4weeks, pullRequests,
    twitterFollowers, redditSubs, categories,
    website, github,
  };
}

// ─── GPT insight generation ────────────────────────────────────────────────────

const FUNDAMENTAL_SYSTEM = `You are a crypto fundamental analyst for @TheProtocoMind.
You analyze AI + crypto projects beyond price. Your job: cut through hype, find signal.

VOICE: Precise. Contrarian when warranted. No cheerleading. No FUD.
You look at: what the project actually does, dev activity, adoption vs narrative, positioning.

OUTPUT FORMAT (for tweets):
- 3 tight lines. Hard limit 278 chars total.
- Line 1: The core positioning insight (what this project actually IS in the ecosystem)
- Line 2: The signal (dev activity / adoption / narrative gap / risk)
- Line 3: The implication or tension (what this means going forward)

Do NOT use: emojis, hashtags, "bullish", "bearish", buy/sell advice.
Do NOT explain too much. Implied > stated. Leave something for the reader to connect.`;

async function generateFundamentalInsight(fundamentals, marketContext = '') {
  const f = fundamentals;

  const devSignal = f.commits4weeks > 20
    ? `active development (${f.commits4weeks} commits/4w)`
    : f.commits4weeks > 5
    ? `moderate dev activity (${f.commits4weeks} commits/4w)`
    : f.commits4weeks > 0
    ? `low dev activity (${f.commits4weeks} commits/4w)`
    : 'GitHub data unavailable';

  const adoptionSignal = f.volumeToMcap !== null
    ? `volume/mcap ratio ${f.volumeToMcap.toFixed(1)}% — ${f.volumeToMcap > 15 ? 'high relative trading (spec-driven)' : f.volumeToMcap > 5 ? 'healthy liquidity' : 'low trading relative to size'}`
    : '';

  const supplySignal = f.circSupplyPct !== null
    ? `${f.circSupplyPct.toFixed(0)}% of supply circulating`
    : '';

  const athSignal = f.athChangePercent !== null
    ? `${Math.abs(f.athChangePercent).toFixed(0)}% below ATH`
    : '';

  const userPrompt = [
    `PROJECT: ${f.name} (${f.symbol}) | Rank #${f.mcapRank || '?'}`,
    '',
    `DESCRIPTION: ${f.description || 'Not available'}`,
    '',
    `CATEGORIES: ${f.categories.join(', ') || 'AI, crypto'}`,
    '',
    `FUNDAMENTALS:`,
    `- Developer activity: ${devSignal}`,
    `- GitHub stars: ${f.githubStars.toLocaleString()} | Forks: ${f.forks}`,
    adoptionSignal ? `- Adoption: ${adoptionSignal}` : '',
    supplySignal   ? `- Supply: ${supplySignal}`     : '',
    athSignal      ? `- Price: ${athSignal}`         : '',
    `- Community: ${(f.twitterFollowers/1000).toFixed(1)}K Twitter followers`,
    '',
    marketContext ? `MARKET CONTEXT: ${marketContext}` : '',
    '',
    `Write a tweet that reveals something non-obvious about this project's fundamentals.`,
    `Focus on: dev activity vs narrative, adoption vs hype, ecosystem role, or structural risk/opportunity.`,
  ].filter(Boolean).join('\n');

  const response = await openai.chat.completions.create({
    model:       config.openai.model,
    max_tokens:  130,
    temperature: 0.75,
    messages: [
      { role: 'system', content: FUNDAMENTAL_SYSTEM },
      { role: 'user',   content: userPrompt },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) return null;

  // Enforce 278 char limit
  if (raw.length > 278) {
    return raw.substring(0, 276).replace(/\s+\S*$/, '').trim();
  }
  return raw;
}

// ─── Thread generation ─────────────────────────────────────────────────────────

const THREAD_SYSTEM = `You are the voice of @TheProtocoMind — a sharp AI crypto analyst.
Write a Twitter thread that's actually worth reading. No fluff. Real signal.

THREAD STRUCTURE (5-7 tweets):
1. HOOK — one line that stops the scroll. A tension, a contradiction, or a strong claim.
2. CONTEXT — what's actually happening in this narrative/project right now.
3. THE DATA — 2-3 specific data points that most people aren't talking about.
4. THE MECHANISM — why this matters. What's the underlying dynamic.
5. THE TENSION — what could go wrong. What would change the thesis.
6. THE TAKE — your read. What to watch. Not buy/sell advice.
7. (Optional) CLOSE — one memorable line that makes people follow.

RULES:
- Each tweet: max 270 chars, 3 lines max
- No emojis. No hashtags. No "bullish" or "bearish".
- Thread numbering: "1/" "2/" etc. at the start of each tweet
- Make tweet 1 standalone-shareable (strong enough on its own)
- Implied > stated. Sharp > complete.

OUTPUT: Return each tweet on a separate line, prefixed with the number (1/, 2/, etc.)`;

async function generateFundamentalThread(fusionData, focusToken = null) {
  const token = focusToken || fusionData?.tokens?.[0];
  if (!token) return null;

  // Fetch fundamentals for the thread token
  const raw = await fetchCoinDetails(token.id || token.name?.toLowerCase().replace(' ', '-'));
  const fundamentals = extractFundamentals(raw);

  await sleep(1500);

  const f = fundamentals || {};
  const price    = formatPrice(token.currentPrice);
  const change   = token.change24h?.toFixed(2);

  const userPrompt = [
    `TOPIC: Fundamental analysis of ${token.name} (${(token.symbol || '').toUpperCase()})`,
    '',
    f.description ? `PROJECT: ${f.description.substring(0, 500)}` : '',
    f.categories?.length ? `CATEGORIES: ${f.categories.join(', ')}` : '',
    '',
    `MARKET DATA:`,
    `- Price: ${price} | 24h change: ${change}%`,
    `- Rank: #${f.mcapRank || token.marketCapRank || '?'}`,
    f.commits4weeks > 0 ? `- Dev activity: ${f.commits4weeks} commits in last 4 weeks` : '',
    f.volumeToMcap ? `- Volume/MCap: ${f.volumeToMcap.toFixed(1)}%` : '',
    f.circSupplyPct ? `- Circulating supply: ${f.circSupplyPct.toFixed(0)}%` : '',
    '',
    `AI ECOSYSTEM CONTEXT: ${fusionData?.narrativeSummary || 'AI infrastructure tokens showing diverging fundamentals'}`,
    '',
    `Write a 5-6 tweet thread analyzing this project's real fundamental position in the AI crypto ecosystem.`,
    `Focus on: what it actually does, developer signals, narrative vs adoption, structural opportunity or risk.`,
  ].filter(Boolean).join('\n');

  const response = await openai.chat.completions.create({
    model:       config.openai.model,
    max_tokens:  800,
    temperature: 0.72,
    messages: [
      { role: 'system', content: THREAD_SYSTEM },
      { role: 'user',   content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return null;

  // Parse tweets from numbered lines
  const lines  = content.split('\n').filter(l => l.trim());
  const tweets = [];
  let   current = '';

  for (const line of lines) {
    if (/^\d+\//.test(line.trim())) {
      if (current) tweets.push(current.trim());
      current = line.trim();
    } else {
      current += '\n' + line.trim();
    }
  }
  if (current) tweets.push(current.trim());

  // Enforce 278 chars per tweet
  const cleaned = tweets.map(t => {
    if (t.length > 278) return t.substring(0, 276).replace(/\s+\S*$/, '').trim();
    return t;
  }).filter(t => t.length > 10);

  return {
    tweets:     cleaned,
    tweetCount: cleaned.length,
    token:      token.name,
    type:       'fundamental_thread',
    generatedAt: new Date().toISOString(),
  };
}

// ─── Single-tweet fundamental insight ─────────────────────────────────────────

/**
 * Genera un tweet de fundamental insight para el token más relevante.
 * Usado desde contentGenerator.js como tipo 'fundamental_insight'.
 */
async function generateFundamentalTweet(fusionData) {
  const tokens = fusionData?.tokens || [];
  if (!tokens.length) return null;

  // Pick the token with the most interesting fundamental situation
  // Priority: tokens with notable dev activity OR narrative divergence
  const focusToken = tokens.find(t => t.name && t.id) || tokens[0];
  if (!focusToken) return null;

  log.info(`Generando fundamental insight para ${focusToken.name} (${focusToken.id})`);

  const raw = await fetchCoinDetails(focusToken.id);
  if (!raw) {
    log.warn(`No se pudo obtener datos CoinGecko para ${focusToken.id} — usando datos básicos`);
    return generateBasicFundamentalTweet(focusToken, fusionData);
  }

  const fundamentals = extractFundamentals(raw);
  await sleep(1200);

  const marketCtx = fusionData?.narrativeSummary || '';
  const insight   = await generateFundamentalInsight(fundamentals, marketCtx);

  return insight;
}

/**
 * Fallback: genera fundamental insight usando solo datos del fusionData.
 */
async function generateBasicFundamentalTweet(token, fusionData) {
  const prompt = [
    `PROJECT: ${token.name} (${(token.symbol || '').toUpperCase()})`,
    `Current price: ${formatPrice(token.currentPrice)} | 24h: ${token.change24h?.toFixed(2)}%`,
    `Market cap rank: #${token.marketCapRank || '?'}`,
    '',
    `AI ECOSYSTEM: ${fusionData?.narrativeSummary || 'AI infrastructure tokens — narrative strong, adoption mixed'}`,
    '',
    `Write a 3-line tweet (max 278 chars) analyzing this project's fundamental position in AI crypto.`,
    `No emojis. No hashtags. No buy/sell advice. Sharp, non-obvious insight.`,
  ].join('\n');

  const response = await openai.chat.completions.create({
    model:       config.openai.model,
    max_tokens:  130,
    temperature: 0.75,
    messages: [
      { role: 'system', content: FUNDAMENTAL_SYSTEM },
      { role: 'user',   content: prompt },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

module.exports = { generateFundamentalTweet, generateFundamentalThread, fetchCoinDetails, extractFundamentals };
