// `worker.js` accepts connections as soon as it's imported, so the worker globals it touches on the
// way have to exist first.  A `MessagePort` stub is enough:  the tests drive `Fireworker` directly
// rather than through a port.
const self = globalThis.self = globalThis;

self.postMessage = () => undefined;
self.addEventListener = () => undefined;
// `navigator` is a read-only getter in Node, so leave it alone if it's already there.
if (!self.navigator) self.navigator = {};

// Enough of the Firebase SDK surface for the module to load;  individual tests install whatever
// behaviour they need onto `firebase.__auth`.
globalThis.firebase = {
  SDK_VERSION: 'test',
  initializeApp: () => ({auth: () => globalThis.firebase.__auth}),
  database: {enableLogging: () => undefined},
  __auth: undefined
};
