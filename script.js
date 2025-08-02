// script.js

// ==== список топ-50 российских акций ====
const STOCKS = [
  'SBER','ROSN','LKOH','NVTK','GAZP','PLZL','SIBN','GMKN','YDEX','TATN',
  'SNGS','VTBR','OZON','TRNF','T','PHOR','CHMF','X5','NLMK','AKRN',
  'UNAC','RUAL','MTSS','PIKK','MOEX','SVCB','MAGN','MGNT','ALRS','IRAO',
  'VSMO','ENPG','IRKT','BANE','CBOM','POLY','AFLT','RTKM','HYDR','FLOT',
  'LENT','BSPB','HEAD','FESH','NMTP','ROSB','NKNC','AFKS','FIXP','LSNG'
];

// ==== вспомогательные словари ====
const CONTRACT_SIZES = {
  'XAUUSD': 100,
  'XAGUSD': 5000,
  'BTCUSDT': 1,
  'ETHUSDT': 1,
  DEFAULT: 100000
};

// ==== разбор пары/тика ====
function parseCurrencyPair(pair) {
  const p = pair.toUpperCase();
  if (STOCKS.includes(p)) {
    return { base: p, quote: document.getElementById('depositCurrency').value };
  }
  if (p.includes('/')) {
    const [base, quote] = p.split('/');
    return { base, quote };
  }
  if (p.endsWith('USDT')) return { base: p.slice(0, -4), quote: 'USDT' };
  if (p.endsWith('USD'))  return { base: p.slice(0, -3), quote: 'USD'  };
  throw new Error('Неверный формат актива.');
}

// ==== контракт-сайз для расчётов ====
function getContractSize(pair) {
  const key = pair.replace('/', '');
  if (STOCKS.includes(key)) return 1;
  return CONTRACT_SIZES[key] || CONTRACT_SIZES.DEFAULT;
}

// ==== определяем тип актива ====
function isCryptoPair(pair) {
  return /BTC|ETH/i.test(pair);
}
function isStockPair(pair) {
  return STOCKS.includes(pair.toUpperCase());
}

// ==== API курсов (стейблкоины нормализуются к USD) ====
async function getExchangeRate(from, to) {
  const STABLE = ['USDT','USDC','DAI','TUSD','USDP'];
  const norm = c => STABLE.includes(c) ? 'USD' : c;
  const f = norm(from.toUpperCase()), t = norm(to.toUpperCase());
  if (f === t) return 1;
  try {
    const res  = await fetch(`https://open.er-api.com/v6/latest/${f}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates[t]) 
      throw new Error(`${from}/${to} не найден`);
    return data.rates[t];
  } catch (err) {
    alert('Не удалось получить курсы: ' + err.message);
    throw err;
  }
}

// ==== сохранение/загрузка формы ====
function saveFormValues() {
  ['currencyPair','depositCurrency','deposit','openPrice','takeProfit',
   'stopLoss','lots','leverage']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) localStorage.setItem(`calc_${id}`, el.value);
    });
}
function loadFormValues() {
  ['currencyPair','depositCurrency','deposit','openPrice','takeProfit',
   'stopLoss','lots','leverage']
    .forEach(id => {
      const stored = localStorage.getItem(`calc_${id}`);
      if (stored !== null) {
        const el = document.getElementById(id);
        if (el) el.value = stored;
      }
    });
}

// ==== динамический расчёт max лотов ====
async function updateMaxLots() {
  const dep = parseFloat(document.getElementById('deposit').value);
  const open = parseFloat(document.getElementById('openPrice').value);
  const lev = parseFloat(document.getElementById('leverage').value);
  const pair = document.getElementById('currencyPair').value.trim().toUpperCase();
  const { quote } = parseCurrencyPair(pair);
  const size = getContractSize(pair);

  if ([dep, open, lev].some(v => isNaN(v) || v <= 0)) {
    document.getElementById('lotsLabel').innerText = 'Количество лотов:';
    document.getElementById('lots').removeAttribute('max');
    return;
  }

  let depositInQuote = dep;
  const depositCurrency = document.getElementById('depositCurrency').value;
  if (depositCurrency !== quote) {
    try {
      // конвертируем депозит в котировочную валюту
      const rate = await getExchangeRate(depositCurrency, quote);
      depositInQuote = dep * rate;
    } catch {
      return;
    }
  }

  const maxLots = (depositInQuote * lev) / (open * size);
  document.getElementById('lotsLabel').innerText =
    `Количество лотов (max: ${maxLots.toFixed(2)}):`;
  document.getElementById('lots').max = maxLots.toFixed(2);
}

// ==== основной расчёт ====
async function calculate(e) {
  e.preventDefault();
  saveFormValues();

  const pair = document.getElementById('currencyPair').value.trim().toUpperCase();
  const dep   = parseFloat(document.getElementById('deposit').value);
  const depCur= document.getElementById('depositCurrency').value;
  const open  = parseFloat(document.getElementById('openPrice').value);
  const tp    = parseFloat(document.getElementById('takeProfit').value);
  const sl    = parseFloat(document.getElementById('stopLoss').value);
  const lots  = parseFloat(document.getElementById('lots').value);
  const lev   = parseFloat(document.getElementById('leverage').value);

  if ([dep, open, tp, sl, lots, lev].some(v => isNaN(v)) || !pair) {
    alert('Заполните все поля корректно.');
    return;
  }

  let base, quote;
  try {
    ({ base, quote } = parseCurrencyPair(pair));
  } catch (err) {
    alert(err.message);
    return;
  }

  // правильная конверсия прибыли/убытка в валюту депозита
  let convRate = 1;
  if (quote !== depCur) {
    try {
      convRate = await getExchangeRate(quote, depCur);
    } catch {
      return;
    }
  }

  const size = getContractSize(pair);
  const margin = (lots * size * open) / lev;

  // учитываем направление сделки: BUY если tp>=open, SELL если tp<open
  let profitQuote, lossQuote;
  if (tp >= open) {
    profitQuote = (tp - open) * lots * size;
    lossQuote   = (open - sl) * lots * size;
  } else {
    profitQuote = (open - tp) * lots * size;
    lossQuote   = (sl - open) * lots * size;
  }

  const profit = profitQuote * convRate;
  const loss   = lossQuote   * convRate;

  const posCost = open * lots * size;
  const profitPosPct = (profitQuote / posCost) * 100;
  const lossPosPct   = (lossQuote   / posCost) * 100;
  const profitDepPct = (profit / dep) * 100;
  const lossDepPct   = (loss   / dep) * 100;

  document.getElementById('profitMoney').textContent           =
    `Прибыль: ${Math.abs(profit.toFixed(2))} ${depCur}`;
  document.getElementById('lossMoney').textContent             =
    `Убыток: ${Math.abs(loss.toFixed(2))} ${depCur}`;
  document.getElementById('marginInfo').textContent            =
    `Требуемая маржа: ${(margin * convRate).toFixed(2)} ${depCur}`;
  document.getElementById('profitDepositPercent').textContent  =
    `Прибыль от депозита: ${Math.abs(profitDepPct.toFixed(2))} %`;
  document.getElementById('lossDepositPercent').textContent    =
    `Убыток от депозита: ${Math.abs(lossDepPct.toFixed(2))} %`;
  document.getElementById('profitPositionPercent').textContent =
    `Прибыль по позиции: ${Math.abs(profitPosPct.toFixed(2))} %`;
  document.getElementById('lossPositionPercent').textContent   =
    `Убыток по позиции: ${Math.abs(lossPosPct.toFixed(2))} %`;
}

// ==== смена темы при выборе актива ====
function updateAssetTheme() {
  const pair = document.getElementById('currencyPair').value;
  const box  = document.getElementById('calculatorBox');
  const stock = isStockPair(pair);
  box.classList.toggle('stock-selected', stock);
  box.classList.toggle('crypto-selected', isCryptoPair(pair) && !stock);
  box.classList.toggle('forex-selected', !isCryptoPair(pair) && !stock);
}

// ==== инициализация ====
document.addEventListener('DOMContentLoaded', () => {
  loadFormValues();
  updateAssetTheme();
  updateMaxLots();

  document.querySelectorAll('#calcForm input, #calcForm select')
    .forEach(el => el.addEventListener('input', () => {
      saveFormValues();
      if (['deposit','openPrice','leverage','depositCurrency'].includes(el.id)) {
        updateMaxLots();
      }
    }));

  document.getElementById('currencyPair')
    .addEventListener('change', () => {
      updateAssetTheme();
      updateMaxLots();
    });

  document.getElementById('calcForm')
    .addEventListener('submit', calculate);
});
