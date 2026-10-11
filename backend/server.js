const express = require('express');
const authService = require('./services/authService');
const configService = require('./services/configService');
const storage = require('./services/storageService');
const validation = require('./services/validationService');
const { redact } = require('./services/redactionService');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const copyEngine = require('./services/copyTradingEngine');
const ipService = require('./services/ipService');
const dhanService = require('./services/dhanService');
const orderQueueService = require('./services/orderQueueService');
const WebSocket = require('ws');
const cryptoService = require('./services/cryptoService');



const app = express();
const PORT = process.env.PORT || 3000;

const compression = require('compression');
app.use(compression());

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));
for (const method of ['get', 'post', 'put', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => register(route, ...handlers.map(handler => typeof handler === 'function' ? (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next) : handler));
}
authService.mount(app);

// Serve static frontend files with Gzip compression and 1-day cache-control
app.use(express.static(path.join(__dirname, '../frontend'), {
  maxAge: 0,
  etag: true
}));

const instrumentService = require('./services/instrumentService');
const unifiedWsClient = require('./services/unifiedWsClient');

// Watchlist and dynamic prices in memory
const watchlists = storage.readJson('watchlists.json', {});
function userWatchlists(userId) {
  if (!watchlists[userId]) watchlists[userId] = { '1': [], '2': [] };
  return watchlists[userId];
}
function allWatchlistSymbols() { return Object.values(watchlists).flatMap(tabs => Object.values(tabs).flat()); }
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function activeContract(stock) { return !stock.expiry || stock.expiry.slice(0, 10) >= todayIST(); }
const basePrices = {};
global.basePrices = basePrices;
const basePrevCloses = {};
const baseOpens = {};
const baseHighs = {};
const baseLows = {};
const baseDepths = {};
const isLivePrice = {};
const lastLiveUpdate = {};
global.lastLiveUpdate = lastLiveUpdate;
const symbolToStockMap = {};
const symbolToTokenMap = {};
const tokenToSymbolMap = {};

const INDEX_TOKENS = {
  'NIFTY-EQ': { token: '99926000', exchange: 'NSE' },
  'BANKNIFTY-EQ': { token: '99926009', exchange: 'NSE' },
  'SENSEX-EQ': { token: '99919000', exchange: 'BSE' }
};

let lastActiveSymbol = null;
let lastActiveSymbolTime = 0;
let lastFrontendActiveTime = Date.now();
let lastSearchSymbols = [];
let lastSearchSymbolsTime = 0;

function updateSymbolOHLC(symbol, ltp, prevClose, open, high, low, depth) {
  if (!symbol || !Number.isFinite(Number(ltp)) || Number(ltp) <= 0) return;
  basePrices[symbol] = Number(ltp);
  for (const [map, value] of [[basePrevCloses, prevClose], [baseOpens, open], [baseHighs, high], [baseLows, low]]) {
    if (value !== null && value !== undefined && Number(value) > 0) map[symbol] = Number(value);
  }
  if (depth) baseDepths[symbol] = depth;
}

let cachedSearchBases = [];
let searchIndex = {};

function buildSearchIndex() {
  const startTime = Date.now();
  searchIndex = {};
  cachedSearchBases.forEach(b => {
    const sym = b.symbol.replace('-EQ', '').toUpperCase().replace(/\s+/g, '');
    const name = b.name.toUpperCase().replace(/\s+/g, '');
    
    const terms = new Set();
    
    // 1. Add prefixes of the symbol (length >= 2)
    for (let len = 2; len <= sym.length; len++) {
      terms.add(sym.substring(0, len));
    }
    
    // 2. Add prefixes of the full name without spaces
    const nameNoSpaces = name.replace(/\s+/g, '');
    for (let len = 2; len <= nameNoSpaces.length; len++) {
      terms.add(nameNoSpaces.substring(0, len));
    }
    
    // 3. Add prefixes of individual words in the name
    const words = b.name.toUpperCase().split(/\s+/).filter(w => w.length >= 2);
    words.forEach(w => {
      const cleanWord = w.replace(/[^A-Z0-9&]/g, '');
      if (cleanWord.length >= 2) {
        for (let len = 2; len <= cleanWord.length; len++) {
          terms.add(cleanWord.substring(0, len));
        }
      }
    });

    terms.forEach(term => {
      if (!searchIndex[term]) {
        searchIndex[term] = [];
      }
      searchIndex[term].push(b);
    });
  });
  console.log(`[Search Index] Built prefix trie index with ${Object.keys(searchIndex).length} terms in ${Date.now() - startTime}ms.`);
}

const COMPANY_NAME_OVERRIDES = {
  'M&M-EQ': 'Mahindra & Mahindra Limited',
  'M&MFIN-EQ': 'Mahindra & Mahindra Financial Services Limited',
  'SMLMAH-EQ': 'SML Mahindra Limited'
};

const { STOCKS_DATABASE } = require('./services/stockDb');
const POPULARITY_MAP = {
  'NIFTY-EQ': 1,
  'BANKNIFTY-EQ': 2,
  'FINNIFTY-EQ': 3,
  'SENSEX-EQ': 4
};
STOCKS_DATABASE.forEach((stock, idx) => {
  POPULARITY_MAP[stock.symbol] = 10 + idx;
});

// Load F&O Symbols Set to identify which scripts support derivatives (Futures & Options)
let foSymbolsSet = new Set();
const foSymbolsPath = path.join(__dirname, 'services', 'foSymbols.json');
if (fs.existsSync(foSymbolsPath)) {
  try {
    const list = JSON.parse(fs.readFileSync(foSymbolsPath, 'utf8'));
    foSymbolsSet = new Set(list.map(s => s.toUpperCase().trim()));
    console.log(`[Startup] Loaded ${foSymbolsSet.size} F&O symbols.`);
  } catch (e) {
    console.error('[Startup] Failed to load F&O symbols:', e.message);
  }
}

function populateBasePrices() {
  for (const key of Object.keys(symbolToStockMap)) delete symbolToStockMap[key];
  for (const stock of instrumentService.getDatabase().filter(activeContract)) {
    if (!symbolToStockMap[stock.symbol] || stock.exchange === 'NSE') symbolToStockMap[stock.symbol] = stock;
    symbolToTokenMap[stock.symbol] = stock.token;
    tokenToSymbolMap[stock.exchange + ':' + stock.token] = stock.symbol;
  }
  for (const [symbol, info] of Object.entries(INDEX_TOKENS)) {
    symbolToStockMap[symbol] = { symbol, name: symbol.replace('-EQ', '') + ' Index', ...info, lotSize: 1, price: 0 };
  }
  cachedSearchBases = Object.values(symbolToStockMap);
}

populateBasePrices();
const CONFIG_PATH = storage.dataPath('config.json');
function loadConfig() { return configService.loadConfig(); }
function saveConfig(config) { configService.saveConfig(config); currentConfig = config; }

// Initial initialization of services
let currentConfig = loadConfig();
currentConfig.users.forEach(user => {
  user.accounts.forEach(acc => {
    try {
      copyEngine.initializeService({ ...acc, ownerId: user.id });
    } catch (e) {
      console.error(`Failed to initialize account ${acc.name}:`, e);
    }
  });
});

// Load all mappings from all users and set them in CopyEngine
const allMappings = [];
currentConfig.users.forEach(user => {
  if (user.mappings) {
    allMappings.push(...user.mappings);
  }
});
copyEngine.setMappings(allMappings);

// --- User Scoping Helpers & Auth ---

function getUserConfig(userId) {
  const config = loadConfig();
  const user = config.users.find(entry => entry.id === userId);
  if (!user) { const error = new Error('User not found'); error.status = 401; throw error; }
  return { config, user };
}

function rebuildGlobalMappings() {
  const config = loadConfig();
  const allMappings = [];
  config.users.forEach(u => {
    if (u.mappings) {
      allMappings.push(...u.mappings);
    }
  });
  copyEngine.setMappings(allMappings);
}

// --- API Endpoints ---

// Get all accounts for logged-in user
app.get('/api/accounts', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { config, user } = getUserConfig(userId);
  
  const accountsWithState = user.accounts.map(acc => {
    const service = copyEngine.services[acc.id];
    const isMaster = user.mappings.some(m => m.masterId === acc.id);
    const computedType = isMaster ? 'master' : 'child';
    return {
      ...configService.publicAccount(acc),
      type: computedType,
      connected: service ? service.session.connected : false
    };
  });
  res.json(accountsWithState);
});

// Add or update an account for logged-in user
app.post('/api/accounts', (req, res) => {
  const { config, user } = getUserConfig(req.userId);
  const input = req.body;
  if (!input || !['angel_one', 'motilal', 'dhan'].includes(input.broker) || typeof input.isSimulated !== 'boolean') validation.reject('Invalid account broker or simulation flag');
  const existing = input.id && user.accounts.find(account => account.id === input.id);
  if (input.id && !existing) return res.status(404).json({ error: 'Account not found' });
  if (existing && existing.broker !== input.broker) validation.reject('Create a separate account to change broker');
  if (existing && existing.isSimulated !== input.isSimulated) validation.reject('Create a separate account to switch between paper and live trading');
  const allowed = ['type', 'name', 'broker', 'isSimulated', 'clientCode', 'userId', 'proxyUrl', ...configService.sensitiveFields];
  const account = { ...(existing || {}), id: existing?.id || 'acc_' + crypto.randomUUID(), ownerId: user.id };
  for (const field of allowed) {
    if (input[field] === undefined) continue;
    if (field !== 'isSimulated' && (typeof input[field] !== 'string' || input[field].length > 16000)) validation.reject('Invalid account field: ' + field);
    if (configService.sensitiveFields.includes(field) && input[field] === '' && existing) continue;
    account[field] = input[field];
  }
  account.type = account.type || 'child';
  if (!['master', 'child'].includes(account.type)) validation.reject('Invalid account role');
  account.name = String(account.name || account.clientCode || account.userId || 'Account').trim().slice(0, 100);
  if (!existing && input.isSimulated) {
    account.balance = Number(input.balance ?? 1000000);
    if (!Number.isFinite(account.balance) || account.balance < 0) validation.reject('Invalid paper balance');
  }
  if (!account.isSimulated && (!account.password || !(account.clientCode || account.userId))) validation.reject('Broker credentials are required');
  if (account.proxyUrl && account.proxyUrl !== 'vps') {
    let proxy;
    try { proxy = new URL(account.proxyUrl); } catch { validation.reject('Invalid proxy URL'); }
    if (!['http:', 'https:'].includes(proxy.protocol)) validation.reject('Unsupported proxy protocol');
  }
  if (existing) user.accounts[user.accounts.indexOf(existing)] = account;
  else user.accounts.push(account);
  saveConfig(config);
  copyEngine.initializeService(account);
  res.json({ success: true, account: configService.publicAccount(account) });
});

// Delete an account for logged-in user
app.delete('/api/accounts/:id', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { config, user } = getUserConfig(userId);
  const accountId = req.params.id;

  const idx = user.accounts.findIndex(a => a.id === accountId);
  if (idx !== -1) {
    const accName = user.accounts[idx].name;
    user.accounts.splice(idx, 1);
    
    // Also remove from mappings
    user.mappings = user.mappings.filter(m => m.masterId !== accountId && m.childId !== accountId);
    user.groups = (user.groups || []).filter(group => group.masterId !== accountId).map(group => ({ ...group, children: group.children.filter(child => child.childId !== accountId) }));
    
    saveConfig(config);
    copyEngine.removeService(accountId);
    rebuildGlobalMappings();

    copyEngine.addLog({
      timestamp: new Date().toISOString(),
      accountId,
      accountName: accName,
      broker: 'System',
      type: 'system',
      message: `Account ${accName} deleted.`
    });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// Recharge simulated account balance
app.post('/api/accounts/:id/recharge', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { config, user } = getUserConfig(userId);
  const accountId = req.params.id;
  const { amount } = req.body;

  const account = user.accounts.find(a => a.id === accountId);
  if (account) {
    const simManager = require('./services/simulatedPortfolioManager');
    if (!account.isSimulated) validation.reject('Only paper accounts can be recharged');
    simManager.recharge(account, amount);
    
    // Update active service account in copyEngine
    const service = copyEngine.services[accountId];
    if (service) {
      service.account = account;
      if (typeof service.clearCache === 'function') {
        service.clearCache();
      }
    }
    
    res.json({ success: true, balance: account.balance });
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// Get simulated account closed trades P&L report
app.get('/api/accounts/:id/pnl-report', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { user } = getUserConfig(userId);
  const accountId = req.params.id;

  const account = user.accounts.find(a => a.id === accountId);
  if (account) {
    const simManager = require('./services/simulatedPortfolioManager');
    const report = simManager.getPnlReport(account);
    res.json(report);
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// Trigger connection login
app.post('/api/connect/:id', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const accountId = req.params.id;
  const service = copyEngine.services[accountId];

  if (!service) {
    return res.status(404).json({ error: 'Account service not found' });
  }

  const success = await service.login();
  if (success && copyEngine.mappings.some(mapping => mapping.active && mapping.masterId === accountId)) await copyEngine.primeMaster(accountId);
  
  if (success) {
    if (service.account.broker === 'dhan') {
      dhanService.resetDataApiStatus();
    }
    try {
      let profileName = null;
      if (typeof service.getProfile === 'function') {
        const profile = await service.getProfile();
        if (profile && profile.name) {
          profileName = profile.name;
        }
      }
      if (profileName) {
        const { config, user } = getUserConfig(userId);
        const idx = user.accounts.findIndex(a => a.id === accountId);
        if (idx !== -1) {
          user.accounts[idx].name = profileName;
          saveConfig(config);
          
          // Update the account name in-memory on the running service without re-instantiating it
          service.account.name = profileName;
        }
      }
    } catch (e) {
      console.error('Failed to update client name from profile:', e);
    }
    
    if (success) {
      service.getHolding().catch(err => console.error('Failed to warm up holdings cache:', err.message));
      service.getPosition().catch(err => console.error('Failed to warm up positions cache:', err.message));
    }
  }

  res.json({ success, connected: service.session.connected });
});

// Get copy mappings for logged-in user
app.get('/api/mappings', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { user } = getUserConfig(userId);
  res.json(user.mappings || []);
});

// Save copy mappings for logged-in user
app.post('/api/mappings', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { config, user } = getUserConfig(userId);
  user.mappings = validation.mappings(req.body, user.accounts.map(account => account.id));
  saveConfig(config);
  rebuildGlobalMappings();
  res.json({ success: true });
});

// Get copy trading groups for logged-in user
app.get('/api/groups', (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { user } = getUserConfig(userId);
  res.json(user.groups || []);
});

// Save copy trading groups for logged-in user
app.post('/api/groups', (req, res) => {
  const { config, user } = getUserConfig(req.userId);
  if (!Array.isArray(req.body) || req.body.length > 100) validation.reject('Invalid groups');
  const groups = req.body.map(group => {
    if (!group || (group.id && !/^[A-Za-z0-9_-]{1,100}$/.test(group.id)) || typeof group.name !== 'string' || group.name.length > 100 || !Array.isArray(group.children)) validation.reject('Invalid group');
    return { id: String(group.id || crypto.randomUUID()), name: group.name, masterId: group.masterId, active: group.active !== false, children: group.children.map(child => ({ childId: child.childId, multiplier: Number(child.multiplier), active: child.active !== false })) };
  });
  const mappings = groups.flatMap(group => group.children.map(child => ({ masterId: group.masterId, childId: child.childId, multiplier: child.multiplier, active: group.active && child.active })));
  const valid = validation.mappings(mappings, user.accounts.map(account => account.id));
  user.groups = groups;
  user.mappings = valid;
  saveConfig(config);
  rebuildGlobalMappings();
  res.json({ success: true, mappings: valid });
});

// Fetch detailed logs scoped to logged-in user's accounts
app.get('/api/logs', (req, res) => {
  lastFrontendActiveTime = Date.now();
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { user } = getUserConfig(userId);
  const userAccIds = user.accounts.map(a => a.id);
  const filteredLogs = copyEngine.getLogs().filter(log => {
    return log.userId === req.userId || userAccIds.includes(log.accountId);
  });
  res.json(filteredLogs.slice(0, 100));
});

// Clear logs
app.post('/api/logs/clear', (req, res) => {
  const { user } = getUserConfig(req.userId);
  copyEngine.clearLogs(user.accounts.map(account => account.id), req.userId);
  res.json({ success: true });
});

// Post logs/errors from frontend for remote diagnostics
app.post('/api/logs', (req, res) => {
  const { message, type, details } = req.body;
  if (typeof message !== 'string' || message.length > 4000 || (type && !['error', 'info', 'warning'].includes(type))) validation.reject('Invalid log entry');
  copyEngine.addLog({
    timestamp: new Date().toISOString(),
    accountId: 'frontend',
    userId: req.userId,
    accountName: 'Browser Client',
    broker: 'System',
    type: type || 'error',
    message: message || 'Uncaught frontend error',
    details: details || null
  });
  console.log('[Frontend Log]', redact(message));
  res.json({ success: true });
});

// Get holdings, positions & funds for dashboard
app.get('/api/portfolio/:id', async (req, res) => {
  lastFrontendActiveTime = Date.now();
  const accountId = req.params.id;
  const service = copyEngine.services[accountId];

  if (!service) {
    return res.status(404).json({ error: 'Account service not found' });
  }

  try {
    const [holdings, positions, funds] = await Promise.all([
      service.getHolding().catch(err => {
        console.error(`[Portfolio] Error fetching holdings for ${accountId}:`, err.message);
        return [];
      }),
      service.getPosition().catch(err => {
        console.error(`[Portfolio] Error fetching positions for ${accountId}:`, err.message);
        return [];
      }),
      service.getFunds().catch(err => {
        console.error(`[Portfolio] Error fetching funds for ${accountId}:`, err.message);
        return { availableCash: 0, utilized: 0, margin: 0 };
      })
    ]);

    res.json({ holdings, positions, funds });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Trigger order placement on Master -> automatically triggers copy, or Child -> direct manual trade
app.post('/api/execute-trade', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { accountId, masterId } = req.body;
  const targetId = accountId || masterId;

  if (!targetId) {
    return res.status(400).json({ success: false, error: 'Account ID or Master ID is required' });
  }

  const { user } = getUserConfig(userId);
  const acc = user.accounts.find(a => a.id === targetId);

  if (!acc) {
    return res.status(404).json({ success: false, error: 'Account not found' });
  }

  try {
    const params = validation.trade(req.body);
    if (req.body.requestId && !/^[a-zA-Z0-9_-]{16,80}$/.test(req.body.requestId)) validation.reject('Invalid request ID');
    await copyEngine.validateOrder(targetId, params);
    const jobId = await orderQueueService.enqueueOrder(userId, targetId, params);

    res.json({
      success: true,
      status: 'QUEUED',
      jobId,
      message: 'Order submitted to execution queue.'
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.post('/api/queue/jobs/:jobId/retry', async (req, res) => {
  if (req.body.confirmed !== true) return res.status(400).json({ error: 'Explicit retry confirmation is required' });
  const result = await orderQueueService.retryJob(req.params.jobId, req.userId);
  res.json(result);
});

// Query execution status of an order job
app.get('/api/execute-trade/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = await orderQueueService.getJobStatus(jobId);
  if (!job || copyEngine.services[job.targetId]?.account.ownerId !== req.userId) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  res.json(job);
});

// Dhan Postback Webhook Endpoint for real-time copy trading executions
app.post('/api/webhooks/dhan', async (req, res) => {
  try {
    await copyEngine.handleDhanWebhook(req.body);
    res.json({ success: true, message: 'Webhook payload processed.' });
  } catch (err) {
    console.error(`[Webhook] Error handling Dhan webhook:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Angel One Postback Webhook Endpoint for real-time copy trading executions
app.post('/api/webhooks/angelone', async (req, res) => {
  try {
    await copyEngine.handleAngelOneWebhook(req.body);
    res.json({ success: true, message: 'Webhook payload processed.' });
  } catch (err) {
    console.error(`[Webhook] Error handling Angel One webhook:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Watchlist Routes ---

function parseDerivative(symbol) {
  const parts = symbol.split('-');
  if (parts.length < 3) return null;
  
  const underlying = parts[0] + '-EQ';
  if (parts[parts.length - 1] === 'FUT') {
    return {
      type: 'FUT',
      underlying,
      expiry: parts[1]
    };
  } else if (parts.length === 4) {
    return {
      type: 'OPT',
      underlying,
      expiry: parts[1],
      strike: parseFloat(parts[2]),
      optionType: parts[3]
    };
  }
  return null;
}

function getAngelOneSymbol(symbol) {
  if (!symbol) return '';
  const parts = symbol.split('-');
  if (parts.length < 3) return symbol;
  
  const underlying = parts[0];
  const expiry = parts[1]; // e.g. "23JUN26"
  const isFut = parts[parts.length - 1] === 'FUT';
  
  if (isFut) {
    return `${underlying}${expiry}FUT`;
  } else if (parts.length === 4) {
    const strike = parseFloat(parts[2]).toString();
    const optType = parts[3]; // CE or PE
    return `${underlying}${expiry}${strike}${optType}`;
  }
  return symbol;
}

// Black-Scholes formula implementation
function cnd(x) {
  const a1 = 0.319381530;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const L = Math.abs(x);
  const K = 1.0 / (1.0 + 0.2316419 * L);
  let w = 1.0 - 1.0 / Math.sqrt(2 * Math.PI) * Math.exp(-L * L / 2) * (a1 * K + a2 * K * K + a3 * Math.pow(K, 3) + a4 * Math.pow(K, 4) + a5 * Math.pow(K, 5));
  if (x < 0) {
    w = 1.0 - w;
  }
  return w;
}

function ndf(x) {
  return (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2);
}

function calculateBlackScholes(optionType, S, K, T, r = 0.07, v = 0.25) {
  if (T <= 0) T = 0.0001; // Avoid division by zero
  
  const d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  
  let price = 0;
  let delta = 0;
  
  if (optionType === 'CE') {
    price = S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2);
    delta = cnd(d1);
  } else {
    price = K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1);
    delta = cnd(d1) - 1;
  }
  
  // Calculate Gamma, Theta, Vega
  const gamma = ndf(d1) / (S * v * Math.sqrt(T));
  
  let theta = 0;
  if (optionType === 'CE') {
    theta = -(S * ndf(d1) * v) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * cnd(d2);
  } else {
    theta = -(S * ndf(d1) * v) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * cnd(-d2);
  }
  const dailyTheta = theta / 365;
  const vega = (S * Math.sqrt(T) * ndf(d1)) / 100; // per 1% volatility change
  
  return {
    price: Math.max(0.05, parseFloat(price.toFixed(2))),
    delta: parseFloat(delta.toFixed(3)),
    gamma: parseFloat(gamma.toFixed(4)),
    theta: parseFloat(dailyTheta.toFixed(3)),
    vega: parseFloat(vega.toFixed(3))
  };
}

function calculateOptionPrice(optionType, underlyingPrice, strike, expiryCode = '25JUN26') {
  const currentDate = new Date();
  let expiryDate = new Date('2026-06-25');
  const monthMap = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
  const match = expiryCode.match(/(\d{1,2})([A-Z]{3})(\d{2})/i);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = monthMap[match[2].toUpperCase()];
    const year = 2000 + parseInt(match[3], 10);
    expiryDate = new Date(year, month, day);
  }
  
  let T = (expiryDate - currentDate) / (1000 * 60 * 60 * 24 * 365);
  if (T <= 0) T = 1 / 365;
  
  const isIndex = underlyingPrice > 5000;
  const iv = isIndex ? 0.13 : 0.26;
  
  const bs = calculateBlackScholes(optionType, underlyingPrice, strike, T, 0.07, iv);
  return bs.price;
}

function calculateFuturePrice(underlyingPrice) {
  return parseFloat((underlyingPrice * 1.0015).toFixed(2));
}

function parseExpiryToDate(symbol, name) {
  const str = (name || '') + ' ' + (symbol || '');
  
  // Match 4-digit year first: e.g. 30JUN2026 or 30Jun2026
  const match4 = str.match(/(\d{1,2})([A-Za-z]{3})(\d{4})/);
  if (match4) {
    const day = parseInt(match4[1]);
    const monthStr = match4[2].toLowerCase();
    const year = parseInt(match4[3]);
    const monthMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const month = monthMap[monthStr] !== undefined ? monthMap[monthStr] : 0;
    return new Date(year, month, day);
  }

  // Match 2-digit year: e.g. 30JUN26 or 30Jun26
  const match2 = str.match(/(\d{1,2})([A-Za-z]{3})(\d{2})/);
  if (match2) {
    const day = parseInt(match2[1]);
    const monthStr = match2[2].toLowerCase();
    const shortYear = parseInt(match2[3]);
    const year = 2000 + shortYear;
    const monthMap = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const month = monthMap[monthStr] !== undefined ? monthMap[monthStr] : 0;
    return new Date(year, month, day);
  }

  return null;
}

function getNearestExpiries(baseSymbol) {
  const db = instrumentService.getDatabase();
  const symbols = db
    .filter(item => item.exchange === 'NFO' && item.symbol.startsWith(baseSymbol))
    .map(item => item.symbol);
    
  if (symbols.length === 0) {
    return ['30JUN26']; // Default fallback
  }
  
  const expirySet = new Set();
  const regex = /\d{2}[A-Z]{3}\d{2}/;
  symbols.forEach(sym => {
    const match = sym.match(regex);
    if (match) {
      expirySet.add(match[0]);
    }
  });
  
  const expiries = Array.from(expirySet);
  if (expiries.length === 0) {
    return ['30JUN26']; // Default fallback
  }
  
  const monthMap = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };
  const parsed = expiries.map(exp => {
    const day = parseInt(exp.substring(0, 2), 10);
    const month = monthMap[exp.substring(2, 5).toUpperCase()];
    const year = 2000 + parseInt(exp.substring(5, 7), 10);
    return {
      code: exp,
      date: new Date(year, month, day)
    };
  });
  
  parsed.sort((a, b) => a.date - b.date);
  return parsed.map(p => p.code);
}

async function fetchSymbolQuoteOnDemand(symbol) { return fetchSymbolsLatestPrices([symbol]); }

async function fetchSymbolsLatestPrices(rawSymbols) {
  if (process.env.OFFLINE_MODE === 'true') return;
  const symbols = [...new Set(rawSymbols.filter(Boolean))].filter(symbol => Date.now() - (lastLiveUpdate[symbol] || 0) > 5000).slice(0, 100);
  if (!symbols.length) return;
  unifiedWsClient.subscribe(symbols);
  const accept = (symbol, quote) => {
    if (!(Number(quote.ltp) > 0)) return;
    const previous = basePrices[symbol];
    updateSymbolOHLC(symbol, Number(quote.ltp), quote.prevClose ?? quote.close, quote.open, quote.high, quote.low, quote.depth);
    isLivePrice[symbol] = true;
    lastLiveUpdate[symbol] = Date.now();
    watchlistChanges[symbol] = previous ? (quote.ltp > previous ? 'up' : quote.ltp < previous ? 'down' : 'flat') : 'flat';
  };
  const credentials = getDhanCredentials();
  if (credentials) {
    try {
      const quotes = await dhanService.fetchPrices(symbols, credentials);
      for (const [symbol, quote] of Object.entries(quotes || {})) accept(symbol, quote);
    } catch (error) { console.warn('[Quotes]', error.message); }
  }
  const missing = symbols.filter(symbol => Date.now() - (lastLiveUpdate[symbol] || 0) > 5000);
  const service = Object.values(copyEngine.services).find(item => item.account.broker === 'angel_one' && !item.account.isSimulated && item.session.connected);
  if (!service || !missing.length) return;
  const groups = {};
  const lookup = {};
  for (const symbol of missing) {
    const stock = symbolToStockMap[symbol];
    if (!stock?.token) continue;
    (groups[stock.exchange] ||= []).push(stock.token);
    lookup[stock.exchange + ':' + stock.token] = symbol;
  }
  if (!Object.keys(groups).length) return;
  try {
    const quotes = await service.getMarketQuotes(groups);
    for (const item of quotes?.fetched || []) {
      const symbol = lookup[item.exchange + ':' + item.symbolToken];
      if (symbol) accept(symbol, item);
    }
  } catch (error) { console.warn('[Quotes]', error.message); }
}

function quoteFor(symbol) {
  const available = Number(basePrices[symbol]) > 0;
  const fresh = available && Date.now() - (lastLiveUpdate[symbol] || 0) <= 60000;
  return {
    ltp: available ? basePrices[symbol] : null,
    prevClose: basePrevCloses[symbol] ?? null, open: baseOpens[symbol] ?? null,
    high: baseHighs[symbol] ?? null, low: baseLows[symbol] ?? null,
    depth: baseDepths[symbol] ?? null, isLive: fresh,
    quoteStatus: fresh ? 'live' : available ? 'stale' : 'unavailable',
    updatedAt: lastLiveUpdate[symbol] || null, change: watchlistChanges[symbol] || 'flat'
  };
}

// Search stocks database for autocomplete suggestions
app.get('/api/stocks/search', async (req, res) => {
  const query = String(req.query.q || '').trim().toUpperCase().replace(/\bM\s*(?:&|AND)\s*M\b/g, 'M&M').slice(0, 100);
  if (query.length < 2) return res.json([]);
  const words = query.split(/\s+/);
  const matches = cachedSearchBases.filter(stock => words.every(word => (stock.symbol + ' ' + stock.name).toUpperCase().includes(word)));
  matches.sort((left, right) => {
    const score = stock => stock.symbol.replace('-EQ', '') === query ? -100 : (stock.expiry ? 10000 : 0) + (POPULARITY_MAP[stock.symbol] || 1000);
    return score(left) - score(right) || String(left.expiry || '').localeCompare(String(right.expiry || '')) || left.symbol.localeCompare(right.symbol);
  });
  const selected = matches.slice(0, 30);
  lastSearchSymbols = selected.map(stock => stock.symbol);
  lastSearchSymbolsTime = Date.now();
  await fetchSymbolsLatestPrices(lastSearchSymbols);
  res.json(selected.map(stock => ({ ...stock, ...quoteFor(stock.symbol), price: quoteFor(stock.symbol).ltp })));
});

app.get('/api/stocks/info', async (req, res) => {
  const symbol = validation.symbol(req.query.symbol);
  const stock = symbolToStockMap[symbol];
  if (!stock || (req.query.exchange && stock.exchange !== req.query.exchange)) return res.status(404).json({ error: 'Active instrument not found on this exchange' });
  lastActiveSymbol = symbol;
  lastActiveSymbolTime = Date.now();
  await fetchSymbolQuoteOnDemand(symbol);
  const quote = quoteFor(symbol);
  res.json({ ...stock, ...quote, price: quote.ltp });
});

app.get('/api/option-chain/expiries', (req, res) => {
  const underlying = validation.symbol(req.query.symbol || 'NIFTY').replace('-EQ', '');
  const contracts = instrumentService.getOptionContracts(underlying);
  const expiries = [...new Map(contracts.map(contract => [contract.expiryCode, { code: contract.expiryCode, date: contract.expiry.slice(0, 10) }])).values()].sort((left, right) => left.date.localeCompare(right.date));
  res.json(expiries);
});

app.get('/api/option-chain', async (req, res) => {
  const underlying = validation.symbol(req.query.symbol || 'NIFTY').replace('-EQ', '');
  const contracts = instrumentService.getOptionContracts(underlying).filter(contract => contract.expiryCode === req.query.expiry);
  if (!contracts.length) return res.status(404).json({ error: 'No active contracts found for this expiry' });
  const spotSymbol = symbolToStockMap[underlying + '-EQ'] ? underlying + '-EQ' : underlying;
  await fetchSymbolQuoteOnDemand(spotSymbol);
  const spot = quoteFor(spotSymbol).ltp;
  let strikes = [...new Set(contracts.map(contract => contract.strike))].sort((left, right) => left - right);
  if (spot) strikes = strikes.sort((left, right) => Math.abs(left - spot) - Math.abs(right - spot)).slice(0, 21).sort((left, right) => left - right);
  else strikes = strikes.slice(0, 21);
  const selected = contracts.filter(contract => strikes.includes(contract.strike));
  await fetchSymbolsLatestPrices(selected.map(contract => contract.symbol));
  const side = contract => {
    if (!contract) return null;
    const quote = quoteFor(contract.symbol);
    return { ...contract, ...quote, changePct: quote.ltp && quote.prevClose ? (quote.ltp - quote.prevClose) / quote.prevClose * 100 : null, volume: null, oi: null, greeks: null };
  };
  res.json({ symbol: underlying, spotPrice: spot, expiry: req.query.expiry, chain: strikes.map(strike => ({
    strike, calls: side(selected.find(contract => contract.strike === strike && contract.optionType === 'CE')),
    puts: side(selected.find(contract => contract.strike === strike && contract.optionType === 'PE'))
  })) });
});

// Stock Candles API Endpoint (Historical Candles)
app.get('/api/stocks/candles', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase().replace('-EQ', '');
  const range = req.query.range || '3mo';
  let interval = '1d';
  if (range === '1d') interval = '2m';
  else if (range === '5d') interval = '15m';
  
  const deriv = parseDerivative(symbol);
  if (deriv || symbolToStockMap[symbol]?.expiry) return res.status(503).json({ error: 'Verified derivative candles are unavailable' });
  const isOption = deriv && deriv.type === 'OPT';
  const isFuture = deriv && deriv.type === 'FUT';
  
  const targetSymbol = deriv ? deriv.underlying.replace('-EQ', '') : symbol;
  
  let yahooSymbol = targetSymbol + '.NS';
  if (targetSymbol === 'NIFTY') yahooSymbol = '%5ENSEI';
  else if (targetSymbol === 'BANKNIFTY') yahooSymbol = '%5ENSEBANK';
  else if (targetSymbol === 'SENSEX') yahooSymbol = '%5EBSESN';
  
  try {
    const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 5000
    });
    
    const result = response.data?.chart?.result?.[0];
    if (!result) {
      throw new Error('No historical chart data found.');
    }
    
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    
    if (timestamps.length === 0) {
      throw new Error('Empty historical data.');
    }
    
    let candles = timestamps.map((t, idx) => {
      let open = quote.open[idx];
      let high = quote.high[idx];
      let low = quote.low[idx];
      let close = quote.close[idx];
      
      if (open === null || high === null || low === null || close === null) {
        return null;
      }
      
      if (deriv) {
        if (isFuture) {
          open = calculateFuturePrice(open);
          high = calculateFuturePrice(high);
          low = calculateFuturePrice(low);
          close = calculateFuturePrice(close);
        } else if (isOption) {
          // Calculate dynamic T based on timestamp date vs mock expiry date 25-JUN-2026
          const expiryDate = new Date('2026-06-25');
          const currentDate = new Date(t * 1000);
          let diffDays = (expiryDate - currentDate) / (1000 * 60 * 60 * 24);
          if (diffDays <= 0) diffDays = 0.5;
          const T = diffDays / 365;
          const isInd = targetSymbol === 'NIFTY' || targetSymbol === 'BANKNIFTY';
          const iv = isInd ? 0.13 : 0.26;
          
          open = calculateBlackScholes(deriv.optionType, open, deriv.strike, T, 0.07, iv).price;
          high = calculateBlackScholes(deriv.optionType, high, deriv.strike, T, 0.07, iv).price;
          low = calculateBlackScholes(deriv.optionType, low, deriv.strike, T, 0.07, iv).price;
          close = calculateBlackScholes(deriv.optionType, close, deriv.strike, T, 0.07, iv).price;
        }
      }
      
      return {
        time: t,
        open: parseFloat(open.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)),
        close: parseFloat(close.toFixed(2))
      };
    }).filter(c => c !== null);
    
    res.json({
      symbol,
      candles
    });
  } catch (error) {
    console.error(`Error fetching candles for ${symbol}:`, error.message);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Get current watchlist symbols
app.get('/api/watchlist', (req, res) => {
  const tab = String(req.query.tab || '1');
  if (!['1', '2'].includes(tab)) return res.status(400).json({ error: 'Invalid watchlist tab' });
  res.json(userWatchlists(req.userId)[tab]);
});

app.post('/api/watchlist', (req, res) => {
  const symbol = validation.symbol(req.body.symbol);
  const tab = String(req.body.tab || '1');
  if (!['1', '2'].includes(tab)) return res.status(400).json({ error: 'Invalid watchlist tab' });
  if (!symbolToStockMap[symbol]) return res.status(400).json({ error: 'Unknown active instrument' });
  const list = userWatchlists(req.userId)[tab];
  if (!list.includes(symbol)) {
    if (list.length >= 20) return res.status(400).json({ error: 'Watchlist limit is 20 symbols' });
    const next = structuredClone(watchlists);
    next[req.userId][tab].push(symbol);
    storage.writeJson('watchlists.json', next);
    watchlists[req.userId] = next[req.userId];
    fetchSymbolQuoteOnDemand(symbol).catch(error => console.warn('[Quote]', error.message));
  }
  res.json({ success: true, watchlist: watchlists[req.userId][tab] });
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const tab = String(req.query.tab || '1');
  if (!['1', '2'].includes(tab)) return res.status(400).json({ error: 'Invalid watchlist tab' });
  const next = structuredClone(watchlists);
  next[req.userId] = { ...userWatchlists(req.userId), [tab]: userWatchlists(req.userId)[tab].filter(symbol => symbol !== req.params.symbol) };
  storage.writeJson('watchlists.json', next);
  watchlists[req.userId] = next[req.userId];
  res.json({ success: true, watchlist: next[req.userId][tab] });
});

const NSE_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25'  // Christmas
];

// Helper to check if Indian Stock Markets (NSE/BSE) are open (Mon-Fri, 9:15 AM - 3:30 PM IST)
function isMarketOpen() {
  return isExchangeMarketOpen('NSE');
}

function getSymbolExchange(symbol) { return symbolToStockMap[symbol]?.exchange || INDEX_TOKENS[symbol]?.exchange || 'NSE'; }

function isExchangeMarketOpen(exchange) {
  const now = new Date();
  
  // Convert current time to India Standard Time (IST, UTC+5:30)
  const istDateStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istDateStr);
  
  const day = istDate.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  
  // Weekend check
  if (day === 0 || day === 6) {
    return false;
  }

  // Holiday check
  const year = istDate.getFullYear();
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const date = String(istDate.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${date}`;
  
  if (NSE_HOLIDAYS_2026.includes(dateStr)) {
    if (exchange !== 'MCX') {
      return false;
    }
  }
  
  const minutesOfDay = hours * 60 + minutes;
  
  if (exchange === 'MCX') {
    // MCX: 9:00 AM to 11:30 PM (540 to 1410 minutes)
    return minutesOfDay >= 9 * 60 && minutesOfDay <= 23 * 60 + 30;
  } else {
    // NSE/BSE/NFO: 9:15 AM to 3:30 PM (555 to 930 minutes) - Regular market session
    return minutesOfDay >= 9 * 60 + 15 && minutesOfDay <= 15 * 60 + 30;
  }
}

function isExchangeMarketOpenOrPreMarket(exchange) {
  const now = new Date();
  
  // Convert current time to India Standard Time (IST, UTC+5:30)
  const istDateStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istDateStr);
  
  const day = istDate.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  
  // Weekend check
  if (day === 0 || day === 6) {
    return false;
  }

  // Holiday check
  const year = istDate.getFullYear();
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const date = String(istDate.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${date}`;
  
  if (NSE_HOLIDAYS_2026.includes(dateStr)) {
    if (exchange !== 'MCX') {
      return false;
    }
  }
  
  const minutesOfDay = hours * 60 + minutes;
  
  if (exchange === 'MCX') {
    // MCX: 9:00 AM to 11:30 PM (540 to 1410 minutes)
    return minutesOfDay >= 9 * 60 && minutesOfDay <= 23 * 60 + 30;
  } else {
    // NSE/BSE/NFO: 9:00 AM to 3:30 PM (540 to 930 minutes) - Includes pre-market session
    return minutesOfDay >= 9 * 60 && minutesOfDay <= 15 * 60 + 30;
  }
}

// Helper to extract Dhan credentials from config or users' accounts
function getDhanCredentials() {
  const service = Object.values(copyEngine.services).find(item => item.account.broker === 'dhan' && !item.account.isSimulated && item.session.connected && item.session.accessToken);
  return service ? { clientId: service.account.clientCode, accessToken: service.session.accessToken } : null;
}

const watchlistChanges = {};
let isFetchingWatchlistPrices = false;
function getPortfolioSymbols(userId) {
  return Object.values(copyEngine.services).filter(service => !userId || service.account.ownerId === userId).flatMap(service => {
    const holdings = service.cache?.holding?.data || [];
    const positions = service.cache?.position?.data || [];
    return [...holdings, ...positions].map(item => item.tradingsymbol || item.scripname || item.symbol).filter(Boolean);
  });
}
async function updateCachedIndices() {
  if (Date.now() - lastFrontendActiveTime > 60000) return;
  await fetchSymbolsLatestPrices(Object.keys(INDEX_TOKENS));
  broadcastWatchlistTick();
}
async function updateCachedWatchlist() {
  if (isFetchingWatchlistPrices || Date.now() - lastFrontendActiveTime > 60000) return;
  isFetchingWatchlistPrices = true;
  try {
    const active = Date.now() - lastActiveSymbolTime < 15000 ? lastActiveSymbol : null;
    const search = Date.now() - lastSearchSymbolsTime < 30000 ? lastSearchSymbols : [];
    await fetchSymbolsLatestPrices([...allWatchlistSymbols(), ...getPortfolioSymbols(), active, ...search]);
  } finally { isFetchingWatchlistPrices = false; broadcastWatchlistTick(); }
}

// Start background task immediately and run loops at different intervals
if (require.main === module && process.env.OFFLINE_MODE !== 'true') setTimeout(() => {
  updateCachedIndices();
  updateCachedWatchlist();
}, 2000);

if (require.main === module && process.env.OFFLINE_MODE !== 'true') setInterval(updateCachedIndices, 5000); // Poll indices every 5s
if (require.main === module && process.env.OFFLINE_MODE !== 'true') setInterval(updateCachedWatchlist, 1500); // Poll live SmartAPI every 1500ms (avoid exceeding rate limit)

// Get dynamic prices for the watchlist (instantaneous memory-based ticking with 0.05 tick size, MCX ticks by 1.00 rupee)
function getWatchlistPrices(activeSymbol, userId) {
  const lists = userId ? userWatchlists(userId) : { '1': [], '2': [] };
  const symbols = [...new Set([...lists['1'], ...lists['2'], ...(userId ? getPortfolioSymbols(userId) : []), activeSymbol, ...Object.keys(INDEX_TOKENS)].filter(Boolean))];
  return { prices: Object.fromEntries(symbols.map(symbol => [symbol, quoteFor(symbol)])), marketOpen: isMarketOpen(), marketStatusSource: 'schedule-estimate' };
}

const sseClients = [];
const wsClients = [];
const wss = new WebSocket.Server({ noServer: true, maxPayload: 4096 });

wss.on('connection', (ws, request) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const activeSymbol = url.searchParams.get('active') || lastActiveSymbol || '';
    
    const clientObj = { ws, activeSymbol, userId: authService.authenticate(request).userId, request };
    wsClients.push(clientObj);
    lastFrontendActiveTime = Date.now();

    // Send initial watchlist details
    const initialData = getWatchlistPrices(activeSymbol, clientObj.userId);
    ws.send(JSON.stringify(initialData));

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'subscribe') {
          clientObj.activeSymbol = typeof parsed.activeSymbol === 'string' ? validation.symbol(parsed.activeSymbol) : '';
          if (parsed.activeSymbol) {
            lastActiveSymbol = parsed.activeSymbol;
            lastActiveSymbolTime = Date.now();
          }
          // Send immediately
          const data = getWatchlistPrices(clientObj.activeSymbol, clientObj.userId);
          ws.send(JSON.stringify(data));
        }
      } catch (err) {
        console.error('[WS Message Error]', err.message);
      }
    });

    ws.on('close', () => {
      const idx = wsClients.indexOf(clientObj);
      if (idx !== -1) {
        wsClients.splice(idx, 1);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS Client Error]', err.message);
      const idx = wsClients.indexOf(clientObj);
      if (idx !== -1) {
        wsClients.splice(idx, 1);
      }
    });
  } catch (err) {
    console.error('[WS Connection Handler Error]', err.message);
  }
});

function broadcastWatchlistTick() {
  if (sseClients.length === 0 && wsClients.length === 0) return;
  lastFrontendActiveTime = Date.now();

  // Broadcast to SSE clients
  if (sseClients.length > 0) {
    sseClients.forEach(client => {
      try {
        if (!authService.authenticate(client.request)) { client.res.end(); return; }
        const data = getWatchlistPrices(client.activeSymbol || '', client.userId);
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        console.error('[SSE Broadcast Error]', e.message);
      }
    });
  }

  // Broadcast to WebSocket clients
  if (wsClients.length > 0) {
    wsClients.forEach(client => {
      try {
        if (!authService.authenticate(client.request)) { client.ws.close(1008, 'Session expired'); return; }
      if (client.ws.readyState === WebSocket.OPEN) {
          const data = getWatchlistPrices(client.activeSymbol || '', client.userId);
          client.ws.send(JSON.stringify(data));
        }
      } catch (e) {
        console.error('[WS Broadcast Error]', e.message);
      }
    });
  }
}

// Register search symbols currently viewed in frontend
app.get('/api/watchlist/active-search', (req, res) => {
  const symbolsStr = req.query.symbols || '';
  lastSearchSymbols = symbolsStr.split(',').filter(Boolean);
  lastSearchSymbolsTime = Date.now();
  res.json({ success: true });
});

// Server-Sent Events stream for watchlist prices
app.get('/api/watchlist/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const activeSymbol = req.query.active || lastActiveSymbol || '';
  const initialData = getWatchlistPrices(activeSymbol, req.userId);
  res.write(`data: ${JSON.stringify(initialData)}\n\n`);

  const clientObj = { res, activeSymbol, userId: req.userId, request: req };
  sseClients.push(clientObj);
  lastFrontendActiveTime = Date.now();

  req.on('close', () => {
    const idx = sseClients.indexOf(clientObj);
    if (idx !== -1) {
      sseClients.splice(idx, 1);
    }
  });
});

app.get('/api/watchlist/prices', async (req, res) => {
  lastFrontendActiveTime = Date.now();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const activeSymbol = req.query.active;
  if (activeSymbol) {
    lastActiveSymbol = activeSymbol;
    lastActiveSymbolTime = Date.now();
  }
  const result = getWatchlistPrices(activeSymbol, req.userId);
  res.json(result);
});

// --- Order Management Routes ---

// Get orders divided into pending and executed for an account
app.get('/api/orders/:id', async (req, res) => {
  const service = copyEngine.services[req.params.id];
  const rawOrders = await service.getOrderBook();
  const pending = [], executed = [];
  for (const order of rawOrders) {
    const status = String(order.orderstatus || order.status || '').toLowerCase();
    const item = { ...order, status, quantity: Number(order.quantity), price: Number(order.averageprice) > 0 ? Number(order.averageprice) : Number(order.price), filledshares: Number(order.filledshares || 0) };
    const isPending = ['pending', 'open', 'sent', 'confirm', 'partial', 'part_traded', 'partially_traded', 'partially executed', 'transit'].includes(status) || status.includes('pending');
    (isPending ? pending : executed).push(item);
  }
  res.json({ pending, executed });
});

// Cancel a pending order
app.post('/api/orders/cancel', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'usr_default';
  const { accountId, orderId } = req.body;
  const service = copyEngine.services[accountId];

  if (!service) {
    return res.status(404).json({ error: 'Account service not found' });
  }

  try {
    const result = await service.cancelOrder(orderId);
    

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Modify a pending order
app.post('/api/orders/modify', async (req, res) => {
  const { accountId, orderid, quantity, price, ordertype, symboltoken, exchange, producttype } = req.body;
  const service = copyEngine.services[accountId];

  if (!service) {
    return res.status(404).json({ error: 'Account service not found' });
  }

  try {
    validation.positiveInteger(quantity);
    if (!Number.isFinite(Number(price)) || Number(price) < 0 || (ordertype === 'LIMIT' && Number(price) <= 0)) validation.reject('Invalid price');
    const original = (await service.getOrderBook(true)).find(order => String(order.orderid) === String(orderid));
    if (!original) validation.reject('Order not found');
    await copyEngine.validateOrder(accountId, validation.trade({ ...original, quantity, price, ordertype: ordertype || original.ordertype }));
    const result = await service.modifyOrder({ ...original, orderid, quantity, price, ordertype: ordertype || original.ordertype });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Get all queue jobs
app.get('/api/queue/jobs', async (req, res) => {
  res.json(await orderQueueService.listJobs(req.userId));
});

// Get detected public IP
app.get('/api/public-ip', (req, res) => {
  res.json({ ip: ipService.getPublicIp() });
});

app.use((error, req, res, next) => {
  console.error('[API]', redact(error.message));
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ success: false, error: error.status && error.status < 500 ? error.message : 'Request failed; check server diagnostics' });
});

// Start Server
const server = require.main === module ? app.listen(PORT, async () => {
  console.log(`===================================================`);
  console.log(`  Copy Trading Application Backend is running!`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`===================================================`);
  
  if (process.env.OFFLINE_MODE === 'true') { copyEngine.start(); await orderQueueService.start(); return; }
  // Start SSH Tunnel for proxy routing (only if running locally on Windows)
  if (process.platform === 'win32' && process.env.ENABLE_SSH_TUNNEL === 'true') {
    try {
      const tunnelService = require('./services/tunnelService');
      await tunnelService.startTunnel();
    } catch (tunnelError) {
      console.error('[System] Error starting SSH tunnel:', tunnelError.message);
    }
    try {
      const esbuild = require('esbuild');
      console.log('[Dev Build] Minifying local assets...');
      esbuild.buildSync({
        entryPoints: [path.join(__dirname, '..', 'frontend', 'app_v6.js')],
        outfile: path.join(__dirname, '..', 'frontend', 'app_v6.min.js'),
        minify: true,
      });
      esbuild.buildSync({
        entryPoints: [path.join(__dirname, '..', 'frontend', 'style.css')],
        outfile: path.join(__dirname, '..', 'frontend', 'style.min.css'),
        minify: true,
      });
      console.log('[Dev Build] Local assets minified successfully.');
    } catch (e) {
      console.warn('[Dev Build] Could not minify local assets:', e.message);
    }
  } else {
    console.log('[System] Running on VPS (Linux), skipping SSH tunnel and local minification.');
  }

  // Detect public IP
  await ipService.detectPublicIp();

  
  // Download and index Angel One NSE equities list dynamically
  console.log('Initializing instruments database from Angel One...');
  await instrumentService.initializeInstruments();
  populateBasePrices();
  console.log('Instruments database and baseline prices initialized.');

  // Initialize Dhan instruments list dynamically
  console.log('Initializing instruments database from Dhan...');
  await dhanService.initializeDhanService();
  console.log('Dhan instruments database initialized.');


  unifiedWsClient.init({ engine: copyEngine, INDEX_TOKENS, symbolToStockMap, updateSymbolOHLC, isLivePrice, lastLiveUpdate, broadcastWatchlistTick });
  copyEngine.start();
  await orderQueueService.start();
  setInterval(async () => {
    try { await instrumentService.initializeInstruments(); await dhanService.initializeDhanService(); populateBasePrices(); } catch (error) { console.error('[Instruments]', error.message); }
  }, 3600000).unref();

  // Auto-connect live accounts
  console.log('Attempting to auto-connect live accounts...');
  for (const id in copyEngine.services) {
    const service = copyEngine.services[id];
    if (service && !service.account.isSimulated) {
      service.login().then(success => {
        if (success) {
          console.log(`Successfully auto-connected live account: ${service.account.name}`);
          service.getHolding().catch(err => console.error(`Failed to warm up holdings cache for ${service.account.name}:`, err.message));
          service.getPosition().catch(err => console.error(`Failed to warm up positions cache for ${service.account.name}:`, err.message));
        } else {
          console.error(`Failed to auto-connect live account: ${service.account.name}`);
        }
      }).catch(err => {
        console.error(`Error auto-connecting live account ${service.account.name}:`, err.message);
      });
    }
  }

  // Start background reconnect poller for live accounts (runs every 3 minutes)
  setInterval(async () => {
    console.log('[System] Running background reconnect poller for live accounts...');
    for (const id in copyEngine.services) {
      const service = copyEngine.services[id];
      if (service && !service.account.isSimulated && !service.session.connected) {
        console.log(`[System] Live account ${service.account.name || id} is offline. Auto-connecting...`);
        try {
          const success = await service.login();
          if (success) {
            console.log(`[System] Successfully auto-reconnected live account: ${service.account.name}`);
            service.getHolding().catch(err => console.error(`[System] Failed to warm up holdings cache:`, err.message));
            service.getPosition().catch(err => console.error(`[System] Failed to warm up positions cache:`, err.message));
          } else {
            console.error(`[System] Auto-reconnect failed for live account: ${service.account.name}`);
          }
        } catch (err) {
          console.error(`[System] Error auto-reconnecting live account ${service.account.name || id}:`, err.message);
        }
      }
    }
  }, 180000);

  // Pre-market daily auto-login scheduler (runs every 60 seconds, logs in at 8:30 AM IST on weekdays)
  setInterval(async () => {
    const now = new Date();
    const istDateStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istDateStr);
    
    const hours = istDate.getHours();
    const minutes = istDate.getMinutes();
    const day = istDate.getDay(); // 0 = Sunday, 6 = Saturday

    const dateKey = `${istDate.getFullYear()}-${istDate.getMonth() + 1}-${istDate.getDate()}`;

    if (day >= 1 && day <= 5 && hours === 8 && minutes === 15 && global.lastAutoLoginDate !== dateKey) {
      global.lastAutoLoginDate = dateKey;
      console.log('[Scheduler] Triggering pre-market daily auto-login for all active real accounts at 8:15 AM IST...');
      
      for (const id in copyEngine.services) {
        const service = copyEngine.services[id];
        if (service && !service.account.isSimulated) {
          console.log(`[Scheduler] Auto-logging in account ${service.account.name || id}...`);
          service.login().then(success => {
            console.log(`[Scheduler] Account ${service.account.name || id} login: ${success ? 'SUCCESS' : 'FAILED'}`);
          }).catch(err => {
            console.error(`[Scheduler] Account ${service.account.name || id} login error:`, err.message);
          });
        }
      }
    }
  }, 60000);
}) : null;

server?.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (pathname === '/api/watchlist/stream' && authService.authenticate(request) && authService.sameOrigin(request)) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (err) {
    console.error('[WS Upgrade Error]', err.message);
    socket.destroy();
  }
});

module.exports = { app, server };
