'use strict';

/**
 * Re-autorización OAuth 2.0 de Twitter
 *
 * Uso:
 *   node scripts/reauthorize.js
 *
 * Qué hace:
 *   1. Genera el link de autorización con PKCE
 *   2. Abre el browser (o muestra el link)
 *   3. Arranca un servidor local en puerto 3000 para capturar el callback
 *   4. Guarda los tokens nuevos en data/oauth2_tokens.json y .env
 */

require('dotenv').config();

const http    = require('http');
const https   = require('https');
const url     = require('url');
const fs      = require('fs');
const path    = require('path');
const { TwitterApi } = require('twitter-api-v2');

const PORT        = 3000;
const CALLBACK    = `http://localhost:${PORT}/callback`;
const TOKEN_FILE  = path.resolve(process.cwd(), 'data', 'oauth2_tokens.json');
const ENV_FILE    = path.resolve(process.cwd(), '.env');

const clientId     = process.env.TWITTER_CLIENT_ID;
const clientSecret = process.env.TWITTER_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('❌ Falta TWITTER_CLIENT_ID o TWITTER_CLIENT_SECRET en .env');
  process.exit(1);
}

// Verificar que el callback esté registrado en el Developer Portal
console.log('\n⚠️  IMPORTANTE: asegurate de que esta URL esté registrada como callback en');
console.log('   Twitter Developer Portal → tu App → User authentication settings:');
console.log(`   ${CALLBACK}\n`);

async function main() {
  const client = new TwitterApi({ clientId, clientSecret });

  // Generar auth link con PKCE
  const { url: authUrl, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK, {
    scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  });

  console.log('🔗 Abriendo browser para autorizar...');
  console.log('   Si no se abre automáticamente, copiá esta URL:\n');
  console.log(`   ${authUrl}\n`);

  // Intentar abrir el browser
  try {
    const open = (u) => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      require('child_process').exec(`${cmd} "${u}"`);
    };
    open(authUrl);
  } catch (e) { /* ignorar — el usuario puede copiar la URL */ }

  // Servidor local para capturar el callback
  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (!parsed.pathname.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const { code, state: returnedState, error } = parsed.query;

      if (error) {
        res.writeHead(400);
        res.end(`<h2>Error: ${error}</h2>`);
        server.close();
        reject(new Error(`Auth rechazada: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('<h2>Error: state mismatch (posible CSRF)</h2>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      try {
        // Intercambiar code por tokens
        const { client: loggedClient, accessToken, refreshToken } =
          await client.loginWithOAuth2({ code, codeVerifier, redirectUri: CALLBACK });

        const expiresAt = Date.now() + (115 * 60 * 1000); // 1h55m

        // Guardar en archivo
        const tokenData = {
          accessToken,
          refreshToken,
          expiresAt,
          refreshedAt: new Date().toISOString(),
          savedAt:     new Date().toISOString(),
        };
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
        console.log(`\n✅ Tokens guardados en ${TOKEN_FILE}`);

        // Actualizar .env
        updateEnvFile('TWITTER_OAUTH2_ACCESS_TOKEN',  accessToken);
        updateEnvFile('TWITTER_OAUTH2_REFRESH_TOKEN',  refreshToken);
        console.log('✅ .env actualizado con los nuevos tokens');

        // Verificar identidad
        const me = await loggedClient.v2.me();
        console.log(`✅ Autenticado como @${me.data.username}`);

        console.log('\n🎉 Re-autorización completada exitosamente!');
        console.log('   Ahora actualizá Railway con los mismos valores:');
        console.log(`   TWITTER_OAUTH2_ACCESS_TOKEN  = ${accessToken.slice(0, 20)}...`);
        console.log(`   TWITTER_OAUTH2_REFRESH_TOKEN = ${refreshToken.slice(0, 20)}...\n`);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>✅ Autorización exitosa!</h2><p>Autenticado como @${me.data.username}</p><p>Podés cerrar esta ventana.</p>`);
      } catch (err) {
        console.error('\n❌ Error intercambiando código:', err.message);
        res.writeHead(500);
        res.end(`<h2>Error: ${err.message}</h2>`);
        server.close();
        reject(err);
        return;
      }

      server.close();
      resolve();
    });

    server.listen(PORT, () => {
      console.log(`⏳ Esperando callback en http://localhost:${PORT}/callback ...`);
    });

    // Timeout de 5 minutos
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout: no se recibió el callback en 5 minutos'));
    }, 5 * 60 * 1000);
  });
}

function updateEnvFile(key, value) {
  if (!fs.existsSync(ENV_FILE)) return;
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
