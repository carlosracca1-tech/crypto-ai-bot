'use strict';

/**
 * OAuth 2.0 Token Manager
 *
 * Maneja el ciclo de vida de los tokens OAuth 2.0 de Twitter:
 * - Access Token expira en 2 horas
 * - Refresh Token expira en 6 meses
 * - Auto-refresca cuando el access token está por vencer
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

const log = createModuleLogger('TokenManager');

// Archivo donde guardamos los tokens actualizados
const TOKEN_FILE = path.resolve(process.cwd(), 'data', 'oauth2_tokens.json');

// Cache en memoria: tokens + client autenticado
let _cachedTokens = null;
let _cachedClient = null;

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
    throw new Error('TWITTER_CLIENT_ID y TWITTER_CLIENT_SECRET son necesarios para el refresh');
  }

  log.info('Refrescando OAuth 2.0 access token...');

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

  _cachedTokens = tokens;
  _cachedClient = client;

  log.info(`Token refrescado. Válido hasta: ${new Date(expiresAt).toLocaleTimeString()}`);
  return { client, ...tokens };
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

module.exports = { getValidClient, getValidToken, forceRefresh };
