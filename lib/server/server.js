/*
* cgm-remote-monitor - web app to broadcast cgm readings
* Copyright (C) 2014 Nightscout contributors.  See the COPYRIGHT file
* at the root directory of this distribution and at
* https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as published
* by the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Description: Basic web server to display data from Dexcom G4.  Requires a database that contains
// the Dexcom SGV data.
'use strict';

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

const fs = require('fs');
const env = require('./env')( );
const language = require('../language')();
const translate = language.set(env.settings.language).translate;
language.loadLocalization(fs);

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;
var HOSTNAME = env.HOSTNAME;

function create (app) {
  var transport = (env.ssl
                ? require('https') : require('http'));
  if (env.ssl) {
    return transport.createServer(env.ssl, app);
  }
  return transport.createServer(app);
}

require('./bootevent')(env, language).boot(function booted (ctx) {

    console.log('Boot event processing completed');
    
    var app = require('./app')(env, ctx);
    var server = create(app).listen(PORT, HOSTNAME);
    console.log(translate('Listening on port'), PORT, HOSTNAME);

    // Keep monitoring completely isolated from normal Nightscout startup.
    // The router is only constructed when /monitor is actually requested.
    let monitorRouter = null;
    app.use('/monitor', function lazyMonitorRouter(req, res, next) {
      try {
        if (!monitorRouter) {
          monitorRouter = require('./monitorbridge')(env);
        }
        return monitorRouter(req, res, next);
      } catch (err) {
        console.error('Monitor bridge failed to initialize:', err);
        return res.status(503).json({ ok: false, error: 'monitor_bridge_unavailable' });
      }
    });

    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return;
    }

    ctx.bus.on('teardown', function serverTeardown () {
      server.close();
      clearTimeout(sendStartupAllClearTimer);
      ctx.store.client.close();
    });

    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    var websocket = require('./websocket')(env, ctx, server);

    //after startup if we don't have any alarms send all clear
    let sendStartupAllClearTimer = setTimeout(function sendStartupAllClear () {
      var alarm = ctx.notifications.findHighestAlarm();
      if (!alarm) {
        ctx.bus.emit('notification', {
          clear: true
          , title: 'All Clear'
          , message: 'Server started without alarms'
        });
      }
    }, 20000);
});
