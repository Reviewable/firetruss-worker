/* globals firebase */

var fireworkers = [];
var apps = {};
// This version is filled in by the build, don't reformat the line.
var VERSION = '2.4.3';


var LocalStorage = function LocalStorage() {
  this._items = [];
  this._pendingItems = [];
  this._initialized = false;
  this._flushPending = this.flushPending.bind(this);
};

var prototypeAccessors = { length: { configurable: true } };

LocalStorage.prototype.init = function init (items) {
  if (!this._initialized) {
    this._items = items;
    this._initialized = true;
  }
};

LocalStorage.prototype._update = function _update (item) {
  if (!this._pendingItems.length) { Promise.resolve().then(this._flushPending); }
  this._pendingItems.push(item);
};

LocalStorage.prototype.flushPending = function flushPending () {
  if (!this._pendingItems.length) { return; }
  if (!fireworkers.length) {
    setTimeout(this._flushPending, 200);
    return;
  }
  fireworkers[0]._send({msg: 'updateLocalStorage', items: this._pendingItems});
  this._pendingItems = [];
};

prototypeAccessors.length.get = function () {return this._items.length;};

LocalStorage.prototype.key = function key (n) {
  return this._items[n].key;
};

LocalStorage.prototype.getItem = function getItem (key) {
  for (var i = 0, list = this._items; i < list.length; i += 1) {
    var item = list[i];

      if (item.key === key) { return item.value; }
  }
  return null;
};

LocalStorage.prototype.setItem = function setItem (key, value) {
  var targetItem;
  for (var i = 0, list = this._items; i < list.length; i += 1) {
    var item = list[i];

      if (item.key === key) {
      targetItem = item;
      item.value = value;
      break;
    }
  }
  if (!targetItem) {
    targetItem = {key: key, value: value};
    this._items.push(targetItem);
  }
  this._update(targetItem);
};

LocalStorage.prototype.removeItem = function removeItem (key) {
  for (var i = 0; i < this._items.length; i++) {
    if (this._items[i].key === key) {
      this._items.splice(i, 1);
      this._update({key: key, value: null});
      break;
    }
  }
};

LocalStorage.prototype.clear = function clear () {
  for (var item in this._items) {
    this._update({key: item.key, value: null});
  }
  this._items = [];
};

Object.defineProperties( LocalStorage.prototype, prototypeAccessors );

self.localStorage = new LocalStorage();


var Branch = function Branch() {
  this._root = null;
};

Branch.prototype.set = function set (value) {
  this._root = value;
};

Branch.prototype.diff = function diff (value, pathPrefix) {
  var updates = {};
  var segments = pathPrefix === '/' ? [''] : pathPrefix.split('/');
  if (this._diffRecursively(this._root, value, segments, updates)) {
    this._root = value;
    updates[pathPrefix] = value;
  }
  return updates;
};

Branch.prototype._diffRecursively = function _diffRecursively (oldValue, newValue, segments, updates) {
  if (oldValue === undefined) { oldValue = null; }
  if (newValue === undefined) { newValue = null; }
  if (oldValue === null) { return newValue !== null; }
  if (oldValue instanceof Object && newValue instanceof Object) {
    var replace = true;
    var keysToReplace = [];
    for (var childKey in newValue) {
      if (!newValue.hasOwnProperty(childKey)) { continue; }
      var replaceChild = this._diffRecursively(
        oldValue[childKey], newValue[childKey], segments.concat(childKey), updates);
      if (replaceChild) {
        keysToReplace.push(childKey);
      } else {
        replace = false;
      }
    }
    if (replace) { return true; }
    for (var childKey$1 in oldValue) {
      if (!oldValue.hasOwnProperty(childKey$1) || newValue.hasOwnProperty(childKey$1)) { continue; }
      updates[segments.concat(childKey$1).join('/')] = null;
      delete oldValue[childKey$1];
    }
    for (var i = 0, list = keysToReplace; i < list.length; i += 1) {
      var childKey$2 = list[i];

        updates[segments.concat(childKey$2).join('/')] = newValue[childKey$2];
      oldValue[childKey$2] = newValue[childKey$2];
    }
  } else {
    return newValue !== oldValue;
  }
};


var Fireworker = function Fireworker(port) {
  this._port = port;
  this._lastWriteSerial = 0;
  this._app = undefined;
  this._cachedAuth = undefined;
  this._cachedDatabase = undefined;
  this._lastJsonUser = undefined;
  this._configError = Fireworker._staticConfigError;
  this._callbacks = {};
  this._messages = [];
  this._flushMessageQueue = this._flushMessageQueue.bind(this);
  port.onmessage = this._receive.bind(this);
};

var prototypeAccessors$1 = { _auth: { configurable: true },_database: { configurable: true } };

prototypeAccessors$1._auth.get = function () {
  if (this._cachedAuth) { return this._cachedAuth; }
  if (!this._app) { throw new Error('Must provide Firebase configuration data first'); }
  return this._cachedAuth = this._app.auth();
};

prototypeAccessors$1._database.get = function () {
  if (this._cachedDatabase) { return this._cachedDatabase; }
  if (!this._app) { throw new Error('Must provide Firebase configuration data first'); }
  if (Fireworker._databaseWrapperCallback) {
    this._cachedDatabase = Fireworker._databaseWrapperCallback(this._app.database());
  } else {
    this._cachedDatabase = this._app.database();
  }
  return this._cachedDatabase;
};

Fireworker.prototype.init = function init (ref) {
    var storage = ref.storage;
    var config = ref.config;

  if (storage) { self.localStorage.init(storage); }
  if (config) {
    try {
      if (!apps[config.databaseURL]) {
        apps[config.databaseURL] = firebase.initializeApp(config, config.databaseURL);
      }
      this._app = apps[config.databaseURL];
      this._app.database();
      this._app.auth();
      this._configError = Fireworker._staticConfigError;
    } catch (e) {
      this._configError = e;
      throw e;
    }
  } else if (this._configError) {
    throw this._configError;
  }
  return {
    exposedFunctionNames: Object.keys(Fireworker._exposed),
    version: VERSION,
    firebaseSdkVersion: firebase.SDK_VERSION
  };
};

Fireworker.prototype.destroy = function destroy () {
  for (var key in this._callbacks) {
    var callback = this._callbacks[key];
    if (callback.cancel) { callback.cancel(); }
  }
  this._callbacks = {};
  this._port.onmessage = null;
  this._messages = [];
  var k = fireworkers.indexOf(this);
  if (k >= 0) { fireworkers[k] = null; }
};

Fireworker.prototype.enableFirebaseLogging = function enableFirebaseLogging (ref) {
    var value = ref.value;

  firebase.database.enableLogging(value);
};

Fireworker.prototype.ping = function ping () {
  // Noop, placeholder for legacy Firetruss clients.
};

Fireworker.prototype.bounceConnection = function bounceConnection () {
  this._database.goOffline();
  this._database.goOnline();
};

Fireworker.prototype._receive = function _receive (event) {
  Fireworker._firstMessageReceived = true;
  for (var i = 0, list = event.data; i < list.length; i += 1) {
      var message = list[i];

      this._receiveMessage(message);
    }
};

Fireworker.prototype._receiveMessage = function _receiveMessage (message) {
    var this$1 = this;

  var promise;
  try {
    var fn = this[message.msg];
    if (typeof fn !== 'function') { throw new Error('Unknown message: ' + message.msg); }
    if (message.writeSerial) {
      this._lastWriteSerial = Math.max(this._lastWriteSerial, message.writeSerial);
    }
    promise = Promise.resolve(fn.call(this, message));
  } catch (e) {
    e.immediateFailure = true;
    promise = Promise.reject(e);
  }
  if (!message.oneWay) {
    promise.then(function (result) {
      this$1._send({msg: 'resolve', id: message.id, result: result});
    }, function (error) {
      this$1._send({msg: 'reject', id: message.id, error: errorToJson(error)});
    });
  }
};

Fireworker.prototype._send = function _send (message) {
  if (!this._messages.length) { Promise.resolve().then(this._flushMessageQueue); }
  this._messages.push(message);
};

Fireworker.prototype._flushMessageQueue = function _flushMessageQueue () {
  this._port.postMessage(this._messages);
  this._messages = [];
};

Fireworker.prototype.call = function call (ref) {
    var name = ref.name;
    var args = ref.args;

  try {
    return Promise.resolve(Fireworker._exposed[name].apply(null, args));
  } catch (e) {
    return Promise.reject(e);
  }
};

Fireworker.prototype.authWithCustomToken = function authWithCustomToken (ref) {
    var url = ref.url;
    var authToken = ref.authToken;

  return this._auth.signInWithCustomToken(authToken)
    .then(function (result) { return userToJson(result.user); });
};

Fireworker.prototype.authAnonymously = function authAnonymously (ref) {
    var url = ref.url;

  return this._auth.signInAnonymously()
    .then(function (result) { return userToJson(result.user); });
};

Fireworker.prototype.unauth = function unauth (ref) {
    var this$1 = this;
    var url = ref.url;

  return this._auth.signOut().catch(function (e) {
    // We can ignore the error if the user is signed out anyway, but make sure to notify all
    // authCallbacks otherwise we end up in a bogus state!
    if (this$1._auth.currentUser === null) {
      for (var callbackId in this$1._callbacks) {
        if (!this$1._callbacks.hasOwnProperty(callbackId)) { continue; }
        var callback = this$1._callbacks[callbackId];
        if (callback.auth) { callback(null); }
      }
    } else {
      return Promise.reject(e);
    }
  });
};

Fireworker.prototype.onAuth = function onAuth (ref) {
    var url = ref.url;
    var callbackId = ref.callbackId;

  var authCallback = this._callbacks[callbackId] = this._onAuthCallback.bind(this, callbackId);
  authCallback.auth = true;
  authCallback.cancel = this._auth.onIdTokenChanged(authCallback);
};

Fireworker.prototype._onAuthCallback = function _onAuthCallback (callbackId, user) {
    var this$1 = this;

  userToJson(user).then(function (jsonUser) {
    if (areEqualValues(this$1._lastJsonUser, jsonUser)) { return; }
    this$1._lastJsonUser = jsonUser;
    this$1._send({msg: 'callback', id: callbackId, args: [jsonUser]});
  });
};

Fireworker.prototype.set = function set (ref) {
    var url = ref.url;
    var value = ref.value;

  return this._createRef(url).set(value);
};

Fireworker.prototype.update = function update (ref) {
    var url = ref.url;
    var value = ref.value;

  return this._createRef(url).update(value);
};

Fireworker.prototype.once = function once (ref) {
    var this$1 = this;
    var url = ref.url;

  return this._createRef(url).once('value').then(function (snapshot) { return this$1._snapshotToJson(snapshot); });
};

Fireworker.prototype.on = function on (ref) {
    var listenerKey = ref.listenerKey;
    var url = ref.url;
    var spec = ref.spec;
    var eventType = ref.eventType;
    var callbackId = ref.callbackId;
    var options = ref.options;

  options = options || {};
  if (options.sync) { options.branch = new Branch(); }
  options.cancel = this.off.bind(this, {listenerKey: listenerKey, url: url, spec: spec, eventType: eventType, callbackId: callbackId});
  var snapshotCallback = this._callbacks[callbackId] =
    this._onSnapshotCallback.bind(this, callbackId, options);
  snapshotCallback.listenerKey = listenerKey;
  snapshotCallback.eventType = eventType;
  snapshotCallback.cancel = options.cancel;
  var cancelCallback = this._onCancelCallback.bind(this, callbackId);
  this._createRef(url, spec).on(eventType, snapshotCallback, cancelCallback);
};

Fireworker.prototype.off = function off (ref) {
    var listenerKey = ref.listenerKey;
    var url = ref.url;
    var spec = ref.spec;
    var eventType = ref.eventType;
    var callbackId = ref.callbackId;

  var snapshotCallback;
  if (callbackId) {
    // Callback IDs will not be reused across on() calls, so it's safe to just delete it.
    snapshotCallback = this._callbacks[callbackId];
    delete this._callbacks[callbackId];
  } else {
    for (var i = 0, list = Object.keys(this._callbacks); i < list.length; i += 1) {
      var key = list[i];

        if (!this._callbacks.hasOwnProperty(key)) { continue; }
      var callback = this._callbacks[key];
      if (callback.listenerKey === listenerKey &&
          (!eventType || callback.eventType === eventType)) {
        delete this._callbacks[key];
      }
    }
  }
  this._createRef(url, spec).off(eventType, snapshotCallback);
};

Fireworker.prototype._onSnapshotCallback = function _onSnapshotCallback (callbackId, options, snapshot) {
  if (options.sync && options.rest) {
    var path = decodeURIComponent(
      snapshot.ref.toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
    var value;
    try {
      value = normalizeFirebaseValue(snapshot.val());
    } catch (e) {
      options.cancel();
      this._onCancelCallback(callbackId, e);
      return;
    }
    var updates = options.branch.diff(value, path);
    for (var childPath in updates) {
      if (!updates.hasOwnProperty(childPath)) { continue; }
      this._send({
        msg: 'callback', id: callbackId,
        args: [null, {
          path: childPath, value: updates[childPath], writeSerial: this._lastWriteSerial
        }]
      });
    }
  } else {
    try {
      var snapshotJson = this._snapshotToJson(snapshot);
      if (options.sync) { options.branch.set(snapshotJson.value); }
      this._send({msg: 'callback', id: callbackId, args: [null, snapshotJson]});
      options.rest = true;
    } catch (e$1) {
      options.cancel();
      this._onCancelCallback(callbackId, e$1);
    }
  }
};

Fireworker.prototype._onCancelCallback = function _onCancelCallback (callbackId, error) {
  delete this._callbacks[callbackId];
  this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
};

Fireworker.prototype.transaction = function transaction (ref$1) {
    var this$1 = this;
    var url = ref$1.url;
    var oldValue = ref$1.oldValue;
    var relativeUpdates = ref$1.relativeUpdates;

  var transactionPath = decodeURIComponent(url.replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
  var ref = this._createRef(url);
  var branch = new Branch();
  var stale, committedValue;

  return ref.transaction(function (value) {
    committedValue = undefined;
    value = normalizeFirebaseValue(value);
    stale = !areEqualNormalFirebaseValues(value, oldValue);
    if (stale) { value = oldValue; }
    if (relativeUpdates) {
      for (var relativePath in relativeUpdates) {
        if (!relativeUpdates.hasOwnProperty(relativePath)) { continue; }
        if (relativePath) {
          var segments = relativePath.split('/');
          if (value === undefined || value === null) { value = {}; }
          var object = value;
          for (var i = 0; i < segments.length - 1; i++) {
            var key = segments[i];
            var child = object[key];
            if (child === undefined || child === null) { child = object[key] = {}; }
            object = child;
          }
          object[segments[segments.length - 1]] = relativeUpdates[relativePath];
        } else {
          value = relativeUpdates[relativePath];
        }
      }
    }
    branch.set(value);
    if (!stale) {
      committedValue = value;
      return value;
    }
  }).then(function (result) {
    var snapshots = [];
    var updates = branch.diff(normalizeFirebaseValue(result.snapshot.val()), transactionPath);
    for (var path in updates) {
      if (!updates.hasOwnProperty(path)) { continue; }
      snapshots.push({
        path: path, value: updates[path], writeSerial: result.writeSerial || this$1._lastWriteSerial
      });
    }
    return {committed: !stale, snapshots: snapshots};
  }, function (error) {
    if (error.message === 'set' || error.message === 'disconnect') {
      return ref.once('value').then(function (snapshot) {
        return {committed: false, snapshots: [snapshot], writeSerial: this$1._lastWriteSerial};
      });
    }
    error.committedValue = committedValue;
    return Promise.reject(error);
  });
};

Fireworker.prototype._snapshotToJson = function _snapshotToJson (snapshot) {
  var path =
    decodeURIComponent(snapshot.ref.toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
  return {
    path: path, value: normalizeFirebaseValue(snapshot.val()), writeSerial: this._lastWriteSerial
  };
};

Fireworker.prototype.onDisconnect = function onDisconnect (ref) {
    var url = ref.url;
    var method = ref.method;
    var value = ref.value;

  var onDisconnect = this._createRef(url).onDisconnect();
  return onDisconnect[method](value);
};

Fireworker.prototype._createRef = function _createRef (url, spec) {
  if (!this._app) { throw new Error('Must provide Firebase configuration data first'); }
  try {
    var ref = this._database.refFromURL(url);
    if (spec) {
      switch (spec.by) {
        case '$key': ref = ref.orderByKey(); break;
        case '$value': ref = ref.orderByValue(); break;
        default: ref = ref.orderByChild(spec.by); break;
      }
      if (spec.at !== undefined) { ref = ref.equalTo(spec.at); }
      else if (spec.from !== undefined) { ref = ref.startAt(spec.from); }
      else if (spec.to !== undefined) { ref = ref.endAt(spec.to); }
      if (spec.first !== undefined) { ref = ref.limitToFirst(spec.first); }
      else if (spec.last !== undefined) { ref = ref.limitToLast(spec.last); }
    }
    return ref;
  } catch (e) {
    e.extra = {url: url, spec: spec};
    throw e;
  }
};

Fireworker.expose = function expose (fn, name) {
  name = name || fn.name;
  if (!name) {
    Fireworker._signalStaticConfigError(
      new Error(("Cannot expose a function with no name: " + fn)));
  }
  if (Fireworker._exposed.hasOwnProperty(name)) {
    Fireworker._signalStaticConfigError(new Error(("Function " + name + "() already exposed")));
  }
  if (Fireworker._firstMessageReceived) {
    Fireworker._signalStaticConfigError(new Error('Too late to expose function, worker in use'));
  }
  Fireworker._exposed[name] = fn;
};

Fireworker.setDatabaseWrapperCallback = function setDatabaseWrapperCallback (fn) {
  if (Fireworker._databaseWrapperCallback) {
    Fireworker._signalStaticConfigError(new Error('Database wrapper callback already set'));
  }
  if (Fireworker._firstMessageReceived) {
    Fireworker._signalStaticConfigError(
      new Error('Too late to set database wrapper callback, worker in use'));
  }
  Fireworker._databaseWrapperCallback = fn;
};

Fireworker._signalStaticConfigError = function _signalStaticConfigError (error) {
  if (!Fireworker._staticConfigError) { Fireworker._staticConfigError = error; }
  for (var i = 0, list = fireworkers; i < list.length; i += 1) {
    var fireworker = list[i];

      if (fireworker && !fireworker._configError) { fireworker._configError = error; }
  }
  throw error;
};

Object.defineProperties( Fireworker.prototype, prototypeAccessors$1 );

Fireworker._exposed = {};
Fireworker._firstMessageReceived = false;
Fireworker._databaseWrapperCallback = undefined;
Fireworker._staticConfigError = undefined;

function errorToJson(error) {
  var json = {name: error.name, message: error.message};
  var propertyNames = Object.getOwnPropertyNames(error);
  for (var i = 0, list = propertyNames; i < list.length; i += 1) {
    var propertyName = list[i];

    json[propertyName] = error[propertyName];
  }
  return json;
}

function normalizeFirebaseValue(value) {
  if (Array.isArray(value)) {
    var normalValue = {};
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (item === undefined || item === null) { continue; }
      normalValue[i] = normalizeFirebaseValue(item);
    }
    return normalValue;
  }
  if (value instanceof Object) {
    for (var key in value) {
      if (value.hasOwnProperty(key)) { value[key] = normalizeFirebaseValue(value[key]); }
    }
  }
  return value;
}

function userToJson(user) {
  if (!user) { return Promise.resolve(user); }
  var json = user.toJSON();
  delete json.stsTokenManager;
  return user.getIdTokenResult().then(function (result) {
    delete result.claims.exp;
    delete result.claims.iat;
    json.claims = result.claims;
    return json;
  });
}


function areEqualNormalFirebaseValues(a, b) {
  if (a === b) { return true; }
  if ((a === null || a === undefined) && (b === null || b === undefined)) { return true; }
  if (a === null || b === null) { return false; }
  if (!(typeof a === 'object' && typeof b === 'object')) { return false; }
  for (var key in a) {
    if (!a.hasOwnProperty(key) || !b.hasOwnProperty(key)) { return false; }
    if (!areEqualNormalFirebaseValues(a[key], b[key])) { return false; }
  }
  for (var key$1 in b) {
    if (!a.hasOwnProperty(key$1) || !b.hasOwnProperty(key$1)) { return false; }
  }
  return true;
}

function areEqualValues(a, b) {
  if (a === b) { return true; }
  if (a === null && b === null || a === undefined && b === undefined) { return true; }
  if (a === null || b === null || a === undefined || b === undefined) { return false; }
  if (!(typeof a === 'object' && typeof b === 'object')) { return false; }
  for (var key in a) {
    if (!a.hasOwnProperty(key) || !b.hasOwnProperty(key)) { return false; }
    if (!areEqualValues(a[key], b[key])) { return false; }
  }
  for (var key$1 in b) {
    if (!a.hasOwnProperty(key$1) || !b.hasOwnProperty(key$1)) { return false; }
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { return false; }
    if (a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i++) {
      if (!areEqualValues(a[i], b[i])) { return false; }
    }
  }
  return true;
}

function acceptConnections() {
  if (typeof onconnect !== 'undefined') {
    self.onconnect = function(event) {
      fireworkers.push(new Fireworker(event.ports[0]));
    };
  } else {
    fireworkers.push(new Fireworker(self));
  }
  self.localStorage.flushPending();
}

self.window = self;
acceptConnections();

export default Fireworker;

//# sourceMappingURL=worker.es2015.js.map