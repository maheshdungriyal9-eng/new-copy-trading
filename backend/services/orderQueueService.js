const crypto = require('crypto');
const copyEngine = require('./copyTradingEngine');
const dbService = require('./dbService');
const validation = require('./validationService');

function parseJob(row) {
  if (!row) return null;
  return { ...row, tradeParams: JSON.parse(row.tradeParams), metadata: JSON.parse(row.metadata || '{}'), result: row.result ? JSON.parse(row.result) : null };
}

function uncertain(message) {
  return /timeout|timedout|network|socket|econn|502|503|504|gateway|fetch failed/i.test(message || '');
}

function orderId(response) {
  return response?.data?.orderid || response?.data?.orderId || response?.uniqueorderid || response?.orderId || null;
}

class OrderQueueService {
  constructor(database = dbService, engine = copyEngine) {
    this.database = database;
    this.engine = engine;
    this.processingAccounts = new Set();
    this.ticking = false;
    this.reconciling = false;
    this.timer = null;
  }

  async start() {
    await this.database.run("UPDATE jobs SET status = 'RECONCILE_REQUIRED', error = 'Server restarted during execution; broker reconciliation required' WHERE status IN ('PROCESSING', 'RETRACTED_WAIT')");
    await this.database.run("CREATE UNIQUE INDEX IF NOT EXISTS jobs_processing_account ON jobs(targetId) WHERE status = 'PROCESSING'");
    this.timer = setInterval(() => { this.tick(); this.reconcile(); }, 2000);
    this.timer.unref?.();
    await this.tick();
  }

  async enqueueOrder(userId, targetId, params, metadata = {}) {
    const tradeParams = validation.trade(params);
    const identity = metadata?.trackingKey
      ? [metadata.trackingKey, targetId, metadata.expectedChildQty].join(':')
      : [userId, targetId, params.requestId || crypto.randomUUID()].join(':');
    const jobId = 'job_' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const referenceSize = this.engine.services[targetId]?.account.broker === 'motilal' ? 10 : 19;
    const brokerRef = crypto.createHash('sha256').update(jobId).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, referenceSize);
    tradeParams.clientOrderId = brokerRef;
    tradeParams.correlationId = brokerRef;
    await this.database.run(
      "INSERT OR IGNORE INTO jobs (id, userId, targetId, tradeParams, status, createdAt, retryCount, metadata) VALUES (?, ?, ?, ?, 'QUEUED', ?, 0, ?)",
      [jobId, userId, targetId, JSON.stringify(tradeParams), new Date().toISOString(), JSON.stringify(metadata || {})]
    );
    const existing = await this.getJobStatus(jobId);
    const comparable = value => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !['clientOrderId', 'correlationId'].includes(key)).sort(([left], [right]) => left.localeCompare(right))));
    if (comparable(existing.tradeParams) !== comparable(tradeParams)) validation.reject('Request ID was already used for a different order');
    queueMicrotask(() => this.tick());
    return jobId;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = await this.database.all("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY createdAt ASC");
      for (const row of rows) {
        const job = parseJob(row);
        if (this.processingAccounts.has(job.targetId)) continue;
        if (Date.now() - Date.parse(job.createdAt) > 120000) {
          await this.database.run("UPDATE jobs SET status = 'EXPIRED', error = 'Queued order expired before placement' WHERE id = ? AND status = 'QUEUED'", [job.id]);
          continue;
        }
        const service = this.engine.services[job.targetId];
        if (!service || (!service.account.isSimulated && !service.session.connected)) continue;
        this.processingAccounts.add(job.targetId);
        try {
          const claimed = await this.database.run(
            "UPDATE jobs SET status = 'PROCESSING', startedAt = ? WHERE id = ? AND status = 'QUEUED'",
            [new Date().toISOString(), job.id]
          );
          if (!claimed.changes) { this.processingAccounts.delete(job.targetId); continue; }
          this.runJob(job).catch(error => console.error('[OrderQueue] Job requires reconciliation:', error.message)).finally(() => {
            this.processingAccounts.delete(job.targetId);
            this.tick();
          });
        } catch (error) {
          this.processingAccounts.delete(job.targetId);
          if (error.code !== 'SQLITE_CONSTRAINT') throw error;
        }
      }
    } catch (error) {
      console.error('[OrderQueue] Queue error:', error.message);
    } finally {
      this.ticking = false;
    }
  }

  async runJob(job) {
    let placementStarted = false;
    try {
      const service = this.engine.services[job.targetId];
      if (!service) throw new Error('Account no longer exists');
      const params = validation.trade(job.tradeParams);
      await this.engine.validateOrder(job.targetId, params, job.id);
      placementStarted = true;
      const isMaster = this.engine.mappings.some(mapping => mapping.active !== false && mapping.masterId === job.targetId);
      const result = isMaster
        ? await this.engine.handleCopyTrade(job.targetId, params)
        : { masterResponse: await service.placeOrder(params) };
      const response = result.masterResponse;
      const accepted = response && (response.status === true || response.status === 'SUCCESS' || response.success === true);
      if (!accepted) {
        const message = result.error || response?.message || 'Broker rejected order';
        const error = new Error(message);
        error.definitive = response?.uncertain !== true && !uncertain(message);
        throw error;
      }
      const brokerOrderId = orderId(response);
      if (!brokerOrderId) throw new Error('Broker acceptance could not be confirmed: missing order ID');
      await this.database.run(
        "UPDATE jobs SET status = 'ACCEPTED', result = ?, error = NULL WHERE id = ?",
        [JSON.stringify({ success: true, brokerOrderId, masterResponse: response, filledQuantity: 0 }), job.id]
      );
      service.clearCache?.();
    } catch (error) {
      const status = placementStarted && !error.definitive ? 'RECONCILE_REQUIRED' : 'FAILED';
      await this.database.run("UPDATE jobs SET status = ?, completedAt = ?, error = ? WHERE id = ?", [status, new Date().toISOString(), error.message, job.id]);
      this.engine.addLog({ timestamp: new Date().toISOString(), accountId: job.targetId, type: 'error', broker: 'Queue', message: error.message });
    }
  }

  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = await this.database.all("SELECT * FROM jobs WHERE status IN ('ACCEPTED', 'RECONCILE_REQUIRED')");
      const books = new Map();
      for (const row of rows) {
        const job = parseJob(row);
        const service = this.engine.services[job.targetId];
        if (!service || (!service.account.isSimulated && !service.session.connected)) continue;
        if (!books.has(job.targetId)) books.set(job.targetId, await service.getOrderBook(true));
        const order = (books.get(job.targetId) || []).find(item =>
          (job.result?.brokerOrderId && String(item.orderid) === String(job.result.brokerOrderId)) ||
          (item.correlationId && item.correlationId === (service.account.broker === 'angel_one' ? job.tradeParams.correlationId?.slice(0, 19) : job.tradeParams.correlationId))
        );
        if (!order) continue;
        const rawStatus = String(order.orderstatus || order.status || '').toLowerCase();
        const completed = ['complete', 'executed', 'traded', 'trd'].includes(rawStatus);
        const failed = ['rejected', 'failed', 'error', 'cancelled', 'canceled', 'expired'].includes(rawStatus);
        const status = completed ? 'COMPLETED' : failed ? 'FAILED' : 'ACCEPTED';
        const filledQuantity = Number(order.filledshares ?? (completed ? order.quantity : 0)) || 0;
        const result = { ...(job.result || {}), success: !failed, brokerOrderId: order.orderid, filledQuantity, brokerStatus: rawStatus };
        await this.database.run("UPDATE jobs SET status = ?, result = ?, error = ?, completedAt = ? WHERE id = ?", [
          status, JSON.stringify(result), failed ? (order.message || 'Broker order ' + rawStatus) : null,
          completed || failed ? new Date().toISOString() : null, job.id
        ]);
        service.clearCache?.();
      }
    } catch (error) {
      console.error('[OrderQueue] Reconciliation error:', error.message);
    } finally {
      this.reconciling = false;
    }
  }

  async getCopyProgress(trackingKey, targetId) {
    const rows = await this.database.all("SELECT * FROM jobs WHERE targetId = ? ORDER BY createdAt ASC", [targetId]);
    const jobs = rows.map(parseJob).filter(job => job.metadata.trackingKey === trackingKey);
    return {
      reserved: Math.max(0, ...jobs.map(job => Number(job.metadata.expectedChildQty) || 0)),
      blocked: jobs.some(job => ['FAILED', 'EXPIRED', 'RECONCILE_REQUIRED'].includes(job.status))
    };
  }

  async getJobStatus(jobId) {
    return parseJob(await this.database.get("SELECT * FROM jobs WHERE id = ?", [jobId]));
  }

  async retryJob(jobId, userId) {
    const job = await this.getJobStatus(jobId);
    const service = job && this.engine.services[job.targetId];
    if (!job || service?.account.ownerId !== userId) validation.reject('Job not found');
    if (!['FAILED', 'EXPIRED'].includes(job.status)) validation.reject('Only definitively failed or expired jobs can be retried');
    if (Number(job.result?.filledQuantity) > 0) validation.reject('Partially filled orders require manual position review; automatic retry is prohibited');
    if (job.result?.brokerOrderId) {
      const orders = await service.getOrderBook(true);
      const order = orders.find(item => String(item.orderid) === String(job.result.brokerOrderId));
      if (!order || !['rejected', 'cancelled', 'canceled', 'expired', 'failed'].includes(String(order.orderstatus || order.status).toLowerCase()) || Number(order.filledshares || 0) > 0) validation.reject('Broker has not confirmed a terminal, zero-fill order');
    }
    if (job.metadata.trackingKey && !this.engine.mappings.some(mapping => mapping.active && mapping.childId === job.targetId && job.metadata.trackingKey.startsWith(mapping.masterId + '_'))) validation.reject('Copy mapping is no longer active');
    await this.engine.validateOrder(job.targetId, job.tradeParams);
    const params = { ...job.tradeParams, clientOrderId: crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, service.account.broker === 'motilal' ? 10 : 19) };
    params.correlationId = params.clientOrderId;
    const updated = await this.database.run("UPDATE jobs SET status = 'QUEUED', tradeParams = ?, result = NULL, error = NULL, completedAt = NULL, createdAt = ?, retryCount = retryCount + 1 WHERE id = ? AND status = ? AND retryCount = ?", [JSON.stringify(params), new Date().toISOString(), jobId, job.status, job.retryCount]);
    if (!updated.changes) validation.reject('Job changed during review; refresh its status');
    queueMicrotask(() => this.tick());
    return this.getJobStatus(jobId);
  }

  async listJobs(userId) {
    const accounts = Object.values(this.engine.services).filter(service => service.account.ownerId === userId).map(service => service.account.id);
    if (!accounts.length) return [];
    const rows = await this.database.all("SELECT * FROM jobs WHERE targetId IN (" + accounts.map(() => '?').join(',') + ") ORDER BY createdAt DESC LIMIT 200", accounts);
    return rows.map(parseJob);
  }
}

module.exports = new OrderQueueService();
module.exports.OrderQueueService = OrderQueueService;
