const axios = require('axios');
const dhanService = require('./dhanService');
const totpHelper = require('./totp');
const simManager = require('./simulatedPortfolioManager');

function formatExpiryDate(dateStr) {
  if (!dateStr || dateStr.startsWith('0001')) return '';
  const parsedStr = dateStr.split(' ')[0];
  const date = new Date(parsedStr.includes('T') ? parsedStr : `${parsedStr}T00:00:00Z`);
  if (isNaN(date.getTime())) return '';
  
  const day = String(date.getUTCDate()).padStart(2, '0');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[date.getUTCMonth()];
  const year = String(date.getUTCFullYear()).substring(2);
  
  return `${day}${month}${year}`;
}

class DhanTradeService {
  constructor(account, logCallback) {
    this.account = account; // { id, name, type: 'master'|'child', broker: 'dhan', clientCode, password, isSimulated }
    this.logCallback = logCallback || (() => {});
    this.session = {
      connected: false,
      accessToken: account.accessToken || null,
      tokenGenerationTime: account.tokenGenerationTime || null
    };

    // Cache portfolio data for 5 seconds to prevent rate-limiting under fast polling
    this.cache = {
      holding: { data: [], timestamp: 0 },
      position: { data: [], timestamp: 0 },
      funds: { data: { availableCash: 0, utilized: 0, margin: 0 }, timestamp: 0 },
      orderBook: { data: [], timestamp: 0 }
    };

    this.simulatedOrders = [
      {
        orderid: 'DH1000000001',
        tradingsymbol: 'SBIN-EQ',
        symboltoken: '3045',
        transactiontype: 'BUY',
        exchange: 'NSE',
        ordertype: 'LIMIT',
        producttype: 'CNC',
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
        orderid: 'DH1000000002',
        tradingsymbol: 'TCS-EQ',
        symboltoken: '11536',
        transactiontype: 'BUY',
        exchange: 'NSE',
        ordertype: 'MARKET',
        producttype: 'INTRADAY',
        quantity: '10',
        price: '3650.00',
        status: 'traded',
        orderstatus: 'traded',
        updatetime: new Date(Date.now() - 1800000).toLocaleString(),
        averageprice: '3650.00',
        filledshares: '10',
        unfilledshares: '0'
      }
    ];
  }

  clearCache() {
    this.cache.holding.timestamp = 0;
    this.cache.position.timestamp = 0;
    this.cache.funds.timestamp = 0;
    this.cache.orderBook.timestamp = 0;
  }

  log(message, type = 'info', details = null) {
    this.logCallback({
      timestamp: new Date().toISOString(),
      accountId: this.account.id,
      accountName: this.account.name,
      broker: 'Dhan',
      type,
      message,
      details
    });
  }

  saveTokenToConfig(accessToken, tokenGenerationTime, name = null) {
    require('./configService').updateAccount(this.account.id, account => {
      account.accessToken = accessToken;
      account.tokenGenerationTime = tokenGenerationTime;
      if (name) account.name = name;
    });
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'client-id': this.account.clientCode,  // Dhan client ID is stored in clientCode
      'access-token': this.session.accessToken || this.account.password  // Dhan access token is stored in session, fallback to password (static token)
    };
  }

  getConfig(headers) {
    const config = { headers, timeout: 7000 };
    if (this.account.proxyUrl === 'vps') {
      if (process.platform === 'win32') {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        config.httpsAgent = new HttpsProxyAgent('http://127.0.0.1:3128');
      }
    } else if (this.account.proxyUrl) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      config.httpsAgent = new HttpsProxyAgent(this.account.proxyUrl);
    }
    return config;
  }

  async login() {
    if (this.account.isSimulated) {
      this.log('Connecting to Dhan (SIMULATED MODE)...', 'info');
      this.session.connected = true;
      this.log('Logged in successfully (SIMULATED MODE)', 'success');
      return true;
    }

    // Check if we have a cached token that is less than 20 hours old
    const cachedTokenAge = this.session.tokenGenerationTime ? (Date.now() - this.session.tokenGenerationTime) : null;
    const isNumericName = /^\d+$/.test(this.account.name || '');
    const hasRealName = this.account.name && !isNumericName;
    const hasCachedToken = this.session.accessToken && cachedTokenAge !== null && cachedTokenAge < 20 * 60 * 60 * 1000 && hasRealName;

    if (this.account.totpSecret && hasCachedToken) {
      const ageMins = Math.round(cachedTokenAge / 60000);
      this.log(`Found cached Dhan access token (Age: ${ageMins} mins). Validating first...`, 'info');
      
      try {
        const headers = this.getHeaders();
        const response = await axios.get('https://api.dhan.co/v2/fundlimit', this.getConfig(headers));
        if (response.data && (response.data.dhanClientId || response.data.availabelBalance !== undefined)) {
          this.session.connected = true;
          this.log('Logged in successfully using cached token!', 'success');
          return true;
        }
      } catch (validationErr) {
        this.log(`Cached token validation failed: ${validationErr.message}. Will generate fresh token.`, 'info');
        // Clear cached token so we try to generate a new one below
        this.session.accessToken = null;
        this.session.tokenGenerationTime = null;
        this.account.accessToken = null;
        this.account.tokenGenerationTime = null;
      }
    }

    try {
      if (this.account.totpSecret) {
        // Enforce the 2-minute safety guard locally to prevent Dhan rate limiting blocks
        const lastGenTime = this.session.lastTokenRequestTime || 0;
        const timeSinceLastRequest = Date.now() - lastGenTime;
        if (timeSinceLastRequest < 125000) { // 125 seconds
          const waitTimeSec = Math.ceil((125000 - timeSinceLastRequest) / 1000);
          throw new Error(`Dhan token generation rate limit: Please wait ${waitTimeSec} seconds before requesting a new token.`);
        }

        this.log(`Generating TOTP code for dynamic login (with -30s clock sync offset)...`, 'info');
        const totpCode = totpHelper.generateTOTP(this.account.totpSecret, Date.now());
        
        const clientId = this.account.clientCode;
        const pin = this.account.password;
        
        this.log(`Requesting dynamic access token for Dhan Client ID: ${clientId}...`, 'info');
        this.session.lastTokenRequestTime = Date.now();
        const authUrl = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${clientId}&pin=${pin}&totp=${totpCode}`;
        
        // Perform POST request to generate access token
        const authResponse = await axios.post(authUrl, {}, this.getConfig({
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }));
        
        if (authResponse.data && authResponse.data.accessToken) {
          const token = authResponse.data.accessToken;
          const genTime = Date.now();
          this.session.accessToken = token;
          this.session.tokenGenerationTime = genTime;
          // Store on account object so it updates in-memory config reference
          this.account.accessToken = token;
          this.account.tokenGenerationTime = genTime;
          const clientName = authResponse.data.dhanClientName;
          if (clientName) {
            this.account.name = clientName;
          }
          this.saveTokenToConfig(token, genTime, clientName);
          this.log(`Dhan Access Token generated successfully. Expiry: ${authResponse.data.expiryTime || '24h'}`, 'success');
        } else {
          const detail = authResponse.data ? JSON.stringify(authResponse.data) : 'Empty response';
          throw new Error(`Dhan Authentication failed: ${detail}`);
        }
      } else {
        // Fallback to static Access Token
        this.session.accessToken = this.account.password;
        this.log(`Using static access token for login...`, 'info');
      }

      this.log(`Validating credentials for client ${this.account.clientCode} with Dhan...`, 'info');
      const headers = this.getHeaders();
      const response = await axios.get('https://api.dhan.co/v2/fundlimit', this.getConfig(headers));

      if (response.data && (response.data.dhanClientId || response.data.availabelBalance !== undefined)) {
        this.session.connected = true;
        this.log('Logged in successfully!', 'success');
        return true;
      } else {
        throw new Error('Invalid authentication response from Dhan API');
      }
    } catch (error) {
      this.session.connected = false;
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Login failed: ${errorMsg}`, 'error');
      return false;
    }
  }


  handleApiError(error, contextName) {
    const errorStr = error.response ? JSON.stringify(error.response.data).toLowerCase() : error.message.toLowerCase();
    
    // Check for auth / token expiration errors (excluding rate limit messages)
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
      errorStr.includes('authentication failed') ||
      errorStr.includes('unauthorized') ||
      (errorStr.includes('invalid response') && !errorStr.includes('upstream server'))
    );
    
    if (isAuthError) {
      this.log(`Token or authentication error detected in ${contextName}. Setting session to disconnected for auto-relogin.`, 'info');
      this.session.connected = false;
    }
  }

  async placeOrder(params) {
    if (!this.account.isSimulated && !this.session.connected) {
      await this.login();
    }

    // params: { tradingsymbol, symboltoken, exchange, transactiontype, quantity, price, ordertype, producttype }
    if (this.account.isSimulated) {
      return simManager.placeOrder(this.account, params);
    }

    try {
      const resolved = dhanService.resolveToDhan(params.tradingsymbol, params.exchange, params.symboltoken);
      if (!resolved) {
        throw new Error(`Could not resolve symbol ${params.tradingsymbol} to Dhan security ID`);
      }

      const { securityId, exchangeSegment } = resolved;
      const headers = this.getHeaders();

      // Map productType appropriately
      const targetProductType = require('./copyTradingEngine').mapProductType(params.producttype, 'dhan', params.exchange);

      const orderType = (params.ordertype || 'LIMIT').toUpperCase();

      const payload = {
        dhanClientId: this.account.clientCode,
        transactionType: params.transactiontype.toUpperCase(),
        exchangeSegment: exchangeSegment,
        productType: targetProductType,
        orderType: orderType,
        validity: 'DAY',
        securityId: securityId,
        quantity: parseInt(params.quantity)
      };

      if (params.clientOrderId || params.correlationId) {
        payload.correlationId = (params.clientOrderId || params.correlationId).substring(0, 25);
      }

      if (orderType !== 'MARKET') {
        payload.price = parseFloat(params.price || 0);
      }

      this.log(`Placing order to Dhan: ${payload.transactionType} ${payload.quantity} ${params.tradingsymbol}`, 'info', payload);
      const response = await axios.post('https://api.dhan.co/v2/orders', payload, this.getConfig(headers));

      if (response.data && response.data.orderId) {
        this.log(`Order placed successfully on Dhan! ID: ${response.data.orderId}`, 'success', response.data);
        this.clearCache();
        return { status: true, message: 'SUCCESS', data: { orderid: response.data.orderId } };
      } else {
        throw new Error(response.data.errorMessage || response.data.remarks || 'Order placement failed');
      }
    } catch (error) {
      this.handleApiError(error, 'placeOrder');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Order placement failed: ${errorMsg}`, 'error');
      return { status: false, message: errorMsg };
    }
  }

  async cancelOrder(orderId) {
    if (this.account.isSimulated) {
      return simManager.cancelOrder(this.account, orderId);
    }

    if (!this.account.isSimulated && !this.session.connected) {
      await this.login();
    }

    try {
      const headers = this.getHeaders();
      this.log(`Cancelling order ${orderId} on Dhan...`, 'info');
      const response = await axios.delete(`https://api.dhan.co/v2/orders/${orderId}`, this.getConfig(headers));
      
      if (response.data && response.data.orderId) {
        this.log(`Order ${orderId} cancelled successfully!`, 'success', response.data);
        this.clearCache();
        return { status: true, message: 'SUCCESS' };
      } else {
        throw new Error(response.data.errorMessage || 'Order cancellation failed');
      }
    } catch (error) {
      this.handleApiError(error, 'cancelOrder');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Order cancellation failed: ${errorMsg}`, 'error');
      return { status: false, message: errorMsg };
    }
  }

  async modifyOrder(params) {
    // params: { orderid, quantity, price, ordertype, symboltoken, exchange, producttype }
    if (this.account.isSimulated) return simManager.modifyOrder(this.account, params);

    if (!this.account.isSimulated && !this.session.connected) {
      await this.login();
    }

    try {
      const headers = this.getHeaders();
      this.log(`Modifying order ${params.orderid} on Dhan...`, 'info');

      const orderType = (params.ordertype || 'LIMIT').toUpperCase();
      const payload = {
        dhanClientId: this.account.clientCode,
        orderId: params.orderid,
        orderType: orderType,
        quantity: parseInt(params.quantity),
        validity: 'DAY'
      };

      if (orderType !== 'MARKET') {
        payload.price = parseFloat(params.price || 0);
      }

      const response = await axios.put(`https://api.dhan.co/v2/orders/${params.orderid}`, payload, this.getConfig(headers));
      if (response.data && response.data.orderId) {
        this.log(`Order ${params.orderid} modified successfully!`, 'success', response.data);
        this.clearCache();
        return { status: true, message: 'SUCCESS' };
      } else {
        throw new Error(response.data.errorMessage || 'Order modification failed');
      }
    } catch (error) {
      this.handleApiError(error, 'modifyOrder');
      const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log(`Order modification failed: ${errorMsg}`, 'error');
      return { status: false, message: errorMsg };
    }
  }

  async getHolding() {
    if (this.account.isSimulated) {
      return simManager.getHolding(this.account);
    }

    if (!this.session.connected) {
      await this.login();
    }

    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000; // 12 hours cache
    if (this.cache.holding.timestamp && (now - this.cache.holding.timestamp < cacheDuration)) {
      return this.cache.holding.data || [];
    }

    try {
      const headers = this.getHeaders();
      const response = await axios.get('https://api.dhan.co/v2/holdings', this.getConfig(headers));
      if (Array.isArray(response.data)) {
        const data = response.data.map(h => ({
          tradingsymbol: h.tradingSymbol,
          exchange: h.exchange,
          quantity: parseFloat(h.totalQty || 0),
          averageprice: parseFloat(h.avgCostPrice || 0),
          ltp: parseFloat(h.lastTradedPrice || 0),
          profitandloss: parseFloat((h.lastTradedPrice - h.avgCostPrice) * h.totalQty || 0),
          symboltoken: h.securityId
        }));
        this.cache.holding = { data, timestamp: now };
        return data;
      }
      this.cache.holding.timestamp = now - cacheDuration + (5 * 60 * 1000); // Retry in 5 minutes
      return this.cache.holding.data || [];
    } catch (error) {
      this.handleApiError(error, 'getHolding');
      console.error(`[Dhan] [${this.account.name}] Fetch holdings failed: ${error.message}`);
      this.cache.holding.timestamp = now - cacheDuration + (5 * 60 * 1000); // Retry in 5 minutes
      return this.cache.holding.data || [];
    }
  }

  async getPosition() {
    if (this.account.isSimulated) {
      return simManager.getPosition(this.account);
    }

    if (!this.session.connected) {
      await this.login();
    }

    const now = Date.now();
    if (this.cache.position.timestamp && (now - this.cache.position.timestamp < 5000)) {
      return this.cache.position.data;
    }

    try {
      const headers = this.getHeaders();
      const response = await axios.get('https://api.dhan.co/v2/positions', this.getConfig(headers));
      if (Array.isArray(response.data)) {
        const data = response.data.map(p => {
          const exchange = (p.exchangeSegment || 'NSE_EQ').split('_')[0];
          const qty = parseFloat(p.netQty || 0);
          const buyAvg = parseFloat(p.buyAvg || 0);
          const sellAvg = parseFloat(p.sellAvg || 0);
          const avgPrice = qty >= 0 ? buyAvg : sellAvg;

          let normalizedSymbol = p.tradingSymbol;
          if (p.drvExpiryDate && !p.drvExpiryDate.startsWith('0001')) {
            const expCode = formatExpiryDate(p.drvExpiryDate);
            if (expCode) {
              const parts = p.tradingSymbol.split('-');
              let underlying = parts[0];
              if (p.drvOptionType && p.drvOptionType !== 'NA') {
                if (parts.length >= 4) {
                  underlying = parts.slice(0, -3).join('-');
                }
                const optType = p.drvOptionType === 'CALL' ? 'CE' : 'PE';
                const strike = parseFloat(p.drvStrikePrice).toString();
                normalizedSymbol = `${underlying}-${expCode}-${strike}-${optType}`;
              } else {
                if (parts.length >= 3) {
                  underlying = parts.slice(0, -2).join('-');
                }
                // Future
                normalizedSymbol = `${underlying}-${expCode}-FUT`;
              }
            }
          }

          const costPrice = parseFloat(p.costPrice || 0);
          const carryForwardBuyQty = parseFloat(p.carryForwardBuyQty || 0);
          const carryForwardSellQty = parseFloat(p.carryForwardSellQty || 0);
          const isCarryForward = carryForwardBuyQty > 0 || carryForwardSellQty > 0;

          // Retrieve real-time LTP from global price cache if available
          let ltp = 0;
          if (global.basePrices && global.basePrices[normalizedSymbol]) {
            ltp = global.basePrices[normalizedSymbol];
          }

          // Fallback: Deduce LTP using unrealizedProfit since Dhan doesn't send LTP directly in position response
          if (!ltp) {
            const unrealized = parseFloat(p.unrealizedProfit || 0);
            if (qty !== 0) {
              const basePrice = costPrice || avgPrice || 1;
              ltp = basePrice + (unrealized / qty);
            } else {
              // For closed positions, determine exit price based on carryforward status
              if (carryForwardBuyQty > 0) {
                ltp = sellAvg || costPrice || avgPrice;
              } else if (carryForwardSellQty > 0) {
                ltp = buyAvg || costPrice || avgPrice;
              } else {
                // For intraday, assume exit price is sellAvg (or buyAvg if sellAvg is 0)
                ltp = sellAvg || buyAvg || costPrice || avgPrice;
              }
            }
          }

          let finalBuyAvg = buyAvg;
          let finalSellAvg = sellAvg;
          let finalRealized = parseFloat(p.realizedProfit || 0);
          let finalUnrealized = parseFloat(p.unrealizedProfit || 0);

          if (qty !== 0) {
            if (isCarryForward) {
              if (carryForwardBuyQty > 0) {
                // Carryforward LONG: entry is replaced by costPrice for daily tracking
                finalBuyAvg = costPrice;
                finalSellAvg = sellAvg;
                const sellQty = parseFloat(p.sellQty || 0);
                finalRealized = sellQty > 0 ? sellQty * (sellAvg - costPrice) : 0;
                finalUnrealized = qty * (ltp - costPrice);
              } else if (carryForwardSellQty > 0) {
                // Carryforward SHORT: entry is replaced by costPrice for daily tracking
                finalBuyAvg = buyAvg;
                finalSellAvg = costPrice;
                const buyQty = parseFloat(p.buyQty || 0);
                finalRealized = buyQty > 0 ? buyQty * (costPrice - buyAvg) : 0;
                finalUnrealized = Math.abs(qty) * (costPrice - ltp);
              }
            } else {
              // Intraday / normal: calculate P&L using actual ltp vs average entry price
              finalUnrealized = qty * (ltp - avgPrice);
            }
          } else {
            finalUnrealized = 0;
            if (isCarryForward) {
              if (carryForwardBuyQty > 0) {
                // Closed Carryforward LONG: entry is replaced by costPrice
                finalBuyAvg = costPrice;
                finalSellAvg = sellAvg;
                finalRealized = carryForwardBuyQty * (sellAvg - costPrice);
              } else if (carryForwardSellQty > 0) {
                // Closed Carryforward SHORT: entry is replaced by costPrice
                finalBuyAvg = buyAvg;
                finalSellAvg = costPrice;
                finalRealized = carryForwardSellQty * (costPrice - buyAvg);
              }
            }
          }

          const totalPnl = finalRealized + finalUnrealized;

          return {
            tradingsymbol: normalizedSymbol,
            exchange: exchange,
            netqty: qty,
            buyavgprice: finalBuyAvg,
            sellavgprice: finalSellAvg,
            ltp: parseFloat(ltp.toFixed(2)),
            netvalue: parseFloat(totalPnl.toFixed(2)),
            realizedProfit: parseFloat(finalRealized.toFixed(2)),
            unrealizedProfit: parseFloat(finalUnrealized.toFixed(2)),
            producttype: p.productType,
            symboltoken: p.securityId
          };
        });
        this.cache.position = { data, timestamp: now };
        return data;
      }
      this.cache.position.timestamp = now;
      return this.cache.position.data || [];
    } catch (error) {
      this.handleApiError(error, 'getPosition');
      console.error(`[Dhan] [${this.account.name}] Fetch positions failed: ${error.message}`);
      this.cache.position.timestamp = now;
      return this.cache.position.data || [];
    }
  }

  async getFunds() {
    if (this.account.isSimulated) {
      return simManager.getFunds(this.account);
    }

    if (!this.session.connected) {
      await this.login();
    }

    const now = Date.now();
    if (this.cache.funds.timestamp && (now - this.cache.funds.timestamp < 5000)) {
      return this.cache.funds.data;
    }

    try {
      const headers = this.getHeaders();
      const response = await axios.get('https://api.dhan.co/v2/fundlimit', this.getConfig(headers));
      if (response.data) {
        // Dhan API has a known typo: availabelBalance
        const available = parseFloat(response.data.availabelBalance || response.data.availableBalance || 0);
        const utilized = parseFloat(response.data.utilizedAmount || 0);
        const data = {
          availableCash: available,
          utilized: utilized,
          margin: available + utilized
        };
        this.cache.funds = { data, timestamp: now };
        return data;
      }
      this.cache.funds.timestamp = now;
      return this.cache.funds.data || { availableCash: 0, utilized: 0, margin: 0 };
    } catch (error) {
      this.handleApiError(error, 'getFunds');
      console.error(`[Dhan] [${this.account.name}] Fetch funds failed: ${error.message}`);
      this.cache.funds.timestamp = now;
      return this.cache.funds.data || { availableCash: 0, utilized: 0, margin: 0 };
    }
  }

  async getOrderBook(forceRefresh = false) {
    if (this.account.isSimulated) {
      return simManager.getOrderBook(this.account);
    }

    if (!this.session.connected) {
      await this.login();
    }

    const now = Date.now();
    if (!forceRefresh && this.cache.orderBook.data && (now - this.cache.orderBook.timestamp < 5000)) {
      return this.cache.orderBook.data;
    }

    try {
      const headers = this.getHeaders();
      const response = await axios.get(`https://api.dhan.co/v2/orders?_t=${Date.now()}`, this.getConfig(headers));
      if (Array.isArray(response.data)) {
        const data = response.data.map(o => {
          let exchange = 'NSE';
          const seg = o.exchangeSegment || '';
          if (seg === 'NSE_EQ') exchange = 'NSE';
          else if (seg === 'NSE_FNO') exchange = 'NFO';
          else if (seg === 'BSE_EQ') exchange = 'BSE';
          else if (seg === 'BSE_FNO') exchange = 'BFO';
          else if (seg === 'MCX_COMM') exchange = 'MCX';
          else if (seg === 'CURRENCY_FUT' || seg === 'CDS_FUT') exchange = 'CDS';
          else exchange = seg.split('_')[0];

          const qty = parseInt(o.quantity || 0);
          const filled = parseInt(o.filled_qty || o.filledQty || 0);

          return {
            orderid: o.orderId,
            tradingsymbol: o.tradingSymbol,
            symboltoken: o.securityId,
            transactiontype: o.transactionType,
            exchange: exchange,
            ordertype: o.orderType,
            producttype: o.productType,
            quantity: qty.toString(),
            price: (o.price || 0).toString(),
            status: o.orderStatus.toLowerCase(),
            orderstatus: o.orderStatus.toLowerCase(),
            updatetime: o.updateTime || o.createTime || new Date().toLocaleString(),
            averageprice: (o.averageTradedPrice ?? 0).toString(),
            correlationId: o.correlationId,
            filledshares: filled.toString(),
            unfilledshares: (qty - filled).toString(),
            expiry: o.drvExpiryDate || '',
            optiontype: o.drvOptionType || '',
            strike: o.drvStrikePrice || 0
          };
        });
        this.cache.orderBook = { data, timestamp: now };
        return data;
      }
      this.cache.orderBook.timestamp = now;
      return this.cache.orderBook.data || [];
    } catch (error) {
      this.handleApiError(error, 'getOrderBook');
      this.log(`Fetch order book failed: ${error.message}`, 'error');
      this.cache.orderBook.timestamp = now;
      return this.cache.orderBook.data || [];
    }
  }

  async getProfile() {
    if (this.account.isSimulated) {
      return { name: `Simulated (${this.account.clientCode || 'User'})` };
    }

    if (!this.session.connected) {
      await this.login();
    }

    try {
      const headers = this.getHeaders();
      this.log('Fetching profile from Dhan...', 'info');
      const response = await axios.get('https://api.dhan.co/v2/profile', this.getConfig(headers));
      if (response.data) {
        let name = response.data.name;
        if (!name) {
          const isNumeric = /^\d+$/.test(this.account.name || '');
          if (this.account.name && !isNumeric) {
            name = this.account.name;
          } else {
            name = response.data.dhanClientId || `Dhan Account ${this.account.clientCode}`;
          }
        }
        return {
          name: name
        };
      }
      return null;
    } catch (error) {
      this.handleApiError(error, 'getProfile');
      this.log(`Fetch profile failed: ${error.message}`, 'error');
      return null;
    }
  }
}

module.exports = DhanTradeService;
