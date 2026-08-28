/**
 * Server-side Indicators & S/R Calculation (MMEM v8)
 */

const IMPLIED_VOLATILITY_MAP = {
  // High Volatility (AI / Crypto)
  NVDA:  59.8,
  MSTR:  90.0,
  SMCI:  85.0,
  TSLA:  65.0,
  COIN:  75.0,
  MARA:  80.0,
  RIOT:  80.0,
  PLTR:  45.0,
  RKLB:  50.0,
  AMD:   40.0,
  AVGO:  35.0,

  // Big Tech (Magnificent 7)
  GOOGL: 16.9,
  GOOG:  16.9,
  AAPL:  18.0,
  MSFT:  17.0,
  AMZN:  24.0,
  META:  25.0,
  TSM:   30.0,

  // Broad Market
  SPY:   12.0,
  QQQ:   16.0,
  IWM:   20.0,
  WMT:   15.0,
  KO:    12.0,
};

function getNYWeekKey(symbol) {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const nyMs  = utcMs - (5 * 3600000);
  const nyDate = new Date(nyMs);
  const dayOfWeek = nyDate.getDay();
  const sunday = new Date(nyDate);
  sunday.setDate(nyDate.getDate() - dayOfWeek);
  sunday.setHours(0, 0, 0, 0);
  const year = sunday.getFullYear();
  const oneJan = new Date(year, 0, 1);
  const weekNum = Math.ceil(((sunday - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
  const sym = (symbol || 'STOCK').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `sw_sr_v8_${sym}_${year}_${weekNum}`;
}

// In-memory cache for server
const srCache = new Map();

function calcExpectedMoveSR(sym, anchorPrice) {
  const iv = IMPLIED_VOLATILITY_MAP[sym] || 25.0; 
  const expectedMove = anchorPrice * (iv / 100) / Math.sqrt(52);
  
  const pivot = anchorPrice;
  const s1 = pivot - expectedMove;
  const r1 = pivot + expectedMove;

  const tier2Dist = expectedMove * 0.21;
  const s2 = s1 - tier2Dist;
  const r2 = r1 + tier2Dist;

  const tier3Dist = expectedMove * 0.50;
  const s3 = s1 - tier3Dist;
  const r3 = r1 + tier3Dist;

  return {
    pivot: +pivot.toFixed(2),
    s1: +s1.toFixed(2),
    s2: +s2.toFixed(2),
    s3: +s3.toFixed(2),
    r1: +r1.toFixed(2),
    r2: +r2.toFixed(2),
    r3: +r3.toFixed(2),
    range: +(r1 - s1).toFixed(2),
    expectedMove: +expectedMove.toFixed(2),
    impliedVolatility: iv,
    method: 'market_maker_expected_move_v8'
  };
}

export function calcQuoteSR(quote) {
  const empty = {
    s1: null, s2: null, s3: null, r1: null, r2: null, r3: null,
    pivot: null, range: null, method: 'market_maker_expected_move_v8'
  };
  if (!quote) return empty;

  const sym = (quote.symbol || 'STOCK').toUpperCase();
  const C = quote.regularMarketPrice || quote.regularMarketPreviousClose || quote.price || 100;
  const cacheKey = getNYWeekKey(sym);
  
  if (!quote.isMock && srCache.has(cacheKey)) {
    return srCache.get(cacheKey);
  }

  const result = calcExpectedMoveSR(sym, C);
  
  if (!quote.isMock) {
    srCache.set(cacheKey, result);
  }
  return result;
}
