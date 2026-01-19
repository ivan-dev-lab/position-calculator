const DEALS_KEY = 'calc_savedDeals';
const SETTINGS_KEY = 'calc_algo_settings';
const PARAMS_KEY = 'calc_algo_params';

const DEFAULT_SETTINGS = {
  totalRisk: 2,
  maxRisk: 1,
  usefulnessShare: 0.8,
  calcDeposit: null
};

const INDEX_SYMBOLS = {
  GER40: '^dax',
  SPX500: '^SPX'
};

const INDEX_DEFS = {
  GER40: { quote: 'EUR', contractSize: 25 },
  SPX500: { quote: 'USD', contractSize: 50 }
};

const CONTRACT_SIZES = {
  XAUUSD: 100,
  XAGUSD: 5000,
  BTCUSDT: 1,
  ETHUSDT: 1,
  DEFAULT: 100000
};

const METAL_PRICE_FIELDS = {
  XAUUSD: 'xauPrice',
  XAGUSD: 'xagPrice'
};

const STABLE_COINS = ['USDT', 'USDC', 'DAI', 'TUSD', 'USDP'];
const CRYPTO_BASES = ['BTC', 'ETH'];
const PRICE_REFRESH_MS = 60000;
const MIN_LOT = 0.01;

const EPSILON = 1e-9;
const MAX_ITER = 50;

let currentDeals = [];
let dealParams = {};
let settings = { ...DEFAULT_SETTINGS };
let priceByPair = {};
let lastPriceUpdate = null;
let fxRateCache = {};
let metalCache = null;
let cryptoCache = {};
let indexCache = {};
let isPriceLoading = false;
let lastResults = null;

function getDealId(deal, index) {
  return String(deal.id || `deal_${index}`);
}

function toNumber(value, fallback) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}

function toNullableNumber(value, fallback = null) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}

function positiveOrNull(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizePair(pair) {
  return String(pair || '').trim().toUpperCase();
}

function normalizeStableCurrency(currency) {
  const upper = String(currency || '').toUpperCase();
  return STABLE_COINS.includes(upper) ? 'USD' : upper;
}

function parseFxPair(pair) {
  if (!pair) return null;
  if (pair.includes('/')) {
    const [base, quote] = pair.split('/');
    if (base && quote) return { base, quote };
    return null;
  }
  if (pair.length === 6) {
    return { base: pair.slice(0, 3), quote: pair.slice(3) };
  }
  return null;
}

function parseCryptoPair(pair) {
  if (!pair) return null;
  const cleaned = pair.includes('/') ? pair.replace('/', '') : pair;
  if (cleaned.endsWith('USDT')) {
    const base = cleaned.slice(0, -4);
    if (!CRYPTO_BASES.includes(base)) return null;
    return { base, quote: 'USDT' };
  }
  if (cleaned.endsWith('USD')) {
    const base = cleaned.slice(0, -3);
    if (!CRYPTO_BASES.includes(base)) return null;
    return { base, quote: 'USD' };
  }
  return null;
}

function parseCalcPair(pair) {
  const normalized = normalizePair(pair);
  if (!normalized) return null;
  const compact = normalized.replace('/', '');
  if (INDEX_DEFS[compact]) {
    return { base: compact, quote: INDEX_DEFS[compact].quote, compact };
  }
  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/');
    if (base && quote) return { base, quote, compact };
  }
  if (compact.endsWith('USDT')) {
    return { base: compact.slice(0, -4), quote: 'USDT', compact };
  }
  if (compact.endsWith('USD')) {
    return { base: compact.slice(0, -3), quote: 'USD', compact };
  }
  return null;
}

function getContractSize(pair) {
  const parsed = parseCalcPair(pair);
  if (!parsed) return null;
  const key = parsed.compact || normalizePair(pair).replace('/', '');
  if (INDEX_DEFS[key]) return INDEX_DEFS[key].contractSize;
  return CONTRACT_SIZES[key] || CONTRACT_SIZES.DEFAULT;
}

function resetPriceCaches() {
  fxRateCache = {};
  metalCache = null;
  cryptoCache = {};
  indexCache = {};
}

async function fetchFxRates(base) {
  const upperBase = String(base || '').toUpperCase();
  if (!upperBase) return null;
  if (fxRateCache[upperBase]) return fxRateCache[upperBase];
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${upperBase}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.result !== 'success' || !data.rates) return null;
    fxRateCache[upperBase] = data.rates;
    return data.rates;
  } catch (err) {
    console.warn('Не удалось получить FX цену:', err);
    return null;
  }
}

async function getExchangeRate(from, to) {
  const base = normalizeStableCurrency(from);
  const quote = normalizeStableCurrency(to);
  if (!base || !quote) return null;
  if (base === quote) return 1;
  const rates = await fetchFxRates(base);
  if (!rates || rates[quote] === undefined) return null;
  const value = parseFloat(rates[quote]);
  return Number.isFinite(value) ? value : null;
}

async function fetchFxPrice(base, quote) {
  if (!base || !quote) return null;
  const upperQuote = String(quote || '').toUpperCase();
  if (upperQuote === String(base || '').toUpperCase()) return 1;
  const rates = await fetchFxRates(base);
  if (!rates || rates[upperQuote] === undefined) return null;
  const value = parseFloat(rates[upperQuote]);
  return Number.isFinite(value) ? value : null;
}

async function fetchMetalPrices() {
  if (metalCache) return metalCache;
  try {
    const res = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    if (!res.ok) return null;
    const data = await res.json();
    const item = data && data.items ? data.items[0] : null;
    if (!item) return null;
    metalCache = item;
    return item;
  } catch (err) {
    console.warn('Не удалось получить цену металлов:', err);
    return null;
  }
}

async function fetchMetalPrice(pair) {
  const field = METAL_PRICE_FIELDS[pair];
  if (!field) return null;
  const data = await fetchMetalPrices();
  if (!data || data[field] === undefined) return null;
  const value = parseFloat(data[field]);
  return Number.isFinite(value) ? value : null;
}

async function fetchCryptoPrice(pair) {
  const parsed = parseCryptoPair(pair);
  if (!parsed) return null;
  const base = parsed.base;
  const quote = normalizeStableCurrency(parsed.quote || 'USD');
  const key = `${base}-${quote}`;
  if (cryptoCache[key]) return cryptoCache[key];
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${base}-${quote}/spot`);
    if (!res.ok) return null;
    const data = await res.json();
    const amount = parseFloat(data && data.data ? data.data.amount : null);
    if (!Number.isFinite(amount)) return null;
    cryptoCache[key] = amount;
    return amount;
  } catch (err) {
    console.warn('Не удалось получить цену криптовалюты:', err);
    return null;
  }
}

async function fetchIndexPrice(pair) {
  const symbol = INDEX_SYMBOLS[pair];
  if (!symbol) return null;
  if (indexCache[pair]) return indexCache[pair];
  try {
    const stooqUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=json`;
    const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(stooqUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const row = data && data.symbols ? data.symbols[0] : null;
    if (!row || row.close === undefined || row.close === null) return null;
    const value = parseFloat(String(row.close).replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    indexCache[pair] = value;
    return value;
  } catch (err) {
    console.warn('Не удалось получить цену индекса:', err);
    return null;
  }
}

async function fetchPriceForPair(pair) {
  const normalized = normalizePair(pair);
  if (!normalized) return null;
  const compact = normalized.replace('/', '');
  if (METAL_PRICE_FIELDS[compact]) return await fetchMetalPrice(compact);
  if (INDEX_SYMBOLS[compact]) return await fetchIndexPrice(compact);
  const crypto = parseCryptoPair(normalized);
  if (crypto && crypto.base) return await fetchCryptoPrice(normalized);
  const fx = parseFxPair(normalized);
  if (!fx) return null;
  return await fetchFxPrice(fx.base, fx.quote);
}
function normalizeSettings(raw) {
  const totalRisk = toNumber(raw.totalRisk, DEFAULT_SETTINGS.totalRisk);
  const maxRisk = toNumber(raw.maxRisk, DEFAULT_SETTINGS.maxRisk);
  let usefulnessShare = toNumber(raw.usefulnessShare, DEFAULT_SETTINGS.usefulnessShare);
  if (usefulnessShare > 1) usefulnessShare = usefulnessShare / 100;
  usefulnessShare = clamp(usefulnessShare, 0, 1);
  let calcDeposit = toNumber(raw.calcDeposit, NaN);
  if (!Number.isFinite(calcDeposit) || calcDeposit <= 0) calcDeposit = null;
  return {
    totalRisk,
    maxRisk,
    usefulnessShare,
    calcDeposit
  };
}

function loadDeals() {
  try {
    const raw = localStorage.getItem(DEALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Не удалось загрузить сделки:', err);
    return [];
  }
}

function saveDeals() {
  localStorage.setItem(DEALS_KEY, JSON.stringify(currentDeals));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed || {});
  } catch (err) {
    console.warn('Не удалось загрузить параметры:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(nextSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
}

function loadParams() {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('Не удалось загрузить параметры сделок:', err);
    return {};
  }
}

function saveParams(nextParams) {
  localStorage.setItem(PARAMS_KEY, JSON.stringify(nextParams));
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function setPriceStatus(text) {
  const status = document.getElementById('priceStatus');
  if (!status) return;
  status.textContent = text;
}

function formatUpdateTime(date) {
  if (!date) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function normalizeInputPair(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function getDefaultDepositValue() {
  const deal = currentDeals.find((item) => Number.isFinite(item.dep) && item.dep > 0);
  return deal ? Number(deal.dep) : 1000;
}

function getDefaultDepositCurrency() {
  const deal = currentDeals.find((item) => item && item.depCur);
  return deal ? String(deal.depCur).toUpperCase() : 'USD';
}

function getDepositOverride() {
  const input = document.getElementById('calcDeposit');
  if (!input) return null;
  const value = parseFloat(input.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function updateCalcDepositPlaceholder() {
  const input = document.getElementById('calcDeposit');
  if (!input) return;
  if (!currentDeals.length) {
    input.placeholder = 'например: 1000';
    return;
  }

  const baseDep = Number(currentDeals[0].dep);
  const baseCur = (currentDeals[0].depCur || 'USD').toUpperCase();
  if (!Number.isFinite(baseDep) || baseDep <= 0) {
    input.placeholder = 'например: 1000';
    return;
  }

  const allSame = currentDeals.every((deal) => {
    const dep = Number(deal.dep);
    const cur = (deal.depCur || 'USD').toUpperCase();
    return dep === baseDep && cur === baseCur;
  });

  if (!allSame) {
    input.placeholder = 'разные депозиты';
    return;
  }

  input.placeholder = `базовый депозит: ${baseDep.toFixed(2)} ${baseCur}`;
}

async function updatePrices(force = false) {
  if (isPriceLoading) return;
  isPriceLoading = true;
  if (force) resetPriceCaches();

  const refreshBtn = document.getElementById('refreshPricesBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  const pairs = Array.from(
    new Set(
      currentDeals
        .map((deal, index) => {
          const id = getDealId(deal, index);
          const params = dealParams[id] || {};
          if (params.priceMode === 'manual') return null;
          return normalizePair(deal.pair);
        })
        .filter(Boolean)
    )
  );

  if (!pairs.length) {
    if (refreshBtn) refreshBtn.disabled = false;
    isPriceLoading = false;
    return;
  }

  const results = await Promise.all(
    pairs.map(async (pair) => {
      try {
        const price = await fetchPriceForPair(pair);
        return { pair, price };
      } catch (err) {
        console.warn('Не удалось обновить цену:', pair, err);
        return { pair, price: null };
      }
    })
  );

  const nextPrices = {};
  const missingPairs = [];

  results.forEach(({ pair, price }) => {
    if (Number.isFinite(price)) {
      nextPrices[pair] = price;
    } else {
      missingPairs.push(pair);
    }
  });

  priceByPair = nextPrices;
  lastPriceUpdate = new Date();

  const okCount = pairs.length - missingPairs.length;
  let statusText = `Цены обновлены: ${okCount}/${pairs.length}`;
  const timeText = formatUpdateTime(lastPriceUpdate);
  if (timeText) statusText += ` • ${timeText}`;
  if (missingPairs.length) statusText += `. Нет цены для: ${missingPairs.join(', ')}`;
  if (PRICE_REFRESH_MS > 0) statusText += ` • автообновление ${Math.round(PRICE_REFRESH_MS / 1000)}с`;

  if (refreshBtn) refreshBtn.disabled = false;
  isPriceLoading = false;
  runAndRender();
}

function updateAddFormDefaults() {
  const pairSelect = document.getElementById('addPair');
  if (pairSelect && pairSelect.selectedIndex < 0) {
    pairSelect.selectedIndex = 0;
  }
}

function addDealFromForm() {
  const pairSelect = document.getElementById('addPair');
  const entryInput = document.getElementById('addEntry');
  const slInput = document.getElementById('addSl');
  const tpInput = document.getElementById('addTp');
  const atrInput = document.getElementById('addAtr');

  if (!pairSelect || !entryInput || !slInput || !tpInput) return;

  const pair = normalizeInputPair(pairSelect.value);
  if (!pair) {
    alert('Введите актив.');
    pairSelect.focus();
    return;
  }

  const entry = toNullableNumber(entryInput.value);
  const sl = toNullableNumber(slInput.value);
  const tp = toNullableNumber(tpInput.value);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
    alert('Введите Entry, SL и TP.');
    return;
  }
  if (entry === sl) {
    alert('Entry и SL не должны совпадать.');
    return;
  }

  const atr = toNullableNumber(atrInput ? atrInput.value : null);
  const deposit = getDefaultDepositValue();
  const depCur = getDefaultDepositCurrency();
  const direction = tp >= entry ? 'BUY' : 'SELL';

  const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const created = Date.now();

  const newDeal = {
    id,
    pair,
    dep: deposit,
    depCur,
    open: entry,
    tp,
    sl,
    lots: MIN_LOT,
    leverage: 1,
    margin: 0,
    profit: 0,
    loss: 0,
    profitDepPct: 0,
    lossDepPct: 0,
    profitPosPct: 0,
    lossPosPct: 0,
    direction,
    created,
    comment: 'добавлено без ручного расчета'
  };

  currentDeals.push(newDeal);
  saveDeals();

  dealParams[id] = {
    enabled: true,
    priceMode: 'auto',
    manualPrice: null,
    entry,
    sl,
    tp,
    atr: Number.isFinite(atr) ? atr : null
  };
  saveParams(dealParams);

  renderDeals(currentDeals);
  updateAddFormDefaults();
  updatePrices(true);

  if (pairSelect) pairSelect.selectedIndex = 0;
  entryInput.value = '';
  slInput.value = '';
  tpInput.value = '';
  if (atrInput) atrInput.value = '';
  pairSelect.focus();
}

function deleteDealById(id) {
  const index = currentDeals.findIndex((deal, idx) => getDealId(deal, idx) === id);
  if (index < 0) return;
  currentDeals.splice(index, 1);
  delete dealParams[id];
  saveDeals();
  saveParams(dealParams);
  renderDeals(currentDeals);
  updateAddFormDefaults();
  updatePrices(true);
}

function deriveMetrics(params, deal, priceNowRaw) {
  const entry = toNullableNumber(params.entry, toNullableNumber(deal.open));
  const sl = toNullableNumber(params.sl, toNullableNumber(deal.sl));
  const tp = toNullableNumber(params.tp, toNullableNumber(deal.tp));
  const priceNow = toNullableNumber(priceNowRaw);
  const atr = positiveOrNull(toNullableNumber(params.atr));

  let riskDist = null;
  if (entry !== null && sl !== null) {
    const dist = Math.abs(entry - sl);
    riskDist = dist > 0 ? dist : null;
  }

  let rewardDist = null;
  if (entry !== null && tp !== null) {
    const dist = Math.abs(tp - entry);
    rewardDist = dist > 0 ? dist : null;
  }

  const rr = riskDist && rewardDist ? rewardDist / riskDist : null;
  const danger = atr && riskDist ? atr / riskDist : null;
  const close = atr && entry !== null && priceNow !== null ? Math.abs(priceNow - entry) / atr : null;

  const valid =
    Number.isFinite(rr) &&
    rr > 0 &&
    Number.isFinite(danger) &&
    danger >= 0 &&
    Number.isFinite(close) &&
    close >= 0;

  return {
    entry,
    sl,
    tp,
    priceNow,
    atr,
    rr,
    danger,
    close,
    valid
  };
}

function ensureParamsForDeals(deals) {
  let changed = false;
  deals.forEach((deal, index) => {
    const id = getDealId(deal, index);
    const current = dealParams[id] || {};
    const entryFallback = toNullableNumber(deal.open);
    const slFallback = toNullableNumber(deal.sl);
    const tpFallback = toNullableNumber(deal.tp);
    const priceMode = current.priceMode === 'manual' ? 'manual' : 'auto';
    const next = {
      enabled: current.enabled !== undefined ? current.enabled : true,
      priceMode,
      manualPrice: Number.isFinite(current.manualPrice) ? current.manualPrice : null,
      entry: Number.isFinite(current.entry) ? current.entry : entryFallback,
      sl: Number.isFinite(current.sl) ? current.sl : slFallback,
      tp: Number.isFinite(current.tp) ? current.tp : tpFallback,
      atr: Number.isFinite(current.atr) ? current.atr : null
    };
    if (!dealParams[id]) {
      dealParams[id] = next;
      changed = true;
    } else if (
      current.enabled !== next.enabled ||
      current.priceMode !== next.priceMode ||
      current.manualPrice !== next.manualPrice ||
      current.entry !== next.entry ||
      current.sl !== next.sl ||
      current.tp !== next.tp ||
      current.atr !== next.atr
    ) {
      dealParams[id] = { ...current, ...next };
      changed = true;
    }
  });
  if (changed) saveParams(dealParams);
}

function calculateWeight(rr, danger, close) {
  if (!Number.isFinite(rr) || !Number.isFinite(danger) || !Number.isFinite(close)) return 0;
  const base = 1 + danger;
  const closeFactor = 1 + close;
  if (!Number.isFinite(base) || !Number.isFinite(closeFactor)) return 0;
  if (base <= 0 || closeFactor <= 0) return 0;
  const penalty = Math.pow(base, 2);
  if (!Number.isFinite(penalty) || penalty <= 0) return 0;
  const weight = rr / (penalty * closeFactor);
  return Number.isFinite(weight) ? weight : 0;
}

function buildCandidates(deals, paramsById, pricesByPair) {
  return deals.map((deal, index) => {
    const id = getDealId(deal, index);
    const params = paramsById[id] || {};
    const enabled = params.enabled !== false;
    const pairKey = normalizePair(deal.pair);
    const useManual = params.priceMode === 'manual';
    const manualPrice = toNullableNumber(params.manualPrice);
    const priceNow = useManual
      ? manualPrice
      : (pricesByPair && pairKey ? pricesByPair[pairKey] : null);
    const metrics = deriveMetrics(params, deal, priceNow);
    const weight = enabled && metrics.valid
      ? calculateWeight(metrics.rr, metrics.danger, metrics.close)
      : 0;
    return {
      id,
      deal,
      index,
      enabled,
      weight,
      rr: metrics.rr,
      danger: metrics.danger,
      close: metrics.close,
      valid: metrics.valid,
      priceNow,
      priceMode: useManual ? 'manual' : 'auto'
    };
  });
}

function sumMapValues(map) {
  let total = 0;
  map.forEach((value) => {
    total += value;
  });
  return total;
}

function allocateWithCaps(activeSet, totalRisk, maxRisk) {
  const riskById = new Map();
  const weightSum = activeSet.reduce((sum, deal) => sum + deal.weight, 0);
  if (weightSum <= 0) {
    return { riskById, leftover: totalRisk };
  }

  activeSet.forEach((deal) => {
    const initial = totalRisk * (deal.weight / weightSum);
    riskById.set(deal.id, Math.min(initial, maxRisk));
  });

  let leftover = totalRisk - sumMapValues(riskById);
  let iter = 0;

  while (leftover > EPSILON && iter < MAX_ITER) {
    const available = activeSet.filter((deal) => {
      return riskById.get(deal.id) < maxRisk - EPSILON;
    });
    if (!available.length) break;
    const availableWeight = available.reduce((sum, deal) => sum + deal.weight, 0);
    if (availableWeight <= 0) break;
    available.forEach((deal) => {
      const current = riskById.get(deal.id) || 0;
      const add = leftover * (deal.weight / availableWeight);
      riskById.set(deal.id, Math.min(current + add, maxRisk));
    });
    leftover = totalRisk - sumMapValues(riskById);
    iter += 1;
  }

  return { riskById, leftover };
}

// Core allocation algorithm (mode A, strict).
function runAlgorithm(deals, paramsById, rawSettings, pricesByPair) {
  const currentSettings = normalizeSettings(rawSettings);
  const candidates = buildCandidates(deals, paramsById, pricesByPair);
  const summary = {
    totalRisk: currentSettings.totalRisk,
    usedRisk: 0,
    leftover: currentSettings.totalRisk,
    activeWeight: 0,
    activeCount: 0,
    enabledCount: candidates.filter((deal) => deal.enabled).length,
    invalidCount: candidates.filter((deal) => deal.enabled && !deal.valid).length,
    note: ''
  };
  const byId = {};

  if (!candidates.length) {
    summary.note = 'Нет сохраненных сделок.';
    return { byId, summary };
  }

  if (currentSettings.totalRisk <= 0 || currentSettings.maxRisk <= 0) {
    summary.note = 'Бюджет риска или лимит на сделку равен 0.';
    candidates.forEach((deal) => {
      byId[deal.id] = {
        weight: deal.weight,
        risk: 0,
        active: false,
        enabled: deal.enabled,
        status: deal.enabled ? 'Бюджет риска = 0' : 'Выключена',
        price: deal.priceNow,
        rr: deal.rr,
        danger: deal.danger,
        close: deal.close
      };
    });
    summary.leftover = currentSettings.totalRisk;
    return { byId, summary };
  }

  if (summary.enabledCount === 0) {
    summary.note = 'Нет включенных сделок.';
    candidates.forEach((deal) => {
      byId[deal.id] = {
        weight: deal.weight,
        risk: 0,
        active: false,
        enabled: deal.enabled,
        status: 'Выключена',
        price: deal.priceNow,
        rr: deal.rr,
        danger: deal.danger,
        close: deal.close
      };
    });
    return { byId, summary };
  }

  const validDeals = candidates.filter((deal) => deal.enabled && deal.valid && deal.weight > 0);
  if (!validDeals.length) {
    summary.note = summary.invalidCount
      ? 'Недостаточно данных для расчета веса.'
      : 'Все включенные сделки имеют нулевой вес.';
    candidates.forEach((deal) => {
      let status = 'Вес <= 0';
      if (!deal.enabled) status = 'Выключена';
      else if (!deal.valid) status = 'Нет данных';
      byId[deal.id] = {
        weight: deal.weight,
        risk: 0,
        active: false,
        enabled: deal.enabled,
        status,
        price: deal.priceNow,
        rr: deal.rr,
        danger: deal.danger,
        close: deal.close
      };
    });
    return { byId, summary };
  }

  const sorted = [...validDeals].sort((a, b) => b.weight - a.weight);
  const totalWeight = sorted.reduce((sum, deal) => sum + deal.weight, 0);
  const targetWeight = totalWeight * currentSettings.usefulnessShare;

  const activeSet = [];
  const activeIds = new Set();
  const reasonById = {};

  let cumulative = 0;
  for (const deal of sorted) {
    activeSet.push(deal);
    activeIds.add(deal.id);
    const sharePctLabel = Math.round(currentSettings.usefulnessShare * 100);
    reasonById[deal.id] = `${sharePctLabel}% полезности`;
    cumulative += deal.weight;
    if (cumulative >= targetWeight) break;
  }

  const minDeals = Math.ceil(currentSettings.totalRisk / currentSettings.maxRisk);
  if (activeSet.length < minDeals) {
    for (const deal of sorted) {
      if (activeIds.has(deal.id)) continue;
      activeSet.push(deal);
      activeIds.add(deal.id);
      reasonById[deal.id] = 'Добавлена для лимита';
      if (activeSet.length >= minDeals) break;
    }
  }

  let riskById = new Map();
  let leftover = currentSettings.totalRisk;
  let nextIndex = 0;
  let expansions = 0;

  while (expansions < MAX_ITER) {
    const allocation = allocateWithCaps(activeSet, currentSettings.totalRisk, currentSettings.maxRisk);
    riskById = allocation.riskById;
    leftover = allocation.leftover;
    if (leftover <= EPSILON) break;

    let added = false;
    for (; nextIndex < sorted.length; nextIndex++) {
      const candidate = sorted[nextIndex];
      if (!activeIds.has(candidate.id)) {
        activeSet.push(candidate);
        activeIds.add(candidate.id);
        reasonById[candidate.id] = 'Добавлена из-за капов';
        added = true;
        nextIndex += 1;
        break;
      }
    }

    if (!added) break;
    expansions += 1;
  }

  summary.usedRisk = sumMapValues(riskById);
  summary.leftover = Math.max(currentSettings.totalRisk - summary.usedRisk, 0);
  summary.activeWeight = activeSet.reduce((sum, deal) => sum + deal.weight, 0);
  summary.activeCount = activeSet.filter((deal) => (riskById.get(deal.id) || 0) > EPSILON).length;

  if (summary.leftover > EPSILON && activeSet.length === sorted.length) {
    summary.note = 'Бюджет риска заполнить полностью не удалось из-за лимитов.';
  }

  candidates.forEach((deal) => {
    const risk = riskById.get(deal.id) || 0;
    const sharePctLabel = Math.round(currentSettings.usefulnessShare * 100);
    let status = `Вне ${sharePctLabel}% полезности`;
    if (!deal.enabled) status = 'Выключена';
    else if (!deal.valid) status = 'Нет данных';
    else if (deal.weight <= 0) status = 'Вес <= 0';
    else if (activeIds.has(deal.id)) status = reasonById[deal.id] || 'Активная';

    byId[deal.id] = {
      weight: deal.weight,
      risk,
      active: activeIds.has(deal.id) && risk > EPSILON,
      enabled: deal.enabled,
      status,
      price: deal.priceNow,
      rr: deal.rr,
      danger: deal.danger,
      close: deal.close
    };
  });

  if (!summary.note && summary.invalidCount > 0) {
    summary.note = `Нет данных для ${summary.invalidCount} сделок.`;
  }

  return { byId, summary };
}

function formatWeight(value, enabled) {
  if (!enabled) return '-';
  if (!Number.isFinite(value)) return '-';
  return value > 0 ? value.toFixed(4) : '0.0000';
}

function formatRisk(value, enabled) {
  if (!enabled) return '-';
  if (!Number.isFinite(value)) return '0.00 %';
  return `${value.toFixed(2)} %`;
}

function formatMetric(value, digits) {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(2)} %`;
}

function formatMoney(value, currency) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(2)} ${currency}`;
}

function formatLots(value) {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

function formatExportValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number' && Number.isNaN(value)) return '-';
  return String(value);
}

function findDealById(id) {
  return currentDeals.find((deal, index) => getDealId(deal, index) === id) || null;
}

function updatePriceModeUI(row, mode) {
  if (!row) return;
  const priceValue = row.querySelector('[data-field="price"]');
  const manualInput = row.querySelector('input[data-field="manualPrice"]');
  const modeSelect = row.querySelector('select[data-field="priceMode"]');
  const isManual = mode === 'manual';

  if (modeSelect) modeSelect.value = isManual ? 'manual' : 'auto';
  if (manualInput) manualInput.style.display = isManual ? 'block' : 'none';
  if (priceValue) priceValue.style.display = isManual ? 'none' : 'block';
}

function renderDeals(deals) {
  const noDeals = document.getElementById('noDeals');
  const count = document.getElementById('dealCount');
  const body = document.getElementById('dealsBody');
  const tableWrapper = document.querySelector('.table-wrapper');
  if (!body || !noDeals || !count || !tableWrapper) return;

  body.innerHTML = '';

  if (!deals.length) {
    noDeals.style.display = 'block';
    count.textContent = '';
    tableWrapper.style.display = 'none';
    return;
  }

  noDeals.style.display = 'none';
  tableWrapper.style.display = 'block';
  count.textContent = `Сделок: ${deals.length}`;

  deals.forEach((deal, index) => {
    const id = getDealId(deal, index);
    const params = dealParams[id] || {};
    const row = document.createElement('tr');
    row.className = 'deal-row';
    row.dataset.id = id;
    row.innerHTML = `
      <td><input type="checkbox" data-field="enabled" data-id="${id}"></td>
      <td>${index + 1}</td>
      <td>${deal.pair || '-'}</td>
      <td>
        <div class="price-cell">
          <select data-field="priceMode" data-id="${id}">
            <option value="auto">Авто</option>
            <option value="manual">Вручную</option>
          </select>
          <div class="price-value" data-field="price">-</div>
          <input type="number" data-field="manualPrice" data-id="${id}" step="0.00001" min="0">
        </div>
      </td>
      <td><input type="number" data-field="entry" data-id="${id}" step="0.00001" min="0"></td>
      <td><input type="number" data-field="tp" data-id="${id}" step="0.00001" min="0"></td>
      <td><input type="number" data-field="sl" data-id="${id}" step="0.00001" min="0"></td>
      <td><input type="number" data-field="atr" data-id="${id}" step="0.00001" min="0"></td>
      <td data-field="rr">-</td>
      <td data-field="danger">-</td>
      <td data-field="close">-</td>
      <td data-field="weight">-</td>
      <td data-field="risk">-</td>
      <td><span class="status-tag" data-field="status">-</span></td>
      <td class="deal-actions">
        <button type="button" class="secondary-btn" data-action="delete" data-id="${id}">Удалить</button>
      </td>
    `;
    body.appendChild(row);

    const enabledInput = row.querySelector('input[data-field="enabled"]');
    const modeSelect = row.querySelector('select[data-field="priceMode"]');
    const manualInput = row.querySelector('input[data-field="manualPrice"]');
    const entryInput = row.querySelector('input[data-field="entry"]');
    const tpInput = row.querySelector('input[data-field="tp"]');
    const slInput = row.querySelector('input[data-field="sl"]');
    const atrInput = row.querySelector('input[data-field="atr"]');

    if (enabledInput) enabledInput.checked = params.enabled !== false;
    if (modeSelect) modeSelect.value = params.priceMode === 'manual' ? 'manual' : 'auto';
    if (manualInput) manualInput.value = Number.isFinite(params.manualPrice) ? params.manualPrice : '';
    if (entryInput) entryInput.value = Number.isFinite(params.entry) ? params.entry : '';
    if (slInput) slInput.value = Number.isFinite(params.sl) ? params.sl : '';
    if (tpInput) tpInput.value = Number.isFinite(params.tp) ? params.tp : '';
    if (atrInput) atrInput.value = Number.isFinite(params.atr) ? params.atr : '';

    updatePriceModeUI(row, params.priceMode === 'manual' ? 'manual' : 'auto');
  });

  updateCalcDepositPlaceholder();
}

function updateSummary(summary) {
  const activeEl = document.getElementById('summaryActive');
  const riskEl = document.getElementById('summaryRisk');
  const leftEl = document.getElementById('summaryLeft');
  const weightEl = document.getElementById('summaryWeight');
  const noteEl = document.getElementById('summaryNote');
  if (!activeEl || !riskEl || !leftEl || !weightEl || !noteEl) return;

  activeEl.textContent = `${summary.activeCount} из ${summary.enabledCount}`;
  riskEl.textContent = `${summary.usedRisk.toFixed(2)} % / ${summary.totalRisk.toFixed(2)} %`;
  leftEl.textContent = `${summary.leftover.toFixed(2)} %`;
  weightEl.textContent = summary.activeWeight.toFixed(4);
  noteEl.textContent = summary.note || '';
}

function updateRows(results) {
  const rows = document.querySelectorAll('.deal-row');
  rows.forEach((row) => {
    const id = row.dataset.id;
    const result = results.byId[id];
    if (!result) return;

    const params = dealParams[id] || {};
    const mode = params.priceMode === 'manual' ? 'manual' : 'auto';
    const priceCell = row.querySelector('[data-field="price"]');
    const rrCell = row.querySelector('[data-field="rr"]');
    const dangerCell = row.querySelector('[data-field="danger"]');
    const closeCell = row.querySelector('[data-field="close"]');
    const weightCell = row.querySelector('[data-field="weight"]');
    const riskCell = row.querySelector('[data-field="risk"]');
    const statusTag = row.querySelector('[data-field="status"]');

    if (priceCell) priceCell.textContent = formatPrice(result.price);
    if (rrCell) rrCell.textContent = formatMetric(result.rr, 2);
    if (dangerCell) dangerCell.textContent = formatMetric(result.danger, 2);
    if (closeCell) closeCell.textContent = formatMetric(result.close, 2);
    if (weightCell) weightCell.textContent = formatWeight(result.weight, result.enabled);
    if (riskCell) riskCell.textContent = formatRisk(result.risk, result.enabled);
    if (statusTag) {
      statusTag.textContent = result.status;
      statusTag.classList.toggle('inactive', !result.active);
    }

    updatePriceModeUI(row, mode);
    row.classList.toggle('active', result.active);
    row.classList.toggle('inactive', !result.active);
  });
}

function buildCalcItems(results) {
  const depositOverride = getDepositOverride();
  return currentDeals
    .map((deal, index) => {
      const id = getDealId(deal, index);
      const result = results.byId[id];
      if (!result || !result.active || result.risk <= EPSILON) return null;

      const params = dealParams[id] || {};
      const entry = toNullableNumber(params.entry, toNullableNumber(deal.open));
      const sl = toNullableNumber(params.sl, toNullableNumber(deal.sl));
      const tp = toNullableNumber(params.tp, toNullableNumber(deal.tp));
      const dep = depositOverride !== null
        ? depositOverride
        : (Number.isFinite(deal.dep) ? Number(deal.dep) : getDefaultDepositValue());
      const depCur = deal.depCur ? String(deal.depCur).toUpperCase() : getDefaultDepositCurrency();
      const pair = normalizePair(deal.pair);
      const parsed = parseCalcPair(pair);

      return {
        id,
        pair,
        entry,
        sl,
        tp,
        dep,
        depCur,
        riskPct: result.risk,
        quote: parsed ? parsed.quote : null,
        size: getContractSize(pair)
      };
    })
    .filter(Boolean);
}

function calculateLotMetrics(item, convRate) {
  if (!Number.isFinite(item.entry) || !Number.isFinite(item.sl) || !Number.isFinite(item.tp)) {
    return { error: 'Недостаточно параметров' };
  }
  if (!Number.isFinite(item.dep) || item.dep <= 0) {
    return { error: 'Нет депозита' };
  }
  if (!Number.isFinite(item.riskPct) || item.riskPct <= 0) {
    return { error: 'Риск = 0' };
  }
  if (!Number.isFinite(item.size) || item.size <= 0) {
    return { error: 'Нет контракта' };
  }
  if (!Number.isFinite(convRate) || convRate <= 0) {
    return { error: 'Нет курса валют' };
  }

  const riskDist = Math.abs(item.entry - item.sl);
  if (!Number.isFinite(riskDist) || riskDist <= 0) {
    return { error: 'SL = Entry' };
  }

  const riskAmount = item.dep * (item.riskPct / 100);
  const maxLots = riskAmount / (riskDist * item.size * convRate);
  if (!Number.isFinite(maxLots) || maxLots <= 0) {
    return { error: 'Лот слишком мал' };
  }
  const floored = Math.floor((maxLots + EPSILON) * 100) / 100;
  if (!Number.isFinite(floored) || floored < 0.01) {
    return { error: 'Риск меньше 0.01 лота' };
  }
  const lots = floored;

  const isBuy = item.tp >= item.entry;
  const profitQuote = (isBuy ? (item.tp - item.entry) : (item.entry - item.tp)) * lots * item.size;
  const lossQuote = (isBuy ? (item.entry - item.sl) : (item.sl - item.entry)) * lots * item.size;
  const profit = profitQuote * convRate;
  const loss = lossQuote * convRate;
  const profitDepPct = (profit / item.dep) * 100;
  const lossDepPct = (loss / item.dep) * 100;

  return {
    lots,
    profit,
    loss,
    profitDepPct,
    lossDepPct,
    isBuy
  };
}

async function resolveRatesForItems(items) {
  const ratePairs = new Map();
  items.forEach((item) => {
    const from = normalizeStableCurrency(item.quote);
    const to = normalizeStableCurrency(item.depCur);
    if (!from || !to) {
      item.rateKey = null;
      return;
    }
    const key = `${from}_${to}`;
    item.rateKey = key;
    if (!ratePairs.has(key)) {
      ratePairs.set(key, { from, to });
    }
  });

  const rates = {};
  await Promise.all(
    Array.from(ratePairs.entries()).map(async ([key, pair]) => {
      const rate = await getExchangeRate(pair.from, pair.to);
      rates[key] = rate;
    })
  );

  return rates;
}

let calcRenderToken = 0;

async function renderCalculatedDeals(results) {
  const grid = document.getElementById('calcResultsGrid');
  const empty = document.getElementById('calcResultsEmpty');
  const count = document.getElementById('calcResultCount');
  if (!grid || !empty || !count) return;

  const items = buildCalcItems(results);
  if (!items.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    count.textContent = '';
    return;
  }

  empty.style.display = 'none';
  count.textContent = `Сделок: ${items.length}`;

  const token = ++calcRenderToken;
  const rates = await resolveRatesForItems(items);

  if (token !== calcRenderToken) return;

  grid.innerHTML = '';
  items.forEach((item) => {
    const rate = item.rateKey ? rates[item.rateKey] : null;
    const calc = calculateLotMetrics(item, rate);
    const isBuy = calc.isBuy !== undefined ? calc.isBuy : item.tp >= item.entry;

    const lotsText = calc.error ? '-' : formatLots(calc.lots);
    const riskText = calc.error
      ? '-'
      : `${formatMoney(calc.loss, item.depCur)} · ${formatPercent(calc.lossDepPct)}`;
    const profitText = calc.error
      ? '-'
      : `${formatMoney(calc.profit, item.depCur)} · ${formatPercent(calc.profitDepPct)}`;

    const card = document.createElement('div');
    card.className = 'deal-card';
    card.innerHTML = `
      <div class="deal-header">
        <div class="deal-title">${item.pair || '-'}</div>
        <span class="deal-tag${isBuy ? '' : ' sell'}">${isBuy ? 'BUY' : 'SELL'}</span>
      </div>
      <div class="deal-meta">
        <div class="meta-item"><span>Entry</span><strong>${formatPrice(item.entry)}</strong></div>
        <div class="meta-item"><span>TP</span><strong>${formatPrice(item.tp)}</strong></div>
        <div class="meta-item"><span>SL</span><strong>${formatPrice(item.sl)}</strong></div>
        <div class="meta-item"><span>Lots</span><strong>${lotsText}</strong></div>
        <div class="meta-item"><span>Risk</span><strong class="loss">${riskText}</strong></div>
        <div class="meta-item"><span>Profit</span><strong class="profit">${profitText}</strong></div>
      </div>
      ${calc.error ? `<div class="deal-note">${calc.error}</div>` : ''}
    `;
    grid.appendChild(card);
  });
}

function pruneParamsForDeals(deals, paramsById) {
  const allowed = new Set(deals.map((deal, index) => getDealId(deal, index)));
  const next = {};
  allowed.forEach((id) => {
    if (paramsById && paramsById[id]) next[id] = paramsById[id];
  });
  return next;
}

function buildCalculatorExport() {
  return JSON.stringify(currentDeals, null, 2);
}

function buildAlgorithmExport() {
  const currentSettings = readSettingsFromInputs();
  const payload = {
    type: 'calc_algo_v1',
    exportedAt: new Date().toISOString(),
    settings: currentSettings,
    params: pruneParamsForDeals(currentDeals, dealParams),
    deals: currentDeals
  };
  return JSON.stringify(payload, null, 2);
}

function getResultsSnapshot() {
  const currentSettings = readSettingsFromInputs();
  return runAlgorithm(currentDeals, dealParams, currentSettings, priceByPair);
}

async function buildPublicationExport(results) {
  const items = buildCalcItems(results);
  if (!items.length) return '';

  const lines = [];
  lines.push('Ближайшая реализация');

  const rates = await resolveRatesForItems(items);

  const dealNumberById = {};
  const pairCounters = {};
  const sortedForNumbering = [...items]
    .map((item) => {
      const deal = findDealById(item.id);
      return { item, created: deal ? deal.created || 0 : 0 };
    })
    .sort((a, b) => a.created - b.created);

  sortedForNumbering.forEach(({ item }) => {
    const pair = item.pair || 'Без актива';
    pairCounters[pair] = (pairCounters[pair] || 0) + 1;
    dealNumberById[item.id] = pairCounters[pair];
  });

  const byPair = new Map();
  sortedForNumbering.forEach(({ item, created }) => {
    const pair = item.pair || 'Без актива';
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push({ item, created });
  });

  for (const [pair, pairItems] of byPair.entries()) {
    if (lines.length > 1) lines.push('');
    lines.push(pair);
    pairItems
      .sort((a, b) => a.created - b.created)
      .forEach((entry, idx) => {
        const item = entry.item;
        const number = dealNumberById[item.id] || 1;
        const rate = item.rateKey ? rates[item.rateKey] : null;
        const calc = calculateLotMetrics(item, rate);
        const volume = calc.error ? '-' : formatLots(calc.lots);
        if (idx > 0) lines.push('');
        lines.push(`#${number}`);
        lines.push(`Entry: ${formatExportValue(item.entry)}`);
        lines.push(`TP: ${formatExportValue(item.tp)}`);
        lines.push(`SL: ${formatExportValue(item.sl)}`);
        lines.push(`VOL: ${formatExportValue(volume)}`);
      });
  }

  return lines.join('\n').trim();
}

function setExportOutput(text) {
  const output = document.getElementById('exportOutput');
  if (!output) return;
  output.value = text;
  output.focus();
  output.select();
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function setupExportControls() {
  const calcBtn = document.getElementById('exportCalcBtn');
  const algoBtn = document.getElementById('exportAlgoBtn');
  const publishBtn = document.getElementById('exportPublishBtn');
  if (calcBtn) calcBtn.addEventListener('click', () => setExportOutput(buildCalculatorExport()));
  if (algoBtn) algoBtn.addEventListener('click', () => setExportOutput(buildAlgorithmExport()));
  if (publishBtn) {
    publishBtn.addEventListener('click', async () => {
      const results = lastResults || getResultsSnapshot();
      const text = await buildPublicationExport(results);
      setExportOutput(text);
    });
  }
}

function ensureDealIds(deals) {
  const usedIds = new Set();
  deals.forEach((deal) => {
    if (!deal || typeof deal !== 'object') return;
    let id = deal.id ? String(deal.id) : '';
    if (!id || usedIds.has(id)) {
      id = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      deal.id = id;
    }
    usedIds.add(id);
  });
}

function parseImportPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  let deals = null;
  let params = null;
  let settingsPayload = null;

  if (Array.isArray(parsed)) {
    deals = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.deals)) deals = parsed.deals;
    if (parsed.params && typeof parsed.params === 'object') params = parsed.params;
    if (parsed.settings && typeof parsed.settings === 'object') settingsPayload = parsed.settings;
  }

  if (!deals) return null;
  return { deals, params, settings: settingsPayload };
}

function setupImportControls() {
  const importBtn = document.getElementById('importAlgoBtn');
  const importInput = document.getElementById('importInput');
  if (!importBtn || !importInput) return;

  importBtn.addEventListener('click', () => {
    const text = importInput.value.trim();
    if (!text) return;
    const payload = parseImportPayload(text);
    if (!payload) {
      alert('Не удалось распознать формат импорта.');
      return;
    }

    const deals = payload.deals.filter(item => item && typeof item === 'object');
    ensureDealIds(deals);

    currentDeals = deals;
    dealParams = payload.params && typeof payload.params === 'object'
      ? pruneParamsForDeals(currentDeals, payload.params)
      : {};
    ensureParamsForDeals(currentDeals);

    saveDeals();
    saveParams(dealParams);

    if (payload.settings) {
      settings = normalizeSettings(payload.settings);
      saveSettings(settings);
      applySettingsToInputs(settings);
    }

    renderDeals(currentDeals);
    updateAddFormDefaults();
    runAndRender();
    updatePrices(true);
  });
}

function readSettingsFromInputs() {
  const totalInput = document.getElementById('riskTotal');
  const maxInput = document.getElementById('riskMax');
  const shareInput = document.getElementById('usefulnessShare');
  const depositInput = document.getElementById('calcDeposit');
  return normalizeSettings({
    totalRisk: totalInput ? totalInput.value : '',
    maxRisk: maxInput ? maxInput.value : '',
    usefulnessShare: shareInput ? shareInput.value : '',
    calcDeposit: depositInput ? depositInput.value : ''
  });
}

function applySettingsToInputs(nextSettings) {
  const totalInput = document.getElementById('riskTotal');
  const maxInput = document.getElementById('riskMax');
  const shareInput = document.getElementById('usefulnessShare');
  const depositInput = document.getElementById('calcDeposit');
  if (totalInput) totalInput.value = nextSettings.totalRisk;
  if (maxInput) maxInput.value = nextSettings.maxRisk;
  if (shareInput) shareInput.value = Math.round(nextSettings.usefulnessShare * 100);
  if (depositInput) {
    depositInput.value = Number.isFinite(nextSettings.calcDeposit) ? nextSettings.calcDeposit : '';
  }
}

function runAndRender() {
  settings = readSettingsFromInputs();
  saveSettings(settings);
  const results = runAlgorithm(currentDeals, dealParams, settings, priceByPair);
  lastResults = results;
  updateSummary(results.summary);
  updateRows(results);
  renderCalculatedDeals(results);
}

function setupSettingsListeners() {
  const inputs = [
    document.getElementById('riskTotal'),
    document.getElementById('riskMax'),
    document.getElementById('usefulnessShare'),
    document.getElementById('calcDeposit')
  ].filter(Boolean);

  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      runAndRender();
    });
  });

  const runBtn = document.getElementById('runAlgoBtn');
  if (runBtn) {
    runBtn.addEventListener('click', () => {
      runAndRender();
    });
  }
}

function setupPriceControls() {
  const refreshBtn = document.getElementById('refreshPricesBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      updatePrices(true);
    });
  }
}

function setupAddDealControls() {
  const addBtn = document.getElementById('addDealBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      addDealFromForm();
    });
  }
}

function startAutoPriceRefresh() {
  if (PRICE_REFRESH_MS <= 0) return;
  setInterval(() => {
    updatePrices(true);
  }, PRICE_REFRESH_MS);
}

function setupDealListeners() {
  const body = document.getElementById('dealsBody');
  if (!body) return;

  body.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.dataset) return;
    const id = target.dataset.id;
    const field = target.dataset.field;
    if (!id || !field) return;

    if (field === 'enabled' || field === 'priceMode') return;

    const params = dealParams[id] || {};
    params[field] = toNullableNumber(target.value);
    dealParams[id] = params;
    saveParams(dealParams);
    runAndRender();
  });

  body.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="delete"][data-id]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    if (confirm('Удалить сделку?')) {
      deleteDealById(id);
    }
  });

  body.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !target.dataset) return;
    const field = target.dataset.field;
    const id = target.dataset.id;
    if (!id) return;
    const params = dealParams[id] || {};
    if (field === 'enabled') {
      params.enabled = target.checked;
    } else if (field === 'priceMode') {
      params.priceMode = target.value === 'manual' ? 'manual' : 'auto';
      if (params.priceMode === 'manual' && !Number.isFinite(params.manualPrice)) {
        const deal = findDealById(id);
        const pairKey = normalizePair(deal ? deal.pair : '');
        if (pairKey && priceByPair[pairKey] !== undefined) {
          params.manualPrice = priceByPair[pairKey];
        }
      }
      const row = target.closest('.deal-row');
      if (row) {
        updatePriceModeUI(row, params.priceMode);
        const manualInput = row.querySelector('input[data-field="manualPrice"]');
        if (manualInput && Number.isFinite(params.manualPrice)) {
          manualInput.value = params.manualPrice;
        }
      }
    } else {
      return;
    }
    dealParams[id] = params;
    saveParams(dealParams);
    runAndRender();
    if (field === 'priceMode' && params.priceMode === 'auto') {
      updatePrices(true);
    }
  });
}

currentDeals = loadDeals();
dealParams = loadParams();
settings = loadSettings();
ensureParamsForDeals(currentDeals);
applySettingsToInputs(settings);
renderDeals(currentDeals);
setupSettingsListeners();
setupPriceControls();
setupAddDealControls();
setupDealListeners();
setupExportControls();
setupImportControls();
runAndRender();
updatePrices(true);
startAutoPriceRefresh();
updateAddFormDefaults();
