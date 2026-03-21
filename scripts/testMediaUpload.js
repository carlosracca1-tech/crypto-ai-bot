'use strict';

/**
 * Diagnóstico OAuth 1.0a + Media Upload
 *
 * Ejecutar desde la terminal del Mac:
 *   node scripts/testMediaUpload.js
 *
 * Verifica:
 *  1. Que las credenciales OAuth 1.0a son válidas
 *  2. Que la app tiene permisos de Read+Write
 *  3. Que el upload de media a Twitter v1.1 funciona
 */

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const { createCanvas } = require('canvas');
const fs   = require('fs');
const path = require('path');

async function main() {
  const {
    TWITTER_APP_KEY:       appKey,
    TWITTER_APP_SECRET:    appSecret,
    TWITTER_ACCESS_TOKEN:  accessToken,
    TWITTER_ACCESS_SECRET: accessSecret,
  } = process.env;

  console.log('\n══════════════════════════════════════════');
  console.log(' OAuth 1.0a + Media Upload — Diagnóstico');
  console.log('══════════════════════════════════════════\n');

  // ─── Verificar que están seteadas ───────────────────────────────────────────
  const vars = { TWITTER_APP_KEY: appKey, TWITTER_APP_SECRET: appSecret, TWITTER_ACCESS_TOKEN: accessToken, TWITTER_ACCESS_SECRET: accessSecret };
  let missing = false;
  for (const [name, val] of Object.entries(vars)) {
    if (!val) {
      console.log(`❌ ${name}: FALTA`);
      missing = true;
    } else {
      console.log(`✅ ${name}: ${val.slice(0, 6)}...${val.slice(-4)}`);
    }
  }

  if (missing) {
    console.log('\n→ Hay variables faltantes. Agrega todas en .env y Railway.\n');
    process.exit(1);
  }

  const client = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });

  // ─── Test 1: Verificar identidad OAuth 1.0a ────────────────────────────────
  console.log('\n── Test 1: Verificar identidad OAuth 1.0a ─────────────────');
  try {
    const me = await client.v1.verifyCredentials();
    console.log(`✅ OK → @${me.screen_name} (ID: ${me.id_str})`);
  } catch (err) {
    console.log(`❌ FALLÓ: ${err.message}`);

    if (err.message.includes('89') || err.message.includes('Invalid or expired token')) {
      console.log(`
→ El Access Token o Access Token Secret son inválidos/expirados.
→ Solución:
  1. Ve a https://developer.twitter.com/en/portal/projects-and-apps
  2. Seleccioná tu app → "Keys and tokens"
  3. En "Authentication Tokens" → "Access Token and Secret"
  4. Hacé click en "Regenerate"
  5. Copiá los nuevos valores (¡SOLO SE MUESTRAN UNA VEZ!)
  6. Actualizá en .env:
       TWITTER_ACCESS_TOKEN=<nuevo_token>
       TWITTER_ACCESS_SECRET=<nuevo_secret>
  7. Actualizá en Railway → Variables con los mismos valores
`);
    } else if (err.message.includes('32') || err.message.includes('Could not authenticate')) {
      console.log(`
→ El App Key o App Secret son incorrectos.
→ Solución:
  1. Ve a https://developer.twitter.com/en/portal/projects-and-apps
  2. Tu app → "Keys and tokens" → "Consumer Keys"
  3. Verificá o Regenerá el API Key (Consumer Key) y API Secret
  4. Actualizá TWITTER_APP_KEY y TWITTER_APP_SECRET en .env y Railway
`);
    } else if (err.message.includes('453') || err.message.includes('access level')) {
      console.log(`
→ La app no tiene acceso suficiente (necesita Elevated o Free con permisos).
→ Solución:
  1. Ve a tu app en developer.twitter.com
  2. "User authentication settings" → Permissions → "Read and Write"
  3. Guardá cambios y después regenerá el Access Token
`);
    }
    process.exit(1);
  }

  // ─── Test 2: Subir imagen de prueba ───────────────────────────────────────
  console.log('\n── Test 2: Upload de imagen de prueba ─────────────────────');

  const testDir  = path.join(__dirname, '../data');
  const testFile = path.join(testDir, 'test_upload.png');

  try {
    // Crear imagen de prueba
    fs.mkdirSync(testDir, { recursive: true });
    const canvas = createCanvas(200, 200);
    const ctx    = canvas.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#26a69a';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('Test OK', 50, 105);
    fs.writeFileSync(testFile, canvas.toBuffer('image/png'));
    console.log(`  Imagen de prueba creada: ${testFile}`);
  } catch (err) {
    console.log(`  ⚠️  No se pudo crear imagen de prueba (canvas): ${err.message}`);
    console.log('  Esto es normal si estás en el VM — ejecutá desde tu Mac terminal.');
    process.exit(0);
  }

  try {
    const mediaId = await client.v1.uploadMedia(testFile);
    console.log(`✅ Media upload OK → media_id: ${mediaId}`);
    console.log('\n🎉 Todo funciona. El bot puede subir imágenes a Twitter.\n');
    fs.unlinkSync(testFile);
  } catch (err) {
    console.log(`❌ Media upload FALLÓ: ${err.message}`);

    if (err.message.includes('89')) {
      console.log('\n→ Token inválido (debería haberse detectado en Test 1)');
    } else if (err.message.includes('permission') || err.message.includes('403')) {
      console.log(`
→ La app no tiene permisos de escritura de media.
→ Solución:
  1. Twitter Developer Portal → tu app → Settings
  2. "User authentication settings" → App permissions: "Read and Write"
  3. Guardá, luego regenerá el Access Token (¡las permisos se aplican al regenerar!)
`);
    } else if (err.message.includes('ELF') || err.message.includes('canvas')) {
      console.log('\n→ Error de canvas (binario Mac/Linux). Ejecutá este script desde la Mac terminal, no el VM.');
    }
    try { fs.unlinkSync(testFile); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Error inesperado:', err.message);
  process.exit(1);
});
