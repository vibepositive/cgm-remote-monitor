'use strict';

const express = require('express');

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

function classifyBolus(t) {
  const enteredBy = String((t && t.enteredBy) || '').toLowerCase();
  const eventType = String((t && t.eventType) || '').toLowerCase();
  if (!(Number(t && t.insulin) > 0)) return null;
  if (enteredBy.includes('openaps') || enteredBy.includes('trio') || enteredBy.includes('loop')) return 'automated';
  if (eventType.includes('correction') || eventType.includes('meal') || eventType.includes('bolus')) return 'manual';
  return 'bolus';
}

function entryView(e) {
  return {
    timestamp: e && (e.dateString || e.created_at || e.date) || null,
    glucose: (e && (e.sgv ?? e.glucose)) ?? null,
    direction: e && e.direction || null,
    noise: (e && e.noise) ?? null
  };
}

function treatmentView(t) {
  return {
    timestamp: t && (t.created_at || t.timestamp || t.date) || null,
    eventType: t && t.eventType || null,
    insulin: (t && t.insulin) ?? null,
    carbs: (t && t.carbs) ?? null,
    enteredBy: t && t.enteredBy || null,
    bolusType: classifyBolus(t),
    duration: (t && t.duration) ?? null,
    rate: (t && t.rate) ?? null,
    absolute: (t && t.absolute) ?? null,
    notes: t && t.notes || null
  };
}

function decisionView(ds) {
  const openaps = (ds && ds.openaps) || {};
  const d = openaps.enacted || openaps.suggested || {};
  const iob = openaps.iob || {};
  const pred = d.predBGs || {};
  return {
    timestamp: ds && (ds.created_at || d.timestamp) || null,
    bg: d.bg ?? null,
    delta: d.delta ?? d.minDelta ?? null,
    eventualBG: d.eventualBG ?? null,
    insulinReq: d.insulinReq ?? null,
    tempRate: d.rate ?? null,
    tempDuration: d.duration ?? null,
    iob: iob.iob ?? d.IOB ?? null,
    bolusIob: iob.bolusiob ?? null,
    basalIob: iob.basaliob ?? null,
    bolusInsulin: iob.bolusinsulin ?? null,
    netBasalInsulin: iob.netbasalinsulin ?? null,
    activity: iob.activity ?? null,
    cob: d.COB ?? null,
    cr: d.CR ?? null,
    effectiveIsf: d.ISF ?? null,
    sensitivityRatio: d.sensitivityRatio ?? null,
    target: d.current_target ?? null,
    threshold: d.threshold ?? null,
    tdd: d.TDD ?? null,
    reason: d.reason ?? null,
    predictions: {
      uam: pred.UAM || [],
      iob: pred.IOB || [],
      zt: pred.ZT || [],
      cob: pred.COB || []
    }
  };
}

function listAsync(module, query, label) {
  return new Promise((resolve, reject) => {
    if (!module || typeof module.list !== 'function') {
      return reject(new Error(`${label} storage module unavailable`));
    }
    module.list(query, (err, results) => {
      if (err) return reject(new Error(`${label} query failed: ${err.message || err}`));
      resolve(Array.isArray(results) ? results : []);
    });
  });
}

function currentProfileAsync(profile) {
  return new Promise((resolve, reject) => {
    if (!profile || typeof profile.last !== 'function') {
      return reject(new Error('profile storage module unavailable'));
    }
    profile.last((err, records) => {
      if (err) return reject(new Error(`profile query failed: ${err.message || err}`));
      resolve(Array.isArray(records) && records.length ? records[0] : null);
    });
  });
}

module.exports = function monitorBridge(env, ctx) {
  const router = express.Router();
  const key = process.env.MONITOR_BRIDGE_KEY;

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'nightscout-monitor',
      configured: Boolean(key),
      source: 'nightscout-context'
    });
  });

  router.get('/24h', async (req, res) => {
    try {
      const supplied = req.get('x-monitor-key') || req.query.key;
      if (!key) return res.status(503).json({ ok: false, error: 'monitor not configured' });
      if (supplied !== key) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (!ctx) return res.status(503).json({ ok: false, error: 'nightscout context unavailable' });

      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const [entriesRaw, treatmentsRaw, deviceRaw, profile] = await Promise.all([
        listAsync(ctx.entries, { count: 500 }, 'entries'),
        listAsync(ctx.treatments, { count: 1500 }, 'treatments'),
        listAsync(ctx.devicestatus, { count: 500 }, 'devicestatus'),
        currentProfileAsync(ctx.profile)
      ]);

      const recent = list => (Array.isArray(list) ? list : [])
        .filter(item => itemTime(item) >= cutoff)
        .sort(newestFirst);

      const entries = recent(entriesRaw);
      const treatments = recent(treatmentsRaw);
      const decisions = recent(deviceRaw);
      const glucose = entries.map(e => Number(e.sgv ?? e.glucose)).filter(Number.isFinite);
      const insulinTreatments = treatments.filter(t => Number(t.insulin) > 0);
      const manualBoluses = insulinTreatments.filter(t => classifyBolus(t) === 'manual');
      const automatedBoluses = insulinTreatments.filter(t => classifyBolus(t) === 'automated');
      const carbs = treatments.filter(t => Number(t.carbs) > 0);
      const sum = list => Number(list.reduce((total, x) => total + Number(x.insulin || 0), 0).toFixed(3));

      return res.json({
        generatedAt: new Date().toISOString(),
        windowHours: 24,
        summary: {
          readings: glucose.length,
          minGlucose: glucose.length ? Math.min(...glucose) : null,
          maxGlucose: glucose.length ? Math.max(...glucose) : null,
          averageGlucose: glucose.length ? Number((glucose.reduce((a, b) => a + b, 0) / glucose.length).toFixed(1)) : null,
          percent70to180: glucose.length ? Number((100 * glucose.filter(g => g >= 70 && g <= 180).length / glucose.length).toFixed(1)) : null,
          percentBelow70: glucose.length ? Number((100 * glucose.filter(g => g < 70).length / glucose.length).toFixed(1)) : null,
          percentAbove180: glucose.length ? Number((100 * glucose.filter(g => g > 180).length / glucose.length).toFixed(1)) : null,
          insulinTotal: sum(insulinTreatments),
          manualBolusTotal: sum(manualBoluses),
          automatedBolusTotal: sum(automatedBoluses),
          carbEntries: carbs.length,
          enteredCarbsTotal: Number(carbs.reduce((total, x) => total + Number(x.carbs || 0), 0).toFixed(1))
        },
        entries: entries.map(entryView),
        treatments: treatments.map(treatmentView),
        decisions: decisions.map(decisionView),
        profile
      });
    } catch (err) {
      console.error('Nightscout monitor /24h failed:', err && err.stack ? err.stack : err);
      return res.status(502).json({
        ok: false,
        error: 'monitor data query failed',
        detail: err && err.message ? err.message : String(err)
      });
    }
  });

  return router;
};
