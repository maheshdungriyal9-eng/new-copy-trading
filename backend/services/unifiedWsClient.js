const WebSocket = require('ws');
const exchangeTypes = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 13 };

class UnifiedBrokerWsClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.activeCredentials = null;
    this.symbols = new Set();
    this.tokens = new Map();
    this.reconnectTimer = null;
  }
  init(context) {
    Object.assign(this, context);
    this.monitor = setInterval(() => this.monitorCredentials(), 10000);
    this.monitor.unref?.();
    this.monitorCredentials();
  }
  resolveSymbol(symbol) {
    const stock = this.INDEX_TOKENS?.[symbol] || this.symbolToStockMap?.[symbol];
    if (!stock?.token || !exchangeTypes[stock.exchange]) return null;
    return { token: String(stock.token), exchangeType: exchangeTypes[stock.exchange] };
  }
  monitorCredentials() {
    const service = Object.values(this.engine.services).find(entry => entry.account.broker === 'angel_one' && !entry.account.isSimulated && entry.session.connected);
    if (!service) { this.close(); return; }
    const credentials = { clientCode: service.account.clientCode, jwtToken: service.session.jwtToken, apiKey: service.account.apiKey, feedToken: service.session.feedToken };
    if (JSON.stringify(credentials) !== JSON.stringify(this.activeCredentials)) {
      this.close();
      this.activeCredentials = credentials;
      this.connect();
    } else if (!this.ws && !this.reconnectTimer) this.connect();
  }
  connect() {
    if (!this.activeCredentials || this.ws) return;
    const credentials = this.activeCredentials;
    const socket = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', { headers: {
      Authorization: credentials.jwtToken, 'x-api-key': credentials.apiKey,
      'x-client-code': credentials.clientCode, 'x-feed-token': credentials.feedToken
    }, handshakeTimeout: 10000 });
    this.ws = socket;
    socket.on('open', () => {
      if (socket !== this.ws) return;
      this.connected = true;
      this.subscribe([...this.symbols], true);
      this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 10000);
      this.heartbeat.unref?.();
    });
    socket.on('message', (message, binary) => { if (binary) this.handleTick(message); });
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (socket !== this.ws) return;
      clearInterval(this.heartbeat);
      this.ws = null;
      this.connected = false;
      if (!this.activeCredentials) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 15000);
      this.reconnectTimer.unref?.();
    });
  }
  subscribe(symbols, force = false) {
    const groups = new Map();
    for (const symbol of symbols) {
      const existed = this.symbols.has(symbol);
      this.symbols.add(symbol);
      const info = this.resolveSymbol(symbol);
      if (!info) continue;
      this.tokens.set(info.exchangeType + ':' + info.token, symbol);
      if (existed && !force) continue;
      groups.set(info.exchangeType, [...(groups.get(info.exchangeType) || []), info.token]);
    }
    if (!this.connected) return;
    for (const [exchangeType, tokens] of groups) {
      for (let offset = 0; offset < tokens.length; offset += 50) this.ws.send(JSON.stringify({
        correlationID: 'watchlist', action: 1, params: { mode: 2, tokenList: [{ exchangeType, tokens: tokens.slice(offset, offset + 50) }] }
      }));
    }
  }
  handleTick(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 123 || buffer[0] !== 2) return;
    const exchangeType = buffer[1];
    const token = buffer.subarray(2, 27).toString('utf8').replace(/\0/g, '').trim();
    const symbol = this.tokens.get(exchangeType + ':' + token);
    if (!symbol) return;
    const divisor = exchangeType === 13 ? 10000000 : 100;
    const read = offset => Number(buffer.readBigInt64LE(offset)) / divisor;
    const price = read(43);
    if (!(price > 0)) return;
    this.updateSymbolOHLC(symbol, price, read(115), read(91), read(99), read(107));
    this.isLivePrice[symbol] = true;
    this.lastLiveUpdate[symbol] = Date.now();
    this.broadcastWatchlistTick();
  }
  close() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.activeCredentials = null;
    socket?.close();
  }
}
module.exports = new UnifiedBrokerWsClient();
module.exports.UnifiedBrokerWsClient = UnifiedBrokerWsClient;
