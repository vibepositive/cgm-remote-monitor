import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const NIGHTSCOUT_URL = (process.env.NIGHTSCOUT_URL || '').replace(/\/$/, '');
const NIGHTSCOUT_TOKEN = process.env.NIGHTSCOUT_TOKEN || '';
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';

if (!NIGHTSCOUT_URL || !NIGHTSCOUT_TOKEN || !BRIDGE_KEY) {
  console.error('Missing required env vars: NIGHTSCOUT_URL, NIGHTSCOUT_TOKEN, BRIDGE_KEY');
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(body));
};

const authed = (req, url) => {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const key = url.searchParams.get('key') || bearer;
  return key === BRIDGE_KEY;
};

const nsFetch = async (path, params = {}) => {
  const url = new URL(`${NIGHTSCOUT_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('token', NIGHTSCOUT_TOKEN);

  const r = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`Nightscout ${path} returned ${r.status}`);
  return r.json();
};

const parseTs = (x) => {
  const candidates = [x?.dateString, x?.created_at, x?.timestamp, x?.date, x?.mills, x?.openaps?.suggested?.timestamp, x?.openaps?.enacted?.timestamp];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const d = typeof c === 'number' ? new Date(c) : new Date(String(c));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return null;
};

const inWindow = (x, cutoff) => {
  const t = parseTs(x);
  return t !== null && t >= cutoff;
};

const firstFinite = (...vals) => vals.find((v) => Number.isFinite(v));

const simplifyEntry = (e) => ({
  timestamp: new Date(parseTs(e)).toISOString(),
  glucose: firstFinite(Number(e.sgv), Number(e.glucose), Number(e.mbg)),
  delta: Number.isFinite(Number(e.delta)) ? Number(e.delta) : undefined,
  direction: e.direction,
  device: e.device
});

const simplifyTreatment = (t) => ({
  timestamp: new Date(parseTs(t)).toISOString(),
  eventType: t.eventType,
  insulin: Number.isFinite(Number(t.insulin)) ? Number(t.insulin) : undefined,
  carbs: Number.isFinite(Number(t.carbs)) ? Number(t.carbs) : undefined,
  duration: Number.isFinite(Number(t.duration)) ? Number(t.duration) : undefined,
  rate: Number.isFinite(Number(t.rate)) ? Number(t.rate) : undefined,
  enteredBy: t.enteredBy,
  notes: t.notes
});

const simplifyDevice = (d) => {
  const o = d?.openaps || {};
  const s = o.suggested || o.enacted || {};
  const i = o.iob || {};
  const pred = s.predBGs || {};
  return {
    timestamp: new Date(parseTs(d)).toISOString(),
    bg: Number.isFinite(Number(s.bg)) ? Number(s.bg) : undefined,
    iob: Number.isFinite(Number(i.iob ?? s.IOB)) ? Number(i.iob ?? s.IOB) : undefined,
    bolusIob: Number.isFinite(Number(i.bolusiob)) ? Number(i.bolusiob) : undefined,
    basalIob: Number.isFinite(Number(i.basaliob)) ? Number(i.basaliob) : undefined,
    bolusInsulin: Number.isFinite(Number(i.bolusinsulin)) ? Number(i.bolusinsulin) : undefined,
    netBasalInsulin: Number.isFinite(Number(i.netbasalinsulin)) ? Number(i.netbasalinsulin) : undefined,
    insulinReq: Number.isFinite(Number(s.insulinReq)) ? Number(s.insulinReq) : undefined,
    tempRate: Number.isFinite(Number(s.rate)) ? Number(s.rate) : undefined,
    tempDuration: Number.isFinite(Number(s.duration)) ? Number(s.duration) : undefined,
    eventualBg: Number.isFinite(Number(s.eventualBG)) ? Number(s.eventualBG) : undefined,
    effectiveIsf: Number.isFinite(Number(s.ISF)) ? Number(s.ISF) : undefined,
    sensitivityRatio: Number.isFinite(Number(s.sensitivityRatio)) ? Number(s.sensitivityRatio) : undefined,
    cob: Number.isFinite(Number(s.COB)) ? Number(s.COB) : undefined,
    tdd: Number.isFinite(Number(s.TDD)) ? Number(s.TDD) : undefined,
    target: Number.isFinite(Number(s.current_target)) ? Number(s.current_target) : undefined,
    threshold: Number.isFinite(Number(s.threshold)) ? Number(s.threshold) : undefined,
    minPredBg: Number.isFinite(Number(s.minPredBG)) ? Number(s.minPredBG) : undefined,
    minGuardBg: Number.isFinite(Number(s.minGuardBG)) ? Number(s.minGuardBG) : undefined,
    predictions: {
      uam: Array.isArray(pred.UAM) ? pred.UAM : undefined,
      iob: Array.isArray(pred.IOB) ? pred.IOB : undefined,
      zeroTemp: Array.isArray(pred.ZT) ? pred.ZT : undefined,
      cob: Array.isArray(pred.COB) ? pred.COB : undefined
    },
    reason: s.reason,
    version: o.version
  };
};

const fetchWindow = async (hours) => {
  const safeHours = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const cutoff = Date.now() - safeHours * 3600_000;

  const [entriesRaw, treatmentsRaw, deviceRaw, profileRaw] = await Promise.all([
    nsFetch('/api/v1/entries.json', { count: 2500 }),
    nsFetch('/api/v1/treatments.json', { count: 2500 }),
    nsFetch('/api/v1/devicestatus.json', { count: 2500 }),
    nsFetch('/api/v1/profile.json', { count: 20 })
  ]);

  const entries = (Array.isArray(entriesRaw) ? entriesRaw : []).filter((x) => inWindow(x, cutoff)).map(simplifyEntry).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const treatments = (Array.isArray(treatmentsRaw) ? treatmentsRaw : []).filter((x) => inWindow(x, cutoff)).map(simplifyTreatment).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const deviceStatus = (Array.isArray(deviceRaw) ? deviceRaw : []).filter((x) => inWindow(x, cutoff)).map(simplifyDevice).sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    generatedAt: new Date().toISOString(),
    hours: safeHours,
    counts: { entries: entries.length, treatments: treatments.length, deviceStatus: deviceStatus.length },
    entries,
    treatments,
    deviceStatus,
    profiles: Array.isArray(profileRaw) ? profileRaw : []
  };
};

const summarize = (data) => {
  const gs = data.entries.map((x) => x.glucose).filter(Number.isFinite);
  const avg = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : null;
  const pct = (fn) => gs.length ? 100 * gs.filter(fn).length / gs.length : null;
  const latestEntry = data.entries.at(-1) || null;
  const latestDevice = data.deviceStatus.at(-1) || null;
  const insulinTreatments = data.treatments.filter((t) => Number.isFinite(t.insulin) && t.insulin > 0);
  const carbTreatments = data.treatments.filter((t) => Number.isFinite(t.carbs) && t.carbs > 0);
  return {
    generatedAt: data.generatedAt,
    hours: data.hours,
    counts: data.counts,
    glucose: gs.length ? {
      latest: latestEntry,
      min: Math.min(...gs),
      max: Math.max(...gs),
      average: Math.round(avg * 10) / 10,
      percent70to180: Math.round(pct((g) => g >= 70 && g <= 180) * 10) / 10,
      percentBelow70: Math.round(pct((g) => g < 70) * 10) / 10,
      percentAbove180: Math.round(pct((g) => g > 180) * 10) / 10
    } : null,
    insulinTreatmentCount: insulinTreatments.length,
    insulinTreatmentUnits: Math.round(insulinTreatments.reduce((a, t) => a + t.insulin, 0) * 100) / 100,
    carbTreatmentCount: carbTreatments.length,
    carbTreatmentGrams: Math.round(carbTreatments.reduce((a, t) => a + t.carbs, 0) * 10) / 10,
    latestTrioDecision: latestDevice,
    latestProfile: data.profiles?.[0] || null
  };
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'nightscout-monitor-bridge' });
    }

    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/current') {
      const data = await fetchWindow(6);
      return json(res, 200, summarize(data));
    }

    if (url.pathname === '/summary') {
      const data = await fetchWindow(url.searchParams.get('hours') || 24);
      return json(res, 200, summarize(data));
    }

    if (url.pathname === '/history' || url.pathname === '/events') {
      const data = await fetchWindow(url.searchParams.get('hours') || 24);
      return json(res, 200, data);
    }

    return json(res, 404, {
      error: 'not_found',
      endpoints: ['/health', '/current?key=...', '/summary?hours=24&key=...', '/history?hours=24&key=...']
    });
  } catch (err) {
    console.error(err);
    return json(res, 502, { error: 'upstream_error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nightscout monitor bridge listening on ${PORT}`);
});
