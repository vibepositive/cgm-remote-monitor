'use strict';

(function () {
  if (window.__nightscoutUamSmbVisualizationLoaded) return;
  window.__nightscoutUamSmbVisualizationLoaded = true;

  var COLORS = {
    manual: '#3b82f6',
    smb: '#8b5cf6',
    uam: '#14b8a6',
    capped: '#f59e0b'
  };
  var MATCH_WINDOW_MS = 90 * 1000;
  var CACHE_PADDING_MS = 15 * 60 * 1000;
  var cache = { start: 0, end: 0, treatments: [], devicestatus: [] };
  var renderTimer = null;
  var fetching = false;

  function numberOrNull(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function itemTime(item) {
    if (!item) return NaN;
    if (Number.isFinite(Number(item.mills))) return Number(item.mills);
    if (Number.isFinite(Number(item.date))) return Number(item.date);
    var raw = item.created_at || item.timestamp || item.dateString;
    var parsed = raw ? Date.parse(raw) : NaN;
    return parsed;
  }

  function getTransformXY(node) {
    if (!node) return null;
    try {
      var consolidated = node.transform && node.transform.baseVal && node.transform.baseVal.consolidate();
      if (consolidated && consolidated.matrix) {
        return { x: consolidated.matrix.e, y: consolidated.matrix.f };
      }
    } catch (err) {
      // Fall back to parsing the transform attribute.
    }
    var transform = node.getAttribute && node.getAttribute('transform');
    var match = transform && transform.match(/translate\(\s*([-\d.]+)(?:[ ,]+([-\d.]+))?/i);
    return match ? { x: Number(match[1]), y: Number(match[2] || 0) } : null;
  }

  function getScaleInfo() {
    var container = document.getElementById('chartContainer');
    if (!container) return null;
    var baseSvg = container.querySelector('svg:not(.uam-smb-overlay)');
    if (!baseSvg) return null;

    var tickNodes = Array.prototype.slice.call(container.querySelectorAll('.chart-focus .x.axis .tick'));
    var ticks = tickNodes.map(function (node) {
      var raw = node.__data__;
      var time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
      var point = getTransformXY(node);
      return point && Number.isFinite(time) ? { time: time, x: point.x } : null;
    }).filter(Boolean).sort(function (a, b) { return a.x - b.x; });

    if (ticks.length < 2) return null;
    var first = ticks[0];
    var last = ticks[ticks.length - 1];
    if (last.time === first.time || last.x === first.x) return null;

    var width = container.clientWidth || Number(baseSvg.getAttribute('width')) || 0;
    var height = container.clientHeight || Number(baseSvg.getAttribute('height')) || 0;
    if (!width || !height) return null;

    var pixelsPerMs = (last.x - first.x) / (last.time - first.time);
    var timeForX = function (x) { return first.time + (x - first.x) / pixelsPerMs; };
    var xForTime = function (time) { return first.x + (time - first.time) * pixelsPerMs; };

    var focusAxis = container.querySelector('.chart-focus .x.axis');
    var axisPoint = getTransformXY(focusAxis);
    var focusHeight = axisPoint && axisPoint.y > 0 ? axisPoint.y : height * 0.7;

    return {
      container: container,
      baseSvg: baseSvg,
      width: width,
      height: height,
      focusHeight: focusHeight,
      start: timeForX(0),
      end: timeForX(width),
      xForTime: xForTime
    };
  }

  function apiUrl(endpoint, start, end, count) {
    var params = new URLSearchParams();
    params.set('count', String(count));
    params.set('find[created_at][$gte]', new Date(start).toISOString());
    params.set('find[created_at][$lte]', new Date(end).toISOString());
    return endpoint + '?' + params.toString();
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Nightscout API returned ' + response.status);
      return response.json();
    });
  }

  function loadData(start, end) {
    if (cache.start <= start && cache.end >= end && cache.treatments.length) {
      return Promise.resolve(cache);
    }
    if (fetching) return Promise.resolve(cache);

    fetching = true;
    var paddedStart = start - CACHE_PADDING_MS;
    var paddedEnd = end + CACHE_PADDING_MS;
    return Promise.all([
      fetchJson(apiUrl('/api/v1/treatments.json', paddedStart, paddedEnd, 5000)),
      fetchJson(apiUrl('/api/v1/devicestatus.json', paddedStart, paddedEnd, 10000))
    ]).then(function (results) {
      cache = {
        start: paddedStart,
        end: paddedEnd,
        treatments: Array.isArray(results[0]) ? results[0] : [],
        devicestatus: Array.isArray(results[1]) ? results[1] : []
      };
      return cache;
    }).catch(function (err) {
      console.warn('UAM/SMB visualization could not load Nightscout data:', err);
      return cache;
    }).finally(function () {
      fetching = false;
    });
  }

  function suggestedFromStatus(status) {
    if (!status || !status.openaps) return null;
    return status.openaps.suggested || status.openaps.enacted || null;
  }

  function microbolusAmount(suggested) {
    if (!suggested) return null;
    var units = numberOrNull(suggested.units);
    if (units !== null) return units;
    var reason = suggested.reason || '';
    var match = reason.match(/Microbolusing\s+([\d.]+)U/i);
    return match ? Number(match[1]) : null;
  }

  function maxBolusFromSuggested(suggested) {
    if (!suggested) return null;
    var direct = numberOrNull(suggested.maxBolus);
    if (direct !== null) return direct;
    var reason = suggested.reason || '';
    var match = reason.match(/maxBolus\s+([\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function uamPrediction(suggested) {
    if (!suggested) return null;
    if (suggested.predBGs && Array.isArray(suggested.predBGs.UAM) && suggested.predBGs.UAM.length) {
      return numberOrNull(suggested.predBGs.UAM[suggested.predBGs.UAM.length - 1]);
    }
    var reason = suggested.reason || '';
    var match = reason.match(/UAMpredBG\s+(-?[\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function nearestDecision(treatment, statuses) {
    var treatmentTime = itemTime(treatment);
    var insulin = numberOrNull(treatment.insulin);
    if (!Number.isFinite(treatmentTime) || insulin === null) return null;

    var best = null;
    var bestDiff = Infinity;
    statuses.forEach(function (status) {
      var suggested = suggestedFromStatus(status);
      if (!suggested || !(suggested.reason || '').match(/Microbolusing/i)) return;
      var statusTime = itemTime(status);
      if (!Number.isFinite(statusTime)) {
        statusTime = itemTime(suggested);
      }
      if (!Number.isFinite(statusTime)) return;
      var diff = Math.abs(statusTime - treatmentTime);
      if (diff > MATCH_WINDOW_MS || diff >= bestDiff) return;

      var amount = microbolusAmount(suggested);
      if (amount !== null && Math.abs(amount - insulin) > 0.06) return;

      best = suggested;
      bestDiff = diff;
    });
    return best;
  }

  function classifyTreatment(treatment, statuses) {
    var insulin = numberOrNull(treatment.insulin);
    if (insulin === null || insulin <= 0) return null;

    var isSmb = String(treatment.eventType || '').toUpperCase() === 'SMB';
    if (!isSmb) {
      return {
        type: 'manual',
        label: 'Manual bolus',
        insulin: insulin,
        treatment: treatment
      };
    }

    var suggested = nearestDecision(treatment, statuses);
    if (!suggested) {
      return {
        type: 'smb',
        label: 'SMB',
        insulin: insulin,
        treatment: treatment
      };
    }

    var reason = suggested.reason || '';
    var cob = numberOrNull(suggested.COB);
    var hasUam = Boolean(
      (suggested.predBGs && Array.isArray(suggested.predBGs.UAM)) || /UAMpredBG/i.test(reason)
    );
    var uamDriven = hasUam && (cob === 0 || /COB:\s*0(?:\D|$)/i.test(reason));
    var maxBolus = maxBolusFromSuggested(suggested);
    var insulinReq = numberOrNull(suggested.insulinReq);
    var capped = uamDriven && maxBolus !== null && insulinReq !== null &&
      Math.abs(insulin - maxBolus) <= 0.051 && insulinReq > maxBolus + 0.05;

    return {
      type: capped ? 'capped' : (uamDriven ? 'uam' : 'smb'),
      label: capped ? 'UAM cap reached' : (uamDriven ? 'UAM-driven SMB' : 'SMB'),
      insulin: insulin,
      treatment: treatment,
      suggested: suggested,
      bg: numberOrNull(suggested.bg),
      iob: numberOrNull(suggested.IOB),
      isf: numberOrNull(suggested.ISF),
      insulinReq: insulinReq,
      maxBolus: maxBolus,
      uamPredBG: uamPrediction(suggested)
    };
  }

  function ensureUi(scale) {
    var container = scale.container;
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    var overlay = container.querySelector('svg.uam-smb-overlay');
    if (!overlay) {
      overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.setAttribute('class', 'uam-smb-overlay');
      overlay.setAttribute('aria-label', 'Insulin automation events');
      overlay.style.position = 'absolute';
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.zIndex = '12';
      overlay.style.pointerEvents = 'none';
      overlay.style.overflow = 'visible';
      container.appendChild(overlay);
    }
    overlay.setAttribute('width', scale.width);
    overlay.setAttribute('height', scale.height);
    overlay.setAttribute('viewBox', '0 0 ' + scale.width + ' ' + scale.height);

    var legend = container.querySelector('.uam-smb-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'uam-smb-legend';
      legend.setAttribute('aria-label', 'Insulin event key');
      legend.style.position = 'absolute';
      legend.style.top = '8px';
      legend.style.right = '10px';
      legend.style.zIndex = '20';
      legend.style.display = 'flex';
      legend.style.flexWrap = 'wrap';
      legend.style.gap = '6px 12px';
      legend.style.alignItems = 'center';
      legend.style.maxWidth = 'calc(100% - 20px)';
      legend.style.padding = '6px 9px';
      legend.style.border = '1px solid rgba(255,255,255,.18)';
      legend.style.borderRadius = '9px';
      legend.style.background = 'rgba(20,24,32,.78)';
      legend.style.backdropFilter = 'blur(4px)';
      legend.style.boxShadow = '0 2px 10px rgba(0,0,0,.24)';
      legend.style.color = '#f8fafc';
      legend.style.font = '600 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      legend.style.pointerEvents = 'none';
      legend.innerHTML = legendItem('manual', 'Manual') + legendItem('smb', 'SMB') +
        legendItem('uam', 'UAM SMB') + legendItem('capped', 'UAM cap');
      container.appendChild(legend);
    }

    var tooltip = container.querySelector('.uam-smb-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'uam-smb-tooltip';
      tooltip.style.position = 'absolute';
      tooltip.style.display = 'none';
      tooltip.style.zIndex = '30';
      tooltip.style.minWidth = '185px';
      tooltip.style.maxWidth = '270px';
      tooltip.style.padding = '9px 11px';
      tooltip.style.border = '1px solid rgba(255,255,255,.2)';
      tooltip.style.borderRadius = '9px';
      tooltip.style.background = 'rgba(15,18,24,.96)';
      tooltip.style.boxShadow = '0 6px 22px rgba(0,0,0,.38)';
      tooltip.style.color = '#f8fafc';
      tooltip.style.font = '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      tooltip.style.pointerEvents = 'none';
      container.appendChild(tooltip);
    }

    return { overlay: overlay, legend: legend, tooltip: tooltip };
  }

  function legendItem(type, text) {
    var shape = type === 'manual' ? '▲' : type === 'smb' ? '◆' : type === 'capped' ? '◉' : '●';
    return '<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">' +
      '<span style="color:' + COLORS[type] + ';font-size:13px">' + shape + '</span>' + text + '</span>';
  }

  function markerShape(type, color) {
    if (type === 'manual') {
      return '<path d="M0,-7 L7,6 L-7,6 Z" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
    }
    if (type === 'smb') {
      return '<path d="M0,-7 L7,0 L0,7 L-7,0 Z" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
    }
    if (type === 'capped') {
      return '<circle r="7" fill="rgba(245,158,11,.16)" stroke="' + color + '" stroke-width="2.5"/>' +
        '<circle r="2.5" fill="' + color + '"/>';
    }
    return '<circle r="6" fill="' + color + '" stroke="#fff" stroke-width="1"/>';
  }

  function tooltipHtml(event) {
    var rows = [];
    rows.push('<div style="font-size:13px;font-weight:800;color:' + COLORS[event.type] + ';margin-bottom:4px">' + event.label + '</div>');
    rows.push('<div><strong>Insulin:</strong> ' + event.insulin.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' U</div>');
    rows.push('<div><strong>Time:</strong> ' + new Date(itemTime(event.treatment)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>');
    if (event.bg !== null && event.bg !== undefined) rows.push('<div><strong>BG:</strong> ' + event.bg + ' mg/dL</div>');
    if (event.uamPredBG !== null && event.uamPredBG !== undefined) rows.push('<div><strong>UAM predicted BG:</strong> ' + event.uamPredBG + ' mg/dL</div>');
    if (event.insulinReq !== null && event.insulinReq !== undefined) rows.push('<div><strong>Insulin required:</strong> ' + event.insulinReq.toFixed(2) + ' U</div>');
    if (event.maxBolus !== null && event.maxBolus !== undefined) rows.push('<div><strong>Max allowed:</strong> ' + event.maxBolus.toFixed(2) + ' U</div>');
    if (event.iob !== null && event.iob !== undefined) rows.push('<div><strong>IOB:</strong> ' + event.iob.toFixed(2) + ' U</div>');
    if (event.isf !== null && event.isf !== undefined) rows.push('<div><strong>ISF:</strong> ' + event.isf + ' mg/dL/U</div>');
    if (event.type === 'capped') {
      rows.push('<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.15);font-weight:800;color:' + COLORS.capped + '">UAM CAP REACHED</div>');
    }
    if (event.type === 'smb' && !event.suggested) {
      rows.push('<div style="margin-top:5px;opacity:.7">No matching Trio decision was found, so this is shown as a standard SMB.</div>');
    }
    return rows.join('');
  }

  function svgElement(name, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function drawEvents(scale, data) {
    var ui = ensureUi(scale);
    var overlay = ui.overlay;
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

    var laneY = Math.max(36, scale.focusHeight - 24);
    var guide = svgElement('line', {
      x1: 0, y1: laneY, x2: scale.width, y2: laneY,
      stroke: 'rgba(255,255,255,.16)', 'stroke-width': 1, 'stroke-dasharray': '3 5'
    });
    overlay.appendChild(guide);

    var laneLabel = svgElement('text', {
      x: 7, y: laneY - 10, fill: 'rgba(255,255,255,.6)', 'font-size': 10,
      'font-family': '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', 'font-weight': 700
    });
    laneLabel.textContent = 'INSULIN EVENTS';
    overlay.appendChild(laneLabel);

    var events = data.treatments.map(function (t) { return classifyTreatment(t, data.devicestatus); })
      .filter(Boolean)
      .filter(function (event) {
        var time = itemTime(event.treatment);
        return time >= scale.start && time <= scale.end;
      })
      .sort(function (a, b) { return itemTime(a.treatment) - itemTime(b.treatment); });

    var showAllAmounts = events.length <= 18;
    events.forEach(function (event) {
      var x = scale.xForTime(itemTime(event.treatment));
      if (x < -10 || x > scale.width + 10) return;

      var group = svgElement('g', {
        transform: 'translate(' + x + ',' + laneY + ')',
        tabindex: '0', role: 'button', 'aria-label': event.label + ' ' + event.insulin + ' units'
      });
      group.style.pointerEvents = 'all';
      group.style.cursor = 'help';
      group.innerHTML = markerShape(event.type, COLORS[event.type]);

      if (showAllAmounts || event.type === 'capped' || event.type === 'manual') {
        var amount = svgElement('text', {
          x: 0, y: -11, 'text-anchor': 'middle', fill: COLORS[event.type],
          'font-size': 9, 'font-family': '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', 'font-weight': 800
        });
        amount.textContent = event.insulin.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        group.appendChild(amount);
      }

      var showTooltip = function () {
        ui.tooltip.innerHTML = tooltipHtml(event);
        ui.tooltip.style.display = 'block';
        var desiredLeft = x + 12;
        var estimatedWidth = 235;
        if (desiredLeft + estimatedWidth > scale.width) desiredLeft = Math.max(8, x - estimatedWidth - 12);
        ui.tooltip.style.left = desiredLeft + 'px';
        ui.tooltip.style.top = Math.max(8, laneY - 150) + 'px';
      };
      var hideTooltip = function () { ui.tooltip.style.display = 'none'; };
      group.addEventListener('mouseenter', showTooltip);
      group.addEventListener('mouseleave', hideTooltip);
      group.addEventListener('focus', showTooltip);
      group.addEventListener('blur', hideTooltip);
      overlay.appendChild(group);
    });
  }

  function render() {
    var scale = getScaleInfo();
    if (!scale) return;
    loadData(scale.start, scale.end).then(function (data) {
      var currentScale = getScaleInfo();
      if (currentScale) drawEvents(currentScale, data);
    });
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  }

  function start() {
    var scale = getScaleInfo();
    if (!scale) {
      setTimeout(start, 1000);
      return;
    }

    render();
    var observer = new MutationObserver(scheduleRender);
    observer.observe(scale.baseSvg, { subtree: true, attributes: true, childList: true });
    window.addEventListener('resize', scheduleRender);
    document.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('.focus-range')) scheduleRender();
    });
    setInterval(render, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1200); });
  } else {
    setTimeout(start, 1200);
  }
})();
