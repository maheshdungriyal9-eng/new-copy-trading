const storage = require('./storageService');
const cryptoService = require('./cryptoService');

const sensitiveFields = ['password', 'totpSecret', 'apiKey', 'apiSecret', 'twoFactor', 'accessToken'];
const initial = { users: [{ id: 'usr_default', name: 'Administrator', accounts: [], mappings: [], groups: [] }] };

function loadConfig() {
  const config = storage.readJson('config.json', initial);
  if (!config || !Array.isArray(config.users)) throw new Error('Invalid config.json: expected users array');
  const ids = new Set();
  for (const user of config.users) {
    if (!user || typeof user.id !== 'string' || !Array.isArray(user.accounts) || !Array.isArray(user.mappings || [])) throw new Error('Invalid user configuration');
    user.mappings ||= [];
    for (const account of user.accounts) {
      if (!account || typeof account.id !== 'string' || ids.has(account.id)) throw new Error('Account IDs must be globally unique');
      ids.add(account.id);
      for (const field of sensitiveFields) if (account[field]) account[field] = cryptoService.decrypt(account[field]);
    }
  }
  return config;
}

function saveConfig(config) {
  const encrypted = structuredClone(config);
  for (const user of encrypted.users) {
    for (const account of user.accounts) {
      for (const field of sensitiveFields) if (account[field]) account[field] = cryptoService.encrypt(account[field]);
    }
  }
  storage.writeJson('config.json', encrypted);
}

function updateAccount(accountId, update) {
  const config = loadConfig();
  const account = config.users.flatMap(user => user.accounts).find(entry => entry.id === accountId);
  if (!account) throw new Error('Account no longer exists');
  update(account);
  saveConfig(config);
}

function publicAccount(account) {
  const result = { ...account, credentialFields: sensitiveFields.filter(field => Boolean(account[field])) };
  for (const field of sensitiveFields) delete result[field];
  delete result.simState;
  delete result.proxyUrl;
  return result;
}

module.exports = { loadConfig, saveConfig, updateAccount, publicAccount, sensitiveFields };
