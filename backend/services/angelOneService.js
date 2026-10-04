const axios = require('axios');
const totpHelper = require('./totp');
const ipService = require('./ipService');
const { HttpsProxyAgent } = require('https-proxy-agent');
const instrumentService = require('./instrumentService');
const simManager = require('./simulatedPortfolioManager');

const sharedSessions = {}; // Cache sessions by clientCode to prevent duplicate login rate limits

class AngelOneService {
  constructor(account, logCallback) {
    this.account = account; // { id, name, type: 'master'|'child', broker: 'angel_one', clientCode, password, totpSecret, apiKey, isSimulated }
    this.logCallback = logCallback || (() => {});
    this.session = {
      jwtToken: null,
      refreshToken: null,
      feedToken: null,
      connected: false
    };
    this.lastLoginTime = 0; // Track last login time to prevent rate limit lockout loops
    
    // Cache portfolio data for 5 seconds to prevent rate-limiting under fast polling
    this.cache = {
      holding: { data: [], timestamp: 0 },
      position: { data: [], timestamp: 0 },
      funds: { data: { availableCash: 0, utilized: 0, margin: 0 }, timestamp: 0 },
      orderBook: { data: [], timestamp: 0 }
    };

    this.simulatedOrders = [
      {
        orderid: '260614000001',
        tradingsymbol: 'SBIN-EQ',
        symboltoken: '3045',
        transactiontype: 'BUY',
        exchange: 'NSE',
        ordertype: 'LIMIT',
        producttype: 'DELIVERY',
        quantity: '5',
        price: '580.00',
        status: 'cancelled',
        orderstatus: 'cancelled',
        updatetime: new Date(Date.now() - 3600000).toLocaleString(),
        averageprice: '0.00',
        filledshares: '0',
        unfilledshares: '5'
      },
      {
        orderid: '260614000002',
        tradingsymbol: 'TCS-EQ',
        symboltoken: '11536',
        transactiontype: 'BUY',
        exchange: 'NSE',
        ordertype: 'MARKET',
        producttype: 'INTRADAY',
        quantity: '10',
        price: '3650.00',
        status: 'executed',
        orderstatus: 'executed',
        updatetime: new Date(Date.now() - 1800000).toLocaleString(),
        averageprice: '3650.00',
        filledshares: '10',
        unfilledshares: '0'
      }
    ];
  }

  clearCache() {
    if (this.cache) {
      this.cache.holding.timestamp = 0;
      this.cache.position.timestamp = 0;
      this.cache.funds.timestamp = 0;
      this.cache.orderBook.timestamp = 0;
    }
  }

  log(message, type = 'info', details = null) {
    this.logCallback({
      timestamp: new Date().toISOString(),
      accountId: this.account.id,
      accountName: this.account.name,
      broker: 'Angel One',
      type,
      message,
      details
    });
  }

  async login() {
    if (this.account.isSimulated) {
      this.log('Connecting to Angel One (SIMULATED MODE)...', 'info');
      this.session = {
        jwtToken: 'simulated_jwt_token_' + Math.random().toString(36).substring(2, 10),
        refreshToken: 'simulated_refresh_token',
        feedToken: 'simulated_feed_token',
        connected: true
      };
      this.log('Logged in successfully (SIMULATED MODE)', 'success', this.session);
      return true;
    }

    // Shared session check: if another instance already authenticated successfully, reuse it
    const clientCode = this.account.clientCode;
    if (clientCode && sharedSessions[clientCode] && sharedSessions[clientCode].connected) {
      this.session = sharedSessions[clientCode];
      this.log(`Re-using active shared session for client ${clientCode}`, 'info');
      return true;
    }

    // Rate limit check: wait at least 15s between login attempts per clientCode globally
    const now = Date.now();
    const lastLoginKey = clientCode || this.account.id;
    if (!global.lastLoginTimes) global.lastLoginTimes = {};
    const lastLoginTime = global.lastLoginTimes[lastLoginKey] || 0;
    if (now - lastLoginTime < 15000) {
      this.log(`Rate limit protection: Skipping login attempt. Last attempt was ${((now - lastLoginTime) / 1000).toFixed(1)}s ago.`, 'warning');
      return false;
    }
    global.lastLoginTimes[lastLoginKey] = now;

    try {
      this.log(`Authenticating client ${clientCode} with Angel One...`, 'info');
      
      const totpCode = totpHelper.generateTOTP(this.account.totpSecret);
      this.log('TOTP generated', 'info');

      const data = {
        clientcode: this.account.clientCode,
        password: this.account.password,
        totp: totpCode
      };

      const clientIp = this.getClientIp();
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '192.168.1.100',
        'X-ClientPublicIP': clientIp,
        'X-MACAddress': '00-50-56-C0-00-08',
        'X-PrivateKey': this.account.apiKey
      };

      this.log('Sending POST to /rest/auth/angelbroking/user/v1/loginByPassword', 'api-request', { data, headers });

      const response = await axios.post('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', data, this.getConfig(headers));

      if (response.data && response.data.status === true) {
        const resData = response.data.data;
        this.session = {
          jwtToken: resData.jwtToken,
          refreshToken: resData.refreshToken,
          feedToken: resData.feedToken,
          connected: true
        };
        if (clientCode) {
          sharedSessions[clientCode] = this.session;
        }
        this.log('Authentication successful!', 'success', response.data);
        return true;
      } else {
        throw new Error(response.data.message || 'Login failed');
      }
    } catch (error) {
      this.session.connected = false;
      if (clientCode && sharedSessions[clientCode]) {
        sharedSessions[clientCode].connected = false;
      }
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Authentication failed: ${errorMsg}`, 'error');
      return false;
    }
  }

  async getHeaders() {
    const clientIp = this.getClientIp();
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '192.168.1.100',
      'X-ClientPublicIP': clientIp,
      'X-MACAddress': '00-50-56-C0-00-08',
      'X-PrivateKey': this.account.apiKey,
      'Authorization': `Bearer ${this.session.jwtToken}`
    };
  }

  getClientIp() {
    let clientIp = ipService.getPublicIp();
    if (this.account.proxyUrl === 'vps') {
      clientIp = '34.93.162.96';
    } else if (this.account.proxyUrl) {
      try {
        const parsedUrl = new URL(this.account.proxyUrl);
        clientIp = parsedUrl.hostname;
      } catch (e) {
        console.error('Failed to parse proxy URL for IP header:', e.message);
      }
    }
    return clientIp;
  }

  getConfig(headers) {
    const config = { headers, timeout: 7000 };
    if (this.account.proxyUrl === 'vps') {
      if (process.platform === 'win32') {
        // Run locally, route through the local SSH tunnel to VPS Squid proxy
        config.httpsAgent = new HttpsProxyAgent('http://127.0.0.1:3128');
      } else {
        // Run on VPS, connect directly (no proxy agent needed)
      }
    } else if (this.account.proxyUrl) {
      config.httpsAgent = new HttpsProxyAgent(this.account.proxyUrl);
    }
    return config;
  }

  async placeOrder(params) {
    // params: { tradingsymbol, symboltoken, exchange, transactiontype, quantity, price, ordertype, producttype }
    const exchangeStr = params.exchange || 'NSE';
    let productTypeStr = require('./copyTradingEngine').mapProductType(params.producttype, 'angel_one', exchangeStr);

    // For F&O / MCX derivatives, Angel One doesn't support 'DELIVERY' (CNC). Positional orders must map to 'CARRYFORWARD' (NRML).
    const isFoExchange = exchangeStr === 'NFO' || exchangeStr === 'NSEFO' || exchangeStr === 'MCX' || exchangeStr === 'CDS' || exchangeStr.includes('FO');
    if (isFoExchange && (productTypeStr === 'DELIVERY' || productTypeStr === 'CNC')) {
      productTypeStr = 'CARRYFORWARD';
    }

    if (this.account.isSimulated) {
      return simManager.placeOrder(this.account, params);
    }

    try {
      if (!this.session.connected) {
        await this.login();
      }

      this.log(`Placing order for ${params.tradingsymbol} (Qty: ${params.quantity})...`, 'info');

      let resolvedSymbol = (params.tradingsymbol || '').trim().toUpperCase().replace(/\s+/g, '');
      let resolvedToken = params.symboltoken;

      // Retrieve fallback F&O parameters from Dhan CSV master if missing
      let dhanDetails = null;
      try {
        const dhanService = require('./dhanService');
        dhanDetails = dhanService.getDhanSymbolDetails(params.tradingsymbol, exchangeStr);
      } catch (e) {}

      if (dhanDetails) {
        if (!params.expiry) params.expiry = dhanDetails.expiryDate;
        if (!params.strike) params.strike = dhanDetails.strike;
        if (!params.optiontype) params.optiontype = dhanDetails.optionType;
      }

      if (exchangeStr === 'NFO' && params.expiry && resolvedSymbol && resolvedSymbol.includes('-')) {
        try {
          const partsSym = resolvedSymbol.split('-');
          let underlying = partsSym[0];
          const isOption = params.optiontype === 'CALL' || params.optiontype === 'PUT' ||
                           params.optiontype === 'CE' || params.optiontype === 'PE' ||
                           resolvedSymbol.endsWith('-CE') || resolvedSymbol.endsWith('-PE');
          if (isOption) {
            if (partsSym.length >= 4) {
              underlying = partsSym.slice(0, -3).join('-');
            }
          } else {
            if (partsSym.length >= 3) {
              underlying = partsSym.slice(0, -2).join('-');
            }
          }

          const parts = params.expiry.split('-');
          if (parts.length === 3) {
            const year = parts[0].substring(2);
            const monthInt = parseInt(parts[1]);
            const day = parts[2].substring(0, 2).padStart(2, '0');
            const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthName = months[monthInt - 1];
            
            if (monthName) {
              const aoExpiry = `${day}${monthName}${year}`;
              if (isOption) {
                const optType = (params.optiontype === 'CALL' || params.optiontype === 'CE' || resolvedSymbol.endsWith('-CE')) ? 'CE' : 'PE';
                const strikePrice = Math.round(parseFloat(params.strike || 0)).toString();
                resolvedSymbol = `${underlying}${aoExpiry}${strikePrice}${optType}`;
              } else {
                resolvedSymbol = `${underlying}${aoExpiry}FUT`;
              }
              this.log(`Translated Dhan derivative symbol ${params.tradingsymbol} to Angel One symbol: ${resolvedSymbol}`, 'info');
            }
          }
        } catch (symErr) {
          this.log(`Failed to translate Dhan derivative symbol to Angel One: ${symErr.message}`, 'error');
        }
      }

      if (resolvedSymbol) {
        const db = instrumentService.getDatabase();
        let inst = db.find(i => i.symbol === resolvedSymbol && i.exchange === exchangeStr);
        if (!inst && (exchangeStr === 'NSE' || exchangeStr === 'BSE') && !resolvedSymbol.endsWith('-EQ')) {
          const testSym = resolvedSymbol + '-EQ';
          inst = db.find(i => i.symbol === testSym && i.exchange === exchangeStr);
          if (inst) {
            resolvedSymbol = testSym;
          }
        }
        if (inst) {
          resolvedToken = inst.token;
          this.log(`Resolved symbol/token for Angel One: ${resolvedSymbol} (Token: ${resolvedToken})`, 'info');
        }
      }

      const headers = await this.getHeaders();
      const payload = {
        variety: 'NORMAL',
        tradingsymbol: resolvedSymbol,
        symboltoken: resolvedToken,
        transactiontype: params.transactiontype, // BUY or SELL
        exchange: exchangeStr,
        ordertype: params.ordertype || 'MARKET',
        producttype: productTypeStr,
        duration: 'DAY',
        price: params.price ? params.price.toString() : '0',
        squareoff: '0',
        stoploss: '0',
        quantity: params.quantity.toString(),
        scripconsent: 'yes'
      };

      if (params.clientOrderId || params.correlationId) {
        payload.clientrefid = (params.clientOrderId || params.correlationId).substring(0, 25);
      }

      this.log('Sending POST to /rest/secure/angelbroking/order/v1/placeOrder', 'api-request', { payload, headers });

      const response = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder', payload, this.getConfig(headers));

      if (response.data && response.data.status === true) {
        this.log(`Order placed successfully! Order ID: ${response.data.data.orderid}`, 'success', response.data);
        this.clearCache(); // Force immediate refresh on next poll
        return response.data;
      } else {
        throw new Error(response.data.message || 'Order placement failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order placement');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: false, message: errorMsg };
    }
  }

  async getHolding() {
    if (this.account.isSimulated) {
      return simManager.getHolding(this.account);
    }

    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000; // 12 hours cache
    if (this.cache.holding.timestamp && (now - this.cache.holding.timestamp < cacheDuration)) {
      return this.cache.holding.data || [];
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const response = await axios.get('https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getHolding', this.getConfig(headers));
      if (response.data.status && Array.isArray(response.data.data)) {
        const data = response.data.data.map(hold => ({
          ...hold,
          quantity: parseFloat(hold.quantity || hold.dpquantity || 0),
          averageprice: parseFloat(hold.averageprice || hold.buyavgprice || 0),
          ltp: parseFloat(hold.ltp || hold.LTP || hold.averageprice || 0),
          profitandloss: parseFloat(hold.profitandloss !== undefined ? hold.profitandloss : 0)
        }));
        this.cache.holding = { data, timestamp: now };
        return data;
      }
      this.cache.holding.timestamp = now - cacheDuration + (5 * 60 * 1000); // Retry in 5 minutes
      return this.cache.holding.data || [];
    } catch (error) {
      this.handleApiError(error, 'Fetch holdings');
      this.cache.holding.timestamp = now - cacheDuration + (5 * 60 * 1000); // Retry in 5 minutes
      return this.cache.holding.data || [];
    }
  }

  async getPosition() {
    if (this.account.isSimulated) {
      return simManager.getPosition(this.account);
    }

    const now = Date.now();
    if (this.cache.position.timestamp && (now - this.cache.position.timestamp < 5000)) {
      return this.cache.position.data;
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const response = await axios.get('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getPosition', this.getConfig(headers));
      if (response.data.status && Array.isArray(response.data.data)) {
        const data = response.data.data.map(pos => {
          const qty = parseFloat(pos.netqty ?? (Number(pos.buyquantity || 0) - Number(pos.sellquantity || 0)));
          const avgNet = parseFloat(pos.avgnetprice || 0);
          const net = parseFloat(pos.netprice || 0);
          const buyAvg = parseFloat(pos.buyavgprice || pos.averageprice || 0);
          const sellAvg = parseFloat(pos.sellavgprice || 0);
          
          let avgPrice = 0;
          if (avgNet !== 0) avgPrice = avgNet;
          else if (net !== 0) avgPrice = net;
          else if (qty < 0) avgPrice = sellAvg !== 0 ? sellAvg : buyAvg;
          else if (qty > 0) avgPrice = buyAvg !== 0 ? buyAvg : sellAvg;
          else avgPrice = buyAvg !== 0 ? buyAvg : (sellAvg !== 0 ? sellAvg : 0);

          return {
            ...pos,
            netqty: qty,
            buyavgprice: avgPrice,
            ltp: parseFloat(pos.ltp || pos.LTP || 0),
            netvalue: parseFloat(pos.netvalue !== undefined ? pos.netvalue : (pos.marktomarket !== undefined ? pos.marktomarket : 0))
          };
        });
        this.cache.position = { data, timestamp: now };
        return data;
      }
      this.cache.position.timestamp = now;
      return this.cache.position.data || [];
    } catch (error) {
      this.handleApiError(error, 'Fetch positions');
      this.cache.position.timestamp = now;
      return this.cache.position.data || [];
    }
  }

  async getFunds() {
    if (this.account.isSimulated) {
      return simManager.getFunds(this.account);
    }

    const now = Date.now();
    if (this.cache.funds.timestamp && (now - this.cache.funds.timestamp < 5000)) {
      return this.cache.funds.data;
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const response = await axios.get('https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS', this.getConfig(headers));
      if (response.data && response.data.status) {
        const data = {
          availableCash: parseFloat(response.data.data.availablecash),
          utilized: parseFloat(response.data.data.utiliseddebits),
          margin: parseFloat(response.data.data.net)
        };
        this.cache.funds = { data, timestamp: now };
        return data;
      }
      this.cache.funds.timestamp = now;
      return this.cache.funds.data || { availableCash: 0, utilized: 0, margin: 0 };
    } catch (error) {
      this.handleApiError(error, 'Fetch funds');
      this.cache.funds.timestamp = now;
      return this.cache.funds.data || { availableCash: 0, utilized: 0, margin: 0 };
    }
  }

  async getOrderBook(forceRefresh = false) {
    if (this.account.isSimulated) {
      return simManager.getOrderBook(this.account);
    }

    const now = Date.now();
    if (!forceRefresh && this.cache.orderBook.data && (now - this.cache.orderBook.timestamp < 5000)) {
      return this.cache.orderBook.data;
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const response = await axios.get('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getOrderBook', this.getConfig(headers));
      if (response.data.status && Array.isArray(response.data.data)) {
        const data = response.data.data;
        this.cache.orderBook = { data, timestamp: now };
        return data;
      }
      this.cache.orderBook.timestamp = now;
      return this.cache.orderBook.data || [];
    } catch (error) {
      this.handleApiError(error, 'Fetch order book');
      this.cache.orderBook.timestamp = now;
      return this.cache.orderBook.data || [];
    }
  }

  async cancelOrder(orderId) {
    if (this.account.isSimulated) {
      return simManager.cancelOrder(this.account, orderId);
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const payload = {
        orderid: orderId,
        variety: 'NORMAL'
      };
      this.log(`Cancelling order ${orderId} with Angel One...`, 'info');
      const response = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/cancelOrder', payload, this.getConfig(headers));
      if (response.data && response.data.status === true) {
        this.log(`Order ${orderId} cancelled successfully!`, 'success', response.data);
        this.clearCache(); // Force immediate refresh on next poll
        return response.data;
      } else {
        throw new Error(response.data.message || 'Order cancellation failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order cancellation');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: false, message: errorMsg };
    }
  }

  async modifyOrder(params) {
    // params: { orderid, quantity, price, ordertype, symboltoken, exchange, producttype }
    const exchangeStr = params.exchange;
    let productTypeStr = params.producttype || 'INTRADAY';

    // For F&O / MCX derivatives, Angel One doesn't support 'DELIVERY' (CNC). Positional orders must map to 'CARRYFORWARD' (NRML).
    const isFoExchange = exchangeStr === 'NFO' || exchangeStr === 'NSEFO' || exchangeStr === 'MCX' || exchangeStr === 'CDS' || (exchangeStr && exchangeStr.includes('FO'));
    if (isFoExchange && (productTypeStr === 'DELIVERY' || productTypeStr === 'CNC')) {
      productTypeStr = 'CARRYFORWARD';
    }

    if (this.account.isSimulated) return simManager.modifyOrder(this.account, params);

    try {
      if (!this.session.connected) {
        await this.login();
      }

      this.log(`Modifying order ${params.orderid} with Angel One...`, 'info');
      const headers = await this.getHeaders();
      const payload = {
        orderid: params.orderid,
        variety: 'NORMAL',
        quantity: params.quantity.toString(),
        price: params.price.toString(),
        ordertype: params.ordertype || 'LIMIT',
        producttype: productTypeStr,
        duration: 'DAY',
        symboltoken: params.symboltoken,
        exchange: exchangeStr
      };
      
      const response = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/modifyOrder', payload, this.getConfig(headers));
      if (response.data && response.data.status === true) {
        this.log(`Order ${params.orderid} modified successfully!`, 'success', response.data);
        this.clearCache(); // Force immediate refresh on next poll
        return response.data;
      } else {
        throw new Error(response.data.message || 'Order modification failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order modification');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: false, message: errorMsg };
    }
  }

  async getMarketQuotes(exchangeTokens) {
    // exchangeTokens: { "NSE": ["3045", "1660"] }
    if (this.account.isSimulated) {
      return { fetched: [], unfetched: [] };
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const payload = {
        mode: 'FULL',
        exchangeTokens: exchangeTokens
      };
      
      const response = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', payload, this.getConfig(headers));
      if (response.data && response.data.status === true) {
        return response.data.data;
      } else {
        throw new Error(response.data.message || 'Failed to fetch quotes');
      }
    } catch (error) {
      this.handleApiError(error, 'Fetch market quotes');
      return { fetched: [], unfetched: [] };
    }
  }

  async getProfile() {
    if (this.account.isSimulated) {
      return { name: `Simulated (${this.account.clientCode || 'User'})` };
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      this.log('Fetching user profile details from Angel One...', 'info');
      const response = await axios.get('https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getProfile', this.getConfig(headers));
      if (response.data && response.data.status === true && response.data.data) {
        return response.data.data; // { clientcode, name, email, mobileno, ... }
      }
      return null;
    } catch (error) {
      this.handleApiError(error, 'Fetch profile');
      return null;
    }
  }

  handleApiError(error, contextName) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    const ctx = contextName || 'API Operation';
    const isBackgroundFetch = ctx.toLowerCase().includes('fetch') || 
                              ctx.toLowerCase().includes('getholding') || 
                              ctx.toLowerCase().includes('getposition') || 
                              ctx.toLowerCase().includes('getfunds');
    
    if (isBackgroundFetch) {
      console.error(`[Angel One] [${this.account.name}] ${ctx} failed: ${errorMsg}`);
    } else {
      this.log(`${ctx} failed: ${errorMsg}`, 'error');
    }
    
    const errorStr = String(errorMsg || '').toLowerCase();
    
    // Check for auth / token expiration errors (excluding rate limit messages)
    const isRateLimitError = (error.response && error.response.status === 429) ||
      errorStr.includes('rate') ||
      errorStr.includes('limit') ||
      errorStr.includes('exceed');
    
    const isAuthError = !isRateLimitError && (
      (error.response && (error.response.status === 401 || error.response.status === 403) &&
       !errorStr.includes('mismatch') &&
       !errorStr.includes('not found') &&
       !errorStr.includes('invalid tradingsymbol') &&
       !errorStr.includes('scrip master')) ||
      errorStr.includes('invalid token') ||
      errorStr.includes('token is invalid') ||
      errorStr.includes('token expired') ||
      errorStr.includes('session expired') ||
      errorStr.includes('session is expired') ||
      errorStr.includes('ag8001') ||
      errorStr.includes('ab1010') ||
      errorStr.includes('ab1004') ||
      (errorStr.includes('invalid response') && !errorStr.includes('upstream server'))
    );
    
    if (isAuthError) {
      this.log('Token or authentication error detected. Setting session to disconnected for auto-relogin.', 'info');
      this.session.connected = false;
      if (this.account.clientCode && sharedSessions[this.account.clientCode]) {
        sharedSessions[this.account.clientCode].connected = false;
      }
    }
  }
}

module.exports = AngelOneService;
