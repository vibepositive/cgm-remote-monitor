'use strict';

const express = require('express');

const MATCH_WINDOW_MS = 2 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemTime(item) {
  const candidates = [
    item && item.date,
    item && item.mills,
    item && item.created_at,
    item && item.timestamp,
    item && item.dateString,
    item && item.openaps && item.openaps.suggested && item.openaps.suggested.timestamp,
    item && item.openaps && item.openaps.enacted && item.openaps.enacted.timestamp
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    const asNumber = Number(candidate);
    if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isFinite(asNumber) && asNumber > 100000000000) {
      return asNumber;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function newestFirst(a, b) {
  return itemTime(b) - itemTime(a);
}

function suggestedFromStatus(status) {
  if (!status || !status.openaps) return null;
  return status.openaps.suggested || status.openaps.enacted || null;
}

function microbolusAmount(suggested) {
  if (!suggested) return null;
  const direct = n(suggested.units);
  if (direct !== null) return direct;
  const match = String(suggested.reason || '').match(/Microbolusing\s+([\d.]+)U/i);
  return match ? Number(match[1]) : null;
}

function maxBolus(suggested) {
  if (!suggested) return null;
  const direct = n(suggested.maxBolus);
  if (direct !== null) return direct;
  const match = String(suggested.reason || '').match(/maxBolus\s+([\d.]+)/i);
  return match ? Number(match[1]) : null;
}

function uamPred(suggested) {
  if (!suggested) return null;
  if (suggested.predBGs && Array.isArray(suggested.predBGs.UAM) && suggested.predBGs.UAM.length) {
    return n(suggested.predBGs.UAM[suggested.predBGs.UAM.length - 1]);
  }
  const match = String(suggested.reason || '').match(/UAMpredBG\s+(-?[\d.]+)/i);
  return match ? Number(match[1]) : null;
}

function nearestDecision(treatment, statuses) {
  const tt = itemTime(treatment);
  const insulin = n(treatment && treatment.insulin);
  let best = null;
  let bestDiff = Infinity;

  (statuses || []).forEach(status => {
    const suggested = suggestedFromStatus(status);
    if (!suggested) return;
    const amount = microbolusAmount(suggested);
    if (amount === null) return;
    if (insulin !== null && Math.abs(amount - insulin) > 0.08) return;

    let st = itemTime(status);
    if (!Number.isFinite(st) || st <= 0) st = itemTime(suggested);
    if (!Number.isFinite(st) || st <= 0) return;

    const diff = Math.abs(st - tt);
    if (diff <= MATCH_WINDOW_MS && diff < bestDiff) {
      best = { suggested, status, diff };
      bestDiff = diff;
    }
  });

  return best;
}

function classifySmb(treatment, statuses) {
  const insulin = n(treatment && treatment.insulin);
  const match = nearestDecision(treatment, statuses);
  if (!match) {
    return {
      type: 'smb',
      label: 'SMB',
      evidence: 'No matching Trio decision found',
      matchSeconds: null,
      insulinReq: null,
      maxBolus: null,
      uamPredBG: null
    };
  }

  const suggested = match.suggested;
  const reason = String(suggested.reason || '');
  const cob = n(suggested.COB);
  const hasUamPrediction = Boolean(suggested.predBGs && Array.isArray(suggested.predBGs.UAM) && suggested.predBGs.UAM.length);
  const reasonMentionsUam = /UAM/i.test(reason);
  const hasUamEvidence = hasUamPrediction || reasonMentionsUam;
  const explicitZeroCob = cob !== null ? cob <= 0.1 : /COB:\s*0(?:\.0+)?(?:\D|$)/i.test(reason);
  const hasNoCobField = cob === null && !/COB:/i.test(reason);
  const uamDriven = hasUamEvidence && (explicitZeroCob || hasNoCobField);
  const max = maxBolus(suggested);
  const insulinReq = n(suggested.insulinReq);
  const capped = Boolean(
    uamDriven &&
    insulin !== null &&
    max !== null &&
    insulinReq !== null &&
    Math.abs(insulin - max) <= 0.08 &&
    insulinReq > max + 0.05
  );

  const evidence = [];
  if (hasUamPrediction) evidence.push('UAM prediction present');
  else if (reasonMentionsUam) evidence.push('decision reason references UAM');
  if (explicitZeroCob) evidence.push('COB is 0');
  if (capped) evidence.push('delivered dose equals maxBolus while insulinReq is higher');
  if (!uamDriven) evidence.push('not enough evidence that UAM was the active driver');

  return {
    type: capped ? 'uam_cap' : (uamDriven ? 'uam' : 'smb'),
    label: capped ? 'UAM cap reached' : (uamDriven ? 'UAM-driven SMB' : 'SMB'),
    evidence: evidence.join('; '),
    matchSeconds: Math.round(match.diff / 1000),
    insulinReq,
    maxBolus: max,
    uamPredBG: uamPred(suggested)
  };
}

function classifyBolus(treatment, statuses) {
  const insulin = n(treatment && treatment.insulin);
  if (insulin === null || insulin <= 0) return null;

  const eventType = String((treatment && treatment.eventType) || '').trim().toUpperCase();
  if (eventType === 'SMB') {
    const smb = classifySmb(treatment, statuses);
    return {
      bolusType: 'automated',
      automationType: smb.type,
      label: smb.label,
      evidence: smb.evidence,
      matchSeconds: smb.matchSeconds,
      insulinReq: smb.insulinReq,
      maxBolus: smb.maxBolus,
      uamPredBG: smb.uamPredBG
    };
  }

  return {
    bolusType: 'manual',
    automationType: null,
    label: 'Manual bolus',
    evidence: `Nightscout eventType is ${treatment && treatment.eventType ? treatment.eventType : 'not SMB'}`,
    matchSeconds: null,
    insulinReq: null,
    maxBolus: null,
    uamPredBG: null
  };
}

function entryView(e) {
  return {
    timestamp: e && (e.dateString || e.created_at || e.date) || null,
    glucose: (e && (e.sgv ?? e.glucose)) ?? null,
    direction: e && e.direction || null,
    noise: (e && e.noise) ?? null
  };
}

function treatmentView(t, statuses) {
  const classification = classifyBolus(t, statuses);
  return {
    timestamp: t && (t.created_at || t.timestamp || t.date) || null,
    eventType: t && t.eventType || null,
    insulin: (t && t.insulin) ?? null,
    carbs: (t && t.carbs) ?? null,
    enteredBy: t && t.enteredBy || null,
    bolusType: classification ? classification.bolusType : null,
    automationType: classification ? classification.automationType : null,
    classificationLabel: classification ? classification.label : null,
    classificationEvidence: classification ? classification.evidence : null,
    matchSeconds: classification ? classification.matchSeconds : null,
    insulinReq: classification ? classification.insulinReq : null,
    maxBolus: classification ? classification.maxBolus : null,
    uamPredBG: classification ? classification.uamPredBG : null,
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
    units: d.units ?? null,
    maxBolus: d.maxBolus ?? null,
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

function dedupe(list, signatureFn) {
  const seen = new Set();
  const out = [];
  (list || []).forEach(item => {
    const id = item && (item._id || item.id);
    const signature = id ? `id:${String(id)}` : signatureFn(item);
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push(item);
  });
  return out;
}

function treatmentSignature(t) {
  return [
    itemTime(t),
    t && t.eventType,
    t && t.insulin,
    t && t.carbs,
    t && t.duration,
    t && t.rate,
    t && t.absolute,
    t && t.enteredBy
  ].join('|');
}

function decisionSignature(d) {
  const openaps = (d && d.openaps) || {};
  const x = openaps.enacted || openaps.suggested || {};
  return [itemTime(d), x.bg, x.insulinReq, x.units, x.rate, x.duration, x.reason].join('|');
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

      const now = Date.now();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const [entriesRaw, treatmentsRaw, deviceRaw, profile] = await Promise.all([
        listAsync(ctx.entries, { count: 500 }, 'entries'),
        listAsync(ctx.treatments, { count: 1500 }, 'treatments'),
        listAsync(ctx.devicestatus, { count: 500 }, 'devicestatus'),
        currentProfileAsync(ctx.profile)
      ]);

      const recent = list => (Array.isArray(list) ? list : [])
        .filter(item => {
          const t = itemTime(item);
          return t >= cutoff && t <= now + FUTURE_TOLERANCE_MS;
        })
        .sort(newestFirst);

      const entries = recent(entriesRaw);
      const treatmentsBeforeDedupe = recent(treatmentsRaw);
      const decisionsBeforeDedupe = recent(deviceRaw);
      const treatments = dedupe(treatmentsBeforeDedupe, treatmentSignature);
      const decisions = dedupe(decisionsBeforeDedupe, decisionSignature);
      const classifications = new Map();
      treatments.forEach(t => classifications.set(t, classifyBolus(t, decisions)));

      const glucose = entries.map(e => Number(e.sgv ?? e.glucose)).filter(Number.isFinite);
      const insulinTreatments = treatments.filter(t => Number(t.insulin) > 0);
      const manualBoluses = insulinTreatments.filter(t => {
        const c = classifications.get(t);
        return c && c.bolusType === 'manual';
      });
      const automatedBoluses = insulinTreatments.filter(t => {
        const c = classifications.get(t);
        return c && c.bolusType === 'automated';
      });
      const uamBoluses = automatedBoluses.filter(t => {
        const c = classifications.get(t);
        return c && (c.automationType === 'uam' || c.automationType === 'uam_cap');
      });
      const cappedUamBoluses = automatedBoluses.filter(t => {
        const c = classifications.get(t);
        return c && c.automationType === 'uam_cap';
      });
      const genericSmbBoluses = automatedBoluses.filter(t => {
        const c = classifications.get(t);
        return c && c.automationType === 'smb';
      });
      const carbs = treatments.filter(t => Number(t.carbs) > 0);
      const sum = list => Number(list.reduce((total, x) => total + Number(x.insulin || 0), 0).toFixed(3));

      return res.json({
        generatedAt: new Date(now).toISOString(),
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
          manualBolusCount: manualBoluses.length,
          automatedBolusTotal: sum(automatedBoluses),
          automatedBolusCount: automatedBoluses.length,
          uamSmbTotal: sum(uamBoluses),
          uamSmbCount: uamBoluses.length,
          uamCapTotal: sum(cappedUamBoluses),
          uamCapCount: cappedUamBoluses.length,
          genericSmbTotal: sum(genericSmbBoluses),
          genericSmbCount: genericSmbBoluses.length,
          carbEntries: carbs.length,
          enteredCarbsTotal: Number(carbs.reduce((total, x) => total + Number(x.carbs || 0), 0).toFixed(1)),
          duplicateTreatmentsRemoved: treatmentsBeforeDedupe.length - treatments.length,
          duplicateDecisionsRemoved: decisionsBeforeDedupe.length - decisions.length
        },
        entries: entries.map(entryView),
        treatments: treatments.map(t => treatmentView(t, decisions)),
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
