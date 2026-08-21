'use strict';

const https = require('https');
const fs = require('fs');

const FAPI = 'https://fapi.binance.com';

// ================= CONFIG =================

const METHOD = '3';

// IMPORTANT SETTINGS
const MAX_M1_M2_DISTANCE = 5;
const REQUIRE_4H_EMA50 = false;

// Scan all these timeframes.
// A timeframe is processed only when a NEW candle has closed.
const TIMEFRAMES = [
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '3h'
];

const DEEP_LIMIT = 1000;

const EMA_FAST = 50;
const EMA_MID = 100;
const EMA_SLOW = 200;

const RSI_PERIOD = 14;
const RSI_OB = 70;

const MAX_M1_M2_BARS = 150;

// ===========================================


function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'GitHub-Trading-Scanner'
      }
    }, res => {

      let data = '';

      res.on('data', chunk => data += chunk);

      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });

    }).on('error', reject);
  });
}


// ================= BINANCE =================

async function fetchPerpetualSymbols() {

  const data = await fetchJSON(
    FAPI + '/fapi/v1/exchangeInfo'
  );

  return data.symbols
    .filter(s =>
      s.contractType === 'PERPETUAL' &&
      s.quoteAsset === 'USDT' &&
      s.status === 'TRADING'
    )
    .map(s => s.symbol)
    .sort();
}


async function fetchKlines(symbol, interval, limit = DEEP_LIMIT) {

  const url =
    `${FAPI}/fapi/v1/klines?symbol=${symbol}` +
    `&interval=${interval}&limit=${limit}`;

  const raw = await fetchJSON(url);

  return raw.map(k => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6]
  }));
}


function isClosed(candle) {
  return candle.closeTime < Date.now();
}


// ================= INDICATORS =================

function calcEMA(values, period) {

  const out = new Array(values.length).fill(null);

  if (values.length < period) return out;

  const k = 2 / (period + 1);

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  out[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    out[i] =
      values[i] * k +
      out[i - 1] * (1 - k);
  }

  return out;
}


function calcRSI(closes, period) {

  const out = new Array(closes.length).fill(null);

  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {

    const d = closes[i] - closes[i - 1];

    if (d >= 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  out[period] =
    avgLoss === 0
      ? 100
      : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {

    const d = closes[i] - closes[i - 1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    avgGain =
      (avgGain * (period - 1) + g) / period;

    avgLoss =
      (avgLoss * (period - 1) + l) / period;

    out[i] =
      avgLoss === 0
        ? 100
        : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}


function crossUpOrDown(a, b, i) {

  if (
    a[i - 1] == null ||
    b[i - 1] == null ||
    a[i] == null ||
    b[i] == null
  ) return false;

  const previous = a[i - 1] - b[i - 1];
  const current = a[i] - b[i];

  if (previous === 0) return false;

  return (
    (previous < 0 && current > 0) ||
    (previous > 0 && current < 0)
  );
}


// ================= METHOD 3 =================

function findCandidate(symbol, candles, timeframe) {

  const closes = candles.map(c => c.close);

  const ema50 = calcEMA(closes, EMA_FAST);
  const ema100 = calcEMA(closes, EMA_MID);
  const ema200 = calcEMA(closes, EMA_SLOW);

  const rsi = calcRSI(closes, RSI_PERIOD);


  // -------- M1 --------

  const crosses = [];

  for (let i = 1; i < candles.length; i++) {

    if (!isClosed(candles[i])) continue;

    if (crossUpOrDown(ema50, ema200, i)) {
      crosses.push(i);
    }
  }

  if (!crosses.length) return null;

  const m1Index =
    crosses[crosses.length - 1];


  // -------- R1 --------

  let r1Index = -1;

  for (let i = m1Index - 1; i >= 0; i--) {

    if (
      rsi[i] != null &&
      rsi[i] > RSI_OB
    ) {
      r1Index = i;
      break;
    }
  }

  if (r1Index < 0) return null;


  // -------- M2 --------

  let m2Index = -1;

  const end = Math.min(
    m1Index + MAX_M1_M2_BARS,
    candles.length - 1
  );

  for (let i = m1Index + 1; i <= end; i++) {

    // Another EMA50/EMA200 cross invalidates M1.
    if (crossUpOrDown(ema50, ema200, i)) {
      return null;
    }

    // EMA200 / EMA100 cross = M2
    if (crossUpOrDown(ema200, ema100, i)) {

      m2Index = i;
      break;
    }
  }

  if (m2Index < 0) return null;


  // -------- M1 → M2 DISTANCE --------

  const distance =
    m2Index - m1Index;

  if (distance > MAX_M1_M2_DISTANCE) {
    return null;
  }


  // -------- T --------

  let tIndex = -1;

  for (let i = m2Index + 1; i < candles.length; i++) {

    if (!isClosed(candles[i])) break;

    if (
      ema200[i] == null ||
      ema200[i - 1] == null
    ) continue;

    const touches =
      candles[i].low <= ema200[i] &&
      candles[i].high >= ema200[i];

    if (!touches) continue;


    // Candle was below EMA200 before touching it.
    const ascending =
      candles[i - 1].close < ema200[i - 1];

    if (ascending) {

      tIndex = i;
      break;
    }
  }

  if (tIndex < 0) return null;


  // -------- FIB BASE --------

  let p1 = -Infinity;
  let p1Index = r1Index;

  for (let i = r1Index; i <= m1Index; i++) {

    if (candles[i].high > p1) {

      p1 = candles[i].high;
      p1Index = i;
    }
  }


  let p2 = Infinity;
  let p2Index = r1Index;

  for (let i = r1Index; i <= tIndex; i++) {

    if (candles[i].low < p2) {

      p2 = candles[i].low;
      p2Index = i;
    }
  }


  // -------- METHOD 3 STRUCTURE --------

  if (
    !(p1Index < p2Index &&
      p2Index < m1Index &&
      m1Index < m2Index)
  ) {
    return null;
  }


  // -------- 100T --------

  let hundredTIndex = -1;

  for (
    let i = m2Index + 1;
    i < candles.length;
    i++
  ) {

    if (!isClosed(candles[i])) break;

    if (
      ema100[i] != null &&
      candles[i].low <= ema100[i] &&
      candles[i].high >= ema100[i]
    ) {
      hundredTIndex = i;
      break;
    }
  }

  if (hundredTIndex < 0) return null;


  // -------- METHOD 3 FIB --------

  let highestHigh = -Infinity;
  let highestHighIndex = -1;

  for (
    let i = p2Index;
    i <= hundredTIndex;
    i++
  ) {

    if (candles[i].high > highestHigh) {

      highestHigh =
        candles[i].high;

      highestHighIndex = i;
    }
  }


  if (
    highestHighIndex < m1Index ||
    highestHighIndex > hundredTIndex
  ) {
    return null;
  }


  if (highestHigh <= p2) {
    return null;
  }


  const range =
    highestHigh - p2;


  const fib50 =
    highestHigh - range * 0.5;

  const fib618 =
    highestHigh - range * 0.618;

  const fib786 =
    highestHigh - range * 0.786;


  // -------- EMA200 FILTER --------

  const ema200AtT =
    ema200[tIndex];

  if (
    ema200AtT == null ||
    !(fib618 > ema200AtT)
  ) {
    return null;
  }


  return {

    symbol,

    timeframe,

    m1Index,
    m2Index,
    tIndex,

    r1Index,

    hundredTIndex,

    distance,

    p1Index,
    p2Index,

    highestHighIndex,

    fib50,
    fib618,
    fib786,

    ema200AtT,

    currentPrice:
      candles[candles.length - 1].close,

    candleTime:
      candles[tIndex].openTime
  };
}


// ================= DUPLICATE PROTECTION =================

const SENT_FILE = 'sent-signals.json';


function loadSentSignals() {

  try {

    if (!fs.existsSync(SENT_FILE)) {
      return [];
    }

    return JSON.parse(
      fs.readFileSync(SENT_FILE, 'utf8')
    );

  } catch {

    return [];
  }
}


function saveSentSignals(data) {

  fs.writeFileSync(
    SENT_FILE,
    JSON.stringify(data, null, 2)
  );
}


function signalId(signal) {

  return [
    signal.symbol,
    signal.timeframe,
    signal.m1Index,
    signal.m2Index,
    signal.tIndex,
    signal.hundredTIndex
  ].join(':');
}


// ================= EMAIL =================
//
// We use Outlook/Microsoft 365 SMTP.
// scanner.js expects:
// OUTLOOK_EMAIL
// OUTLOOK_PASSWORD
// ALERT_TO
//
// Nodemailer is installed by the workflow.

async function sendEmail(signal) {

  const nodemailer =
    require('nodemailer');


  const transporter =
    nodemailer.createTransport({

      host: 'smtp.office365.com',

      port: 587,

      secure: false,

      auth: {
        user: process.env.OUTLOOK_EMAIL,
        pass: process.env.OUTLOOK_PASSWORD
      }
    });


  const time =
    new Date(signal.candleTime)
      .toLocaleString('en-GB', {
        timeZone: 'Asia/Colombo'
      });


  const subject =
    `🚨 Method 3 Signal — ${signal.symbol} — ${signal.timeframe}`;


  const body = `
TRADING SIGNAL

Symbol: ${signal.symbol}

Method: 3

Signal Timeframe: ${signal.timeframe}

M1 → M2 Distance:
${signal.distance} candles

Maximum Allowed:
${MAX_M1_M2_DISTANCE} candles

4H EMA50 Confirmation:
OFF

R1:
${timeFromIndex(signal, signal.r1Index)}

M1:
${timeFromIndex(signal, signal.m1Index)}

M2:
${timeFromIndex(signal, signal.m2Index)}

T:
${timeFromIndex(signal, signal.tIndex)}

100T:
${timeFromIndex(signal, signal.hundredTIndex)}

Fib 0.500:
${signal.fib50}

Fib 0.618:
${signal.fib618}

Fib 0.786:
${signal.fib786}

EMA200 at T:
${signal.ema200AtT}

Current Price:
${signal.currentPrice}

T Candle:
${time}

Scanner:
GitHub Actions
`;


  await transporter.sendMail({

    from: process.env.OUTLOOK_EMAIL,

    to: process.env.ALERT_TO,

    subject,

    text: body
  });
}


function timeFromIndex(signal, index) {

  return String(index);
}


// ================= MAIN SCANNER =================

async function scanTimeframe(
  symbols,
  timeframe
) {

  console.log(
    `\n========== ${timeframe} SCAN ==========`
  );

  const sent =
    loadSentSignals();

  let newSent = false;

  let found = 0;

  for (const symbol of symbols) {

    try {

      const candles =
        await fetchKlines(
          symbol,
          timeframe,
          DEEP_LIMIT
        );


      // Need enough EMA history.
      if (
        candles.length <
        EMA_SLOW + 20
      ) {
        continue;
      }


      const signal =
        findCandidate(
          symbol,
          candles,
          timeframe
        );


      if (!signal) continue;


      found++;

      const id =
        signalId(signal);


      console.log(
        `SIGNAL: ${symbol} ${timeframe} ${id}`
      );


      if (sent.includes(id)) {

        console.log(
          'Already emailed → skip'
        );

        continue;
      }


      await sendEmail(signal);


      console.log(
        `EMAIL SENT → ${symbol} ${timeframe}`
      );


      sent.push(id);

      newSent = true;


    } catch (error) {

      console.error(
        `Error scanning ${symbol}:`,
        error.message
      );
    }
  }


  if (newSent) {
    saveSentSignals(sent);
  }


  console.log(
    `${timeframe}: ${found} new/valid signal(s)`
  );
}


// ================= RUN =================

async function main() {

  console.log(
    '======================================'
  );

  console.log(
    'METHOD 3 BACKGROUND SCANNER'
  );

  console.log(
    'M1 → M2 MAX DISTANCE = 5'
  );

  console.log(
    '4H EMA50 CONFIRMATION = OFF'
  );

  console.log(
    '======================================'
  );


  const symbols =
    await fetchPerpetualSymbols();


  console.log(
    `Found ${symbols.length} USDT-M perpetual symbols.`
  );


  // Scan every supported timeframe.
  for (const timeframe of TIMEFRAMES) {

    await scanTimeframe(
      symbols,
      timeframe
    );
  }


  console.log(
    '\nScanner finished.'
  );
}


main().catch(error => {

  console.error(error);

  process.exit(1);

});
