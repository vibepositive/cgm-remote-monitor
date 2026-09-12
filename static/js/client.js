'use strict';

$(document).on('online', function() {
	console.log('Application got online event, reloading');
	window.location.reload();
});

$(document).ready(function() {
	console.log('Application got ready event');
	window.Nightscout.client.init();

	// Read-only Trio insulin classification overlay. This only changes chart
	// presentation; it does not alter Nightscout treatment or dosing behavior.
	var classifiedInsulin = document.createElement('script');
	classifiedInsulin.src = 'js/classified-insulin-events.js?v=20260912-1';
	classifiedInsulin.async = true;
	document.body.appendChild(classifiedInsulin);
});
