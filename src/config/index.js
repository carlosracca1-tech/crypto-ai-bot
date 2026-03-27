'use strict';

require('dotenv').config();

const config = {
  // ─── OpenAI ────────────────────────────────────────────────────────────────
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // GPT-4o-mini: ~10x más barato que GPT-4o, suficiente para tweets de 280 chars
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'dall-e-3',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '800', 10),
    // Timeout para evitar que el pipeline se cuelgue si OpenAI no responde
    requestTimeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10),
  },

  // ─── Twitter / X ───────────────────────────────────────────────────────────
  twitter: {
    appKey: process.env.TWITTER_APP_KEY,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
    bearerToken: process.env.TWITTER_BEARER_TOKEN,
    // COST CONTROL: Free tier = solo writes. NO search, NO reads.
    // Con esto Twitter cuesta $0/mes en vez de $100/mes.
    // Solo se desactiva si tenés plan Basic ($100/mes) y querés engagement.
    readsDisabled: process.env.TWITTER_READS_DISABLED !== 'false',  // DEFAULT: true
  },

  // ─── CoinGecko ─────────────────────────────────────────────────────────────
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY || '',
    baseUrl: 'https://api.coingecko.com/api/v3',
    proBaseUrl: 'https://pro-api.coingecko.com/api/v3',
    // Delay entre requests normales. Free tier: ~30 req/min → mínimo 2000ms.
    // Recomendado: 2500ms para tener margen. Configurable vía Railway.
    rateLimit: parseInt(process.env.COINGECKO_RATE_LIMIT_MS || '2500', 10),
    // Cache del market overview (minutos). Evita llamadas repetidas en el mismo día.
    overviewCacheMinutes: parseInt(process.env.COINGECKO_OVERVIEW_CACHE_MIN || '60', 10),
    // Cooldown extra que se aplica SOLO cuando un token falla con 429.
    // Rompe la cascada: espera que el rate limit window se resetee (~60s)
    // antes de continuar con el siguiente token.
    rateLimitCooldownMs: parseInt(process.env.COINGECKO_RATE_LIMIT_COOLDOWN_MS || '15000', 10),
  },

  // ─── Tokens a monitorear ───────────────────────────────────────────────────
  tokens: {
    // IDs de CoinGecko para proyectos AI
    ids: (process.env.TOKEN_IDS || [
      'bittensor',
      'render-token',
      'fetch-ai',
      'singularitynet',
      'ocean-protocol',
      'akash-network',
      'numeraire',
      'cortex',
      'matrix-ai-network',
      'alethea-artificial-liquid-intelligence-token',
      'worldcoin-wld',
      'near',
      'injective-protocol',
      'the-graph',
      'helium',
    ].join(',')).split(',').map(s => s.trim()),

    // Categoría CoinGecko para AI
    category: 'artificial-intelligence',

    // Top N tokens por cap de mercado a analizar en profundidad
    topN: parseInt(process.env.TOKEN_TOP_N || '10', 10),
  },

  // ─── Análisis técnico ──────────────────────────────────────────────────────
  technicalAnalysis: {
    rsiPeriod: 10,
    macdFast: 8,
    macdSlow: 17,
    macdSignal: 9,
    maPeriods: [7, 14, 20],
    volumeAvgPeriod: 10,
    ohlcDays: 90, // días de velas diarias a obtener
  },

  // ─── Narrativas / Twitter ──────────────────────────────────────────────────
  narrative: {
    searchQueries: [
      'AI crypto',
      'decentralized AI',
      'Bittensor TAO',
      'Render Network RNDR',
      'AI agents blockchain',
      'crypto compute',
      'AGI blockchain',
      'AI data marketplace',
      'fetch.ai FET',
      'SingularityNET AGIX',
      'on-chain AI',
      'AI infrastructure crypto',
      'machine learning blockchain',
    ],
    tweetsPerQuery: parseInt(process.env.NARRATIVE_TWEETS_PER_QUERY || '50', 10),
    minMentionsThreshold: parseInt(process.env.NARRATIVE_MIN_MENTIONS || '3', 10),
    lookbackHours: parseInt(process.env.NARRATIVE_LOOKBACK_HOURS || '24', 10),
  },

  // ─── Contenido ─────────────────────────────────────────────────────────────
  content: {
    // 3 tweets/día = calidad > cantidad. Bien espaciados, cada uno importa.
    tweetsPerDay: parseInt(process.env.TWEETS_PER_DAY || '3', 10),
    threadEveryNDays: parseInt(process.env.THREAD_EVERY_N_DAYS || '7', 10),
    dryRun: process.env.DRY_RUN === 'true',
    manualApproval: process.env.MANUAL_APPROVAL === 'true',
    // Quality gate: 'local' (gratis, rule-based) o 'gpt' (pago, usa OpenAI)
    qualityGateMode: process.env.QUALITY_GATE_MODE || 'local',
    postingSpreadHours: [9, 14, 20],
  },

  // ─── Imágenes ──────────────────────────────────────────────────────────────
  images: {
    width: 1200,
    height: 675,
    outputDir: process.env.IMAGE_OUTPUT_DIR || './data/images',
    useOpenAIImages: process.env.USE_OPENAI_IMAGES === 'true',
  },

  // ─── Storage ───────────────────────────────────────────────────────────────
  storage: {
    dataDir: process.env.DATA_DIR || './data',
    insightsFile: './data/insights.json',
    tweetsFile: './data/generated_tweets.json',
    narrativesFile: './data/narratives.json',
    marketFile: './data/market_snapshot.json',
  },

  // ─── Retry ─────────────────────────────────────────────────────────────────
  retry: {
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '2000', 10),
    backoffMultiplier: 2,
  },

  // ─── Alertas / Email ───────────────────────────────────────────────────────
  alerts: {
    // Destinatario de alertas (errores + health check)
    email: process.env.ALERT_EMAIL || 'carlosracca1@gmail.com',
    // SendGrid: SENDGRID_API_KEY
    // Gmail SMTP: SMTP_USER + SMTP_PASS (usar App Password)
    // Sin config → emails guardados en data/email_log.json solamente
    sendgridKey: process.env.SENDGRID_API_KEY || null,
    smtpHost:    process.env.SMTP_HOST    || 'smtp.gmail.com',
    smtpPort:    parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser:    process.env.SMTP_USER    || null,
    smtpPass:    process.env.SMTP_PASS    || null,
  },
};

// Validación de variables críticas
function validateConfig() {
  const required = [
    ['openai.apiKey', config.openai.apiKey],
  ];

  const warnings = [];

  if (!config.twitter.appKey) warnings.push('TWITTER_APP_KEY no definido - posting deshabilitado');
  if (!config.twitter.bearerToken) warnings.push('TWITTER_BEARER_TOKEN no definido - narrative detection deshabilitado');

  for (const [name, val] of required) {
    if (!val) throw new Error(`Variable de configuración requerida faltante: ${name}`);
  }

  return warnings;
}

module.exports = { config, validateConfig };
