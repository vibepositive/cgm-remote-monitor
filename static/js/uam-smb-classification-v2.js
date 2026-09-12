'use strict';

(function () {
  if (window.__nightscoutUamSmbClassificationV2Loaded) return;
  window.__nightscoutUamSmbClassificationV2Loaded = true;

  var COLORS = {
    manual: '#3b82f6',
    smb: '#8b5cf6',
    uam: '#14b8a6',
    capped: '#f59e0b'
  };
  var MATCH_WINDOW_MS = 2 * 60 * 1000;
  var NATIVE_MATCH_WINDOW_MS = 30 * 1000;
  var CACHE_PADDING_MS = 15 * 60 * 1000;
  var cache = { start: 0, end: 0, treatments: [], devicestatus: [] };
  var fetching = false;
  var renderTimer = null;

  function n(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
      var consolidated = node.transform && node.transform.baseVal && node.transform.baseVal.consolidate();
      if (consolidated && consolidated.matrix) return { x: consolidated.matrix.e, y: consolidated.matrix.f };
    } catch (err) {}
    var transform = node.getAttribute && node.getAttribute('transform');
    var match = transform && transform.match(/translate\(\s*([-\d.]+)(?:[ ,]+([-\d.]+))?/i);
    return match ? { x: Number(match[1]), y: Number(match[2] || 0) } : null;
  }

  function scaleInfo() {
    var container = document.getElementById('chartContainer');
    if (!container) return null;
    var svg = container.querySelector('svg:not(.uam-smb-overlay):not(.uam-smb-v2-overlay)');
    if (!svg) return null;
    var ticks = Array.prototype.slice.call(container.querySelectorAll('.chart-focus .x.axis .tick')).map(function (node) {
      var raw = node.__data__;
      var time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
      var pt = getTransformXY(node);
      return pt && Number.isFinite(time) ? { time: time, x: pt.x } : null;
    }).filter(Boolean).sort(function (a, b) { return a.x - b.x; });
    if (ticks.length < 2) return null;
    var first = ticks[0];
    var last = ticks[ticks.length - 1];
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
    return fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Nightscout API returned ' + response.status);
      return response.json();
    });
  }

  function loadData(start, end) {
    if (cache.start <= start && cache.end >= end && cache.treatments.length) return Promise.resolve(cache);
    if (fetching) return Promise.resolve(cache);
    fetching = true;
    var s = start - CACHE_PADDING_MS;
    var e = end + CACHE_PADDING_MS;
    return Promise.all([
      fetchJson(apiUrl('/api/v1/treatments.json', s, e, 5000)),
      fetchJson(apiUrl('/api/v1/devicestatus.json', s, e, 10000))
    ]).then(function (results) {
      cache = {
        start: s,
        end: e,
        treatments: Array.isArray(results[0]) ? results[0] : [],
        devicestatus: Array.isArray(results[1]) ? results[1] : []
      };
      return cache;
    }).catch(function (err) {
      console.warn('UAM/SMB v2 visualization could not load Nightscout data:', err);
      return cache;
    }).finally(function () { fetching = false; });
  }

  function suggestedFromStatus(status) {
    if (!status || !status.openaps) return null;
    return status.openaps.suggested || status.openaps.enacted || null;
  }

  function microbolusAmount(suggested) {
    if (!suggested) return null;
    var direct = n(suggested.units);
    if (direct !== null) return direct;
    var reason = suggested.reason || '';
    var match = reason.match(/Microbolusing\s+([\d.]+)U/i);
    return match ? Number(match[1]) : null;
  }

  function maxBolus(suggested) {
    if (!suggested) return null;
    var direct = n(suggested.maxBolus);
    if (direct !== null) return direct;
    var reason = suggested.reason || '';
    var match = reason.match(/maxBolus\s+([\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function uamPred(suggested) {
    if (!suggested) return null;
    if (suggested.predBGs && Array.isArray(suggested.predBGs.UAM) && suggested.predBGs.UAM.length) {
      return n(suggested.predBGs.UAM[suggested.predBGs.UAM.length - 1]);
    }
    var match = (suggested.reason || '').match(/UAMpredBG\s+(-?[\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function nearestDecision(treatment, statuses) {
    var tt = itemTime(treatment);
    var insulin = n(treatment.insulin);
    var best = null;
    var bestDiff = Infinity;
    statuses.forEach(function (status) {
      var suggested = suggestedFromStatus(status);
      if (!suggested) return;
      var amount = microbolusAmount(suggested);
      if (amount === null) return;
      if (insulin !== null && Math.abs(amount - insulin) > 0.08) return;
      var st = itemTime(status);
      if (!Number.isFinite(st)) st = itemTime(suggested);
      if (!Number.isFinite(st)) return;
      var diff = Math.abs(st - tt);
      if (diff <= MATCH_WINDOW_MS && diff < bestDiff) {
        best = { suggested: suggested, status: status, diff: diff };
        bestDiff = diff;
      }
    });
    return best;
  }

  function classify(treatment, statuses) {
    var insulin = n(treatment.insulin);
    if (insulin === null || insulin <= 0) return null;
    var isSmb = String(treatment.eventType || '').toUpperCase() === 'SMB';
    if (!isSmb) return { type: 'manual', label: 'Manual bolus', insulin: insulin, treatment: treatment, evidence: 'Nightscout treatment is not marked SMB' };

    var match = nearestDecision(treatment, statuses);
    if (!match) return { type: 'smb', label: 'SMB', insulin: insulin, treatment: treatment, evidence: 'No matching Trio decision found' };

    var suggested = match.suggested;
    var reason = suggested.reason || '';
    var cob = n(suggested.COB);
    var hasUamPrediction = Boolean(suggested.predBGs && Array.isArray(suggested.predBGs.UAM) && suggested.predBGs.UAM.length);
    var reasonMentionsUam = /UAM/i.test(reason);
    var hasUamEvidence = hasUamPrediction || reasonMentionsUam;
    var explicitZeroCob = cob !== null ? cob <= 0.1 : /COB:\s*0(?:\.0+)?(?:\D|$)/i.test(reason);
    var hasNoCobField = cob === null && !/COB:/i.test(reason);
    var uamDriven = hasUamEvidence && (explicitZeroCob || hasNoCobField);

    var max = maxBolus(suggested);
    var insulinReq = n(suggested.insulinReq);
    var capped = uamDriven && max !== null && insulinReq !== null && Math.abs(insulin - max) <= 0.08 && insulinReq > max + 0.05;

    var evidence = [];
    if (hasUamPrediction) evidence.push('UAM prediction present');
    else if (reasonMentionsUam) evidence.push('decision reason references UAM');
    if (explicitZeroCob) evidence.push('COB is 0');
    if (capped) evidence.push('delivered dose equals maxBolus while insulinReq is higher');
    if (!uamDriven) evidence.push('not enough evidence that UAM was the active driver');

    return {
      type: capped ? 'capped' : (uamDriven ? 'uam' : 'smb'),
      label: capped ? 'UAM cap reached' : (uamDriven ? 'UAM-driven SMB' : 'SMB'),
      insulin: insulin,
      treatment: treatment,
      suggested: suggested,
      evidence: evidence.join('; '),
      bg: n(suggested.bg),
      iob: n(suggested.IOB),
      insulinReq: insulinReq,
      maxBolus: max,
      uamPredBG: uamPred(suggested),
      matchSeconds: Math.round(match.diff / 1000)
    };
  }

  function dedupeEvents(events) {
    var seen = {};
    return events.filter(function (event) {
      var time = itemTime(event.treatment);
      var bucket = Number.isFinite(time) ? Math.round(time / 1000) : 0;
      var key = bucket + '|' + String(event.treatment.eventType || '') + '|' + Number(event.insulin || 0).toFixed(3);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function nativeTreatmentMarkers(container) {
    var containerRect = container.getBoundingClientRect();
    return Array.prototype.slice.call(container.querySelectorAll('g.draggable-treatment')).map(function (node) {
      var treatment = node.__data__ || {};
      var insulin = n(treatment.insulin);
      if (insulin === null || insulin <= 0) return null;
      var rect = node.getBoundingClientRect();
      var time = itemTime(treatment);
      if (!Number.isFinite(time)) return null;
      return {
        node: node,
        treatment: treatment,
        insulin: insulin,
        carbs: n(treatment.carbs),
        time: time,
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top + rect.height / 2 - containerRect.top
      };
    }).filter(Boolean);
  }

  function nearestNativeMarker(event, markers, used) {
    var time = itemTime(event.treatment);
    var insulin = n(event.insulin);
    var best = null;
    var bestScore = Infinity;
    markers.forEach(function (marker, index) {
      if (used[index]) return;
      if (insulin !== null && Math.abs(marker.insulin - insulin) > 0.05) return;
      var diff = Math.abs(marker.time - time);
      if (diff > NATIVE_MATCH_WINDOW_MS) return;
      var score = diff + Math.abs(marker.insulin - insulin) * 100000;
      if (score < bestScore) {
        best = { marker: marker, index: index };
        bestScore = score;
      }
    });
    if (!best) return null;
    used[best.index] = true;
    return best.marker;
  }

  function hideNativeInsulinMarker(marker) {
    if (!marker || !marker.node) return;
    if (marker.node.getAttribute('data-uam-smb-hidden') === '1') return;
    marker.node.setAttribute('data-uam-smb-hidden', '1');
    marker.node.style.display = 'none';
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function ensureUi(scale) {
    var c = scale.container;
    if (window.getComputedStyle(c).position === 'static') c.style.position = 'relative';

    var oldLegend = c.querySelector('.uam-smb-legend');
    if (oldLegend) oldLegend.style.display = 'none';
    var oldOverlay = c.querySelector('svg.uam-smb-overlay');
    if (oldOverlay) oldOverlay.style.display = 'none';

    var overlay = c.querySelector('svg.uam-smb-v2-overlay');
    if (!overlay) {
      overlay = svgEl('svg', { 'class': 'uam-smb-v2-overlay', 'aria-label': 'Classified insulin automation events' });
      overlay.style.position = 'absolute';
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.zIndex = '16';
      overlay.style.pointerEvents = 'none';
      overlay.style.overflow = 'visible';
      c.appendChild(overlay);
    }
    overlay.setAttribute('width', scale.width);
    overlay.setAttribute('height', scale.height);
    overlay.setAttribute('viewBox', '0 0 ' + scale.width + ' ' + scale.height);

    var legend = c.querySelector('.uam-smb-v2-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'uam-smb-v2-legend';
      legend.style.position = 'absolute';
      legend.style.top = '8px';
      legend.style.right = '10px';
      legend.style.zIndex = '25';
      legend.style.padding = '7px 10px';
      legend.style.border = '1px solid rgba(255,255,255,.2)';
      legend.style.borderRadius = '9px';
      legend.style.background = 'rgba(20,24,32,.88)';
      legend.style.color = '#f8fafc';
      legend.style.font = '600 11px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      legend.style.pointerEvents = 'none';
      legend.innerHTML = '<div style="font-size:10px;opacity:.72;margin-bottom:5px;letter-spacing:.04em">CLASSIFIED INSULIN EVENTS</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<span style="color:' + COLORS.manual + '">▲ Manual</span>' +
        '<span style="color:' + COLORS.smb + '">◆ SMB</span>' +
        '<span style="color:' + COLORS.uam + '">● UAM SMB</span>' +
        '<span style="color:' + COLORS.capped + '">◎ UAM cap</span>' +
        '</div>';
      c.appendChild(legend);
    }

    var tooltip = c.querySelector('.uam-smb-v2-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'uam-smb-v2-tooltip';
      tooltip.style.position = 'absolute';
      tooltip.style.display = 'none';
      tooltip.style.zIndex = '30';
      tooltip.style.minWidth = '210px';
      tooltip.style.maxWidth = '310px';
      tooltip.style.padding = '9px 11px';
      tooltip.style.border = '1px solid rgba(255,255,255,.2)';
      tooltip.style.borderRadius = '9px';
      tooltip.style.background = 'rgba(15,18,24,.97)';
      tooltip.style.color = '#f8fafc';
      tooltip.style.font = '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      tooltip.style.pointerEvents = 'none';
      c.appendChild(tooltip);
    }
    return { overlay: overlay, legend: legend, tooltip: tooltip };
  }

  function marker(type) {
    var color = COLORS[type];
    if (type === 'manual') return '<path d="M0,-7 L7,6 L-7,6 Z" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
    if (type === 'smb') return '<path d="M0,-7 L7,0 L0,7 L-7,0 Z" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
    if (type === 'capped') return '<circle r="7" fill="rgba(245,158,11,.16)" stroke="' + color + '" stroke-width="2.5"/><circle r="2.5" fill="' + color + '"/>';
    return '<circle r="6" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
  }

  function tooltipHtml(event) {
    var rows = [];
    rows.push('<div style="font-weight:800;color:' + COLORS[event.type] + ';font-size:13px;margin-bottom:4px">' + event.label + '</div>');
    rows.push('<div><strong>Delivered:</strong> ' + event.insulin.toFixed(2) + ' U</div>');
    rows.push('<div><strong>Time:</strong> ' + new Date(itemTime(event.treatment)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>');
    if (event.insulinReq !== null && event.insulinReq !== undefined) rows.push('<div><strong>Insulin req:</strong> ' + event.insulinReq.toFixed(2) + ' U</div>');
    if (event.maxBolus !== null && event.maxBolus !== undefined) rows.push('<div><strong>Max allowed:</strong> ' + event.maxBolus.toFixed(2) + ' U</div>');
    if (event.iob !== null && event.iob !== undefined) rows.push('<div><strong>IOB:</strong> ' + event.iob.toFixed(2) + ' U</div>');
    if (event.uamPredBG !== null && event.uamPredBG !== undefined) rows.push('<div><strong>UAM predicted BG:</strong> ' + event.uamPredBG + ' mg/dL</div>');
    if (event.matchSeconds !== undefined) rows.push('<div><strong>Decision match:</strong> ' + event.matchSeconds + ' sec</div>');
    rows.push('<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.14);opacity:.82"><strong>Classification:</strong> ' + event.evidence + '</div>');
    return rows.join('');
  }

  function draw(scale, data) {
    var ui = ensureUi(scale);
    while (ui.overlay.firstChild) ui.overlay.removeChild(ui.overlay.firstChild);

    var events = data.treatments.map(function (t) { return classify(t, data.devicestatus); }).filter(Boolean).filter(function (event) {
      var time = itemTime(event.treatment);
      return time >= scale.start && time <= scale.end;
    }).sort(function (a, b) { return itemTime(a.treatment) - itemTime(b.treatment); });
    events = dedupeEvents(events);

    var nativeMarkers = nativeTreatmentMarkers(scale.container);
    var usedNative = {};
    var fallbackIndex = 0;

    events.forEach(function (event) {
      var nativeMarker = nearestNativeMarker(event, nativeMarkers, usedNative);
      var x;
      var y;

      if (nativeMarker) {
        x = nativeMarker.x;
        y = nativeMarker.y;
        hideNativeInsulinMarker(nativeMarker);
      } else {
        x = scale.xForTime(itemTime(event.treatment));
        y = 62 + ((fallbackIndex % 3) * 20);
        fallbackIndex += 1;
      }

      if (x < -10 || x > scale.width + 10 || y < -10 || y > scale.height + 10) return;
      var group = svgEl('g', { transform: 'translate(' + x + ',' + y + ')', tabindex: '0', role: 'button', 'aria-label': event.label + ' ' + event.insulin + ' units' });
      group.style.pointerEvents = 'all';
      group.style.cursor = 'help';
      group.innerHTML = marker(event.type);
      var amount = svgEl('text', { x: 0, y: -11, 'text-anchor': 'middle', fill: COLORS[event.type], 'font-size': 9, 'font-weight': 800 });
      amount.textContent = event.insulin.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' U';
      group.appendChild(amount);

      var show = function () {
        ui.tooltip.innerHTML = tooltipHtml(event);
        ui.tooltip.style.display = 'block';
        var left = x + 12;
        if (left + 280 > scale.width) left = Math.max(8, x - 292);
        ui.tooltip.style.left = left + 'px';
        var tooltipTop = y + 18;
        if (tooltipTop + 185 > scale.height) tooltipTop = Math.max(8, y - 193);
        ui.tooltip.style.top = tooltipTop + 'px';
      };
      var hide = function () { ui.tooltip.style.display = 'none'; };
      group.addEventListener('mouseenter', show);
      group.addEventListener('mouseleave', hide);
      group.addEventListener('focus', show);
      group.addEventListener('blur', hide);
      ui.overlay.appendChild(group);
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
      var onlyOurChanges = mutations.length && mutations.every(function (mutation) {
        var target = mutation.target;
        return target && target.closest && (target.closest('.uam-smb-v2-overlay') || target.closest('.uam-smb-v2-tooltip') || target.closest('.uam-smb-v2-legend'));
      });
      if (onlyOurChanges) return;
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
    setInterval(render, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1400); });
  else setTimeout(start, 1400);
})();