'use strict';

(function () {
  if (window.__classifiedInsulinEventsLoaded) return;
  window.__classifiedInsulinEventsLoaded = true;

  var COLORS = {
    manual: '#3b82f6',
    smb: '#8b5cf6',
    uam: '#14b8a6',
    capped: '#f59e0b'
  };

  var MATCH_WINDOW_MS = 2 * 60 * 1000;
  var fetching = false;
  var renderTimer = null;

  function n(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function itemTime(item) {
    if (!item) return NaN;
    if (Number.isFinite(Number(item.mills))) return Number(item.mills);
    if (Number.isFinite(Number(item.date)) && Number(item.date) > 100000000000) return Number(item.date);
    var raw = item.created_at || item.timestamp || item.dateString;
    return raw ? Date.parse(raw) : NaN;
  }

  function transformX(node) {
    if (!node) return null;
    try {
      var consolidated = node.transform && node.transform.baseVal && node.transform.baseVal.consolidate();
      if (consolidated && consolidated.matrix) return consolidated.matrix.e;
    } catch (err) {}
    var transform = node.getAttribute && node.getAttribute('transform');
    var match = transform && transform.match(/translate\(\s*([-\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function scaleInfo() {
    var container = document.getElementById('chartContainer');
    if (!container) return null;

    var ticks = Array.prototype.slice.call(container.querySelectorAll('.chart-focus .x.axis .tick')).map(function (node) {
      var raw = node.__data__;
      var time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
      var x = transformX(node);
      return Number.isFinite(time) && Number.isFinite(x) ? { time: time, x: x } : null;
    }).filter(Boolean).sort(function (a, b) { return a.x - b.x; });

    if (ticks.length < 2) return null;

    var first = ticks[0];
    var last = ticks[ticks.length - 1];
    var pixelsPerMs = (last.x - first.x) / (last.time - first.time);
    if (!Number.isFinite(pixelsPerMs) || pixelsPerMs === 0) return null;

    var width = container.clientWidth || 0;
    return {
      container: container,
      width: width,
      start: first.time + (0 - first.x) / pixelsPerMs,
      end: first.time + (width - first.x) / pixelsPerMs,
      xForTime: function (time) {
        return first.x + (time - first.time) * pixelsPerMs;
      }
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
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('Nightscout API returned ' + response.status);
      return response.json();
    });
  }

  function loadData(start, end) {
    if (fetching) return Promise.resolve(null);
    fetching = true;

    var padding = 5 * 60 * 1000;
    return Promise.all([
      fetchJson(apiUrl('/api/v1/treatments.json', start - padding, end + padding, 5000)),
      fetchJson(apiUrl('/api/v1/devicestatus.json', start - padding, end + padding, 10000))
    ]).then(function (results) {
      return {
        treatments: Array.isArray(results[0]) ? results[0] : [],
        devicestatus: Array.isArray(results[1]) ? results[1] : []
      };
    }).catch(function (err) {
      console.warn('Classified insulin events could not load Nightscout data:', err);
      return null;
    }).finally(function () {
      fetching = false;
    });
  }

  function decisionCandidates(status) {
    if (!status || !status.openaps) return [];
    var out = [];
    if (status.openaps.enacted) out.push(status.openaps.enacted);
    if (status.openaps.suggested) out.push(status.openaps.suggested);
    return out;
  }

  function microbolusAmount(decision) {
    if (!decision) return null;
    var direct = n(decision.units);
    if (direct !== null) return direct;
    var match = String(decision.reason || '').match(/Microbolusing\s+([\d.]+)U/i);
    return match ? Number(match[1]) : null;
  }

  function maxBolus(decision) {
    if (!decision) return null;
    var direct = n(decision.maxBolus);
    if (direct !== null) return direct;
    var match = String(decision.reason || '').match(/maxBolus\s+([\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function uamPred(decision) {
    if (!decision) return null;
    if (decision.predBGs && Array.isArray(decision.predBGs.UAM) && decision.predBGs.UAM.length) {
      return n(decision.predBGs.UAM[decision.predBGs.UAM.length - 1]);
    }
    var match = String(decision.reason || '').match(/UAMpredBG\s+(-?[\d.]+)/i);
    return match ? Number(match[1]) : null;
  }

  function nearestDecision(treatment, statuses) {
    var treatmentTime = itemTime(treatment);
    var insulin = n(treatment.insulin);
    var best = null;
    var bestDiff = Infinity;

    statuses.forEach(function (status) {
      var statusTime = itemTime(status);
      if (!Number.isFinite(statusTime)) return;

      decisionCandidates(status).forEach(function (decision) {
        var amount = microbolusAmount(decision);
        if (amount === null) return;
        if (insulin !== null && Math.abs(amount - insulin) > 0.08) return;

        var diff = Math.abs(statusTime - treatmentTime);
        if (diff <= MATCH_WINDOW_MS && diff < bestDiff) {
          best = { decision: decision, diff: diff };
          bestDiff = diff;
        }
      });
    });

    return best;
  }

  function classify(treatment, statuses) {
    var insulin = n(treatment && treatment.insulin);
    if (insulin === null || insulin <= 0) return null;

    var eventType = String(treatment.eventType || '').trim().toUpperCase();
    if (eventType !== 'SMB') {
      return {
        type: 'manual',
        label: 'Manual bolus',
        insulin: insulin,
        treatment: treatment,
        evidence: 'Nightscout eventType is ' + (treatment.eventType || 'Bolus')
      };
    }

    var match = nearestDecision(treatment, statuses);
    if (!match) {
      return {
        type: 'smb',
        label: 'SMB',
        insulin: insulin,
        treatment: treatment,
        evidence: 'No matching Trio decision found'
      };
    }

    var decision = match.decision;
    var reason = String(decision.reason || '');
    var cob = n(decision.COB);
    var hasUamPrediction = Boolean(decision.predBGs && Array.isArray(decision.predBGs.UAM) && decision.predBGs.UAM.length);
    var reasonMentionsUam = /UAM/i.test(reason);
    var explicitZeroCob = cob !== null ? cob <= 0.1 : /COB:\s*0(?:\.0+)?(?:\D|$)/i.test(reason);
    var noCobField = cob === null && !/COB:/i.test(reason);
    var uamDriven = (hasUamPrediction || reasonMentionsUam) && (explicitZeroCob || noCobField);

    var maximum = maxBolus(decision);
    var insulinReq = n(decision.insulinReq);
    var explicitCap = maximum !== null && Math.abs(insulin - maximum) <= 0.08 && insulinReq !== null && insulinReq > maximum + 0.05;
    var reasonCap = /maxBolus|max smb|max uam|limited by/i.test(reason) && insulinReq !== null && insulinReq > insulin + 0.05;
    var capped = uamDriven && (explicitCap || reasonCap);

    var evidence = [];
    if (hasUamPrediction) evidence.push('UAM prediction present');
    else if (reasonMentionsUam) evidence.push('decision reason references UAM');
    if (explicitZeroCob) evidence.push('COB is 0');
    if (capped) evidence.push('UAM/SMB delivery was capped');
    if (!uamDriven) evidence.push('UAM not established as active driver');

    return {
      type: capped ? 'capped' : (uamDriven ? 'uam' : 'smb'),
      label: capped ? 'UAM cap' : (uamDriven ? 'UAM SMB' : 'SMB'),
      insulin: insulin,
      treatment: treatment,
      evidence: evidence.join('; '),
      insulinReq: insulinReq,
      maxBolus: maximum,
      iob: n(decision.IOB),
      uamPredBG: uamPred(decision)
    };
  }

  function dedupe(events) {
    var seen = {};
    return events.filter(function (event) {
      var treatment = event.treatment || {};
      var key = treatment._id || [Math.round(itemTime(treatment) / 1000), treatment.eventType || '', Number(event.insulin).toFixed(3)].join('|');
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function hideNativeInsulinTreatments(container) {
    var groups = Array.prototype.slice.call(container.querySelectorAll('.draggable-treatment'));
    var insulinTransforms = {};

    groups.forEach(function (group) {
      var path = group.querySelector('path');
      if (!path) return;
      var fill = String(path.getAttribute('fill') || '').toLowerCase();
      var stroke = String(path.getAttribute('stroke') || '').toLowerCase();
      if (fill === '#0099ff' || stroke === '#0099ff' || fill === 'rgb(0, 153, 255)' || stroke === 'rgb(0, 153, 255)') {
        insulinTransforms[group.getAttribute('transform') || ''] = true;
      }
    });

    groups.forEach(function (group) {
      var transform = group.getAttribute('transform') || '';
      if (insulinTransforms[transform]) group.style.display = 'none';
    });
  }

  function ensureUi(scale) {
    var container = scale.container;
    if (window.getComputedStyle(container).position === 'static') container.style.position = 'relative';

    var oldSvg = container.querySelector('svg.classified-insulin-overlay');
    if (oldSvg && oldSvg.parentNode) oldSvg.parentNode.removeChild(oldSvg);

    var lane = container.querySelector('.classified-insulin-lane');
    if (!lane) {
      lane = document.createElement('div');
      lane.className = 'classified-insulin-lane';
      lane.style.cssText = 'position:absolute;left:0;right:0;top:42px;height:42px;z-index:40;pointer-events:none;border-bottom:1px solid rgba(255,255,255,.12);';
      container.appendChild(lane);

      var laneLabel = document.createElement('div');
      laneLabel.textContent = 'INSULIN EVENTS';
      laneLabel.style.cssText = 'position:absolute;left:7px;top:0;color:rgba(255,255,255,.58);font:700 10px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.04em;';
      lane.appendChild(laneLabel);
    }

    var legend = container.querySelector('.classified-insulin-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'classified-insulin-legend';
      legend.style.cssText = 'position:absolute;top:8px;right:10px;z-index:45;padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(20,24,32,.94);color:#f8fafc;font:600 11px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;';
      legend.innerHTML = '<div style="font-size:10px;opacity:.72;margin-bottom:5px">CLASSIFIED INSULIN EVENTS</div><div style="display:flex;gap:10px;flex-wrap:wrap"><span style="color:' + COLORS.manual + '">▲ Manual</span><span style="color:' + COLORS.smb + '">◆ SMB</span><span style="color:' + COLORS.uam + '">● UAM SMB</span><span style="color:' + COLORS.capped + '">◎ UAM cap</span></div>';
      container.appendChild(legend);
    }

    var tooltip = container.querySelector('.classified-insulin-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'classified-insulin-tooltip';
      tooltip.style.cssText = 'position:absolute;display:none;z-index:50;min-width:215px;max-width:320px;padding:9px 11px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(15,18,24,.98);color:#f8fafc;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;';
      container.appendChild(tooltip);
    }

    return { lane: lane, tooltip: tooltip };
  }

  function markerElement(type) {
    var marker = document.createElement('div');
    marker.setAttribute('data-type', type);
    marker.style.cssText = 'position:absolute;top:18px;width:18px;height:18px;transform:translateX(-50%);pointer-events:auto;cursor:help;';

    if (type === 'manual') {
      marker.style.width = '0';
      marker.style.height = '0';
      marker.style.borderLeft = '9px solid transparent';
      marker.style.borderRight = '9px solid transparent';
      marker.style.borderBottom = '17px solid ' + COLORS.manual;
    } else if (type === 'smb') {
      marker.style.width = '13px';
      marker.style.height = '13px';
      marker.style.background = COLORS.smb;
      marker.style.transform = 'translateX(-50%) rotate(45deg)';
      marker.style.top = '20px';
    } else if (type === 'uam') {
      marker.style.width = '14px';
      marker.style.height = '14px';
      marker.style.borderRadius = '50%';
      marker.style.background = COLORS.uam;
      marker.style.top = '19px';
    } else {
      marker.style.width = '15px';
      marker.style.height = '15px';
      marker.style.borderRadius = '50%';
      marker.style.border = '3px solid ' + COLORS.capped;
      marker.style.boxSizing = 'border-box';
      marker.style.top = '18px';
      marker.style.background = 'transparent';
    }

    return marker;
  }

  function tooltipHtml(event) {
    var rows = [
      '<div style="font-weight:800;color:' + COLORS[event.type] + ';font-size:13px;margin-bottom:4px">' + event.label + '</div>',
      '<div><strong>Delivered:</strong> ' + event.insulin.toFixed(2) + ' U</div>',
      '<div><strong>Time:</strong> ' + new Date(itemTime(event.treatment)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</div>'
    ];
    if (event.insulinReq !== null && event.insulinReq !== undefined) rows.push('<div><strong>Insulin req:</strong> ' + event.insulinReq.toFixed(2) + ' U</div>');
    if (event.maxBolus !== null && event.maxBolus !== undefined) rows.push('<div><strong>Max allowed:</strong> ' + event.maxBolus.toFixed(2) + ' U</div>');
    if (event.iob !== null && event.iob !== undefined) rows.push('<div><strong>IOB:</strong> ' + event.iob.toFixed(2) + ' U</div>');
    if (event.uamPredBG !== null && event.uamPredBG !== undefined) rows.push('<div><strong>UAM predicted BG:</strong> ' + event.uamPredBG + ' mg/dL</div>');
    rows.push('<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.14);opacity:.82"><strong>Classification:</strong> ' + event.evidence + '</div>');
    return rows.join('');
  }

  function draw(scale, data) {
    if (!data) return;

    hideNativeInsulinTreatments(scale.container);
    var ui = ensureUi(scale);

    Array.prototype.slice.call(ui.lane.querySelectorAll('.classified-insulin-marker')).forEach(function (node) {
      node.parentNode.removeChild(node);
    });

    var events = dedupe(data.treatments.map(function (treatment) {
      return classify(treatment, data.devicestatus);
    }).filter(Boolean).filter(function (event) {
      var time = itemTime(event.treatment);
      return Number.isFinite(time) && time >= scale.start && time <= scale.end;
    }).sort(function (a, b) {
      return itemTime(a.treatment) - itemTime(b.treatment);
    }));

    events.forEach(function (event) {
      var x = scale.xForTime(itemTime(event.treatment));
      if (!Number.isFinite(x) || x < -10 || x > scale.width + 10) return;

      var marker = markerElement(event.type);
      marker.className = 'classified-insulin-marker';
      marker.style.left = x + 'px';
      marker.setAttribute('aria-label', event.label + ' ' + event.insulin + ' units');

      var show = function () {
        ui.tooltip.innerHTML = tooltipHtml(event);
        ui.tooltip.style.display = 'block';
        var left = x + 12;
        if (left + 310 > scale.width) left = Math.max(8, x - 322);
        ui.tooltip.style.left = left + 'px';
        ui.tooltip.style.top = '88px';
      };
      var hide = function () { ui.tooltip.style.display = 'none'; };

      marker.addEventListener('mouseenter', show);
      marker.addEventListener('mouseleave', hide);
      marker.addEventListener('focus', show);
      marker.addEventListener('blur', hide);
      marker.tabIndex = 0;
      ui.lane.appendChild(marker);
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
      var onlyOurs = mutations.length && mutations.every(function (mutation) {
        var target = mutation.target;
        return target && target.closest && (target.closest('.classified-insulin-lane') || target.closest('.classified-insulin-tooltip') || target.closest('.classified-insulin-legend'));
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
    setInterval(render, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1200); });
  } else {
    setTimeout(start, 1200);
  }
})();