const { monitorEventLoopDelay } = require('perf_hooks');
const {Utilities} = require("./library/utilities");
const escape = require('escape-html');

class ServerStats {
  started = false;
  requestCount = 0;
  staticRequestCount = 0;
  requestTime = 0;
  // Collect metrics every 10 minutes
  intervalMs = 10 * 60 * 1000;
  history = [];
  requestCountSnapshot = 0;
  startMem = 0;
  startTime = Date.now();
  timer;
  cachingModules = [];
  taskMap = new Map();

  constructor() {
    this.timer = setInterval(() => {
      this.recordMetrics();
    }, this.intervalMs);
  }

  recordMetrics() {
    if (this.started) {
      const now = Date.now();

      const currentMem = process.memoryUsage().heapUsed;
      const combinedCount = this.requestCount + this.staticRequestCount;
      const requestsDelta = combinedCount - this.requestCountSnapshot;
      const requestsTat = requestsDelta > 0 ? this.requestTime / requestsDelta : 0;
      const minutesSinceStart = this.history.length > 1
        ? this.intervalMs / 60000
        : (now - this.startTime) / 60000;
      const requestsPerMin = minutesSinceStart > 0 ? requestsDelta / minutesSinceStart : 0;

      const loopDelay = this.eventLoopMonitor.mean / 1e6;
      // Worst single stall in the window - the mean dilutes a multi-second
      // event-loop block into noise; the max is what shows request-freezing
      // stalls (see the 2026-07-30 tx.fhir.org incident).
      const loopMax = this.eventLoopMonitor.max / 1e6;
      // Two distinct caches: the expansion cache (count entries) and the client
      // (resource) cache (count concepts held - a sense of how much it's carrying).
      let expansionItems = 0;
      let clientConcepts = 0;
      for (let m of this.cachingModules) {
        if (typeof m.expansionItemCount === 'function') {
          expansionItems = expansionItems + m.expansionItemCount();
        }
        if (typeof m.clientConceptCount === 'function') {
          clientConcepts = clientConcepts + m.clientConceptCount();
        }
      }

      this.history.push({time: now, mem: currentMem - this.startMem, rpm: requestsPerMin, tat: requestsTat, block: loopDelay, blockMax: loopMax, expansion: expansionItems, clientConcepts: clientConcepts});

      this.eventLoopMonitor.reset();
      this.requestCountSnapshot = combinedCount;
      this.requestTime = 0;
      this.lastTime = now;

      // Prune old data (keep 24 hours)
      const cutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago
      this.history = this.history.filter(m => m.time > cutoff);
    }
  }

  markStarted() {
    this.started = true;
    this.startMem = process.memoryUsage().heapUsed;
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopMonitor.enable();
    this.recordMetrics();
  }

  countRequest(name, tat) {
    // we ignore name for now, but we might split the tat tracking up by name
    // at some stage
    this.requestCount++;
    this.requestTime = this.requestTime + tat;
  }

  addTask(name, frequency) {
    let info = {};
    this.taskMap.set(name, info);
    info.frequency = frequency;
    info.state = "Started";
    info.status = "started"
  }

  task(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'working';
    }
  }

  taskDone(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'resting';
    }
  }

  taskError(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'error';
    }
  }

  taskDetails() {
    if (this.taskMap.size == 0) {
      return "";
    }
    let html = '<table class="grid" >';
    html += "<tr><th>Background Task</th><th>Status</th><th>Frequency</th><th>Last Seen</th></tr>";
    for (let m of this.taskMap.keys()) {
      let mm = this.taskMap.get(m);
      let color = this.getTaskColor(mm.status);
      html += `<tr style="background-color: ${color}"><td>`;
      html += escape(m);
      html += "</td><td>";
      html += escape(mm.state);
      html += "</td><td>";
      html += mm.frequency;
      html += "</td><td>";
      html += Utilities.formatDuration(mm.date, Date.now());
      html += "</td></tr>";
    }
    html += "</table>";
    return html;
  }

  finishStats() {
    clearInterval(this.timer);
  }

  // Live cache aggregates across all registered caching modules (defensive: a
  // module that doesn't expose a given metric contributes 0).
  _sumCachingModules(method) {
    let total = 0;
    for (let m of this.cachingModules) {
      if (typeof m[method] === 'function') {
        total = total + m[method]();
      }
    }
    return total;
  }

  expansionItems() { return this._sumCachingModules('expansionItemCount'); }
  clientCaches() { return this._sumCachingModules('clientCacheCount'); }
  clientConcepts() { return this._sumCachingModules('clientConceptCount'); }
  maxClientCaches() { return this._sumCachingModules('maxClientCacheCount'); }
  maxClientConcepts() { return this._sumCachingModules('maxClientConceptCount'); }

  getTaskColor(status) {
    switch (status) {
      case "started": return "LightGrey";
      case "working": return "LightGreen";
      case "resting": return "White";
      case "error": return "LightRed";
      default: return "DarkBlue"; // should not happen
    }
  }
}
module.exports = ServerStats;