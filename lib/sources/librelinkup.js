
var qs = require('qs');
var url = require('url');
var crypto = require('crypto');

const _LluApiEndpoints = {
    AE: "api-ae.libreview.io",
    AP: "api-ap.libreview.io",
    AU: "api-au.libreview.io",
    CA: "api-ca.libreview.io",
    DE: "api-de.libreview.io",
    EU: "api-eu.libreview.io",
    EU2: "api-eu2.libreview.io",
    FR: "api-fr.libreview.io",
    JP: "api-jp.libreview.io",
    US: "api-us.libreview.io",
}

var Defaults = {
  Login: '/llu/auth/login',
  Connections: '/llu/connections',
  Graph: '/llu/connections/',
  Logbook: '/llu/connections/',
  mime: 'application/json',
  Version: '4.17.0',
  Product: 'llu.android',

};
var software = require('../../package.json');
var user_agent_string = [software.name, `${software.name}@${software.version}`, `LibreView@${Defaults.Version}`, software.homepage].join(', ');

function mapArrowTrend (trend) {
  return mapArrowTrend.map[trend] || mapArrowTrend.map.default;
}
mapArrowTrend.map = {
  1: 'SingleDown',
  2: 'FortyFiveDown',
  3: 'Flat',
  4: 'FortyFiveUp',
  5: 'SingleUp',
  default: 'NOT COMPUTABLE'
};

function base_for (spec) {
  var server = spec.linkUpServer ? spec.linkUpServer : _LluApiEndpoints[spec.linkUpRegion.toUpperCase( ) || 'EU' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}
function linkUpSource (opts, axios) {
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': Defaults.mime,
                          'Accept-Encoding': "gzip, deflate, br",
                          'version': opts.linkUpVersion,
                          'User-Agent': user_agent_string,
                          'product': opts.linkUpProduct
                        };
  var baseURL = opts.baseURL;
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials ( ) {
      var payload = {
        email: opts.linkUpUsername,
        password: opts.linkUpPassword
      };
      return http.post(Defaults.Login, payload).then((response) => {
        console.log("LIBRE LINKUP AUTH", response.headers, response.data);
        return response.data;

      });
    },
    sessionFromAuth (auth) {
      function isPatient (elem) {
        return elem.patientId == opts.linkUpPatientId;
      }
      var token = auth.data.authTicket.token;
      var userId = auth.data.user.id;
      var accountId = crypto.createHash('sha256').update(userId).digest('hex');

      // Extract region from JWT payload to hit the correct regional endpoint
      var regionalBase = opts.baseURL;
      try {
        var jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
        var jwtRegion = jwtPayload.region && jwtPayload.region.toUpperCase();
        var regionalHost = jwtRegion && _LluApiEndpoints[jwtRegion];
        if (regionalHost) {
          regionalBase = 'https://' + regionalHost;
          console.log("LIBRE LINKUP regional endpoint from JWT:", jwtRegion, regionalBase);
        }
      } catch (e) {
        console.log("LIBRE LINKUP could not decode JWT region, using configured base URL", e.message);
      }

      var headers = {
        'Authorization': [ 'Bearer', token ].join(' '),
        'Account-Id': accountId
      };
      var connectionsUrl = regionalBase + Defaults.Connections;
      return http.get(connectionsUrl, { headers }).then((resp) => {
        console.log("CONNECTIONS RESPONSE FROM LIBRELINKUP", resp.status, resp.headers, resp.data);
        var connections = resp.data.data;

        if (connections.length == 0) {
          var err = new Error("NO CONNECTION WITH LIBRE LINKUP AVAILABLE");
          console.log(err);
          throw err;
        }
        if (connections.length > 1 && opts.linkUpPatientId) {
          connections = connections.filter(isPatient);
          if (connections.length > 1) {
            console.log("WARNING choose one of the", connections.length, 'patientIds and assign to CONNECT_LINK_UP_PATIENT_ID variable.')
          }
        }
        var result = connections[0];
        result.authTicket = auth.data.authTicket;
        result.accountId = accountId;
        result.regionalBase = regionalBase;
        console.log("LIBRE SESSION FROM AUTH", result);
        return result;

      });
      // return Promise.resolve(auth.data.authTicket);
    },
    dataFromSesssion (session, _last_known) {
      var regionalBase = session.regionalBase || opts.baseURL;
      var graph_url = regionalBase + Defaults.Graph + session.patientId + '/graph';
      var logbook_url = regionalBase + Defaults.Logbook + session.patientId + '/logbook';
      var token = session.authTicket.token;
      var headers = {
        'Authorization': `Bearer ${token}`,
        'Account-Id': session.accountId
      };
      return Promise.all([
        http.get(graph_url, { headers }),
        http.get(logbook_url, { headers })
      ]).then(([graphResp, logbookResp]) => {
        console.log("RECEIVED LIBRE GRAPH DATA", graphResp.status, graphResp.headers, graphResp.data);
        console.log("RECEIVED LIBRE LOGBOOK DATA", logbookResp.status, logbookResp.headers, logbookResp.data);
        return { graph: graphResp.data, logbook: logbookResp.data };
      });
    },
    transformGlucose (payload, last_known) {
      var { graph, logbook } = payload;
      var forty_eight_hours_ago = new Date(new Date( ).getTime( ) - (48 * 60 * 60 * 1000));
      var backfill_from = (last_known && last_known.entries) ? last_known.entries : forty_eight_hours_ago;
      function is_newer (elem) {
        return backfill_from < new Date(elem.dateString);
      }

      function to_ns_sgv (elem) {
        var dateTime = new Date(elem.FactoryTimestamp);
        var offset = dateTime.getTimezoneOffset( ) * 60 * 1000;
        dateTime.setTime(dateTime.getTime( ) - offset);
        return {
          type: 'sgv',
          device: 'nightscout-connect-librelinkup',
          dateString: dateTime.toISOString( ),
          date: dateTime.getTime( ),
          direction: mapArrowTrend(elem.TrendArrow),
          sgv: elem.ValueInMgPerDl,
        };
      }

      // Logbook returns full 5-min resolution entries, each with TrendArrow.
      // Graph's current reading (glucoseMeasurement) may be newer than what the logbook has.
      // Deduplicate by timestamp, preferring the current reading so its direction is preserved.
      var logbookEntries = (logbook.data || [ ]).map(to_ns_sgv).filter(is_newer);
      var currentSgv = graph.data && graph.data.connection && graph.data.connection.glucoseMeasurement
        ? to_ns_sgv(graph.data.connection.glucoseMeasurement)
        : null;
      var entries = currentSgv
        ? logbookEntries.filter(e => e.date !== currentSgv.date).concat(is_newer(currentSgv) ? [currentSgv] : [])
        : logbookEntries;
      var treatments = [ ];
      var devicestatus = [ ];
      var profiles = [ ];
      console.log("TRANSFORMING LIBRE BATCH", logbookEntries.length, 'logbook entries, current:', currentSgv && currentSgv.dateString);
      return { entries, treatments, devicestatus, profiles };
    },
    align_to_glucose (last_known) {
      console.log("LIBRELINKUP SOURCE DRIVER ALIGNMENT FOR GLUCOSE");
      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * 5)
      if (missing > 1 && missing < 3) {
        console.log("READJUSTING SHOULD MAKE A DIFFERENCE MISSING", missing);

      }
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * 5);
      var buffer_lag = 18000; // 18 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
    }
  };
  function tracker_for ( ) {
    var AxiosTracer = require('../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 3600000 - 600000,
        EXPIRE_SESSION_DELAY: 3600000
      }
    });



    builder.register_loop('LibreLinkUp', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        transform: impl.transformGlucose,
        backoff: {
          interval_ms: 30 * 1000
        },
        // only try 3 times to get data
        maxRetries: 2
      },
      // poll every minute so we don't miss a reading
      expected_data_interval_ms: 60 * 1000,
      backoff: {
        interval_ms: 30 * 1000
      },
    });
    return builder;
  };
  impl.generate_driver = generate_driver;
  return impl;
}
linkUpSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);
  var config = {
    linkUpRegion: input.linkUpRegion,
    linkUpServer: input.linkUpServer,
    linkUpUsername: input.linkUpUsername,
    linkUpPassword: input.linkUpPassword,
    linkUpPatientId: input.linkUpPatientId,
    linkUpVersion: input.linkUpVersion || Defaults.Version,
    linkUpProduct: input.linkUpProduct || Defaults.Product,
    baseURL
  };
  var errors = [ ];
  if (!config.linkUpUsername) {
    errors.push({desc: "The LibreLinkUp Username is required.. CONNECT_LINK_UP_USERNAME must be an active LibreLinkUp User to log in.", err: new Error('CONNECT_LINK_UP_USERNAME') } );
  }
  if (!config.linkUpPassword) {
    errors.push({desc: "LibreLinkUp Password is required. CONNECT_LINK_UP_PASSWORD must be the password for the LibreLinkUp User in order to login.", err: new Error('CONNECT_LINK_UP_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'linkUp' : 'disabled';
  return { ok, errors, config };
}
module.exports = linkUpSource;
