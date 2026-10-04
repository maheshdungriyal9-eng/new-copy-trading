const axios = require('axios');
const crypto = require('crypto');
const totpHelper = require('./totp');
const { HttpsProxyAgent } = require('https-proxy-agent');
const ipService = require('./ipService');
const instrumentService = require('./instrumentService');
const simManager = require('./simulatedPortfolioManager');

class MotilalService {
  constructor(account, logCallback) {
    this.account = account; // { id, name, type: 'master'|'child', broker: 'motilal', userId, password, twoFactor, totpSecret, apiKey, apiSecret, isSimulated }
    this.logCallback = logCallback || (() => {});
    this.session = {
      authToken: null,
      accessToken: null,
      connected: false
    };
    this.cache = {
      holding: { data: [], timestamp: 0 },
      position: { data: [], timestamp: 0 },
      funds: { data: { availableCash: 0, utilized: 0, margin: 0 }, timestamp: 0 },
      orderBook: { data: [], timestamp: 0 }
    };
    this.simulatedOrders = [
      {
        orderid: 'M260614001',
        symbol: 'RELAXO',
        symboltoken: 123,
        buyorsell: 'BUY',
        exchange: 'NSE',
        ordertype: 'LIMIT',
        producttype: 'Normal',
        orderqty: 10,
        price: 810.00,
        orderstatus: 'Cancel',
        recordinserttime: new Date(Date.now() - 3600000).toLocaleString(),
        averageprice: 0,
        totalqtytraded: 0,
        totalqtyremaining: 10
      },
      {
        orderid: 'M260614002',
        symbol: 'INFY',
        symboltoken: 1660,
        buyorsell: 'BUY',
        exchange: 'NSE',
        ordertype: 'MARKET',
        producttype: 'Normal',
        orderqty: 15,
        price: 1420.50,
        orderstatus: 'Traded',
        recordinserttime: new Date(Date.now() - 1800000).toLocaleString(),
        averageprice: 1420.50,
        totalqtytraded: 15,
        totalqtyremaining: 0
      }
    ];
  }

  clearCache() {
    this.cache.holding.timestamp = 0;
    this.cache.position.timestamp = 0;
    this.cache.funds.timestamp = 0;
    this.cache.orderBook.timestamp = 0;
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
    const config = { headers };
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

  log(message, type = 'info', details = null) {
    this.logCallback({
      timestamp: new Date().toISOString(),
      accountId: this.account.id,
      accountName: this.account.name,
      broker: 'Motilal Oswal',
      type,
      message,
      details
    });
  }

  async login() {
    if (this.account.isSimulated) {
      this.log('Connecting to Motilal Oswal (SIMULATED MODE)...', 'info');
      this.session = {
        authToken: 'simulated_mo_auth_token_' + Math.random().toString(36).substring(2, 10),
        accessToken: 'simulated_mo_access_token_' + Math.random().toString(36).substring(2, 10),
        connected: true
      };
      this.log('Logged in successfully (SIMULATED MODE)', 'success', this.session);
      return true;
    }

    try {
      this.log(`Authenticating user ${this.account.userId} with Motilal Oswal...`, 'info');
      
      const totpCode = totpHelper.generateTOTP(this.account.totpSecret);
      this.log('TOTP generated', 'info');

      // Calculate password hash: SHA-256(Password + APIKey)
      const passwordHash = crypto
        .createHash('sha256')
        .update(this.account.password + this.account.apiKey)
        .digest('hex');

      const data = {
        userid: this.account.userId,
        password: passwordHash,
        '2FA': this.account.twoFactor || '',
        totp: totpCode
      };

      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'MOSL/V.1.1.0',
        'ApiKey': this.account.apiKey,
        'ClientLocalIp': '192.168.1.100',
        'ClientPublicIp': this.getClientIp(),
        'MacAddress': '00:50-56-C0-00-08',
        'SourceId': 'WEB',
        'vendorinfo': this.account.userId,
        'osname': 'Windows 10',
        'osversion': '10.0.19041',
        'devicemodel': 'AHV',
        'manufacturer': 'DELL',
        'productname': 'CopyTradingApp',
        'productversion': '1.0.0',
        'installedappid': 'AppID',
        'browsername': 'Chrome',
        'browserversion': '105.0',
        'apisecretkey': this.account.apiSecret || ''
      };

      this.log('Sending POST to /rest/login/v7/authdirectapi', 'api-request', { data, headers });

      // Call Motilal Oswal Login API
      const response = await axios.post('https://openapi.motilaloswal.com/rest/login/v7/authdirectapi', data, this.getConfig(headers));

      if (response.data && response.data.status === 'SUCCESS') {
        const authToken = response.data.AuthToken;
        this.session.authToken = authToken;
        
        // Next, call the Get Access Token API to complete the login
        this.log('Auth token received. Generating Access Token...', 'info');
        
        const tokenHeaders = {
          ...headers,
          'Authorization': authToken
        };

        this.log('Sending POST to /rest/login/v1/getaccesstoken', 'api-request', { headers: tokenHeaders });

        const tokenResponse = await axios.post('https://openapi.motilaloswal.com/rest/login/v1/getaccesstoken', {}, this.getConfig(tokenHeaders));
        
        if (tokenResponse.data && tokenResponse.data.status === 'SUCCESS') {
          this.session.accessToken = tokenResponse.data.accesstoken;
          this.session.connected = true;
          this.log('Logged in and token generated successfully!', 'success', tokenResponse.data);
          return true;
        } else {
          throw new Error(tokenResponse.data.message || 'Access token generation failed');
        }
      } else {
        throw new Error(response.data.message || 'Login failed');
      }
    } catch (error) {
      this.session.connected = false;
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Authentication failed: ${errorMsg}`, 'error');
      return false;
    }
  }

  async getHeaders() {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'MOSL/V.1.1.0',
      'ApiKey': this.account.apiKey,
      'ClientLocalIp': '192.168.1.100',
      'ClientPublicIp': '103.55.66.77',
      'MacAddress': '00:50-56-C0-00-08',
      'SourceId': 'WEB',
      'vendorinfo': this.account.userId,
      'osname': 'Windows 10',
      'osversion': '10.0.19041',
      'devicemodel': 'AHV',
      'manufacturer': 'DELL',
      'productname': 'CopyTradingApp',
      'productversion': '1.0.0',
      'installedappid': 'AppID',
      'browsername': 'Chrome',
      'browserversion': '105.0',
      'apisecretkey': this.account.apiSecret || '',
      'accesstoken': this.session.accessToken,
      'Authorization': this.session.authToken
    };
  }

  handleApiError(error, contextName) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    const ctx = contextName || 'API Operation';
    const isBackgroundFetch = ctx.toLowerCase().includes('fetch') || 
                              ctx.toLowerCase().includes('getholding') || 
                              ctx.toLowerCase().includes('getposition') || 
                              ctx.toLowerCase().includes('getfunds');
    
    if (isBackgroundFetch) {
      console.error(`[Motilal Oswal] [${this.account.name || this.account.id}] ${ctx} failed: ${errorMsg}`);
    } else {
      this.log(`${ctx} failed: ${errorMsg}`, 'error');
    }
    
    const errorStr = String(errorMsg || '').toLowerCase();
    
    // Check for auth / token expiration errors (401, 403, or invalid token/session messages)
    const isRateLimitError = (error.response && error.response.status === 429) ||
      errorStr.includes('rate') ||
      errorStr.includes('limit') ||
      errorStr.includes('exceed');
    
    const isAuthError = !isRateLimitError && (
      (error.response && (error.response.status === 401 || error.response.status === 403)) ||
      errorStr.includes('invalid token') ||
      errorStr.includes('token is invalid') ||
      errorStr.includes('token expired') ||
      errorStr.includes('session expired') ||
      errorStr.includes('session is expired') ||
      errorStr.includes('unauthorized') ||
      errorStr.includes('auth') ||
      (errorStr.includes('invalid response') && !errorStr.includes('upstream server'))
    );
    
    if (isAuthError) {
      this.log('Token or authentication error detected for Motilal. Setting session to disconnected for auto-relogin.', 'info');
      this.session.connected = false;
    }
  }

  async placeOrder(params) {
    // params: { tradingsymbol, symboltoken, exchange, buyorsell, quantity, price, ordertype, producttype }
    if (this.account.isSimulated) {
      return simManager.placeOrder(this.account, params);
    }

    try {
      if (!this.session.connected) {
        await this.login();
      }

      this.log(`Placing order for ${params.tradingsymbol} (Qty: ${params.quantity})...`, 'info');

      const exchangeStr = (params.exchange || 'NSE').toUpperCase();
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

      // Handle translation of Dhan derivative symbols (e.g. NIFTY-30JUN26-23500-CE)
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
              this.log(`Translated Dhan derivative symbol ${params.tradingsymbol} to Motilal symbol: ${resolvedSymbol}`, 'info');
            }
          }
        } catch (symErr) {
          this.log(`Failed to translate Dhan derivative symbol to Motilal: ${symErr.message}`, 'error');
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
          this.log(`Resolved symbol/token for Motilal: ${resolvedSymbol} (Token: ${resolvedToken})`, 'info');
        }
      }

      // Map F&O exchanges to what Motilal API expects (NSEFO, BSEFO)
      let targetExchange = exchangeStr;
      if (exchangeStr === 'NFO') {
        targetExchange = 'NSEFO';
      } else if (exchangeStr === 'BFO') {
        targetExchange = 'BSEFO';
      }

      // Map lot size for F&O orders (Motilal Oswal expects quantityinlot to be number of lots)
      let lotSize = 1;
      const isFoExchange = exchangeStr === 'NFO' || exchangeStr === 'NSEFO' || exchangeStr === 'MCX' || exchangeStr === 'CDS' || exchangeStr.includes('FO');
      if (isFoExchange) {
        try {
          const dhanService = require('./dhanService');
          if (dhanDetails && dhanDetails.lotSize) {
            lotSize = dhanDetails.lotSize;
          } else {
            lotSize = dhanService.getDhanLotSize(params.tradingsymbol, exchangeStr);
          }
        } catch (e) {
          console.error('[MotilalService] Failed to retrieve contract lot size:', e.message);
        }
      }
      if (!Number.isSafeInteger(Number(params.quantity)) || Number(params.quantity) <= 0 || !Number.isFinite(lotSize) || lotSize <= 0 || Number(params.quantity) % lotSize !== 0) throw new Error('Quantity must be a positive multiple of the contract lot size');
      const lots = Number(params.quantity) / lotSize;

      const headers = await this.getHeaders();
      const payload = {
        clientcode: '', // Not required for normal investor clients
        exchange: targetExchange,
        symboltoken: parseInt(resolvedToken),
        buyorsell: params.transactiontype || 'BUY',
        ordertype: params.ordertype || 'MARKET',
        producttype: require('./copyTradingEngine').mapProductType(params.producttype, 'motilal', exchangeStr), // Normal, ValuePlus, Delivery
        orderduration: 'DAY',
        price: params.price ? parseFloat(params.price) : 0.0,
        triggerprice: 0.0,
        quantityinlot: lots,
        disclosedquantity: 0,
        amoorder: 'N',
        algoid: '',
        goodtilldate: '',
        tag: (params.clientOrderId || params.correlationId || 'CTApp').substring(0, 25)
      };

      this.log('Sending POST to /rest/trans/v2/placeorder', 'api-request', { payload, headers });

      const response = await axios.post('https://openapi.motilaloswal.com/rest/trans/v2/placeorder', payload, this.getConfig(headers));

      if (response.data && response.data.status === 'SUCCESS') {
        this.log(`Order placed successfully! ID: ${response.data.uniqueorderid}`, 'success', response.data);
        this.clearCache();
        return response.data;
      } else {
        throw new Error(response.data.message || 'Order placement failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order placement');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: 'FAILURE', message: errorMsg };
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
      const response = await axios.post('https://openapi.motilaloswal.com/rest/report/v3/getdpholding', {}, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS' && Array.isArray(response.data.data)) {
        const data = response.data.data.map(h => {
          const rawSymbol = h.scripname || h.tradingsymbol || '';
          const normalizedSymbol = rawSymbol.trim().toUpperCase().replace(/\s+/g, '-');
          const qty = parseFloat(h.dpquantity || h.quantity || 0);
          const avg = parseFloat(h.buyavgprice || h.averageprice || 0);
          const ltp = parseFloat(h.closeprice || h.ltp || avg || 0);
          return {
            ...h,
            scripname: rawSymbol,
            tradingsymbol: normalizedSymbol,
            exchange: h.exchange || 'NSE',
            quantity: qty,
            averageprice: avg,
            ltp: ltp,
            profitandloss: parseFloat(((ltp - avg) * qty).toFixed(2)),
            symboltoken: String(h.nsesymboltoken || h.symboltoken || '')
          };
        });
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
      const response = await axios.post('https://openapi.motilaloswal.com/rest/book/v4/getposition', {}, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS' && Array.isArray(response.data.data)) {
        const data = response.data.data.map(p => {
          const rawSymbol = p.symbol || p.tradingsymbol || '';
          const normalizedSymbol = rawSymbol.trim().toUpperCase().replace(/\s+/g, '-');
          const buyQty = parseFloat(p.buyquantity || 0);
          const sellQty = parseFloat(p.sellquantity || 0);
          const netQty = buyQty - sellQty;
          const buyAmt = parseFloat(p.buyamount || 0);
          const sellAmt = parseFloat(p.sellamount || 0);
          const avgPrice = netQty >= 0 ? (buyQty > 0 ? buyAmt / buyQty : 0) : (sellQty > 0 ? sellAmt / sellQty : 0);
          const ltp = parseFloat(p.LTP || p.ltp || avgPrice || 0);
          const pnl = parseFloat(p.marktomarket || p.netvalue || ((ltp - avgPrice) * netQty) || 0);
          return {
            ...p,
            symbol: rawSymbol,
            tradingsymbol: normalizedSymbol,
            exchange: (p.exchange === 'NSEFO' || p.exchange === 'NFO') ? 'NFO' : (p.exchange === 'BSEFO' || p.exchange === 'BFO' ? 'BFO' : (p.exchange || 'NSE')),
            netqty: netQty,
            buyavgprice: avgPrice,
            avgnetprice: avgPrice,
            ltp: ltp,
            LTP: ltp,
            netvalue: pnl,
            marktomarket: pnl,
            producttype: p.producttype || p.productname || 'NORMAL',
            symboltoken: String(p.symboltoken || '')
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
      const response = await axios.post('https://openapi.motilaloswal.com/rest/report/v3/getreportmarginsummary', {}, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS' && Array.isArray(response.data.data)) {
        const cashObj = response.data.data.find(d => d.particulars === 'Total Available Margin for Cash') || { amount: 0 };
        const data = {
          availableCash: parseFloat(cashObj.amount || 0),
          utilized: 0.0,
          margin: parseFloat(cashObj.amount || 0)
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
      const response = await axios.post('https://openapi.motilaloswal.com/rest/book/v5/getorderbook', {}, this.getConfig(headers));
      const data = response.data.status === 'SUCCESS' ? response.data.data : [];
      const normalizedData = data.map(o => {
        let exchange = 'NSE';
        const ex = (o.exchange || '').toUpperCase();
        if (ex === 'NSEFO' || ex === 'NFO') exchange = 'NFO';
        else if (ex === 'BSEFO' || ex === 'BFO') exchange = 'BFO';
        else if (ex === 'MCX') exchange = 'MCX';
        else if (ex === 'NSECD') exchange = 'CDS';
        else exchange = ex;

        const qty = parseInt(o.orderqty || 0);
        const filled = parseInt(o.totalqtytraded || 0);

        return {
          orderid: o.uniqueorderid || o.orderid,
          correlationId: o.tag || o.clientrefid,
          tradingsymbol: o.symbol || o.tradingsymbol,
          symboltoken: String(o.symboltoken || ''),
          transactiontype: o.buyorsell,
          exchange: exchange,
          ordertype: o.ordertype,
          producttype: o.producttype || o.productname || 'Normal',
          quantity: qty.toString(),
          price: (o.price || 0).toString(),
          status: (o.orderstatus || '').toLowerCase(),
          orderstatus: (o.orderstatus || '').toLowerCase(),
          updatetime: o.recordinserttime || new Date().toLocaleString(),
          averageprice: (o.averageprice || 0).toString(),
          filledshares: filled.toString(),
          unfilledshares: (qty - filled).toString(),
          expiry: o.expirydate || o.expiry || '',
          optiontype: o.optiontype || '',
          strike: o.strikeprice || o.strike || 0
        };
      });
      this.cache.orderBook = { data: normalizedData, timestamp: now };
      return normalizedData;
    } catch (error) {
      this.handleApiError(error, 'Fetch order book');
      this.cache.orderBook.timestamp = now;
      return this.cache.orderBook.data || [];
    }
  }

  async modifyOrder(params) {
    if (this.account.isSimulated) return simManager.modifyOrder(this.account, params);

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const payload = {
        uniqueorderid: params.orderid,
        orderqty: parseInt(params.quantity),
        price: parseFloat(params.price),
        ordertype: params.ordertype || 'LIMIT',
        producttype: params.producttype || 'INTRADAY',
        orderduration: 'DAY'
      };
      this.log(`Modifying order ${params.orderid} with Motilal Oswal...`, 'info');
      const response = await axios.post('https://openapi.motilaloswal.com/rest/trans/v2/modifyorder', payload, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS') {
        this.log(`Order ${params.orderid} modified successfully!`, 'success', response.data);
        this.clearCache();
        return { status: true, message: 'SUCCESS' };
      } else {
        throw new Error(response.data.message || 'Order modification failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order modification');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: false, message: errorMsg };
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
        clientcode: '', // Not required for normal investor clients
        uniqueorderid: orderId
      };
      this.log(`Cancelling order ${orderId} with Motilal Oswal...`, 'info');
      const response = await axios.post('https://openapi.motilaloswal.com/rest/trans/v2/cancelorder', payload, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS') {
        this.log(`Order ${orderId} cancelled successfully!`, 'success', response.data);
        this.clearCache();
        return response.data;
      } else {
        throw new Error(response.data.message || 'Order cancellation failed');
      }
    } catch (error) {
      this.handleApiError(error, 'Order cancellation');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      return { status: 'ERROR', message: errorMsg };
    }
  }

  async getProfile() {
    if (this.account.isSimulated) {
      return { name: `Simulated (${this.account.userId || 'User'})` };
    }

    try {
      if (!this.session.connected) await this.login();
      const headers = await this.getHeaders();
      const response = await axios.post('https://openapi.motilaloswal.com/rest/login/v5/getprofile', {}, this.getConfig(headers));
      if (response.data && response.data.status === 'SUCCESS' && response.data.data) {
        return { name: response.data.data.name };
      }
      return null;
    } catch (error) {
      this.handleApiError(error, 'Fetch profile');
      return null;
    }
  }
}

module.exports = MotilalService;
