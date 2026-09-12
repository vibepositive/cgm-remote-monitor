'use strict';

const express = require('express');

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function itemTime(item) {
  const candidates = [
    item && item.date,
    item && item.mills,
    item && item.created_at,
    item && item.timestamp,
    item && item.openaps && item.openaps.suggested && item.openaps.suggested.timestamp,
    item && item.openaps && item.openaps.enacted && item.openaps.enacted.timestamp
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function newestFirst(a, b) {
  return itemTime(b) - itemTime(a);
}

function extractDecision(ds) {
  const openaps = (ds && ds.openaps) || {};
  const decision = openaps.enacted || openaps.suggested || {};
  const iob = openaps.iob || {};
  const predictions = decision.predBGs || {};
  return {
    timestamp: ds && (ds.created_at || decision.timestamp) || null,
    bg: decision.bg ?? null,
    delta: decision.delta ?? decision.minDelta ?? null,
    eventualBG: decision.eventualBG ?? null,
    insulinReq: decision.insulinReq ?? null,
    tempRate: decision.rate ?? null,
    tempDuration: decision.duration ?? null,
    iob: iob.iob ?? decision.IOB ?? null,
    bolusIob: iob.bolusiob ?? null,
    basalIob: iob.basaliob ?? null,
    bolusInsulin: iob.bolusinsulin ?? null,
    netBasalInsulin: iob.netbasalinsulin ?? null,
    activity: iob.activity ?? null,
    cob: decision.COB ?? null,
    cr: decision.CR ?? null,
    effectiveIsf: decision.ISF ?? null,
    sensitivityRatio: decision.sensitivityRatio ?? null,
    target: decision.current_target ?? null,
    threshold: decision.threshold ?? null,
    tdd: decision.TDD ?? null,
    reason: decision.reason ?? null,
    predictions: {
      uam: predictions.UAM || [],
      iob: predictions.IOB || [],
      zt: predictions.ZT || [],
      cob: predictions.COB || []
    }
  };
}

function extractEntry(entry) {
  return {
    timestamp: entry && (entry.dateString || entry.created_at || entry.date) || null,
    date: entry && entry.date || null,
    glucose: (entry && (entry.sgv ?? entry.glucose)) || null,
    direction: entry && entry.direction || null,
    noise: (entry && entry.noise) ?? null,
    device: entry && entry.device || null
  };
}

function extractTreatment(t) {
  return {
    timestamp: t && (t.created_at || t.timestamp || t.date) || null,
    eventType: t && t.eventType || null,
    insulin: (t && t.insulin) ?? null,
    carbs: (t && t.carbs) ?? null,
    enteredBy: t && t.enteredBy || null,
    notes: t && t.notes || null,
    duration: (t && t.duration) ?? null,
    rate: (t && t.rate) ?? null,
    absolute: (t && t.absolute) ?? null
  };
}

function buildSummary(entries, treatments, deviceStatus, hours) {
  const glucose = entries.map(e => e.sgv ?? e.glucose).filter(v => Number.isFinite(Number(v))).map(Number);
  const range = glucose.length ? {
    min: Math.min(...glucose),
    max: Math.max(...glucose),
    average: Math.round(glucose.reduce((a, b) => a + b, 0) / glucose.length),
    readings: glucose.length,
    below70: glucose.filter(v => v < 70).length,
    above180: glucose.filter(v => v > 180).length
  } : null;
  const insulinTreatments = treatments.filter(t => Number(t.insulin) > 0);
  const carbTreatments = treatments.filter(t => Number(t.carbs) > 0);
  return {
    hours,
    generatedAt: new Date().toISOString(),
    glucose: range,
    insulinTreatmentCount: insulinTreatments.length,
    treatmentInsulinTotal: Number(insulinTreatments.reduce((sum, t) => sum + Number(t.insulin || 0), 0).toFixed(3)),
    carbTreatmentCount: carbTreatments.length,
    enteredCarbsTotal: Number(carbTreatments.reduce((sum, t) => sum + Number(t.carbs || 0), 0).toFixed(1)),
    deviceStatusCount: deviceStatus.length,
    latestDecision: deviceStatus.length ? extractDecision(deviceStatus[0]) : null
  };
}

module.exports = function monitorBridge(env) {
  const router = express.Router();
  const key = process.env.MONITOR_BRIDGE_KEY;
  const token = process.env.MONITOR_NIGHTSCOUT_TOKEN;
  const localPort = env.PORT || process.env.PORT || 1337;
  const base = `http://127.0.0.1:${localPort}`;

  if (!key || !token) {
    router.get('*', (req, res) => res.status(503).json({
      ok: false,
      error: 'monitor bridge is not configured'
    }));
    return router;
  }

  function authorize(req, res, next) {
    const supplied = req.get('x-monitor-key') || req.query.key;
    if (supplied !== key) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  }

  async function ns(path) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${base}${path}${separator}token=${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Nightscout ${path} returned ${response.status}`);
    return response.json();
  }

  function hoursFor(req) {
    return Math.max(1, Math.min(168, asNumber(req.query.hours, 24)));
  }

  async function load(hours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const entryCount = Math.min(2500, Math.ceil(hours * 15) + 100);
    const dsCount = Math.min(2500, Math.ceil(hours * 15) + 100);
    const treatmentCount = Math.min(2500, Math.ceil(hours * 50) + 200);
    const [entriesRaw, treatmentsRaw, deviceRaw, profilesRaw] = await Promise.all([
      ns(`/api/v1/entries.json?count=${entryCount}`),
      ns(`/api/v1/treatments.json?count=${treatmentCount}`),
      ns(`/api/v1/devicestatus.json?count=${dsCount}`),
      ns('/api/v1/profile.json?count=10')
    ]);
    const filterRecent = list => (Array.isArray(list) ? list : []).filter(item => itemTime(item) >= cutoff).sort(newestFirst);
    return {
      entries: filterRecent(entriesRaw),
      treatments: filterRecent(treatmentsRaw),
      deviceStatus: filterRecent(deviceRaw),
      profiles: Array.isArray(profilesRaw) ? profilesRaw : []
    };
  }

  router.get('/health', (req, res) => res.json({ ok: true, service: 'nightscout-monitor-bridge' }));

  router.use(authorize);

  router.get('/current', async (req, res, next) => {
    try {
      const data = await load(2);
      res.json({
        generatedAt: new Date().toISOString(),
        entry: data.entries.length ? extractEntry(data.entries[0]) : null,
        decision: data.deviceStatus.length ? extractDecision(data.deviceStatus[0]) : null,
        recentTreatments: data.treatments.slice(0, 20).map(extractTreatment),
        profile: data.profiles[0] || null
      });
    } catch (err) { next(err); }
  });

  router.get('/summary', async (req, res, next) => {
    try {
      const hours = hoursFor(req);
      const data = await load(hours);
      res.json(buildSummary(data.entries, data.treatments, data.deviceStatus, hours));
    } catch (err) { next(err); }
  });

  router.get('/history', async (req, res, next) => {
    try {
      const hours = hoursFor(req);
      const data = await load(hours);
      res.json({
        generatedAt: new Date().toISOString(),
        hours,
        summary: buildSummary(data.entries, data.treatments, data.deviceStatus, hours),
        entries: data.entries.map(extractEntry),
        treatments: data.treatments.map(extractTreatment),
        decisions: data.deviceStatus.map(extractDecision),
        profile: data.profiles[0] || null
      });
    } catch (err) { next(err); }
  });

  router.get('/events', async (req, res, next) => {
    try {
      const hours = hoursFor(req);
      const data = await load(hours);
      const timeline = [];
      data.entries.forEach(e => timeline.push({ type: 'glucose', at: itemTime(e), data: extractEntry(e) }));
      data.treatments.forEach(t => timeline.push({ type: 'treatment', at: itemTime(t), data: extractTreatment(t) }));
      data.deviceStatus.forEach(d => timeline.push({ type: 'decision', at: itemTime(d), data: extractDecision(d) }));
      timeline.sort((a, b) => b.at - a.at);
      res.json({ generatedAt: new Date().toISOString(), hours, events: timeline });
    } catch (err) { next(err); }
  });

  return router;
};
