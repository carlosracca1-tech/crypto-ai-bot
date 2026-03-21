# AI Crypto Bot

Sistema autónomo de análisis de mercado y publicación en Twitter/X para tokens AI de crypto.

## Arquitectura del sistema

```
CoinGecko API ──────────────────────────┐
                                        ▼
                               [ MARKET DATA ]
                               precio / OHLC / vol
                                        │
                                        ▼
                          [ TECHNICAL ANALYSIS ]
                          RSI / MACD / MA / Breakout
                                        │
Twitter API ────────────────────────────┤
                                        ▼
                         [ NARRATIVE DETECTION ]
                         clustering / frecuencia / sentimiento
                                        │
                                        ▼
OpenAI GPT ─────────────────────────── ┤
                                        ▼
                          [ FUSION ENGINE ]
                          score compuesto / divergencias
                                        │
                                        ▼
                       [ CONTENT GENERATOR (GPT) ]
                       tweets / threads / imágenes
                                        │
                                        ▼
                        [ TWITTER PUBLISHER ]
                        scheduling / media upload / posting
```

## Stack

- Node.js 18+
- OpenAI API (GPT-4o para análisis y generación)
- Twitter API v2 (búsqueda + posting)
- CoinGecko API (datos de mercado)
- `technicalindicators` (RSI, MACD, MA, ATR, Bollinger)
- `chartjs-node-canvas` + `canvas` (generación de imágenes)
- `node-cron` (automatización)
- `winston` (logging)

## Requisitos de APIs

### OpenAI
- Cuenta en platform.openai.com
- API key con acceso a GPT-4o
- Crédito disponible (~$0.10–0.50 por ejecución diaria)

### Twitter / X Developer
- Cuenta Developer en developer.twitter.com
- App con permisos de Read + Write
- Access Level: "Basic" o superior para búsqueda
- Bearer Token para narrative detection (búsqueda)
- OAuth 1.0a para posting (App Key/Secret + Access Token/Secret)

### CoinGecko
- API pública gratuita (30 llamadas/min)
- Opcional: API Pro para mayor límite

## Instalación

```bash
# 1. Clonar / copiar el proyecto
cd crypto-ai-bot

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 4. Crear carpetas necesarias
mkdir -p data/images data/history logs
```

### Dependencias de sistema (para canvas)

En Ubuntu/Debian:
```bash
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev \
  libjpeg-dev libgif-dev librsvg2-dev
```

En macOS:
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

## Configuración

Editar `.env` con los valores reales:

```env
# Mínimo necesario para funcionar:
OPENAI_API_KEY=sk-proj-...
TWITTER_APP_KEY=...
TWITTER_APP_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
TWITTER_BEARER_TOKEN=...

# Opcionales:
COINGECKO_API_KEY=          # sin key usa API pública
DRY_RUN=false               # true = no publica
MANUAL_APPROVAL=false       # true = revisión manual
TWEETS_PER_DAY=3
THREAD_EVERY_N_DAYS=3
CRON_SCHEDULE=0 6 * * *     # 06:00 UTC diariamente
```

## Uso

### Dry Run (recomendado para empezar)

Ejecuta el pipeline completo sin publicar nada:

```bash
npm run dry-run
```

Mostrará en consola:
- Resumen de mercado
- Análisis técnico por token
- Tweets generados
- Thread del día (si aplica)
- Insights de narrativas

### Test de módulos individuales

```bash
# Test solo datos de mercado y análisis técnico
npm run test-market

# Test solo detección de narrativas
npm run test-narrative
```

### Revisión manual antes de publicar

Modo interactivo donde aprobar cada tweet:

```bash
# 1. Primero generar sin publicar
DRY_RUN=true npm run pipeline

# 2. Revisar y aprobar manualmente
npm run review
```

El revisor te muestra cada tweet y permite:
- `p` — Publicar
- `e` — Editar el texto
- `s` — Saltar
- `d` — Ver imagen generada
- `q` — Salir

### Pipeline completo (publicación automática)

```bash
# Ejecución única
npm run pipeline

# Con flags
node src/pipeline.js --dry-run --force --skip-posting
```

Flags disponibles:
- `--dry-run` — No publica (sobreescribe .env)
- `--force` — Ignora verificación de ejecución duplicada
- `--skip-posting` — Corre análisis y genera contenido pero no publica

### Scheduler automático diario

```bash
# Iniciar el scheduler (corre permanentemente)
npm start

# Iniciar y ejecutar pipeline ahora mismo
node scheduler/cron.js --run-now
```

El scheduler corre por defecto a las **06:00 UTC** cada día (`CRON_SCHEDULE` en .env).

## Despliegue en producción

### Opción 1: VPS con PM2

```bash
# Instalar PM2
npm install -g pm2

# Iniciar el scheduler
pm2 start scheduler/cron.js --name crypto-ai-bot

# Configurar para reinicio automático
pm2 startup
pm2 save

# Ver logs en tiempo real
pm2 logs crypto-ai-bot

# Monitoreo
pm2 monit
```

### Opción 2: Docker

```dockerfile
FROM node:20-alpine

# Dependencias de sistema para canvas
RUN apk add --no-cache \
    build-base \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

RUN mkdir -p data/images data/history logs

CMD ["node", "scheduler/cron.js"]
```

```bash
docker build -t crypto-ai-bot .
docker run -d \
  --name crypto-ai-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  --restart unless-stopped \
  crypto-ai-bot
```

### Opción 3: GitHub Actions (cron)

```yaml
# .github/workflows/bot.yml
name: AI Crypto Bot

on:
  schedule:
    - cron: '0 6 * * *'  # 06:00 UTC
  workflow_dispatch:

jobs:
  run-bot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install system deps
        run: |
          sudo apt-get install -y libcairo2-dev libpango1.0-dev \
            libjpeg-dev libgif-dev librsvg2-dev
      - run: npm ci
      - run: node src/pipeline.js --force
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          TWITTER_APP_KEY: ${{ secrets.TWITTER_APP_KEY }}
          TWITTER_APP_SECRET: ${{ secrets.TWITTER_APP_SECRET }}
          TWITTER_ACCESS_TOKEN: ${{ secrets.TWITTER_ACCESS_TOKEN }}
          TWITTER_ACCESS_SECRET: ${{ secrets.TWITTER_ACCESS_SECRET }}
          TWITTER_BEARER_TOKEN: ${{ secrets.TWITTER_BEARER_TOKEN }}
```

## Estructura de archivos

```
crypto-ai-bot/
├── src/
│   ├── config/
│   │   └── index.js           # Configuración centralizada
│   ├── data/
│   │   ├── marketData.js      # CoinGecko API + normalización
│   │   └── technicalAnalysis.js # RSI, MACD, MA, breakouts
│   ├── narrative/
│   │   ├── twitterScraper.js  # Búsqueda de tweets
│   │   ├── narrativeDetector.js # Clustering + frecuencia + scoring
│   │   └── sentimentAnalyzer.js # GPT análisis de narrativas
│   ├── analysis/
│   │   └── fusionEngine.js    # Merge técnico + narrativo
│   ├── content/
│   │   └── contentGenerator.js # GPT → tweets + threads
│   ├── images/
│   │   └── imageGenerator.js  # Charts + insight cards
│   ├── twitter/
│   │   └── twitterClient.js   # Posting + media upload
│   ├── storage/
│   │   └── dataStore.js       # Persistencia JSON
│   ├── utils/
│   │   ├── logger.js          # Winston + rotación de logs
│   │   ├── retry.js           # Retry exponencial
│   │   └── helpers.js         # Formatters + stats
│   └── pipeline.js            # Orquestador principal
├── scheduler/
│   └── cron.js                # node-cron scheduler
├── scripts/
│   ├── dryRun.js              # Ejecución sin publicar
│   ├── reviewTweets.js        # Aprobación manual interactiva
│   ├── testMarket.js          # Test datos de mercado
│   └── testNarrative.js       # Test narrativas
├── data/                      # Generado en runtime
│   ├── images/                # PNGs generados
│   ├── history/               # Snapshots históricos
│   ├── market_snapshot.json
│   ├── narratives.json
│   ├── insights.json
│   └── generated_tweets.json
├── logs/                      # Generado en runtime
│   ├── app-YYYY-MM-DD.log
│   └── error-YYYY-MM-DD.log
├── .env.example
├── .gitignore
└── package.json
```

## Tipos de contenido generado

El bot genera diariamente:

1. **Market Insight** — Estado macro del sector AI crypto con datos específicos
2. **Technical Analysis** — Análisis técnico del token más destacado (RSI, MACD, MA)
3. **Narrative Insight** — Qué está dominando el discourse de Twitter/X
4. **Contrarian** (alternado) — Perspectiva que contradice el consenso con datos
5. **System Thinking** (alternado) — Observaciones estructurales sobre DeFi AI

Thread completo cada 3 días (configurable): 6 tweets de análisis profundo.

## Costos estimados por ejecución

| Componente | Costo aprox. |
|-----------|-------------|
| GPT-4o (análisis + contenido) | $0.05–0.15 |
| CoinGecko API (free tier) | $0.00 |
| Twitter API (Basic) | $100/mes plan |
| Canvas / imágenes locales | $0.00 |
| **Total por día** | **~$0.05–0.20** |

## Troubleshooting

**Error: `canvas` no instala**
```bash
# Ubuntu
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev
npm rebuild canvas
```

**Error: Twitter 403 - Insufficient permissions**
- Verificar que la app tiene permisos de "Read and Write"
- Regenerar Access Token/Secret después de cambiar permisos

**CoinGecko rate limit (429)**
- Aumentar `COINGECKO_RATE_LIMIT_MS=2000`
- O conseguir API key Pro

**Pipeline ya ejecutado hoy**
```bash
node src/pipeline.js --force
```
