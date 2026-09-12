'use strict';

(function () {
  if (window.__nightscoutUamSmbCleanupLoaded) return;
  window.__nightscoutUamSmbCleanupLoaded = true;

  var renderTimer = null;
  var MIN_MARKER_GAP = 22;
  var LANE_SPACING = 18;
  var MAX_LANES = 3;

  function isNativeInsulinLabel(text) {
    return /^\s*\.?\d+(?:\.\d+)?\s*U\s*$/i.test(text || '');
  }

  function parseTranslate(node) {
    if (!node) return null;
    var transform = node.getAttribute('transform') || '';
    var match = transform.match(/translate\(\s*([-\d.]+)(?:[ ,]+([-\d.]+))?/i);
    if (!match) return null;
    return { x: Number(match[1]), y: Number(match[2] || 0) };
  }

  function hideNativeInsulinLabels(container) {
    Array.prototype.forEach.call(
      container.querySelectorAll('.draggable-treatment #label text'),
      function (label) {
        if (isNativeInsulinLabel(label.textContent)) {
          label.style.display = 'none';
          label.setAttribute('data-uam-smb-hidden-native-insulin-label', 'true');
        }
      }
    );
  }

  function cleanOverlay(container) {
    var overlay = container.querySelector('svg.uam-smb-overlay');
    if (!overlay) return;

    var groups = Array.prototype.slice.call(
      overlay.querySelectorAll('g[aria-label]')
    ).map(function (group) {
      var point = parseTranslate(group);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

      if (!group.hasAttribute('data-clean-base-y')) {
        group.setAttribute('data-clean-base-y', String(point.y));
      }

      var aria = group.getAttribute('aria-label') || '';
      var isManual = /^Manual bolus\b/i.test(aria);
      var isCapped = /^UAM cap reached\b/i.test(aria);

      // Automated delivery amounts are available in the tooltip. Keeping them
      // off the graph prevents the repeated 0.x U labels from obscuring CGM data.
      if (!isManual && !isCapped) {
        Array.prototype.forEach.call(group.children, function (child) {
          if (child.tagName && child.tagName.toLowerCase() === 'text') {
            child.style.display = 'none';
          }
        });
      }

      return {
        group: group,
        x: point.x,
        baseY: Number(group.getAttribute('data-clean-base-y')),
        isManual: isManual,
        isCapped: isCapped
      };
    }).filter(Boolean).sort(function (a, b) {
      return a.x - b.x;
    });

    var lastX = [];
    for (var i = 0; i < MAX_LANES; i++) lastX.push(-Infinity);

    groups.forEach(function (event) {
      var lane = 0;
      for (var i = 0; i < MAX_LANES; i++) {
        if (event.x - lastX[i] >= MIN_MARKER_GAP) {
          lane = i;
          break;
        }
        if (i === MAX_LANES - 1) {
          lane = lastX.indexOf(Math.min.apply(null, lastX));
        }
      }

      lastX[lane] = event.x;
      var y = event.baseY - lane * LANE_SPACING;
      event.group.setAttribute('transform', 'translate(' + event.x + ',' + y + ')');
      event.group.setAttribute('data-clean-lane', String(lane));
    });
  }

  function applyCleanup() {
    var container = document.getElementById('chartContainer');
    if (!container) return;
    hideNativeInsulinLabels(container);
    cleanOverlay(container);
  }

  function scheduleCleanup() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(applyCleanup, 120);
  }

  function start() {
    var container = document.getElementById('chartContainer');
    if (!container) {
      setTimeout(start, 500);
      return;
    }

    applyCleanup();

    var observer = new MutationObserver(scheduleCleanup);
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['transform']
    });

    window.addEventListener('resize', scheduleCleanup);
    setInterval(applyCleanup, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(start, 1500);
    });
  } else {
    setTimeout(start, 1500);
  }
})();
