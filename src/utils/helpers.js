'use strict';

/**
 * Formatea un número como precio con símbolo de dólar
 */
function formatPrice(num) {
  if (num >= 1000) return `$${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (num >= 1) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(8)}`;
}

/**
 * Formatea un porcentaje con signo
 */
function formatPct(num) {
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

/**
 * Formatea volumen / market cap en unidades legibles
 */
function formatVolume(num) {
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

/**
 * Calcula la media aritmética de un array
 */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calcula la desviación estándar
 */
function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / arr.length);
}

/**
 * Normaliza un valor entre 0 y 1
 */
function normalize(value, min, max) {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/**
 * Trunca texto a N caracteres
 */
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Obtiene fecha actual ISO sin tiempo
 */
function todayISO() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Obtiene timestamp Unix actual
 */
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Calcula diferencia en horas entre dos fechas
 */
function hoursBetween(dateA, dateB) {
  return Math.abs(dateA - dateB) / (1000 * 60 * 60);
}

/**
 * Elimina duplicados de un array por una clave
 */
function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cuenta ocurrencias de elementos en un array
 */
function countOccurrences(arr) {
  return arr.reduce((acc, val) => {
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
}

/**
 * Ordena un objeto por valores descendentes
 */
function sortByValueDesc(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([, a], [, b]) => b - a)
  );
}

/**
 * Determina señal de tendencia basada en RSI
 */
function rsiSignal(rsi) {
  if (rsi >= 70) return 'overbought';
  if (rsi <= 30) return 'oversold';
  if (rsi >= 60) return 'bullish';
  if (rsi <= 40) return 'bearish';
  return 'neutral';
}

/**
 * Chunk de un array en partes de tamaño N
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  formatPrice,
  formatPct,
  formatVolume,
  mean,
  stdDev,
  normalize,
  truncate,
  todayISO,
  nowUnix,
  hoursBetween,
  uniqueBy,
  countOccurrences,
  sortByValueDesc,
  rsiSignal,
  chunkArray,
};
