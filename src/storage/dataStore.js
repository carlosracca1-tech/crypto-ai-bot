'use strict';

const fs = require('fs-extra');
const path = require('path');
const { config } = require('../config');
const { createModuleLogger } = require('../utils/logger');
const { todayISO } = require('../utils/helpers');

const log = createModuleLogger('DataStore');

// ─── Inicialización ────────────────────────────────────────────────────────────

async function initStorage() {
  await fs.ensureDir(config.storage.dataDir);
  await fs.ensureDir(config.images.outputDir);
  await fs.ensureDir('./logs');
  log.info(`Storage inicializado en: ${path.resolve(config.storage.dataDir)}`);
}

// ─── Helpers de lectura/escritura ─────────────────────────────────────────────

async function readJSON(filepath) {
  try {
    const exists = await fs.pathExists(filepath);
    if (!exists) return null;
    const raw = await fs.readFile(filepath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.error(`Error leyendo ${filepath}: ${err.message}`);
    return null;
  }
}

async function writeJSON(filepath, data) {
  try {
    await fs.ensureDir(path.dirname(filepath));
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    log.debug(`Guardado: ${filepath}`);
  } catch (err) {
    log.error(`Error escribiendo ${filepath}: ${err.message}`);
    throw err;
  }
}

// ─── Market Snapshot ───────────────────────────────────────────────────────────

async function saveMarketSnapshot(snapshot) {
  await writeJSON(config.storage.marketFile, snapshot);

  // También guardar histórico por fecha
  const dateFile = path.join(config.storage.dataDir, 'history', `market_${todayISO()}.json`);
  await writeJSON(dateFile, snapshot);

  log.info('Market snapshot guardado');
}

async function loadMarketSnapshot() {
  return readJSON(config.storage.marketFile);
}

// ─── Narrativas ────────────────────────────────────────────────────────────────

async function saveNarratives(narrativeData) {
  await writeJSON(config.storage.narrativesFile, narrativeData);

  const dateFile = path.join(config.storage.dataDir, 'history', `narratives_${todayISO()}.json`);
  await writeJSON(dateFile, narrativeData);

  log.info('Datos de narrativas guardados');
}

async function loadNarratives() {
  return readJSON(config.storage.narrativesFile);
}

// ─── Insights fusionados ───────────────────────────────────────────────────────

async function saveInsights(insights) {
  await writeJSON(config.storage.insightsFile, insights);

  const dateFile = path.join(config.storage.dataDir, 'history', `insights_${todayISO()}.json`);
  await writeJSON(dateFile, insights);

  log.info('Insights guardados');
}

async function loadInsights() {
  return readJSON(config.storage.insightsFile);
}

// ─── Tweets generados ─────────────────────────────────────────────────────────

async function saveTweets(tweetData) {
  // Cargar tweets existentes para no sobreescribir
  const existing = await readJSON(config.storage.tweetsFile) || { entries: [] };

  // Añadir nueva entrada
  existing.entries.unshift({
    date: todayISO(),
    ...tweetData,
    savedAt: new Date().toISOString(),
  });

  // Mantener solo los últimos 30 días
  existing.entries = existing.entries.slice(0, 30);

  await writeJSON(config.storage.tweetsFile, existing);
  log.info(`Tweets guardados (total registros: ${existing.entries.length})`);
}

async function loadTweets() {
  return readJSON(config.storage.tweetsFile);
}

async function loadTodayTweets() {
  const all = await loadTweets();
  if (!all?.entries) return null;
  return all.entries.find(e => e.date === todayISO()) || null;
}

async function updateTweetStatus(tweetId, updates) {
  const all = await loadTweets();
  if (!all?.entries) return;

  for (const entry of all.entries) {
    if (!entry.tweets) continue;
    const tweet = entry.tweets.find(t => t.id === tweetId);
    if (tweet) {
      Object.assign(tweet, updates);
      await writeJSON(config.storage.tweetsFile, all);
      log.info(`Tweet ${tweetId} actualizado`);
      return;
    }
  }

  log.warn(`Tweet ${tweetId} no encontrado en storage`);
}

// ─── Run log ───────────────────────────────────────────────────────────────────

async function logPipelineRun(runData) {
  const runFile = path.join(config.storage.dataDir, 'pipeline_runs.json');
  const existing = await readJSON(runFile) || { runs: [] };

  existing.runs.unshift({
    ...runData,
    timestamp: new Date().toISOString(),
  });

  // Mantener últimas 30 ejecuciones
  existing.runs = existing.runs.slice(0, 30);
  await writeJSON(runFile, existing);
}

async function getLastRunInfo() {
  const runFile = path.join(config.storage.dataDir, 'pipeline_runs.json');
  const data = await readJSON(runFile);
  return data?.runs?.[0] || null;
}

/**
 * Verifica si el pipeline ya corrió hoy para evitar duplicados
 */
async function hasRunToday() {
  const lastRun = await getLastRunInfo();
  if (!lastRun) return false;
  const lastDate = lastRun.timestamp?.split('T')[0];
  return lastDate === todayISO();
}

// ─── Limpieza de archivos viejos ───────────────────────────────────────────────

async function cleanupOldFiles(daysToKeep = 30) {
  const historyDir = path.join(config.storage.dataDir, 'history');
  const exists = await fs.pathExists(historyDir);
  if (!exists) return;

  const files = await fs.readdir(historyDir);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);

  let deleted = 0;
  for (const file of files) {
    const filepath = path.join(historyDir, file);
    const stat = await fs.stat(filepath);
    if (stat.mtime < cutoff) {
      await fs.remove(filepath);
      deleted++;
    }
  }

  if (deleted > 0) log.info(`Limpieza: ${deleted} archivos históricos eliminados`);

  // Limpiar imágenes viejas
  const imageFiles = await fs.readdir(config.images.outputDir).catch(() => []);
  for (const file of imageFiles) {
    const filepath = path.join(config.images.outputDir, file);
    const stat = await fs.stat(filepath).catch(() => null);
    if (stat && stat.mtime < cutoff) {
      await fs.remove(filepath);
    }
  }
}

module.exports = {
  initStorage,
  saveMarketSnapshot,
  loadMarketSnapshot,
  saveNarratives,
  loadNarratives,
  saveInsights,
  loadInsights,
  saveTweets,
  loadTweets,
  loadTodayTweets,
  updateTweetStatus,
  logPipelineRun,
  getLastRunInfo,
  hasRunToday,
  cleanupOldFiles,
};
