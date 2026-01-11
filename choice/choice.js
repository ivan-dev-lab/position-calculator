const DEALS_KEY = 'calc_savedDeals';
const LIMITS_KEY = 'calc_tradeLimitUsd';
const DEPOSIT_KEY = 'calc_choiceDepositUsd';
const GROUPS_KEY = 'calc_dealGroups';
const GROUPS = [
  { id: 'primary', listId: 'groupPrimary' },
  { id: 'reserve', listId: 'groupReserve' },
  { id: 'extra', listId: 'groupExtra' },
  { id: 'pool', listId: 'groupPool' }
];
const COLUMN_ORDER = ['primary', 'reserve', 'extra', 'pool'];
const COLUMN_TITLES = {
  primary: 'Ближайшая реализация',
  reserve: 'Запасные',
  extra: 'Дополнительные возможности',
  pool: 'Сделки'
};

let dealGroups = {};
let currentDeals = [];
let activeCardId = null;
const rateCache = {};
const stableCurrencies = ['USDT', 'USDC', 'DAI', 'TUSD', 'USDP'];
const groupSet = new Set(GROUPS.map(group => group.id));
const legacyGroupMap = { rejected: 'pool' };

function normalizeGroupId(groupId) {
  if (!groupId) return 'pool';
  const normalized = legacyGroupMap[groupId] || groupId;
  return groupSet.has(normalized) ? normalized : 'pool';
}

function getDealId(deal, index) {
  return String(deal.id || `deal_${index}`);
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return `${Math.abs(value).toFixed(2)} %`;
}

function formatExportValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number' && Number.isNaN(value)) return '-';
  return String(value);
}

function formatRiskReward(profitPct, lossPct) {
  if (
    typeof profitPct !== 'number' ||
    Number.isNaN(profitPct) ||
    typeof lossPct !== 'number' ||
    Number.isNaN(lossPct) ||
    lossPct === 0
  ) {
    return '-';
  }
  const ratio = Math.abs(profitPct) / Math.abs(lossPct);
  if (!Number.isFinite(ratio)) return '-';
  return ratio.toFixed(2);
}

function createMetaItem(label, value, valueClass, dataField) {
  const item = document.createElement('div');
  item.className = 'meta-item';

  const title = document.createElement('span');
  title.textContent = label;

  const content = document.createElement('strong');
  content.textContent = value;
  if (valueClass) content.className = valueClass;
  if (dataField) content.dataset.field = dataField;

  item.append(title, content);
  return item;
}




function setActiveCard(card) {
  const prev = document.querySelector('.deal-card.active');
  if (prev && prev !== card) prev.classList.remove('active');
  if (card) {
    card.classList.add('active');
    activeCardId = card.dataset.id;
  }
}

function loadDealGroups() {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('Не удалось загрузить группы сделок:', err);
    return {};
  }
}

function saveDealGroups() {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(dealGroups));
}

function normalizeCurrency(currency) {
  if (!currency) return '';
  const upper = String(currency).toUpperCase();
  return stableCurrencies.includes(upper) ? 'USD' : upper;
}

async function getRateToUsd(currency) {
  const curr = normalizeCurrency(currency);
  if (!curr || curr === 'USD') return 1;
  if (rateCache[curr]) return rateCache[curr];
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${curr}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates || !data.rates.USD) {
      return null;
    }
    rateCache[curr] = data.rates.USD;
    return data.rates.USD;
  } catch (err) {
    console.warn('Не удалось получить курс валюты:', err);
    return null;
  }
}

function setLimitStatText(lossUsdText, lossPctText, usagePctText) {
  const lossUsd = document.getElementById('limitLossUsd');
  const lossPct = document.getElementById('limitLossPct');
  const usagePct = document.getElementById('limitUsagePct');
  if (lossUsd) lossUsd.textContent = lossUsdText;
  if (lossPct) lossPct.textContent = lossPctText;
  if (usagePct) usagePct.textContent = usagePctText;
}

async function updateLimitStats() {
  const limitInput = document.getElementById('limitsValue');
  if (!limitInput) return;
  const limitValue = parseFloat(limitInput.value);
  const depositOverride = getOverrideDeposit();

  if (!limitValue || limitValue <= 0) {
    setLimitStatText('-', '-', '-');
    return;
  }

  const primaryDeals = currentDeals.filter((deal, index) => {
    const id = getDealId(deal, index);
    return normalizeGroupId(dealGroups[id]) === 'primary';
  });

  if (!primaryDeals.length) {
    setLimitStatText('0.00', '0.00 %', '0.00 %');
    return;
  }

  const currencies = Array.from(new Set(primaryDeals.map(d => normalizeCurrency(d.depCur))));
  const rates = {};
  for (const currency of currencies) {
    const rate = await getRateToUsd(currency);
    if (rate === null) {
      setLimitStatText('-', '-', '-');
      return;
    }
    rates[currency] = rate;
  }

  let totalLossUsd = 0;
  let totalDepUsd = 0;
  primaryDeals.forEach((deal) => {
    const curr = normalizeCurrency(deal.depCur);
    const rate = rates[curr];
    if (!rate) return;
    totalLossUsd += (Number(deal.loss) || 0) * rate;
    totalDepUsd += (Number(deal.dep) || 0) * rate;
  });

  const lossPctBase = depositOverride || (totalDepUsd > 0 ? totalDepUsd : null);
  const lossPct = lossPctBase ? (totalLossUsd / lossPctBase) * 100 : null;
  const usagePct = (totalLossUsd / limitValue) * 100;

  const lossUsdText = `${totalLossUsd.toFixed(2)} USD`;
  const lossPctText = lossPct === null ? '-' : `${lossPct.toFixed(2)} %`;
  const usagePctText = `${usagePct.toFixed(2)} %`;
  setLimitStatText(lossUsdText, lossPctText, usagePctText);
}

function getOverrideDeposit() {
  const depositInput = document.getElementById('depositValue');
  if (!depositInput) return null;
  const value = parseFloat(depositInput.value);
  if (!value || value <= 0) return null;
  return value;
}

function updateCardPercentValues(card, profitPct, lossPct) {
  const profitEl = card.querySelector('[data-field="profitPct"]');
  if (profitEl) profitEl.textContent = formatPercent(profitPct);
  const lossEl = card.querySelector('[data-field="lossPct"]');
  if (lossEl) lossEl.textContent = formatPercent(lossPct);
  const rrEl = card.querySelector('[data-field="rr"]');
  if (rrEl) rrEl.textContent = formatRiskReward(profitPct, lossPct);
}

async function updateDealPercentages() {
  const depositValue = getOverrideDeposit();
  const cards = document.querySelectorAll('.deal-card');
  if (!cards.length) return;

  const dealMap = new Map();
  currentDeals.forEach((deal, index) => {
    dealMap.set(getDealId(deal, index), deal);
  });

  if (!depositValue) {
    cards.forEach((card) => {
      const deal = dealMap.get(card.dataset.id);
      if (!deal) return;
      updateCardPercentValues(card, deal.profitDepPct, deal.lossDepPct);
    });
    return;
  }

  const currencies = Array.from(new Set(currentDeals.map(d => normalizeCurrency(d.depCur))));
  const rates = {};
  for (const currency of currencies) {
    const rate = await getRateToUsd(currency);
    if (rate !== null) rates[currency] = rate;
  }

  cards.forEach((card) => {
    const deal = dealMap.get(card.dataset.id);
    if (!deal) return;
    const rate = rates[normalizeCurrency(deal.depCur)];
    if (!rate) {
      updateCardPercentValues(card, null, null);
      return;
    }
    const profitUsd = (Number(deal.profit) || 0) * rate;
    const lossUsd = (Number(deal.loss) || 0) * rate;
    const profitPct = (profitUsd / depositValue) * 100;
    const lossPct = (lossUsd / depositValue) * 100;
    updateCardPercentValues(card, profitPct, lossPct);
  });
}

function buildCalculatorExport() {
  return JSON.stringify(currentDeals, null, 2);
}

function buildChoiceExport() {
  const limitInput = document.getElementById('limitsValue');
  const limitValue = limitInput ? parseFloat(limitInput.value) : null;
  const depositValue = getOverrideDeposit();
  const normalizedGroups = {};
  currentDeals.forEach((deal, index) => {
    const id = getDealId(deal, index);
    normalizedGroups[id] = normalizeGroupId(dealGroups[id]);
  });
  const payload = {
    type: 'calc_choice_v1',
    exportedAt: new Date().toISOString(),
    limitUsd: limitValue && limitValue > 0 ? limitValue : null,
    depositUsd: depositValue && depositValue > 0 ? depositValue : null,
    dealGroups: normalizedGroups,
    deals: currentDeals
  };
  return JSON.stringify(payload, null, 2);
}

function buildPublicationExport() {
  const lines = [];
  const dealIndexMap = new Map();
  currentDeals.forEach((deal, index) => {
    dealIndexMap.set(deal, index);
  });

  const dealNumberById = {};
  const pairCounters = {};
  const sortedForNumbering = currentDeals
    .map((deal, index) => ({ deal, index }))
    .sort((a, b) => (a.deal.created || 0) - (b.deal.created || 0));

  sortedForNumbering.forEach(({ deal, index }) => {
    const pair = deal.pair || 'Без названия';
    pairCounters[pair] = (pairCounters[pair] || 0) + 1;
    dealNumberById[getDealId(deal, index)] = pairCounters[pair];
  });

  COLUMN_ORDER.forEach((groupId) => {
    if (groupId === 'pool') return;
    const title = COLUMN_TITLES[groupId];
    const deals = currentDeals.filter((deal, index) => {
      const id = getDealId(deal, index);
      return normalizeGroupId(dealGroups[id]) === groupId;
    });
    if (!deals.length) return;

    if (lines.length) lines.push('');
    lines.push(title);

    deals.sort((a, b) => (a.created || 0) - (b.created || 0));

    const byPair = new Map();
    deals.forEach((deal) => {
      const pair = deal.pair || 'Без названия';
      if (!byPair.has(pair)) byPair.set(pair, []);
      byPair.get(pair).push(deal);
    });

    for (const [pair, pairDeals] of byPair.entries()) {
      if (lines[lines.length - 1] !== title) lines.push('');
      lines.push(pair);
      pairDeals.forEach((deal, idx) => {
        const dealIndex = dealIndexMap.get(deal);
        const id = getDealId(deal, dealIndex);
        const number = dealNumberById[id] || 1;
        if (idx > 0) lines.push('');
        lines.push(`#${number}`);
        lines.push(`Entry: ${formatExportValue(deal.open)}`);
        lines.push(`TP: ${formatExportValue(deal.tp)}`);
        lines.push(`SL: ${formatExportValue(deal.sl)}`);
        lines.push(`VOL: ${formatExportValue(deal.lots)}`);
      });
    }
  });

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
  const choiceBtn = document.getElementById('exportChoiceBtn');
  const publishBtn = document.getElementById('exportPublishBtn');
  if (calcBtn) calcBtn.addEventListener('click', () => setExportOutput(buildCalculatorExport()));
  if (choiceBtn) choiceBtn.addEventListener('click', () => setExportOutput(buildChoiceExport()));
  if (publishBtn) publishBtn.addEventListener('click', () => setExportOutput(buildPublicationExport()));
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
  let groups = null;
  let limit = null;
  let deposit = null;

  if (Array.isArray(parsed)) {
    deals = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.deals)) deals = parsed.deals;
    if (parsed.dealGroups && typeof parsed.dealGroups === 'object') groups = parsed.dealGroups;
    if (parsed.limitUsd !== undefined) {
      const value = parseFloat(parsed.limitUsd);
      if (!Number.isNaN(value)) limit = value;
    }
    if (parsed.depositUsd !== undefined) {
      const value = parseFloat(parsed.depositUsd);
      if (!Number.isNaN(value)) deposit = value;
    }
  }

  if (!deals) return null;
  return { deals, groups, limit, deposit };
}

function setupImportControls() {
  const importBtn = document.getElementById('importChoiceBtn');
  const importInput = document.getElementById('importInput');
  if (!importBtn || !importInput) return;

  importBtn.addEventListener('click', () => {
    const text = importInput.value.trim();
    if (!text) return;
    const payload = parseImportPayload(text);
    if (!payload) {
      alert('Не удалось разобрать текст импорта.');
      return;
    }

    const deals = payload.deals.filter(item => item && typeof item === 'object');
    ensureDealIds(deals);

    currentDeals = deals;
    localStorage.setItem(DEALS_KEY, JSON.stringify(currentDeals));

    if (payload.groups) {
      const normalizedGroups = {};
      Object.keys(payload.groups).forEach((id) => {
        normalizedGroups[id] = normalizeGroupId(payload.groups[id]);
      });
      dealGroups = normalizedGroups;
      saveDealGroups();
    } else {
      dealGroups = {};
      saveDealGroups();
    }

    if (typeof payload.limit === 'number' && payload.limit > 0) {
      const limitInput = document.getElementById('limitsValue');
      if (limitInput) {
        limitInput.value = String(payload.limit);
        localStorage.setItem(LIMITS_KEY, limitInput.value);
      }
    }

    if (typeof payload.deposit === 'number' && payload.deposit > 0) {
      const depositInput = document.getElementById('depositValue');
      if (depositInput) {
        depositInput.value = String(payload.deposit);
        localStorage.setItem(DEPOSIT_KEY, depositInput.value);
      }
    }

    renderDeals(currentDeals);
    updateLimitStats();
    updateDealPercentages();
  });
}

function renderDeals(deals) {
  const noDeals = document.getElementById('noDeals');
  const count = document.getElementById('dealCount');
  if (!noDeals || !count) return;

  const lists = {};
  GROUPS.forEach(group => {
    const list = document.getElementById(group.listId);
    if (list) {
      list.innerHTML = '';
      lists[group.id] = list;
    }
  });

  if (!deals.length) {
    noDeals.style.display = 'block';
    count.textContent = '';
    return;
  }

  noDeals.style.display = 'none';
  count.textContent = `Всего: ${deals.length}`;

  deals.forEach((deal, index) => {
    const card = document.createElement('article');
    card.className = 'deal-card';
    card.dataset.id = getDealId(deal, index);
    card.setAttribute('draggable', 'true');

    const header = document.createElement('div');
    header.className = 'deal-header';

    const title = document.createElement('div');
    title.className = 'deal-title';
    title.textContent = `${index + 1}. ${deal.pair || '-'}`;

    const tag = document.createElement('span');
    tag.className = 'deal-tag';
    const direction = String(deal.direction || '').toUpperCase();
    tag.textContent = direction || '-';
    if (direction === 'SELL') tag.classList.add('sell');

    header.append(title, tag);

    const meta = document.createElement('div');
    meta.className = 'deal-meta';
    meta.append(
      createMetaItem('Профит, %', formatPercent(deal.profitDepPct), 'profit', 'profitPct'),
      createMetaItem('Убыток, %', formatPercent(deal.lossDepPct), 'loss', 'lossPct'),
      createMetaItem('RR', formatRiskReward(deal.profitDepPct, deal.lossDepPct), null, 'rr')
    );

    card.append(header, meta);

    const groupId = normalizeGroupId(dealGroups[card.dataset.id]);
    const targetList = lists[groupId] || lists.pool || lists.primary;
    if (targetList) targetList.appendChild(card);
  });

  if (activeCardId) {
    const active = document.querySelector(`.deal-card[data-id="${activeCardId}"]`);
    if (active) setActiveCard(active);
  }

  updateLimitStats();
  updateDealPercentages();
  updateDepositPlaceholder();
}

function loadDeals() {
  try {
    const raw = localStorage.getItem(DEALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Не удалось загрузить сделки:', err);
    return [];
  }
}

function loadLimits() {
  const limits = document.getElementById('limitsValue');
  if (!limits) return;
  const stored = localStorage.getItem(LIMITS_KEY);
  if (stored !== null) limits.value = stored;
  limits.addEventListener('input', () => {
    localStorage.setItem(LIMITS_KEY, limits.value);
    updateLimitStats();
  });
}

function loadDepositOverride() {
  const deposit = document.getElementById('depositValue');
  if (!deposit) return;
  const stored = localStorage.getItem(DEPOSIT_KEY);
  if (stored !== null) deposit.value = stored;
  deposit.addEventListener('input', () => {
    localStorage.setItem(DEPOSIT_KEY, deposit.value);
    updateDealPercentages();
    updateLimitStats();
  });
}

function updateDepositPlaceholder() {
  const depositInput = document.getElementById('depositValue');
  if (!depositInput) return;
  if (!currentDeals.length) {
    depositInput.placeholder = 'Например: 1000';
    return;
  }

  const first = currentDeals[0];
  const baseDep = Number(first.dep);
  const baseCur = (first.depCur || 'USD').toUpperCase();
  if (!baseDep) {
    depositInput.placeholder = 'Например: 1000';
    return;
  }

  const allSame = currentDeals.every((deal) => {
    const dep = Number(deal.dep);
    const cur = (deal.depCur || 'USD').toUpperCase();
    return dep === baseDep && cur === baseCur;
  });

  if (!allSame) {
    depositInput.placeholder = 'Депозиты различаются';
    return;
  }

  depositInput.placeholder = `Изначальный депозит: ${baseDep.toFixed(2)} ${baseCur}`;
}



function setupBoardInteractions() {
  const board = document.getElementById('dealBoard');
  if (!board) return;

  board.addEventListener('click', (event) => {
    const card = event.target.closest('.deal-card');
    if (card) setActiveCard(card);
  });

  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.deal-card');
    if (!card || !event.dataTransfer) return;
    event.dataTransfer.setData('text/plain', card.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
    setActiveCard(card);
  });

}

function setupDropZones() {
  document.querySelectorAll('.board-column').forEach((column) => {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('drag-over');
    });

    column.addEventListener('dragleave', () => {
      column.classList.remove('drag-over');
    });

    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const id = event.dataTransfer ? event.dataTransfer.getData('text/plain') : '';
      if (!id) return;
      const group = normalizeGroupId(column.dataset.group || 'pool');
      dealGroups[id] = group;
      saveDealGroups();
      const list = column.querySelector('.board-list');
      const card = document.querySelector(`.deal-card[data-id="${id}"]`);
      if (list && card) list.appendChild(card);
      updateLimitStats();
    });
  });
}

window.addEventListener('beforeunload', (event) => {
  event.preventDefault();
  event.returnValue = 'Изменения на этой странице не сохраняются.';
});

dealGroups = loadDealGroups();
loadLimits();
loadDepositOverride();
currentDeals = loadDeals();
renderDeals(currentDeals);
setupBoardInteractions();
setupDropZones();
setupExportControls();
setupImportControls();
