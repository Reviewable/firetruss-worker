/* globals firebase */

const fireworkers = [];
const apps = {};
// This version is filled in by the build, don't reformat the line.
const VERSION = 'dev';


class LocalStorage {
  constructor() {
    this._items = [];
    this._pendingItems = [];
    this._initialized = false;
    this._flushPending = this.flushPending.bind(this);
  }

  init(items) {
    if (!this._initialized) {
      this._items = items;
      this._initialized = true;
    }
  }

  _update(item) {
    if (!this._pendingItems.length) Promise.resolve().then(this._flushPending);
    this._pendingItems.push(item);
  }

  flushPending() {
    if (!this._pendingItems.length) return;
    if (!fireworkers.length) {
      setTimeout(this._flushPending, 200);
      return;
    }
    fireworkers[0]._send({msg: 'updateLocalStorage', items: this._pendingItems});
    this._pendingItems = [];
  }

  get length() {return this._items.length;}

  key(n) {
    return this._items[n].key;
  }

  getItem(key) {
    for (const item of this._items) {
      if (item.key === key) return item.value;
    }
    return null;
  }

  setItem(key, value) {
    let targetItem;
    for (const item of this._items) {
      if (item.key === key) {
        targetItem = item;
        item.value = value;
        break;
      }
    }
    if (!targetItem) {
      targetItem = {key, value};
      this._items.push(targetItem);
    }
    this._update(targetItem);
  }

  removeItem(key) {
    for (let i = 0; i < this._items.length; i++) {
      if (this._items[i].key === key) {
        this._items.splice(i, 1);
        this._update({key, value: null});
        break;
      }
    }
  }

  clear() {
    for (const item in this._items) {
      this._update({key: item.key, value: null});
    }
    this._items = [];
  }
}

self.localStorage = new LocalStorage();


class Branch {
  constructor() {
    this._root = null;
  }

  set(value) {
    this._root = value;
  }

  diff(value, pathPrefix) {
    const updates = {};
    const segments = pathPrefix === '/' ? [''] : pathPrefix.split('/');
    if (this._diffRecursively(this._root, value, segments, updates)) {
      this._root = value;
      updates[pathPrefix] = value;
    }
    return updates;
  }

  _diffRecursively(oldValue, newValue, segments, updates) {
    if (oldValue === undefined) oldValue = null;
    if (newValue === undefined) newValue = null;
    if (oldValue === null) return newValue !== null;
    if (oldValue instanceof Object && newValue instanceof Object) {
      let replace = true;
      const keysToReplace = [];
      for (const childKey in newValue) {
        if (!Object.hasOwn(newValue, childKey)) continue;
        const replaceChild = this._diffRecursively(
          oldValue[childKey], newValue[childKey], segments.concat(childKey), updates);
        if (replaceChild) {
          keysToReplace.push(childKey);
        } else {
          replace = false;
        }
      }
      if (replace) return true;
      for (const childKey in oldValue) {
        if (!Object.hasOwn(oldValue, childKey) || Object.hasOwn(newValue, childKey)) continue;
        updates[segments.concat(childKey).join('/')] = null;
        delete oldValue[childKey];
      }
      for (const childKey of keysToReplace) {
        updates[segments.concat(childKey).join('/')] = newValue[childKey];
        oldValue[childKey] = newValue[childKey];
      }
    } else {
      return newValue !== oldValue;
    }
  }
}


export default class Fireworker {
  constructor(port) {
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
    this._logging = false;
    port.onmessage = this._receive.bind(this);
  }

  get _auth() {
    if (this._cachedAuth) return this._cachedAuth;
    if (!this._app) throw new Error('Must provide Firebase configuration data first');
    return this._cachedAuth = this._app.auth();
  }

  get _database() {
    if (this._cachedDatabase) return this._cachedDatabase;
    if (!this._app) throw new Error('Must provide Firebase configuration data first');
    if (Fireworker._databaseWrapperCallback) {
      this._cachedDatabase = Fireworker._databaseWrapperCallback(this._app.database());
    } else {
      this._cachedDatabase = this._app.database();
    }
    return this._cachedDatabase;
  }

  init({storage, config}) {
    if (storage) self.localStorage.init(storage);
    if (config) {
      try {
        this._app = apps[config.databaseURL];
        if (!this._app) {
          this._app = apps[config.databaseURL] = firebase.initializeApp(config, config.databaseURL);
          // If the API key looks invalid then assume that we're running against Cinderbase rather
          // than Firebase and override the configuration appropriately.
          if (config.apiKey && config.apiKey.length < 20) {
            this._app.database().INTERNAL.forceWebSockets();
            this._app.auth().useEmulator(config.databaseURL, {disableWarnings: true});
          }
        }
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
  }

  destroy() {
    for (const key in this._callbacks) {
      const callback = this._callbacks[key];
      if (callback.cancel) callback.cancel();
    }
    this._callbacks = {};
    this._port.onmessage = null;
    this._messages = [];
    const k = fireworkers.indexOf(this);
    if (k >= 0) fireworkers[k] = null;
  }

  enableFirebaseLogging({value}) {
    this._logging = value;
    firebase.database.enableLogging(value);
  }

  ping() {
    // Noop, placeholder for legacy Firetruss clients.
  }

  bounceConnection() {
    this._database.goOffline();
    this._database.goOnline();
  }

  _receive(event) {
    Fireworker._firstMessageReceived = true;
    for (const message of event.data) this._receiveMessage(message);
  }

  _receiveMessage(message) {
    let promise;
    try {
      if (this._logging) console.log('wrkr_recv:', message);
      const fn = this[message.msg];
      if (typeof fn !== 'function') throw new Error('Unknown message: ' + message.msg);
      if (message.writeSerial) {
        this._lastWriteSerial = Math.max(this._lastWriteSerial, message.writeSerial);
      }
      promise = Promise.resolve(fn.call(this, message));
    } catch (e) {
      e.immediateFailure = true;
      promise = Promise.reject(e);
    }
    if (!message.oneWay) {
      promise.then(result => {
        this._send({msg: 'resolve', id: message.id, result});
      }, error => {
        this._send({msg: 'reject', id: message.id, error: errorToJson(error)});
      });
    }
  }

  _send(message) {
    if (!this._messages.length) Promise.resolve().then(this._flushMessageQueue);
    this._messages.push(message);
    if (this._logging) console.log('wrkr_send:', message);
  }

  _flushMessageQueue() {
    try {
      if (this._logging) console.log('wrkr_flush:', this._messages.length, 'messages');
      this._port.postMessage(this._messages);
    } catch {
      for (const message of this._messages) {
        try {
          this._port.postMessage([message]);
        } catch (e) {
          const error = {name: e.name, message: e.message};
          if (message.error) error.cause = `${message.error.name}: ${message.error.message}`;
          if (message.result) {
            try {
              error.cause = `result: ${JSON.stringify(message.result)}`;
            } catch (e2) {
              error.cause = `result JSON error: ${e2.name}: ${e2.message}`;
            }
          }
          this._port.postMessage([{msg: 'crash', error}]);
        }
      }
    }
    this._messages = [];
  }

  call({name, args}) {
    try {
      return Promise.resolve(Fireworker._exposed[name].apply(null, args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  authWithCustomToken({url, authToken}) {
    return this._auth.signInWithCustomToken(authToken)
      .then(result => userToJson(result.user));
  }

  authAnonymously({url}) {
    return this._auth.signInAnonymously()
      .then(result => userToJson(result.user));
  }

  unauth({url}) {
    return this._auth.signOut().catch(e => {
      // We can ignore the error if the user is signed out anyway, but make sure to notify all
      // authCallbacks otherwise we end up in a bogus state!
      if (this._auth.currentUser === null) {
        for (const callbackId in this._callbacks) {
          if (!Object.hasOwn(this._callbacks, callbackId)) continue;
          const callback = this._callbacks[callbackId];
          if (callback.auth) callback(null);
        }
      } else {
        return Promise.reject(e);
      }
    });
  }

  onAuth({url, callbackId}) {
    const authCallback = this._callbacks[callbackId] = this._onAuthCallback.bind(this, callbackId);
    authCallback.auth = true;
    authCallback.cancel = this._auth.onIdTokenChanged(authCallback);
  }

  _onAuthCallback(callbackId, user) {
    userToJson(user).then(jsonUser => {
      if (areEqualValues(this._lastJsonUser, jsonUser)) return;
      this._lastJsonUser = jsonUser;
      this._send({msg: 'callback', id: callbackId, args: [jsonUser]});
    });
  }

  set({url, value}) {
    return this._createRef(url).set(value);
  }

  update({url, value}) {
    return this._createRef(url).update(value);
  }

  once({url}) {
    return this._createRef(url).once('value').then(snapshot => this._snapshotToJson(snapshot));
  }

  on({listenerKey, url, spec, eventType, callbackId, options}) {
    options = options || {};
    if (options.sync) options.branch = new Branch();
    options.cancel = this.off.bind(this, {listenerKey, url, spec, eventType, callbackId});
    const snapshotCallback = this._callbacks[callbackId] =
      this._onSnapshotCallback.bind(this, callbackId, options);
    snapshotCallback.listenerKey = listenerKey;
    snapshotCallback.eventType = eventType;
    snapshotCallback.cancel = options.cancel;
    const cancelCallback = this._onCancelCallback.bind(this, callbackId);
    this._createRef(url, spec).on(eventType, snapshotCallback, cancelCallback);
  }

  off({listenerKey, url, spec, eventType, callbackId}) {
    let snapshotCallback;
    if (callbackId) {
      // Callback IDs will not be reused across on() calls, so it's safe to just delete it.
      snapshotCallback = this._callbacks[callbackId];
      delete this._callbacks[callbackId];
    } else {
      for (const key of Object.keys(this._callbacks)) {
        if (!Object.hasOwn(this._callbacks, key)) continue;
        const callback = this._callbacks[key];
        if (callback.listenerKey === listenerKey &&
            (!eventType || callback.eventType === eventType)) {
          delete this._callbacks[key];
        }
      }
    }
    this._createRef(url, spec).off(eventType, snapshotCallback);
  }

  _onSnapshotCallback(callbackId, options, snapshot) {
    if (options.sync && options.rest) {
      const path = decodeURIComponent(
        snapshot.ref.toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
      let value;
      try {
        value = normalizeFirebaseValue(snapshot.val());
      } catch (e) {
        options.cancel();
        this._onCancelCallback(callbackId, e);
        return;
      }
      const updates = options.branch.diff(value, path);
      for (const childPath in updates) {
        if (!Object.hasOwn(updates, childPath)) continue;
        this._send({
          msg: 'callback', id: callbackId,
          args: [null, {
            path: childPath, value: updates[childPath], writeSerial: this._lastWriteSerial
          }]
        });
      }
    } else {
      try {
        const snapshotJson = this._snapshotToJson(snapshot);
        if (options.sync) options.branch.set(snapshotJson.value);
        this._send({msg: 'callback', id: callbackId, args: [null, snapshotJson]});
        options.rest = true;
      } catch (e) {
        options.cancel();
        this._onCancelCallback(callbackId, e);
      }
    }
  }

  _onCancelCallback(callbackId, error) {
    delete this._callbacks[callbackId];
    this._send({msg: 'callback', id: callbackId, args: [errorToJson(error)]});
  }

  transaction({url, oldValue, relativeUpdates}) {
    const transactionPath = decodeURIComponent(url.replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
    const ref = this._createRef(url);
    const branch = new Branch();
    let stale, committedValue;

    return ref.transaction(value => {
      committedValue = undefined;
      value = normalizeFirebaseValue(value);
      stale = !areEqualNormalFirebaseValues(value, oldValue);
      if (stale) value = oldValue;
      if (relativeUpdates) {
        for (const relativePath in relativeUpdates) {
          if (!Object.hasOwn(relativeUpdates, relativePath)) continue;
          if (relativePath) {
            const segments = relativePath.split('/');
            if (value === undefined || value === null) value = {};
            let object = value;
            for (let i = 0; i < segments.length - 1; i++) {
              const key = segments[i];
              let child = object[key];
              if (child === undefined || child === null) child = object[key] = {};
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
    }).then(result => {
      const snapshots = [];
      const updates = branch.diff(normalizeFirebaseValue(result.snapshot.val()), transactionPath);
      for (const path in updates) {
        if (!Object.hasOwn(updates, path)) continue;
        snapshots.push({
          path, value: updates[path], writeSerial: result.writeSerial || this._lastWriteSerial
        });
      }
      return {committed: !stale, snapshots};
    }, error => {
      if (error.message === 'set' || error.message === 'disconnect') {
        return ref.once('value').then(snapshot => ({committed: false, snapshots: [{
          path: transactionPath, value: snapshot.val(), writeSerial: this._lastWriteSerial
        }]}));
      }
      error.committedValue = committedValue;
      return Promise.reject(error);
    });
  }

  _snapshotToJson(snapshot) {
    const path =
      decodeURIComponent(snapshot.ref.toString().replace(/.*?:\/\/[^/]*/, '').replace(/\/$/, ''));
    return {
      path, value: normalizeFirebaseValue(snapshot.val()), writeSerial: this._lastWriteSerial
    };
  }

  onDisconnect({url, method, value}) {
    const onDisconnect = this._createRef(url).onDisconnect();
    return onDisconnect[method](value);
  }

  _createRef(url, spec) {
    if (!this._app) throw new Error('Must provide Firebase configuration data first');
    try {
      let ref = this._database.refFromURL(url);
      if (spec) {
        switch (spec.by) {
          case '$key': ref = ref.orderByKey(); break;
          case '$value': ref = ref.orderByValue(); break;
          default: ref = ref.orderByChild(spec.by); break;
        }
        if (spec.at !== undefined) ref = ref.equalTo(spec.at);
        else if (spec.from !== undefined) ref = ref.startAt(spec.from);
        else if (spec.to !== undefined) ref = ref.endAt(spec.to);
        if (spec.first !== undefined) ref = ref.limitToFirst(spec.first);
        else if (spec.last !== undefined) ref = ref.limitToLast(spec.last);
      }
      return ref;
    } catch (e) {
      e.extra = {url, spec};
      throw e;
    }
  }

  static expose(fn, name) {
    name = name || fn.name;
    if (!name) {
      Fireworker._signalStaticConfigError(
        new Error(`Cannot expose a function with no name: ${fn}`));
    }
    if (Object.hasOwn(Fireworker._exposed, name)) {
      Fireworker._signalStaticConfigError(new Error(`Function ${name}() already exposed`));
    }
    if (Fireworker._firstMessageReceived) {
      Fireworker._signalStaticConfigError(new Error('Too late to expose function, worker in use'));
    }
    Fireworker._exposed[name] = fn;
  }

  static setDatabaseWrapperCallback(fn) {
    if (Fireworker._databaseWrapperCallback) {
      Fireworker._signalStaticConfigError(new Error('Database wrapper callback already set'));
    }
    if (Fireworker._firstMessageReceived) {
      Fireworker._signalStaticConfigError(
        new Error('Too late to set database wrapper callback, worker in use'));
    }
    Fireworker._databaseWrapperCallback = fn;
  }

  static _signalStaticConfigError(error) {
    if (!Fireworker._staticConfigError) Fireworker._staticConfigError = error;
    for (const fireworker of fireworkers) {
      if (fireworker && !fireworker._configError) fireworker._configError = error;
    }
    throw error;
  }
}

Fireworker._exposed = {};
Fireworker._firstMessageReceived = false;
Fireworker._databaseWrapperCallback = undefined;
Fireworker._staticConfigError = undefined;

function errorToJson(error) {
  const json = {name: error.name, message: error.message};
  const propertyNames = Object.getOwnPropertyNames(error);
  for (const propertyName of propertyNames) {
    const type = typeof error[propertyName];
    if (type === 'string' || type === 'number' || type === 'boolean') {
      json[propertyName] = error[propertyName];
    }
  }
  return json;
}

function normalizeFirebaseValue(value) {
  if (Array.isArray(value)) {
    const normalValue = {};
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === undefined || item === null) continue;
      normalValue[i] = normalizeFirebaseValue(item);
    }
    return normalValue;
  }
  if (value instanceof Object) {
    for (const key in value) {
      if (Object.hasOwn(value, key)) value[key] = normalizeFirebaseValue(value[key]);
    }
  }
  return value;
}

function userToJson(user) {
  if (!user) return Promise.resolve(user);
  const json = user.toJSON();
  delete json.stsTokenManager;
  return user.getIdTokenResult().then(result => {
    delete result.claims.exp;
    delete result.claims.iat;
    json.claims = result.claims;
    return json;
  });
}


function areEqualNormalFirebaseValues(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || b === null) return false;
  if (!(typeof a === 'object' && typeof b === 'object')) return false;
  for (const key in a) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return false;
    if (!areEqualNormalFirebaseValues(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return false;
  }
  return true;
}

function areEqualValues(a, b) {
  if (a === b) return true;
  if (a === null && b === null || a === undefined && b === undefined) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (!(typeof a === 'object' && typeof b === 'object')) return false;
  for (const key in a) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return false;
    if (!areEqualValues(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!areEqualValues(a[i], b[i])) return false;
    }
  }
  return true;
}

function acceptConnections() {
  if (typeof onconnect === 'undefined') {
    fireworkers.push(new Fireworker(self));
  } else {
    self.onconnect = function(event) {
      fireworkers.push(new Fireworker(event.ports[0]));
    };
  }
  self.localStorage.flushPending();
}

self.window = self;
acceptConnections();
