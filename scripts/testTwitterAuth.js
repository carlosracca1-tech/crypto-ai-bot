'use strict';

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

async function testAuth() {
  console.log('\n=== TEST OAUTH 2.0 TWITTER ===\n');

  const clientId     = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const refreshToken = process.env.TWITTER_OAUTH2_REFRESH_TOKEN;

  console.log('Variables cargadas:');
  console.log(`  CLIENT_ID:       ${clientId?.slice(0,10)}... (${clientId?.length} chars)`);
  console.log(`  CLIENT_SECRET:   ${clientSecret?.slice(0,6)}... (${clientSecret?.length} chars)`);
  console.log(`  REFRESH_TOKEN:   ${refreshToken?.slice(0,20)}... (${refreshToken?.length} chars)`);

  if (!clientId || !clientSecret || !refreshToken) {
    console.log('\n❌ Faltan variables de entorno. Verificar .env\n');
    return;
  }

  // Test: Refresh + postear con el client devuelto directamente
  console.log('\nTest: Refresh OAuth 2.0 y postear con el client devuelto...');
  try {
    const refreshClient = new TwitterApi({ clientId, clientSecret });

    // client ES el user context client — NO usar new TwitterApi(accessToken)
    const {
      client,
      accessToken,
      refreshToken: newRefreshToken,
    } = await refreshClient.refreshOAuth2Token(refreshToken);

    console.log(`  ✅ Refresh exitoso!`);
    console.log(`     Nuevo access token: ${accessToken.slice(0,20)}...`);
    if (newRefreshToken) {
      console.log(`     Nuevo refresh token: ${newRefreshToken.slice(0,20)}...`);
      console.log('\n  ⚠️  NUEVO REFRESH TOKEN — actualizar en .env y Railway:');
      console.log(`     TWITTER_OAUTH2_REFRESH_TOKEN=${newRefreshToken}`);
    }

    // Verificar identidad con el client de user context
    console.log('\nVerificando identidad...');
    const me = await client.v2.me();
    console.log(`  ✅ Autenticado como @${me.data.username}`);

    // Postear tweet de prueba y borrarlo
    console.log('\nPosteando tweet de prueba...');
    const result = await client.v2.tweet({ text: `Auth test OK ${Date.now()} (auto-delete)` });
    console.log(`  ✅ Tweet publicado! ID: ${result.data.id}`);

    await client.v2.deleteTweet(result.data.id);
    console.log(`  ✅ Tweet borrado`);

    console.log('\n✅✅✅ TODO FUNCIONA — Auth completa OK ✅✅✅');
  } catch (err) {
    console.log(`  ❌ Falló: ${err.message}`);
    if (err.data)   console.log(`     Data: ${JSON.stringify(err.data)}`);
    if (err.errors) console.log(`     Errors: ${JSON.stringify(err.errors)}`);
    if (err.code)   console.log(`     Code: ${err.code}`);

    if (err.message?.includes('invalid_client') || err.code === 400) {
      console.log('\n  💡 SOLUCIÓN "invalid_client":');
      console.log('     Los tokens Access/Refresh del portal fueron generados');
      console.log('     ANTES de regenerar el Client Secret — son incompatibles.');
      console.log('     Pasos:');
      console.log('     1. Twitter Developer Portal → tu App → Keys and Tokens');
      console.log('     2. Sección "OAuth 2.0 Client ID and Client Secret"');
      console.log('     3. Clic en "Regenerate" en el Access Token (OAuth 2.0)');
      console.log('     4. Copiar el nuevo Access Token y Refresh Token al .env');
      console.log('     5. Correr este script de nuevo');
    }
  }

  console.log('\n=== FIN ===\n');
}

testAuth().catch(console.error);
