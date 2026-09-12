'use strict';

(function () {
  if (window.__classifiedInsulinEventsLoaded) return;
  window.__classifiedInsulinEventsLoaded = true;

  var COLORS = { manual: '#3b82f6', smb: '#8b5cf6', uam: '#14b8a6', capped: '#f59e0b' };
  var MATCH_WINDOW_MS = 2 * 60 * 1000;
  var CACHE_PADDING_MS = 15 * 60 * 1000;
  var cache = { start: 0, end: 0, treatments: [], devicestatus: [] };
  var fetching = false;
  var renderTimer = null;

  function n(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  function itemTime(item) {
    if (!item) return NaN;
    if (Number.isFinite(Number(item.mills))) return Number(item.mills);
    if (Number.isFinite(Number(item.date))) return Number(item.date);
    var raw = item.created_at || item.timestamp || item.dateString;
    return raw ? Date.parse(raw) : NaN;
  }

  function getTransformXY(node) {
    if (!node) return null;
    try {
      var c = node.transform && node.transform.baseVal && node.transform.baseVal.consolidate();
      if (c && c.matrix) return { x: c.matrix.e, y: c.matrix.f };
    } catch (e) {}
    var t = node.getAttribute && node.getAttribute('transform');
    var m = t && t.match(/translate\(\s*([-\d.]+)(?:[ ,]+([-\d.]+))?/i);
    return m ? { x: Number(m[1]), y: Number(m[2] || 0) } : null;
  }

  function scaleInfo() {
    var container = document.getElementById('chartContainer');
    if (!container) return null;
    var svg = container.querySelector('svg:not(.classified-insulin-overlay)');
    if (!svg) return null;
    var ticks = Array.prototype.slice.call(container.querySelectorAll('.chart-focus .x.axis .tick')).map(function (node) {
      var raw = node.__data__;
      var time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
      var pt = getTransformXY(node);
      return pt && Number.isFinite(time) ? { time: time, x: pt.x } : null;
    }).filter(Boolean).sort(function (a, b) { return a.x - b.x; });
    if (ticks.length < 2) return null;
    var first = ticks[0], last = ticks[ticks.length - 1];
    var ppm = (last.x - first.x) / (last.time - first.time);
    if (!Number.isFinite(ppm) || ppm === 0) return null;
    var width = container.clientWidth || Number(svg.getAttribute('width')) || 0;
    var height = container.clientHeight || Number(svg.getAttribute('height')) || 0;
    return {
      container: container,
      width: width,
      height: height,
      start: first.time + (0 - first.x) / ppm,
      end: first.time + (width - first.x) / ppm,
      xForTime: function (time) { return first.x + (time - first.time) * ppm; }
    };
  }

  function apiUrl(endpoint, start, end, count) {
    var p = new URLSearchParams();
    p.set('count', String(count));
    p.set('find[created_at][$gte]', new Date(start).toISOString());
    p.set('find[created_at][$lte]', new Date(end).toISOString());
    return endpoint + '?' + p.toString();
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Nightscout API returned ' + r.status);
      return r.json();
    });
  }

  function loadData(start, end) {
    if (cache.start <= start && cache.end >= end && cache.treatments.length) return Promise.resolve(cache);
    if (fetching) return Promise.resolve(cache);
    fetching = true;
    var s = start - CACHE_PADDING_MS, e = end + CACHE_PADDING_MS;
    return Promise.all([
      fetchJson(apiUrl('/api/v1/treatments.json', s, e, 5000)),
      fetchJson(apiUrl('/api/v1/devicestatus.json', s, e, 10000))
    ]).then(function (r) {
      cache = { start: s, end: e, treatments: Array.isArray(r[0]) ? r[0] : [], devicestatus: Array.isArray(r[1]) ? r[1] : [] };
      return cache;
    }).catch(function (err) {
      console.warn('Classified insulin events could not load Nightscout data:', err);
      return cache;
    }).finally(function () { fetching = false; });
  }

  function suggestedFromStatus(status) {
    return status && status.openaps ? (status.openaps.suggested || status.openaps.enacted || null) : null;
  }

  function microbolusAmount(s) {
    if (!s) return null;
    var direct = n(s.units);
    if (direct !== null) return direct;
    var m = String(s.reason || '').match(/Microbolusing\s+([\d.]+)U/i);
    return m ? Number(m[1]) : null;
  }

  function maxBolus(s) {
    if (!s) return null;
    var direct = n(s.maxBolus);
    if (direct !== null) return direct;
    var m = String(s.reason || '').match(/maxBolus\s+([\d.]+)/i);
    return m ? Number(m[1]) : null;
  }

  function uamPred(s) {
    if (!s) return null;
    if (s.predBGs && Array.isArray(s.predBGs.UAM) && s.predBGs.UAM.length) return n(s.predBGs.UAM[s.predBGs.UAM.length - 1]);
    var m = String(s.reason || '').match(/UAMpredBG\s+(-?[\d.]+)/i);
    return m ? Number(m[1]) : null;
  }

  function nearestDecision(treatment, statuses) {
    var tt = itemTime(treatment), insulin = n(treatment.insulin), best = null, bestDiff = Infinity;
    statuses.forEach(function (status) {
      var s = suggestedFromStatus(status);
      if (!s) return;
      var amount = microbolusAmount(s);
      if (amount === null) return;
      if (insulin !== null && Math.abs(amount - insulin) > 0.08) return;
      var st = itemTime(status);
      if (!Number.isFinite(st)) st = itemTime(s);
      if (!Number.isFinite(st)) return;
      var diff = Math.abs(st - tt);
      if (diff <= MATCH_WINDOW_MS && diff < bestDiff) {
        best = { suggested: s, diff: diff };
        bestDiff = diff;
      }
    });
    return best;
  }

  function classify(treatment, statuses) {
    var insulin = n(treatment && treatment.insulin);
    if (insulin === null || insulin <= 0) return null;
    var eventType = String(treatment.eventType || '').toUpperCase();
    if (eventType !== 'SMB') {
      return { type: 'manual', label: 'Manual bolus', insulin: insulin, treatment: treatment, evidence: 'Nightscout eventType: ' + (treatment.eventType || 'Bolus') };
    }

    var match = nearestDecision(treatment, statuses);
    if (!match) return { type: 'smb', label: 'SMB', insulin: insulin, treatment: treatment, evidence: 'No matching Trio decision found' };

    var s = match.suggested;
    var reason = String(s.reason || '');
    var cob = n(s.COB);
    var hasUamPrediction = Boolean(s.predBGs && Array.isArray(s.predBGs.UAM) && s.predBGs.UAM.length);
    var reasonMentionsUam = /UAM/i.test(reason);
    var explicitZeroCob = cob !== null ? cob <= 0.1 : /COB:\s*0(?:\.0+)?(?:\D|$)/i.test(reason);
    var hasNoCobField = cob === null && !/COB:/i.test(reason);
    var uamDriven = (hasUamPrediction || reasonMentionsUam) && (explicitZeroCob || hasNoCobField);
    var max = maxBolus(s), insulinReq = n(s.insulinReq);
    var capped = uamDriven && max !== null && insulinReq !== null && Math.abs(insulin - max) <= 0.08 && insulinReq > max + 0.05;

    var evidence = [];
    if (hasUamPrediction) evidence.push('UAM prediction present');
    else if (reasonMentionsUam) evidence.push('decision reason references UAM');
    if (explicitZeroCob) evidence.push('COB is 0');
    if (capped) evidence.push('dose equals maxBolus while insulinReq is higher');
    if (!uamDriven) evidence.push('UAM not established as active driver');

    return {
      type: capped ? 'capped' : (uamDriven ? 'uam' : 'smb'),
      label: capped ? 'UAM cap' : (uamDriven ? 'UAM SMB' : 'SMB'),
      insulin: insulin,
      treatment: treatment,
      evidence: evidence.join('; '),
      insulinReq: insulinReq,
      maxBolus: max,
      iob: n(s.IOB),
      uamPredBG: uamPred(s)
    };
  }

  function dedupeEvents(events) {
    var seen = {};
    return events.filter(function (e) {
      var t = itemTime(e.treatment);
      var id = e.treatment && e.treatment._id;
      var key = id || (Math.round(t / 1000) + '|' + String(e.treatment.eventType || '') + '|' + Number(e.insulin).toFixed(3));
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function hideNativeInsulinGroups(container) {
    Array.prototype.slice.call(container.querySelectorAll('svg g')).forEach(function (node) {
      if (node.closest && node.closest('svg.classified-insulin-overlay')) return;
      var d = node.__data__;
      if (!d || typeof d !== 'object') return;
      var insulin = n(d.insulin);
      var eventType = String(d.eventType || '').toUpperCase();
      if (insulin !== null && insulin > 0 && (eventType === 'SMB' || eventType === 'BOLUS' || eventType.indexOf('BOLUS') >= 0)) {
        node.setAttribute('data-classified-insulin-native', '1');
      }
    });
  }

  function ensureStyle() {
    if (document.getElementById('classified-insulin-style')) return;
    var style = document.createElement('style');
    style.id = 'classified-insulin-style';
    style.textContent = '[data-classified-insulin-native="1"]{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;}';
    document.head.appendChild(style);
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function ensureUi(scale) {
    ensureStyle();
    var c = scale.container;
    if (window.getComputedStyle(c).position === 'static') c.style.position = 'relative';

    Array.prototype.slice.call(c.querySelectorAll('.uam-smb-legend,.uam-smb-v2-legend,.uam-smb-v2-tooltip,svg.uam-smb-overlay,svg.uam-smb-v2-overlay')).forEach(function (n) {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });

    var overlay = c.querySelector('svg.classified-insulin-overlay');
    if (!overlay) {
      overlay = svgEl('svg', { 'class': 'classified-insulin-overlay', 'aria-label': 'Classified insulin events' });
      overlay.style.cssText = 'position:absolute;left:0;top:0;z-index:20;pointer-events:none;overflow:visible';
      c.appendChild(overlay);
    }
    overlay.setAttribute('width', scale.width);
    overlay.setAttribute('height', scale.height);
    overlay.setAttribute('viewBox', '0 0 ' + scale.width + ' ' + scale.height);

    var legend = c.querySelector('.classified-insulin-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'classified-insulin-legend';
      legend.style.cssText = 'position:absolute;top:8px;right:10px;z-index:25;padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(20,24,32,.9);color:#f8fafc;font:600 11px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none';
      legend.innerHTML = '<div style="font-size:10px;opacity:.72;margin-bottom:5px">CLASSIFIED INSULIN EVENTS</div><div style="display:flex;gap:10px"><span style="color:' + COLORS.manual + '">▲ Manual</span><span style="color:' + COLORS.smb + '">◆ SMB</span><span style="color:' + COLORS.uam + '">● UAM SMB</span><span style="color:' + COLORS.capped + '">◎ UAM cap</span></div>';
      c.appendChild(legend);
    }

    var tooltip = c.querySelector('.classified-insulin-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'classified-insulin-tooltip';
      tooltip.style.cssText = 'position:absolute;display:none;z-index:30;min-width:210px;max-width:310px;padding:9px 11px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(15,18,24,.97);color:#f8fafc;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none';
      c.appendChild(tooltip);
    }
    return { overlay: overlay, tooltip: tooltip };
  }

  function marker(type) {
    var color = COLORS[type];
    if (type === 'manual') return '<path d="M0,-8 L8,7 L-8,7 Z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>';
    if (type === 'smb') return '<path d="M0,-8 L8,0 L0,8 L-8,0 Z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>';
    if (type === 'capped') return '<circle r="8" fill="rgba(245,158,11,.18)" stroke="' + color + '" stroke-width="3"/><circle r="3" fill="' + color + '"/>';
    return '<circle r="7" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>';
  }

  function tooltipHtml(e) {
    var rows = [
      '<div style="font-weight:800;color:' + COLORS[e.type] + ';font-size:13px;margin-bottom:4px">' + e.label + '</div>',
      '<div><strong>Delivered:</strong> ' + e.insulin.toFixed(2) + ' U</div>',
      '<div><strong>Time:</strong> ' + new Date(itemTime(e.treatment)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>'
    ];
    if (e.insulinReq !== null && e.insulinReq !== undefined) rows.push('<div><strong>Insulin req:</strong> ' + e.insulinReq.toFixed(2) + ' U</div>');
    if (e.maxBolus !== null && e.maxBolus !== undefined) rows.push('<div><strong>Max allowed:</strong> ' + e.maxBolus.toFixed(2) + ' U</div>');
    if (e.iob !== null && e.iob !== undefined) rows.push('<div><strong>IOB:</strong> ' + e.iob.toFixed(2) + ' U</div>');
    if (e.uamPredBG !== null && e.uamPredBG !== undefined) rows.push('<div><strong>UAM predicted BG:</strong> ' + e.uamPredBG + ' mg/dL</div>');
    rows.push('<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.14);opacity:.82"><strong>Classification:</strong> ' + e.evidence + '</div>');
    return rows.join('');
  }

  function draw(scale, data) {
    var ui = ensureUi(scale);
    hideNativeInsulinGroups(scale.container);
    while (ui.overlay.firstChild) ui.overlay.removeChild(ui.overlay.firstChild);

    var events = dedupeEvents(data.treatments.map(function (t) { return classify(t, data.devicestatus); }).filter(Boolean).filter(function (e) {
      var time = itemTime(e.treatment);
      return time >= scale.start && time <= scale.end;
    }).sort(function (a, b) { return itemTime(a.treatment) - itemTime(b.treatment); }));

    var laneY = 58;
    var lane = svgEl('line', { x1: 0, x2: scale.width, y1: laneY, y2: laneY, stroke: 'rgba(255,255,255,.13)', 'stroke-width': 1 });
    ui.overlay.appendChild(lane);

    events.forEach(function (event) {
      var x = scale.xForTime(itemTime(event.treatment));
      if (x < -10 || x > scale.width + 10) return;
      var g = svgEl('g', { transform: 'translate(' + x + ',' + laneY + ')', tabindex: '0', role: 'button', 'aria-label': event.label + ' ' + event.insulin + ' units' });
      g.style.pointerEvents = 'all';
      g.style.cursor = 'help';
      g.innerHTML = marker(event.type);
      var show = function () {
        ui.tooltip.innerHTML = tooltipHtml(event);
        ui.tooltip.style.display = 'block';
        var left = x + 12;
        if (left + 280 > scale.width) left = Math.max(8, x - 292);
        ui.tooltip.style.left = left + 'px';
        ui.tooltip.style.top = '78px';
      };
      var hide = function () { ui.tooltip.style.display = 'none'; };
      g.addEventListener('mouseenter', show);
      g.addEventListener('mouseleave', hide);
      g.addEventListener('focus', show);
      g.addEventListener('blur', hide);
      ui.overlay.appendChild(g);
    });
  }

  function render() {
    var scale = scaleInfo();
    if (!scale) return;
    loadData(scale.start, scale.end).then(function (data) {
      var current = scaleInfo();
      if (current) draw(current, data);
    });
  }

  function scheduleRender(mutations) {
    if (Array.isArray(mutations)) {
      var onlyOurs = mutations.length && mutations.every(function (m) {
        var t = m.target;
        return t && t.closest && (t.closest('.classified-insulin-overlay') || t.closest('.classified-insulin-tooltip') || t.closest('.classified-insulin-legend'));
      });
      if (onlyOurs) return;
    }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  }

  function start() {
    var scale = scaleInfo();
    if (!scale) return setTimeout(start, 1000);
    render();
    var observer = new MutationObserver(scheduleRender);
    observer.observe(scale.container, { subtree: true, attributes: true, childList: true });
    window.addEventListener('resize', scheduleRender);
    setInterval(render, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1200); });
  else setTimeout(start, 1200);
})();