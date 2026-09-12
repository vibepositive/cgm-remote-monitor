'use strict';

$(document).on('online', function() {
	console.log('Application got online event, reloading');
	window.location.reload();
});

$(document).ready(function() {
	console.log('Application got ready event');
	window.Nightscout.client.init();

	// Custom read-only visualization for Trio insulin automation events.
	// Kept separate from Nightscout's dosing and treatment logic so it can be
	// removed or updated without changing any therapy behavior.
	var automationVisualization = document.createElement('script');
	automationVisualization.src = 'js/uam-smb-classification-v2.js';
	automationVisualization.async = true;
	document.body.appendChild(automationVisualization);
});
