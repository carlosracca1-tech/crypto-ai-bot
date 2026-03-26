'use strict';
/**
 * Quick OAuth2 Re-auth - No server needed
 *
 * Uso: node scripts/quick-reauth.js
 *
 * 1. Genera PKCE y muestra URL de autorización
 * 2. Vos abrís la URL en el browser y autorizás
 * 3. El browser redirige a localhost:3000/callback (404, no importa)
 * 4. Copiás la URL COMPLETA de la barra de direcciones
 * 5. La pegás acá en la terminal
 * 6. El script intercambia el código por tokens y los guarda
 */

require('dotenv').config();

const https   = require('https');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');

const TOKEN_FILE = path.resolve(process.cwd(), 'data', 'oauth2_tokens.json');
const ENV_FILE   = path.resolve(process.cwd(), '.env');

const clientId     = process.env.TWITTER_CLIENT_ID;
const clientSecret = process.env.TWITTER_CLIENT_SECRET;
const CALLBACK     = 'http://localhost:3000/callback';

if (!clientId || !clientSecret) {
  console.error('❌ Falta TWITTER_CLIENT_ID o TWITTER_CLIENT_SECRET en .env');
  process.exit(1);
}

// ─── PKCE helpers ────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Token exchange via raw HTTPS ────────────────────────────────
function exchangeCode(code, codeVerifier) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: CALLBACK,
      code_verifier: codeVerifier,
    }).toString();

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const options = {
      hostname: 'api.twitter.com',
      port: 443,
      path: '/2/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.access_token) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Save tokens ─────────────────────────────────────────────────
function saveTokens(accessToken, refreshToken) {
  const tokenData = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (115 * 60 * 1000),
    refreshedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  console.log(`\n✅ Tokens guardados en ${TOKEN_FILE}`);

  // Update .env
  if (fs.existsSync(ENV_FILE)) {
    let content = fs.readFileSync(ENV_FILE, 'utf8');
    const update = (key, val) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
    };
    update('TWITTER_OAUTH2_ACCESS_TOKEN', accessToken);
    update('TWITTER_OAUTH2_REFRESH_TOKEN', refreshToken);
    fs.writeFileSync(ENV_FILE, content);
    console.log('✅ .env actualizado');
  }
}

// ─── Main flow ───────────────────────────────────────────────────
async function main() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = 'quickauth_' + Date.now();

  const scopes = 'tweet.read tweet.write users.read offline.access';
  const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(CALLBACK)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  console.log('\n════════════════════════════════════════════════════');
  console.log('  Twitter OAuth2 Quick Re-Authorization');
  console.log('════════════════════════════════════════════════════\n');
  console.log('1. Abrí esta URL en tu browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2. Hacé click en "Authorize app"');
  console.log('3. El browser va a ir a localhost:3000/callback (va a dar 404, está OK)');
  console.log('4. Copiá la URL COMPLETA de la barra de direcciones');
  console.log('5. Pegala acá abajo:\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const callbackUrl = await new Promise(resolve => {
    rl.question('URL del callback: ', resolve);
  });
  rl.close();

  // Extract code from callback URL
  const url = new URL(callbackUrl);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code) {
    console.error('\n❌ No se encontró el código en la URL');
    process.exit(1);
  }

  if (returnedState !== state) {
    console.warn('⚠️  State mismatch — continuando igual (podría ser un refresh de página)');
  }

  console.log('\n⏳ Intercambiando código por tokens...');

  try {
    const tokens = await exchangeCode(code, codeVerifier);

    saveTokens(tokens.access_token, tokens.refresh_token);

    console.log('\n🎉 ¡Re-autorización completada!');
    console.log('\n📋 Copiá estos valores para Railway:\n');
    console.log(`TWITTER_OAUTH2_ACCESS_TOKEN=${tokens.access_token}`);
    console.log(`TWITTER_OAUTH2_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error('\n   Si dice "invalid_grant", el código expiró. Volvé a correr el script.');
    process.exit(1);
  }
}

main();
