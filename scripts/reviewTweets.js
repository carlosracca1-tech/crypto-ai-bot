'use strict';

/**
 * REVIEW MODE - Modo de aprobación manual de tweets
 * Permite revisar y aprobar cada tweet antes de publicarlo
 */

require('dotenv').config();

const readline = require('readline');
const { loadTodayTweets } = require('../src/storage/dataStore');
const { postTweet } = require('../src/twitter/twitterClient');
const { selectAndGenerateImage } = require('../src/images/imageGenerator');
const { loadInsights } = require('../src/storage/dataStore');
const { createModuleLogger } = require('../src/utils/logger');

const log = createModuleLogger('ReviewTweets');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function printTweet(tweet, index, total) {
  console.log('\n' + '═'.repeat(65));
  console.log(`TWEET ${index}/${total} | Tipo: ${tweet.type.toUpperCase()}`);
  console.log(`Caracteres: ${tweet.content.length}/280 | Estado: ${tweet.posted ? 'PUBLICADO' : 'PENDIENTE'}`);
  console.log('─'.repeat(65));
  console.log(tweet.content);
  console.log('─'.repeat(65));
}

async function reviewAndPost() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('       MODO DE REVISIÓN MANUAL DE TWEETS');
  console.log('══════════════════════════════════════════════════════════\n');

  const todayData = await loadTodayTweets();

  if (!todayData || !todayData.tweets || todayData.tweets.length === 0) {
    console.log('No hay tweets generados hoy.');
    console.log('Ejecuta primero: npm run dry-run');
    rl.close();
    return;
  }

  const pendingTweets = todayData.tweets.filter(t => !t.posted);
  console.log(`Tweets pendientes de publicación: ${pendingTweets.length}`);

  if (pendingTweets.length === 0) {
    console.log('Todos los tweets ya fueron publicados hoy.');
    rl.close();
    return;
  }

  const fusionData = await loadInsights();

  for (let i = 0; i < pendingTweets.length; i++) {
    const tweet = pendingTweets[i];
    printTweet(tweet, i + 1, pendingTweets.length);

    while (true) {
      const action = await ask('\n[p] Publicar  [e] Editar  [s] Saltar  [q] Salir  [d] Ver imagen: ');
      const cmd = action.trim().toLowerCase();

      if (cmd === 'q') {
        console.log('Saliendo del modo de revisión.');
        rl.close();
        return;
      }

      if (cmd === 's') {
        console.log('Tweet saltado.');
        break;
      }

      if (cmd === 'd') {
        // Mostrar ruta de imagen generada
        if (fusionData) {
          try {
            const imgPath = await selectAndGenerateImage(tweet, fusionData);
            if (imgPath) {
              console.log(`Imagen generada en: ${imgPath}`);
            } else {
              console.log('No se pudo generar imagen para este tweet.');
            }
          } catch (e) {
            console.log(`Error generando imagen: ${e.message}`);
          }
        }
        continue;
      }

      if (cmd === 'e') {
        console.log('\nContenido actual:');
        console.log(tweet.content);
        const newContent = await ask('\nNuevo contenido (Enter para mantener actual): ');
        if (newContent.trim()) {
          if (newContent.length > 280) {
            console.log(`ERROR: El texto tiene ${newContent.length} caracteres. Máximo 280.`);
            continue;
          }
          tweet.content = newContent.trim();
          console.log(`Tweet editado. Nuevo contenido (${tweet.content.length} chars):\n${tweet.content}`);
        }
        printTweet(tweet, i + 1, pendingTweets.length);
        continue;
      }

      if (cmd === 'p') {
        const confirm = await ask('Confirmar publicación? [s/n]: ');
        if (confirm.toLowerCase() === 's' || confirm.toLowerCase() === 'y') {
          try {
            let imagePath = null;
            if (fusionData) {
              try {
                imagePath = await selectAndGenerateImage(tweet, fusionData);
              } catch (imgErr) {
                log.warn(`Error con imagen: ${imgErr.message}`);
              }
            }

            const result = await postTweet(tweet.content, imagePath);
            tweet.posted = true;
            tweet.postId = result.id;
            tweet.postedAt = new Date().toISOString();

            console.log(`Tweet publicado exitosamente. ID: ${result.id}`);
            console.log(`URL: https://twitter.com/i/web/status/${result.id}`);
            break;
          } catch (err) {
            console.log(`Error publicando: ${err.message}`);
            const retry = await ask('Reintentar? [s/n]: ');
            if (retry.toLowerCase() !== 's') break;
          }
        } else {
          console.log('Publicación cancelada.');
        }
        continue;
      }

      console.log('Opción inválida. Usa: p, e, s, q, d');
    }
  }

  // Publicar thread si existe y no fue publicado
  if (todayData.thread && !todayData.thread.posted) {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('THREAD DISPONIBLE');
    console.log('══════════════════════════════════════════════════════════');

    todayData.thread.tweets.forEach((t, i) => {
      console.log(`\n[${i + 1}/${todayData.thread.tweetCount}]:`);
      console.log(t.tweet);
    });

    const publishThread = await ask('\n¿Publicar este thread? [s/n]: ');
    if (publishThread.toLowerCase() === 's') {
      const { postThread } = require('../src/twitter/twitterClient');
      try {
        const results = await postThread(todayData.thread.tweets);
        todayData.thread.posted = true;
        console.log(`Thread publicado. ${results.length} tweets.`);
      } catch (err) {
        console.log(`Error publicando thread: ${err.message}`);
      }
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('Revisión completada.');
  console.log('══════════════════════════════════════════════════════════\n');

  rl.close();
}

reviewAndPost().catch(err => {
  log.error(err.message);
  rl.close();
  process.exit(1);
});
