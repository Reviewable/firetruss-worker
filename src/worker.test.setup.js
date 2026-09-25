// `worker.js` accepts connections as soon as it's imported, so the worker globals it touches on the
// way have to exist first.  A `MessagePort` stub is enough:  the tests drive `Fireworker` directly
// rather than through a port.
const self = globalThis.self = globalThis;

self.postMessage = () => undefined;
self.addEventListener = () => undefined;
// `navigator` is a read-only getter in Node, so leave it alone if it's already there.
if (!self.navigator) self.navigator = {};

// `worker.js` takes a liveness lock at module scope, which needs the Web Locks API;  Node only
// exposes that from 24 on, and the resulting `TypeError` surfaces as an unhandled rejection that
// fails the whole file after every test has already passed.  Granting the lock immediately is
// enough here:  the callback signals that by resolving, and holds the lock by returning a promise
// it never settles, which this passes straight back out as a real implementation would.
if (!self.navigator.locks) {
  self.navigator.locks = {
    request: (name, callback) => Promise.resolve(callback())
  };
}

// Enough of the Firebase SDK surface for the module to load;  individual tests install whatever
// behaviour they need onto `firebase.__auth`.
globalThis.firebase = {
  SDK_VERSION: 'test',
  initializeApp: () => ({auth: () => globalThis.firebase.__auth}),
  database: {enableLogging: () => undefined},
  __auth: undefined
};
