/**
 * Connected-by-tcp for HomeBridge
 * 
 * @author Jordan <https://github.com/chanomie>
 * @author Gene Park <https://github.com/gene203>
 */

var request = require("request"),
    uuid = require("node-uuid"),
    xml2js = require('xml2js'),
    Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform("homebridge-conntectedbytcp", "ConnectedByTcp", ConnectedByTcp);
};

function ConnectedByTcp(log, config) 
{
  this.log        = log;
  this.name       = config["name"];
  this.ip         = config["ip"]; 
  this.token      = config["token"];
  this.loglevel   = config["loglevel"];
  this.devices    = [];
  this.deviceNames = config["deviceNames"];
  
  // drop the request after 1.5 sec
  this.requestTimeout = config["requestTimeout"] || 1500; 

  // Cache the roomGetCarousel data. default is not used, but set 100 to cache for 100 ms
  // this can avoid too many of the requests to the gateway, but for now this feature can be disable due to the
  // request queue feature is good enough. but if there are many request maybe 10 ms or 100ms would help.
  this.cache = {
    roomGetCarousel: {
      timestamp: null,
      data: null
    },
    // room data cahe time to alive, default is not use the cache feature
    // 0 is to avoid the cache feature, unit is ms.
    ttl : config["roomCacheTTL"] || 0
  };


  this.roomGetCarouselRequest = {
    inProgress: false,
    promise: null
  };

  if(this.token === undefined) {
    this.log("token is not in config, attempting to sync hub: [" + this.ip + "]");
    this.syncHub();
  }
};

ConnectedByTcp.prototype = {
  accessories: function (callback) {
    var self = this;

    self.log("in accessories");
    self.search(function() { self.registerAccessories(callback) });
  },
  registerAccessories: function (callback) {
    var self = this;
    self.log("returning devices: ", self.devices);
    callback(self.devices);
  },
  syncHub: function() {
    var self = this,
        hubAddress = "https://" + this.ip + "/gwr/gop.php",
        loginUid = uuid.v4(),
        cmd="GWRLogin",
        data=encodeURIComponent("<gip><version>1</version><email>"+loginUid+"</email><password>"+loginUid+"</password></gip>"),
        fmt="xml";

    request({
      "rejectUnauthorized": false,
      "url": hubAddress,
      "method": "POST",
      headers: {
        'Content-Type': 'text/xml'
      },
      body: "cmd=" + cmd + "&data=" + data + "&fmt=xml"
    }, function(error, response, body) {
      if (error && error.code == "ECONNREFUSED") {
        self.log("Unabled to connect to IP, is this the right IP address for your hub?");
      } else if (error) {
        self.log("error.code: " + error.code);
        self.log("error.errno: " + error.errno);
        self.log("error.syscall: " + error.syscall);
      } else if(body == "<gip><version>1</version><rc>404</rc></gip>") {
        self.log("Hub is not in sync mode, set to sync mode an try again.");
      } else if(body.match(/.*<token>(.*)<\/token>.*/) !== null) {
        // Token Matches
        // <gip><version>1</version><rc>200</rc><token>e2de937chr0lhrlqd6bus3l2z5jcy5p3vs7013bn</token></gip>
        self.token = body.replace(/.*<token>(.*)<\/token>.*/,"$1");
        self.log("Hub is synced, update your config.json to include:");
        self.log("  token: " + self.token);
      } else {
        self.log("error: " + error);
        self.log("response: " + response);
        self.log("body: " + body);
      }
    });
  },
  search: function(searchCallback) {
    var self = this,
        hubAddress = "https://" + self.ip + "/gwr/gop.php",
        cmd="RoomGetCarousel",
        data=encodeURIComponent("<gip><version>1</version><token>" + self.token + "</token><fields>name\ncontrol\npower\nproduct\nclass\nrealtype\nstatus</fields></gip>"),
        fmt="xml";

    self.roomGetCarousel('search').then(function(result, err) {
      if ( ! result ) {
	      searchCallback(null);
        return;
      }
      for (var i = 0; i < result.gip.room.length; i++) {
        for (var j = 0; j < result.gip.room[i].device.length; j++) {
          for (var k = 0; k < result.gip.room[i].device[j].did.length; k++) {
            self.log(JSON.stringify(result.gip.room[i].device[j]));
            var level = 0;
            if("level" in result.gip.room[i].device[j]) {
              level = result.gip.room[i].device[j].level ? result.gip.room[i].device[j].level[k] : 0;
            }
            var roomName = result.gip.room[i].name && result.gip.room[i].name.length > 0 ? 
              result.gip.room[i].name[0] : 
              result.gip.room[i].name
            ;
            var newDevice = new TcpLightbulb(
              self,
              self.log,
              result.gip.room[i].device[j].did[k],
              result.gip.room[i].device[j].state[k],
              level,
              roomName
            );

            self.devices.push(newDevice);
          }
        }
      }
      searchCallback();
    }).catch(error => {
      // Handle the error
      searchCallback(error);
    });
  },

  /**
   * Iterate the room and get the device status.
   * 
   * This function is called too often in a short period time, 
   * all the requests than initiated before the 1st request is concluded will be queued and 
   * use the same result from the 1st reqeust by;
   * 
   * Enhanced Request Management to Prevent Gateway Overload
   *
   * This feature optimizes the handling of overlapping requests to the gateway. 
   * Previously, rapid, consecutive requests to the gateway often resulted in 
   * unnecessary load or, in some cases, the gateway appeared to ignore these 
   * repetitive requests, likely as a protective measure against overload.
   *
   * The improvement works by detecting if a same request is already in progress. 
   * If so, it refrains from sending a new, identical request to the gateway. Instead,
   * it waits for the response of the ongoing request. This approach significantly 
   * reduces the number of redundant requests sent to the gateway in a short period, 
   * ensuring smoother operation and reducing the risk of the gateway dismissing 
   * these requests as potential spam or attack vectors.
   *
   * Additionally, this method improves overall performance by reducing network 
   * traffic, leading to more efficient communication with the gateway and ensuring
   * that each legitimate request is handled appropriately without being disregarded.
   * 
   * @return Promise - call callback in Promise.then(function{}).catch(function{}); or HomeBridge will complain.
   */
  roomGetCarousel: function(label) {
    var self = this,
        cache = self.cache.roomGetCarousel,
        currentTime = new Date().getTime();

    // Cache the result to avoid too much request to the gateway.
    if (cache.timestamp && (currentTime - cache.timestamp) < cache.ttl) 
    {
      if(self.loglevel >= 2)
        self.log("roomGetCarousel:use cache:",(currentTime - cache.timestamp), "<" , cache.ttl);

      return new Promise(function(resolve, reject){
        resolve(cache.data);
      }); 
    }

    // If a request is already in progress, return the existing promise
    if (self.roomGetCarouselRequest.inProgress) {
      return self.roomGetCarouselRequest.promise;
    }

    // Mark that a request is in progress and create a new promise
    self.roomGetCarouselRequest.inProgress = true;
    
    return self.roomGetCarouselRequest.promise = new Promise(function(resolve, reject) {
      var hubAddress = "https://" + self.ip + "/gwr/gop.php",
        cmd="RoomGetCarousel",
        data=encodeURIComponent("<gip><version>1</version><token>" + self.token + "</token><fields>name\ncontrol\npower\nproduct\nclass\nrealtype\nstatus</fields></gip>"),
        fmt="xml";

      request({
        "rejectUnauthorized": false,
        "url": hubAddress,
        "method": "POST",
        "timeout": self.requestTimeout,
        headers: {
          'Content-Type': 'text/xml'
        },
        body: "cmd=" + cmd + "&data=" + data + "&fmt=xml"
      }, function(error, response, body) {
        if (error && error.code == "ECONNREFUSED") {
          self.log("Unabled to connect to IP, is this the right IP address for your hub?");
          reject(error.code); // callback();
        } else if (error && error.code == "ECONNRESET") {
          self.log("roomGetCarousel:error.code: " + error.code);
          reject(error.code); // callback();
        } else if (error && error.code == "ESOCKETTIMEDOUT") {
          self.log("roomGetCarousel:timeout, checking cache");
          currentTime = new Date().getTime();
          if (cache.timestamp && (currentTime - cache.timestamp) < cache.ttl) 
          {
              self.log("roomGetCarousel:use cache:",(currentTime - cache.timestamp), "<" , cache.ttl);
              resolve(cache.data); 
              return;
          }
          self.log("roomGetCarousel:no recent cache:"+label);
          reject(error.code);
  
        } else if (error) {
          self.log("roomGetCarousel:error.code: " + error.code);
          self.log("roomGetCarousel:error.errno: " + error.errno);
          self.log("roomGetCarousel:error.syscall: " + error.syscall);
          reject(error.code);
        } else if(body == "<gip><version>1</version><rc>404</rc></gip>") {
          self.log("roomGetCarousel:Hub is not in sync mode, set to sync mode an try again.");
          reject("Hub is not in sync mode");
        } else {
          if(self.loglevel >= 3) {
            self.log("roomGetCarousel result: %s", body);
          }
          xml2js.parseString(body, function (err, result) {
            // Cache the result
            self.cache.roomGetCarousel = {
              timestamp: new Date().getTime(),
              data: result
            };
            
            resolve(result);
          });
        }
      });
    }).then(result => {
        // Reset the state after the request is complete
        self.roomGetCarouselRequest.inProgress = false;
        return result;
    }).catch(error => {
        // Reset the state and propagate the error
        self.roomGetCarouselRequest.inProgress = false;
        throw error;
    });
  },

  deviceUpdateStatus: function(tcpLightbulb, callback) {
    var self = this;
    self.roomGetCarousel('dUS').then(result => {
      if(!result) 
      {
        self.log("deviceUpdateStatus:roomGetCarousel return nil",tcpLightbulb);
        callback("return nil");
        return
      }
      if(self.loglevel >= 3) {
        self.log("deviceUpdateStatus: Calback from roomGetCarousel : [%s]", JSON.stringify(result));
      }

      for (var i = 0; i < result.gip.room.length; i++) {
        for (var j = 0; j < result.gip.room[i].device.length; j++) {
          for (var k = 0; k < result.gip.room[i].device[j].did.length; k++) {
            if(tcpLightbulb.deviceid == result.gip.room[i].device[j].did[k]) {
              if(self.loglevel >= 3) {
                self.log("deviceUpdateStatus: Updating bulb based on result [%s]",
                  JSON.stringify(result.gip.room[i].device[j]));
              }

              tcpLightbulb.state = result.gip.room[i].device[j].state[k];
              if("level" in result.gip.room[i].device[j]) {
                tcpLightbulb.level = result.gip.room[i].device[j].level ? result.gip.room[i].device[j].level[k] : 0;
              } else {
                tcpLightbulb.level = 0;
              }
          }
          }
        }
      }

      callback();
    }).catch(error => {
      callback(error);
    });
  },

  deviceSendCommand: function(deviceid, statevalue, callback) {
    var self = this,
        hubAddress = "https://" + self.ip + "/gwr/gop.php",
        cmd="DeviceSendCommand",
        unencodedData = "<gip><version>1</version><token>" + self.token + "</token><did>" + deviceid + "</did><value>" + statevalue + "</value></gip>",
        data=encodeURIComponent(unencodedData);
        fmt="xml",
        body="cmd=" + cmd + "&data=" + data + "&fmt=xml";

    if(self.loglevel >= 3) {
      self.log("Sending device request: %s", unencodedData);
    }

    request({
      "rejectUnauthorized": false,
      "url": hubAddress,
      "method": "POST",
      "timeout": self.requestTimeout,
      headers: {
        'Content-Type': 'text/xml'
      },
      body: body
    }, function(error, response, body) {
      if (error && error.code == "ECONNREFUSED") {
        self.log("Unabled to connect to IP, is this the right IP address for your hub?");
        callback();
      } else if (error && error.code == "ECONNRESET") {
        self.log("ECONNRESET: "+hubAddress+" "+ body);
        callback();
      } else if (error) {
        self.log("deviceSendCommand:error.code: " + error.code);
        self.log("deviceSendCommand:error.errno: " + error.errno);
        self.log("deviceSendCommand:error.syscall: " + error.syscall);
        callback();
      } else if(body == "<gip><version>1</version><rc>404</rc></gip>") {
        self.log("Token is invalid, switch back to sync mode to try again.");
        callback();
      } else {
        xml2js.parseString(body, function (err, result) {
          if ( err ) 
          {
		self.log("xml2js: err: " , err);
          	self.log("Done parsing XML: " + JSON.stringify(result));
	  }
          callback();
        });
      }
    });
  },

  deviceSendCommandLevel: function(deviceid, level, callback) {
    var self = this,
        hubAddress = "https://" + self.ip + "/gwr/gop.php",
        cmd="DeviceSendCommand",
        unencodedData = "<gip><version>1</version><token>" + self.token + "</token><did>" + deviceid + "</did><value>" + level + "</value><type>level</type></gip>",
        data=encodeURIComponent(unencodedData);
        fmt="xml",
        body="cmd=" + cmd + "&data=" + data + "&fmt=xml";

    if(self.loglevel >= 3) {
      self.log("Sending device request: %s", unencodedData);
    }

    request({
      "rejectUnauthorized": false,
      "url": hubAddress,
      "method": "POST",
      "timeout": self.requestTimeout,
      headers: {
        'Content-Type': 'text/xml'
      },
      body: body
    }, function(error, response, body) {
      if (error && error.code == "ECONNREFUSED") {
        self.log("Unabled to connect to IP, is this the right IP address for your hub?");
        callback();
      } else if (error) {
        self.log("error.code: " + error.code);
        self.log("error.errno: " + error.errno);
        self.log("error.syscall: " + error.syscall);
        callback();
      } else if(body == "<gip><version>1</version><rc>404</rc></gip>") {
        self.log("Token is invalid, switch back to sync mode to try again.");
        callback();
      } else {
        xml2js.parseString(body, function (err, result) {
          if ( err ) {
            self.log("Parsing err:", err);
            self.log("Done parsing XML: " + JSON.stringify(result));
          }
          callback();
        });

      }
    });
  }
};

function TcpLightbulb(connectedByTcp, log, deviceid, state, level, name) {
  var self = this;

  self.connectedByTcp = connectedByTcp;
  self.log = log;
  self.roomName = name;
  if (connectedByTcp.deviceNames && connectedByTcp.deviceNames[deviceid]) {
    self.name = connectedByTcp.deviceNames[deviceid];
  } else {
    self.name = "Bulb " + deviceid;
  }
  self.deviceid = deviceid;
  self.state = state;
  self.level = level;
  self.log("Creating Lightbulb with device id '%s' and state '%s' at room %s", self.deviceid, self.state, self.roomName);
};

TcpLightbulb.prototype = {
  getPowerOn: function(callback) {
    var self = this;

    if(self.loglevel >= 2)
      self.log("getPowerOn: '%s' is %s", self.name, self.state);

    self.connectedByTcp.deviceUpdateStatus(this, function() {
      callback(null, self.state > 0);
    });
  },

  setPowerOn: function(powerOn, callback) {
    var self = this;

    self.log("setPowerOn: Set '%s' to %s", self.name, powerOn);
    self.connectedByTcp.deviceSendCommand(self.deviceid, powerOn == true ? 1 : 0, function(err){
      if (err) 
      {
         self.log("Error in setPowerOn: " + err);
         callback(err); // Pass the error to HomeKit
         return;
      }
      self.connectedByTcp.cache.roomGetCarousel.timestamp = 0; // invalidate cache
      callback(null);
    });
  },

  getBrightness: function(callback) {
    var self = this;

    if(self.loglevel >= 3)
      self.log("getBrightness: '%s' is %s", self.name, self.level);
    
    self.connectedByTcp.deviceUpdateStatus(this, function() {
      callback(null, parseInt(self.level));

    });
  },

  setBrightness: function(level, callback) {
    var self = this;

    self.log("setBrightness: Set '%s' to %s", self.name, level);
    self.connectedByTcp.deviceSendCommandLevel(self.deviceid, level,function(err){
      if (err) {
         self.log("Error in setPowerOn: " + err);
         callback(err); // Pass the error to HomeKit
         return;
      }
      self.connectedByTcp.cache.roomGetCarousel.timestamp = 0; // invalidate cache
      callback(null);
    });
  },

  getServices: function() {
    var lightbulbService = new Service.Lightbulb(this.name);

    lightbulbService
      .getCharacteristic(Characteristic.On)
      .on('get', this.getPowerOn.bind(this))
      .on('set', this.setPowerOn.bind(this));

    lightbulbService
      .addCharacteristic(Characteristic.Brightness)
      .on('get', this.getBrightness.bind(this))
      .on('set', this.setBrightness.bind(this));

    return [lightbulbService];
  }
}
