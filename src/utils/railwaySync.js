'use strict';

/**
 * Railway Environment Variable Sync
 *
 * Después de cada refresh de OAuth2 tokens, sincroniza los nuevos valores
 * a las variables de entorno de Railway via su API GraphQL.
 * Así los tokens sobreviven redeploys sin necesidad de actualizar manualmente.
 *
 * Requisitos:
 *   - RAILWAY_API_TOKEN: token de la API de Railway (https://railway.com/account/tokens)
 *   - RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID:
 *     inyectados automáticamente por Railway en cada deploy.
 *
 * Si RAILWAY_API_TOKEN no está configurado, el sync se skipea silenciosamente.
 */

const https = require('https');
const { createModuleLogger } = require('./logger');

const log = createModuleLogger('RailwaySync');

/**
 * Ejecuta una mutación GraphQL contra la API de Railway.
 */
function railwayGraphQL(query, variables, apiToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });

    const options = {
      hostname: 'backboard.railway.app',
      port: 443,
      path: '/graphql/v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors && json.errors.length > 0) {
            reject(new Error(`Railway API error: ${json.errors[0].message}`));
          } else {
            resolve(json.data);
          }
        } catch (e) {
          reject(new Error(`Railway API parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Actualiza una variable de entorno en Railway.
 */
async function upsertVariable(apiToken, projectId, serviceId, environmentId, name, value) {
  const mutation = `
    mutation variableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;

  const variables = {
    input: {
      projectId,
      serviceId,
      environmentId,
      name,
      value,
    },
  };

  return railwayGraphQL(mutation, variables, apiToken);
}

/**
 * Sincroniza los tokens OAuth2 con las env vars de Railway.
 * Si no hay RAILWAY_API_TOKEN, no hace nada (degradación graceful).
 *
 * @param {string} accessToken  - Nuevo access token
 * @param {string} refreshToken - Nuevo refresh token
 */
async function syncTokensToRailway(accessToken, refreshToken) {
  const apiToken      = process.env.RAILWAY_API_TOKEN;
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!apiToken) {
    log.debug('RAILWAY_API_TOKEN no configurado — sync deshabilitado');
    return false;
  }

  if (!projectId || !serviceId || !environmentId) {
    log.warn('Faltan RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID o RAILWAY_ENVIRONMENT_ID');
    return false;
  }

  try {
    log.info('Sincronizando tokens con Railway env vars...');

    await upsertVariable(apiToken, projectId, serviceId, environmentId,
      'TWITTER_OAUTH2_ACCESS_TOKEN', accessToken);

    await upsertVariable(apiToken, projectId, serviceId, environmentId,
      'TWITTER_OAUTH2_REFRESH_TOKEN', refreshToken);

    log.info('✅ Tokens sincronizados con Railway (no trigger redeploy)');
    return true;
  } catch (err) {
    log.warn(`No se pudieron sincronizar tokens con Railway: ${err.message}`);
    return false;
  }
}

module.exports = { syncTokensToRailway };
