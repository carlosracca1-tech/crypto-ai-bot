'use strict';

/**
 * OAuth 2.0 Token Manager
 *
 * Maneja el ciclo de vida de los tokens OAuth 2.0 de Twitter:
 * - Access Token expira en 2 horas
 * - Refresh Token expira en 6 meses
 * - Auto-refresca cuando el access token está por vencer
 * - ALERTA por email cuando el refresh falla (tokens revocados/expirados)
 *
 * IMPORTANTE: new TwitterApi(accessToken) crea un cliente app-only (Bearer).
 * Para user context OAuth 2.0 hay que usar el objeto `client` que devuelve
 * refreshOAuth2Token(). Por eso cacheamos ese client, no solo el token string.
 */

require('dotenv').config();

const fs   = require('fs-extra');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const { createModuleLogger } = require('./logger');
const { syncTokensToRailway } = require('./railwaySync');

const log = createModuleLogger('TokenManager');

// Archivo donde guardamos los tokens actualizados
const TOKEN_FILE = path.resolve(process.cwd(), 'data', 'oauth2_tokens.json');

// Cache en memoria: tokens + client autenticado
let _cachedTokens = null;
let _cachedClient = null;

// Flag para no enviar la misma alerta repetidamente en un ciclo
let _alertSentThisSession = false;

// ─── Carga de tokens desde disco o env ───────────────────────────────────────

async function loadTokens() {
  // 1. Intentar desde archivo (más actualizado que env vars)
  try {
    if (await fs.pathExists(TOKEN_FILE)) {
      const data = await fs.readJSON(TOKEN_FILE);
      if (data.refreshToken) {
        log.info('Tokens cargados desde archivo local');
        return data;
      }
    }
  } catch (err) {
    log.warn(`No se pudo leer tokens de archivo: ${err.message}`);
  }

  // 2. Fallback a variables de entorno
  const accessToken  = process.env.TWITTER_OAUTH2_ACCESS_TOKEN;
  const refreshToken = process.env.TWITTER_OAUTH2_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error('TWITTER_OAUTH2_REFRESH_TOKEN no está configurado en .env');
  }

  log.info('Tokens cargados desde variables de entorno');
  return {
    accessToken,
    refreshToken,
    expiresAt: 0, // Forzar refresh en primer uso
  };
}

// ─── Guardado de tokens en disco ─────────────────────────────────────────────

async function saveTokens(tokens) {
  try {
    await fs.ensureDir(path.dirname(TOKEN_FILE));
    await fs.writeJSON(TOKEN_FILE, {
      accessToken:  tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt:    tokens.expiresAt,
      refreshedAt:  tokens.refreshedAt,
      savedAt:      new Date().toISOString(),
    }, { spaces: 2 });
    log.info('Tokens guardados exitosamente');
  } catch (err) {
    log.warn(`No se pudieron guardar tokens: ${err.message}`);
  }
}

// ─── Alerta de tokens expirados ──────────────────────────────────────────────

async function sendTokenExpirationAlert(errorMessage) {
  if (_alertSentThisSession) return;
  _alertSentThisSession = true;

  log.error('═══════════════════════════════════════════════════════════');
  log.error('🚨 TOKENS OAUTH2 EXPIRADOS O REVOCADOS');
  log.error(`Error: ${errorMessage}`);
  log.error('Los tweets NO se van a publicar hasta que reautorices.');
  log.error('Ejecutá: node scripts/reauthorize.js');
  log.error('═══════════════════════════════════════════════════════════');

  // Intentar enviar email de alerta
  try {
    const { sendErrorAlert } = require('../alerts/emailAlerts');
    await sendErrorAlert({
      module: 'TokenManager — OAuth2 EXPIRADO',
      error: errorMessage,
      stack: 'El bot NO puede publicar tweets. Requiere reautorización manual.',
      context: {
        accion_requerida: 'Ejecutar: node scripts/reauthorize.js',
        token_file: TOKEN_FILE,
        ultima_renovacion: _cachedTokens?.refreshedAt || 'desconocida',
        docs: 'https://developer.twitter.com/en/docs/authentication/oauth-2-0',
      },
    });
  } catch (e) {
    log.warn(`No se pudo enviar alerta de tokens: ${e.message}`);
  }
}

// ─── Refresh real ─────────────────────────────────────────────────────────────

/**
 * Hace el refresh con el refreshToken dado.
 * Devuelve { client, accessToken, refreshToken, expiresAt }.
 * El `client` devuelto por refreshOAuth2Token() ES user context OAuth 2.0.
 */
async function doRefresh(refreshToken) {
  const clientId     = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('TWITTER_CLIENT_ID y TWITTER_CLIENT_SECRET son necesarios para el refresh');
    await sendTokenExpirationAlert(err.message);
    throw err;
  }

  log.info('Refrescando OAuth 2.0 access token...');

  try {
    const refreshClient = new TwitterApi({ clientId, clientSecret });

    // client aquí ES el cliente autenticado como user context (no app-only)
    const {
      client,
      accessToken:  newAccessToken,
      refreshToken: newRefreshToken,
    } = await refreshClient.refreshOAuth2Token(refreshToken);

    const expiresAt = Date.now() + (115 * 60 * 1000); // 1h55m

    const tokens = {
      accessToken:  newAccessToken,
      refreshToken: newRefreshToken || refreshToken,
      expiresAt,
      refreshedAt:  new Date().toISOString(),
    };

    await saveTokens(tokens);

    // Sincronizar con Railway env vars para que sobrevivan redeploys
    await syncTokensToRailway(newAccessToken, tokens.refreshToken);

    // También actualizar process.env en memoria
    process.env.TWITTER_OAUTH2_ACCESS_TOKEN  = newAccessToken;
    process.env.TWITTER_OAUTH2_REFRESH_TOKEN = tokens.refreshToken;

    _cachedTokens = tokens;
    _cachedClient = client;
    _alertSentThisSession = false; // Reset flag on success

    log.info(`✅ Token refrescado OK. Válido hasta: ${new Date(expiresAt).toLocaleTimeString()}`);
    return { client, ...tokens };
  } catch (err) {
    // ─── ALERTA: el refresh falló ──────────────────────────────────────
    const isAuthError = err.message?.includes('401') ||
                        err.message?.includes('403') ||
                        err.message?.includes('invalid_request') ||
                        err.message?.includes('invalid_grant') ||
                        err.message?.includes('token') ||
                        err.code === 401 || err.code === 403;

    if (isAuthError) {
      await sendTokenExpirationAlert(`Refresh falló: ${err.message}`);
    }

    log.error(`❌ Error en refresh OAuth2: ${err.message}`);
    throw err;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Devuelve un cliente OAuth 2.0 user context válido.
 * Si el access token está por vencer (o no existe), hace refresh automático.
 * Usar SIEMPRE este método para postear — no new TwitterApi(string).
 */
async function getValidClient() {
  // Usar cache si todavía es válido
  if (_cachedClient && _cachedTokens && _cachedTokens.expiresAt > Date.now()) {
    return _cachedClient;
  }

  const tokens = await loadTokens();

  // Refrescar si está vencido o no tiene expiry
  if (!tokens.expiresAt || tokens.expiresAt <= Date.now()) {
    log.info('Access token vencido o sin expiry. Iniciando refresh...');
    const result = await doRefresh(tokens.refreshToken);
    return result.client;
  }

  // Token aún válido pero no tenemos el client cacheado → refresh igual
  // (no podemos reconstruir el client user-context desde un token string)
  log.info('Reconstruyendo client con refresh (primera vez en sesión)...');
  const result = await doRefresh(tokens.refreshToken);
  return result.client;
}

/**
 * Fuerza un refresh del token (útil al inicio de cada pipeline run).
 * @returns {import('twitter-api-v2').TwitterApi} cliente autenticado
 */
async function forceRefresh() {
  const tokens = await loadTokens();
  const result = await doRefresh(tokens.refreshToken);
  return result.client;
}

/**
 * Legacy: devuelve solo el access token string (para compatibilidad).
 * Prefer getValidClient() para postear.
 */
async function getValidToken() {
  const tokens = await loadTokens();
  if (!tokens.expiresAt || tokens.expiresAt <= Date.now()) {
    const result = await doRefresh(tokens.refreshToken);
    return result.accessToken;
  }
  return tokens.accessToken;
}

/**
 * Verifica si los tokens están sanos sin hacer refresh.
 * Útil para health checks.
 */
async function checkTokenHealth() {
  try {
    const tokens = await loadTokens();
    const now = Date.now();
    const expiresAt = tokens.expiresAt || 0;
    const isExpired = expiresAt <= now;
    const hoursUntilExpiry = isExpired ? 0 : (expiresAt - now) / 3600000;

    return {
      hasRefreshToken: !!tokens.refreshToken,
      hasAccessToken:  !!tokens.accessToken,
      isExpired,
      expiresAt: new Date(expiresAt).toISOString(),
      hoursUntilExpiry: hoursUntilExpiry.toFixed(1),
      lastRefresh: tokens.refreshedAt || 'never',
    };
  } catch (err) {
    return { error: err.message, healthy: false };
  }
}

module.exports = { getValidClient, getValidToken, forceRefresh, checkTokenHealth };
