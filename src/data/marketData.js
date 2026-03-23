'use strict';

const axios = require('axios');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { withRetry, sleep } = require('../utils/retry');

const log = createModuleLogger('MarketData');

// Configuración de axios con interceptores de rate-limit
const cgClient = axios.create({
  baseURL: config.coingecko.apiKey
    ? config.coingecko.proBaseUrl
    : config.coingecko.baseUrl,
  timeout: 15000,
  headers: config.coingecko.apiKey
    ? { 'x-cg-pro-api-key': config.coingecko.apiKey }
    : {},
});

/**
 * Obtiene tokens de la categoría AI ordenados por market cap
 * @returns {Promise<Array>}
 */
async function fetchAIMarketOverview() {
  log.info('Obteniendo overview de mercado AI...');

  const result = await withRetry(
    async () => {
      const response = await cgClient.get('/coins/markets', {
        params: {
          vs_currency: 'usd',
          category: config.tokens.category,
          order: 'market_cap_desc',
          per_page: 50,
          page: 1,
          sparkline: false,
          price_change_percentage: '1h,24h,7d',
        },
      });
      return response.data;
    },
    { label: 'fetchAIMarketOverview', ...config.retry }
  );

  log.info(`Obtenidos ${result.length} tokens de la categoría AI`);
  return result.map(normalizeMarketToken);
}

/**
 * Obtiene datos OHLC de un token específico
 * @param {string} tokenId - ID de CoinGecko
 * @param {number} days - Días de historial
 * @returns {Promise<Array>}
 */
async function fetchOHLC(tokenId, days = 90) {
  log.info(`Obteniendo OHLC para ${tokenId} (${days} días)...`);

  await sleep(config.coingecko.rateLimit); // rate limiting

  const raw = await withRetry(
    async () => {
      const response = await cgClient.get(`/coins/${tokenId}/ohlc`, {
        params: { vs_currency: 'usd', days },
      });
      return response.data;
    },
    { label: `fetchOHLC(${tokenId})`, ...config.retry }
  );

  // raw = [[timestamp, open, high, low, close], ...]
  return raw.map(([timestamp, open, high, low, close]) => ({
    timestamp,
    date: new Date(timestamp).toISOString(),
    open,
    high,
    low,
    close,
  }));
}

/**
 * Obtiene historial de precios en formato simple [timestamp, price]
 * @param {string} tokenId
 * @param {number} days
 * @returns {Promise<Array>}
 */
async function fetchPriceHistory(tokenId, days = 90) {
  log.info(`Obteniendo precio histórico para ${tokenId}...`);

  await sleep(config.coingecko.rateLimit);

  const raw = await withRetry(
    async () => {
      const response = await cgClient.get(`/coins/${tokenId}/market_chart`, {
        params: { vs_currency: 'usd', days, interval: 'daily' },
      });
      return response.data;
    },
    { label: `fetchPriceHistory(${tokenId})`, ...config.retry }
  );

  return {
    prices: raw.prices.map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: raw.total_volumes.map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
    marketCaps: raw.market_caps.map(([ts, cap]) => ({ timestamp: ts, marketCap: cap })),
  };
}

/**
 * Obtiene datos de mercado para tokens específicos por ID
 * @param {string[]} tokenIds
 * @returns {Promise<Array>}
 */
async function fetchTokensMarketData(tokenIds) {
  log.info(`Obteniendo market data para ${tokenIds.length} tokens...`);

  const result = await withRetry(
    async () => {
      const response = await cgClient.get('/coins/markets', {
        params: {
          vs_currency: 'usd',
          ids: tokenIds.join(','),
          order: 'market_cap_desc',
          per_page: tokenIds.length,
          page: 1,
          sparkline: false,
          price_change_percentage: '1h,24h,7d,30d',
        },
      });
      return response.data;
    },
    { label: 'fetchTokensMarketData', ...config.retry }
  );

  return result.map(normalizeMarketToken);
}

/**
 * Normaliza la respuesta de CoinGecko a estructura interna
 * @param {object} raw
 * @returns {object}
 */
function normalizeMarketToken(raw) {
  return {
    id: raw.id,
    symbol: raw.symbol?.toUpperCase(),
    name: raw.name,
    currentPrice: raw.current_price,
    marketCap: raw.market_cap,
    marketCapRank: raw.market_cap_rank,
    volume24h: raw.total_volume,
    volumeToMarketCap: raw.total_volume && raw.market_cap
      ? raw.total_volume / raw.market_cap
      : null,
    change1h: raw.price_change_percentage_1h_in_currency,
    change24h: raw.price_change_percentage_24h,
    change7d: raw.price_change_percentage_7d_in_currency,
    change30d: raw.price_change_percentage_30d_in_currency,
    ath: raw.ath,
    athDate: raw.ath_date,
    athChange: raw.ath_change_percentage,
    atl: raw.atl,
    atlDate: raw.atl_date,
    atlChange: raw.atl_change_percentage,
    circulatingSupply: raw.circulating_supply,
    totalSupply: raw.total_supply,
    maxSupply: raw.max_supply,
    high24h: raw.high_24h,
    low24h: raw.low_24h,
    lastUpdated: raw.last_updated,
    image: raw.image,
  };
}

/**
 * Obtiene detalles completos de un token (descripción, links, etc.)
 * @param {string} tokenId
 * @returns {Promise<object>}
 */
async function fetchTokenDetails(tokenId) {
  await sleep(config.coingecko.rateLimit);

  const raw = await withRetry(
    async () => {
      const response = await cgClient.get(`/coins/${tokenId}`, {
        params: {
          localization: false,
          tickers: false,
          market_data: true,
          community_data: false,
          developer_data: false,
        },
      });
      return response.data;
    },
    { label: `fetchTokenDetails(${tokenId})`, ...config.retry }
  );

  return {
    id: raw.id,
    name: raw.name,
    symbol: raw.symbol?.toUpperCase(),
    description: raw.description?.en?.slice(0, 500),
    categories: raw.categories,
    homepage: raw.links?.homepage?.[0],
    twitterHandle: raw.links?.twitter_screen_name,
    githubRepos: raw.links?.repos_url?.github?.filter(Boolean),
    sentimentVotesUp: raw.sentiment_votes_up_percentage,
    sentimentVotesDown: raw.sentiment_votes_down_percentage,
    watchlistUsers: raw.watchlist_portfolio_users,
    publicInterestScore: raw.public_interest_score,
  };
}

// ─── OHLC sintético desde historial de precios ────────────────────────────────

/**
 * CoinGecko free tier devuelve solo ~23 candles para ohlc?days=90 (granularidad
 * semanal/4h). Con menos de 50 candles no se puede calcular MA50 ni detectar
 * tendencia. Solución: construir OHLC diario sintético desde market_chart,
 * que sí retorna datos diarios para 90+ días en cualquier plan.
 *
 * open  = cierre del día anterior
 * close = precio del día
 * high  = max(open, close) con +0.15% de wick estimado
 * low   = min(open, close) con -0.15% de wick estimado
 */
function buildOhlcFromPriceHistory(priceHistory) {
  if (!priceHistory?.prices || priceHistory.prices.length < 2) return [];

  return priceHistory.prices.map((p, i, arr) => {
    const open  = i > 0 ? arr[i - 1].price : p.price;
    const close = p.price;
    const high  = Math.max(open, close) * 1.0015;
    const low   = Math.min(open, close) * 0.9985;
    return {
      timestamp: p.timestamp,
      date:      new Date(p.timestamp).toISOString(),
      open,
      high,
      low,
      close,
    };
  });
}

/**
 * Obtiene el snapshot completo del mercado AI (top N tokens con OHLC)
 * @returns {Promise<object>}
 */
async function getFullMarketSnapshot() {
  const startTime = Date.now();
  log.info('Iniciando snapshot completo del mercado...');

  // 1. Overview general
  const overview = await fetchAIMarketOverview();
  const topTokens = overview.slice(0, config.tokens.topN);

  // 2. OHLC y historial de precios para top tokens
  const MIN_CANDLES = 50; // mínimo para calcular MA50 y detectar tendencia
  const enriched = [];
  const failedTokens = [];

  for (const token of topTokens) {
    try {
      log.info(`Enriqueciendo datos para ${token.symbol}...`);

      const ohlcRaw = await fetchOHLC(token.id, config.technicalAnalysis.ohlcDays);
      await sleep(config.coingecko.rateLimit);
      const history = await fetchPriceHistory(token.id, config.technicalAnalysis.ohlcDays);
      await sleep(config.coingecko.rateLimit);

      // Si CoinGecko devuelve pocos candles (granularidad semanal/4h),
      // usar OHLC sintético construido desde el historial diario de precios
      let ohlc = ohlcRaw;
      if (ohlc.length < MIN_CANDLES) {
        const synthetic = buildOhlcFromPriceHistory(history);
        if (synthetic.length >= MIN_CANDLES) {
          log.info(`${token.symbol}: OHLC API ${ohlc.length} candles → usando sintético diario (${synthetic.length} candles)`);
          ohlc = synthetic;
        } else {
          log.warn(`${token.symbol}: OHLC insuficiente (API: ${ohlcRaw.length}, sintético: ${synthetic.length})`);
        }
      }

      enriched.push({ ...token, ohlc, history });
    } catch (err) {
      log.error(`Error enriqueciendo ${token.symbol}: ${err.message}`);
      enriched.push({ ...token, ohlc: [], history: null });
      failedTokens.push({ symbol: token.symbol, error: err.message });

      // FIX: si el error es 429 (rate limit), esperar un cooldown largo antes
      // del próximo token para romper la cascada de fallos consecutivos.
      // Sin este sleep, el siguiente token empieza casi de inmediato y
      // también falla porque la API sigue bloqueada.
      if (err.message && err.message.includes('429')) {
        const cooldown = config.coingecko.rateLimitCooldownMs || 15000;
        log.warn(`429 en ${token.symbol} — cooldown ${cooldown}ms antes del próximo token`);
        await sleep(cooldown);
      }
    }
  }

  // Alerta de degradación si ≥30% de los tokens fallaron
  const failureRate = failedTokens.length / topTokens.length;
  if (failedTokens.length > 0) {
    log.warn(`Snapshot degradado: ${failedTokens.length}/${topTokens.length} tokens sin OHLC (${(failureRate * 100).toFixed(0)}%)`);
  }
  if (failureRate >= 0.3) {
    setImmediate(async () => {
      try {
        const { sendErrorAlert } = require('../alerts/emailAlerts');
        await sendErrorAlert({
          module: 'MarketData — Snapshot Degradado',
          error: `${failedTokens.length}/${topTokens.length} tokens fallaron al obtener OHLC (${(failureRate * 100).toFixed(0)}%)`,
          stack: failedTokens.map(t => `${t.symbol}: ${t.error}`).join('\n'),
          context: {
            tokens_fallidos: failedTokens.map(t => t.symbol).join(', '),
            tasa_fallo: `${(failureRate * 100).toFixed(0)}%`,
            causa_probable: 'CoinGecko rate limit (429)',
            accion_recomendada: 'Subir COINGECKO_RATE_LIMIT_MS a 3000 en Railway Variables',
          },
        });
      } catch (e) {
        log.error(`No se pudo enviar alerta de degradación: ${e.message}`);
      }
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Snapshot completo en ${elapsed}s. ${enriched.length} tokens procesados.`);

  return {
    timestamp: new Date().toISOString(),
    totalTokensInCategory: overview.length,
    tokens: enriched,
    marketOverview: {
      totalMarketCap: overview.reduce((a, t) => a + (t.marketCap || 0), 0),
      topGainers24h: [...overview]
        .sort((a, b) => (b.change24h || 0) - (a.change24h || 0))
        .slice(0, 5)
        .map(t => ({ symbol: t.symbol, change24h: t.change24h })),
      topLosers24h: [...overview]
        .sort((a, b) => (a.change24h || 0) - (b.change24h || 0))
        .slice(0, 5)
        .map(t => ({ symbol: t.symbol, change24h: t.change24h })),
      avgChange24h:
        overview.reduce((a, t) => a + (t.change24h || 0), 0) / overview.length,
    },
  };
}

module.exports = {
  fetchAIMarketOverview,
  fetchOHLC,
  fetchPriceHistory,
  fetchTokensMarketData,
  fetchTokenDetails,
  getFullMarketSnapshot,
};
