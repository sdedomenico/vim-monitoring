/*
   Copyright (C) 2015  Space Hellas S.A.

   This program is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>.
   */

var winston  = require('winston');
var influent = require('influent');
var Hapi     = require('hapi');
var Joi      = require('joi');
var http     = require('http');
var CronJob  = require('cron').CronJob;

// Configuration variables
var config       = require('config');
var loggingLevel = config.get('loggingLevel');
var dbHost       = config.get('database.host');
var dbPortTemp   = config.get('database.port');
if (typeof dbPortTemp === 'string' || dbPortTemp instanceof String) {
  var dbPort = parseInt(dbPortTemp);
} else {
  var dbPort = dbPortTemp;
}
var dbUsername         = config.get('database.username');
var dbPassword         = config.get('database.password');
var dbName             = config.get('database.name');
var pollingInterval    = config.get('ceilometer.pollingInterval');

winston.level = loggingLevel;
winston.log('info', 'T-NOVA VIM monitoring system');

// Database connection instantiation
var dbInflux = influent.createClient(
  {
    username   : dbUsername,
    password   : dbPassword,
    database   : dbName,
    server     : [{
      protocol : 'http',
      host     : dbHost,
      port     : dbPort
    }]
  }
);

var writeMeasurement = function(name, value, timestamp) {
  winston.log('verbose', name + ': ' + value + ' recorded at: ' +
    timestamp.toDate());
  dbInflux.then(function(client) {
    client.writeOne({
      key: name,
      fields: {
        value: value
      },
      timestamp: timestamp.toDate()
    });
  });
};

// TODO Do not issue new token if the previous one is not expired

var openStack      = require('./openstack.js');
var getToken       = openStack.getToken;
var getMeasurement = openStack.getMeasurement;

getMeasurements = function() {
  getToken()
    .then(function(token) {
      getMeasurement(token.id, 'cpu_util');
    })
    .catch(function(data) {
      winston.log('error', 'Error getting a new token.');
    });
  setTimeout(getMeasurements, pollingInterval);
};

getMeasurements();

var server = new Hapi.Server();
server.connection({
  port: 3000,
  labels: ['api']
});

server.register([
  require('inert'),
  require('vision'),
  {
    register: require('hapi-swaggered'),
    options: {
      tags: {
        'foobar/test': 'Example foobar description'
      },
      info: {
        title: 'T-NOVA VIM Monitoring API',
        description: 'Powered by node, hapi, joi, hapi-swaggered,' +
          'hapi-swaggered-ui and swagger-ui',
        version: '0.0.1'
      }
    }
  },
  {
    register: require('hapi-swaggered-ui'),
    options: {
      title: 'T-NOVA VIM Monitoring API',
      path: '/docs',
      swaggerOptions: {
        validatorUrl: null
      }
    }
  }], {
  select: 'api'
}, function(err) {
  if (err) {
    throw err;
  }
});

server.route({
  path: '/',
  method: 'GET',
  handler: function(request, reply) {
    reply.redirect('/docs');
  }
});

server.route({
  method: 'GET',
  path: '/api/meters/{host}/memfree',
  config: {
    tags: ['api'],
    description: 'Get the latest value of free memory on a specific host',
    validate: {
      params: {
        host: Joi.string().required().description('host name')
      }
    },
    handler: function(request, reply) {
      dbInflux.then(function(client) {
        client
          .query('SELECT last(value) FROM memory_value WHERE host=\'' +
            request.params.host + '\' AND type_instance=\'free\'')
          .then(function(result) {
            if ('series' in result.results[0]) {
              var meter = {};
              meter.date = result.results[0].series[0].values[0][0];
              meter.value = result.results[0].series[0].values[0][1];
              reply(meter);
            } else {
              reply('No hostname found.').code(404);
            }
          });
      });
    }
  }
});

server.route({
  method: 'GET',
  path: '/api/meters/{host}/cpuidle',
  config: {
    tags: ['api'],
    description: 'Get the latest value of idle CPU usage on a specific host ' +
      'in jiffies',
    validate: {
      params: {
        host: Joi.string().required().description('host name')
      }
    },
    handler: function(request, reply) {
      dbInflux.then(function(client) {
        client
          .query('SELECT LAST(value) FROM aggregation_value WHERE host=\'' +
            request.params.host +
            '\' AND type=\'cpu\' AND type_instance=\'idle\'')
          .then(function(result) {
            if ('series' in result.results[0]) {
              var meter = {};
              meter.date = result.results[0].series[0].values[0][0];
              meter.value = result.results[0].series[0].values[0][1];
              reply(meter);
            } else {
              reply('No hostname found.').code(404);
            }
          });
      });
    }
  }
});

function formatBytes(bytes, decimals) {
  if (bytes == 0) {
    return '0 Byte';
  }
  var k = 1000;
  var dm = decimals + 1 || 3;
  var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toPrecision(dm) + ' ' + sizes[i];
}

server.route({
  method: 'GET',
  path: '/api/meters/{host}/fs',
  config: {
    tags: ['api'],
    description: 'Get the latest root filesystem status on a specific host',
    validate: {
      params: {
        host: Joi.string().required().description('host name')
      }
    },
    handler: function(request, reply) {
      dbInflux.then(function(client) {
        client
          .query('SELECT * FROM df_value WHERE host=\'' + request.params.host +
            '\' AND instance=\'root\' AND time > now() - 30s')
          .then(function(result) {
            if ('series' in result.results[0]) {
              var measurement = result.results[0].series[0];
              var meter = {};
              meter.date = measurement.values[0][0];
              for (var i = 0; i < measurement.values.length; i++) {
                meter[measurement.values[i][4]] =
                  formatBytes(measurement.values[i][5], 2);
              }
              reply(meter);
            } else {
              reply('No hostname found.').code(404);
            }
          });
      });
    }
  }
});

server.route({
  method: 'POST',
  path: '/api/subscribe',
  config: {
    tags: ['api'],
    description: 'Subscribe to meter events',
    validate: {
      payload: Joi.object().keys({
        meters: Joi.array().items(Joi.string().required()).
          description('array of meter types'),
        instances: Joi.array().items(Joi.string().required()).
          description('array of instances'),
        interval: Joi.number().integer().required().
          description('interval in minutes'),
        callbackUrl: Joi.string().uri().required().
          description('callback URL')
      })
    },
    handler: function(request, reply) {
      reply('Your request has been registered successfully. ' +
        'Information shall be send every ' +
        request.payload.interval + ' minutes');
    }
  }
});

server.start(function() {
  winston.log('info', 'Server running at: ' + server.info.uri);
});
