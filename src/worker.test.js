import {test} from 'node:test';
import assert from 'node:assert/strict';

import './worker.test.setup.js';
import Fireworker from './worker.js';

// Drives a `Fireworker` directly, with a stub port that records what it would post and a stub
// Firebase auth whose token lookups the test releases by hand.  Every ordering guarantee here is
// about the order the worker emits its messages in, so the recorded log is the assertion target.
function createWorker() {
  const sent = [];
  const port = {postMessage: messages => {sent.push(...messages);}};
  const listeners = [];
  const pendingLookups = [];

  const makeUser = uid => ({
    uid,
    toJSON: () => ({uid}),
    // Resolves only once the test releases this lookup, so a later conversion can be made to
    // overtake an earlier one.
    getIdTokenResult: () => new Promise((resolve, reject) => {
      pendingLookups.push({uid, resolve: () => resolve({claims: {}}), reject});
    })
  });

  const auth = {
    currentUser: null,
    onIdTokenChanged: listener => {
      listeners.push(listener);
      return () => undefined;
    },
    signInWithCustomToken: () => Promise.resolve({user: makeUser('signed-in')}),
    signOut: () => Promise.resolve()
  };
  globalThis.firebase.__auth = auth;

  const worker = new Fireworker(port);
  worker._app = {auth: () => auth};
  worker._cachedAuth = auth;
  worker.onAuth({url: 'https://example.firebaseio.com', callbackId: 1});

  // Takes the lookup out of the list as it settles it, so releasing the same one twice, or a uid
  // that was never held, fails the test instead of quietly settling an already-settled promise.
  const settleLookup = uid => {
    const index = pendingLookups.findIndex(candidate => candidate.uid === uid);
    assert.notEqual(index, -1, `no pending lookup for ${uid}`);
    return pendingLookups.splice(index, 1)[0];
  };

  return {
    makeUser, worker,
    // What the worker has posted so far, as compact labels.
    log: () => sent.map(message => message.msg === 'callback' ?
      `callback:${message.args[0] ? message.args[0].uid : 'null'}` :
      `${message.msg}:${message.id}`),
    // Mimics the SDK notifying its listeners of an auth change.
    notify: user => Promise.all(listeners.map(listener => listener(user))),
    release: uid => settleLookup(uid).resolve(),
    rejectLookup: (uid, error) => settleLookup(uid).reject(error)
  };
}

// Lets every already-scheduled microtask and timer callback run.
function drain() {
  return new Promise(resolve => {setTimeout(resolve, 10);});
}

// Resolves to the value or the error, so a test can assert on either without branching.
function settle(promise) {
  return Promise.resolve(promise).then(value => value, error => error);
}

test('auth changes are reported in the order Firebase reported them', async () => {
  const {log, notify} = createWorker();

  // Two changes, the first of which takes longer to convert than the second.
  notify({uid: 'first', toJSON: () => ({uid: 'first'}),
    getIdTokenResult: () =>
      new Promise(resolve => {setTimeout(() => resolve({claims: {}}), 30);})});
  await drain();
  notify({uid: 'second', toJSON: () => ({uid: 'second'}),
    getIdTokenResult: () => Promise.resolve({claims: {}})});
  await new Promise(resolve => {setTimeout(resolve, 60);});

  assert.deepEqual(log(), ['callback:first', 'callback:second']);
});

test('a sign-out is not reported ahead of the sign-in it follows', async () => {
  const {log, notify, makeUser, release} = createWorker();

  // A sign-in whose conversion is held, then the sign-out that supersedes it.  Reported the other
  // way round, the client ends up signed in after a sign-out.
  notify(makeUser('user'));
  await drain();
  notify(null);
  await drain();
  release('user');
  await drain();

  assert.deepEqual(log(), ['callback:user', 'callback:null']);
});

test('token lookups still run concurrently', async () => {
  const {notify} = createWorker();
  const started = Date.now();
  const lookupMillis = 40;
  const slowUser = uid => ({
    uid,
    toJSON: () => ({uid}),
    getIdTokenResult: () =>
      new Promise(resolve => {setTimeout(() => resolve({claims: {}}), lookupMillis);})
  });

  await Promise.all([notify(slowUser('a')), notify(slowUser('b')), notify(slowUser('c'))]);

  assert.ok(
    Date.now() - started < lookupMillis * 2,
    'serialized the lookups instead of only their results');
});

// These two drive `_userToJsonInOrder` directly:  the auth requests are its callers that actually
// receive a rejection.  A failed conversion for an auth *change* is dropped by `_onAuthCallback`,
// which predates this change and is left alone.
test('a failed lookup does not wedge the ones behind it', async () => {
  const {makeUser, release, rejectLookup, worker} = createWorker();

  const failing = settle(worker._userToJsonInOrder(makeUser('failing')));
  const following = settle(worker._userToJsonInOrder(makeUser('following')));
  await drain();
  rejectLookup('failing', new Error('token lookup failed'));
  release('following');

  assert.equal((await failing).message, 'token lookup failed');
  assert.equal((await following).uid, 'following', 'the failure stopped the queue');
});

// The eager local conversion used to sit rejected with nothing attached until its turn came up,
// which the platform reports as an unhandled rejection even though the caller does get the error.
test('a lookup that fails early is not reported as unhandled', async () => {
  const {makeUser, release, rejectLookup, worker} = createWorker();
  const unhandled = [];
  const record = error => {unhandled.push((error && error.message) || String(error));};
  process.on('unhandledRejection', record);

  try {
    // The first conversion is held, so the second can't reach the front of the queue when it fails.
    const held = settle(worker._userToJsonInOrder(makeUser('held')));
    const failing = settle(worker._userToJsonInOrder(makeUser('failing')));
    await drain();
    rejectLookup('failing', new Error('token lookup failed'));
    await drain();

    assert.deepEqual(unhandled, [], 'reported a rejection that was going to be handled');

    release('held');
    assert.equal((await held).uid, 'held');
    assert.equal((await failing).message, 'token lookup failed');
    await drain();

    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});

// The client serializes its auth calls on the responses it gets back, so a logout response that
// overtakes an earlier auth change makes it republish a stale user after the logout completed.
test('a logout response waits for the auth changes that preceded it', async () => {
  const {log, notify, makeUser, release, worker} = createWorker();
  const order = [];

  // An unsolicited refresh for the signed-in user, held mid-conversion.
  const refresh = notify(makeUser('old')).then(() => {order.push(...log());});
  await drain();

  // A logout:  the SDK notifies null before settling `signOut()`.
  const unauthenticated = worker.unauth({url: 'https://example.firebaseio.com'})
    .then(() => {order.push('logout-resolved');});
  const signedOut = notify(null);
  await drain();

  assert.deepEqual(order, [], 'completed the logout before the earlier auth changes were sent');

  release('old');
  await Promise.all([unauthenticated, refresh, signedOut]);
  await drain();

  // The logout must complete only after the changes that preceded it have gone out.
  assert.equal(
    order[order.length - 1], 'logout-resolved',
    'the logout response overtook an auth change');
  assert.deepEqual(log(), ['callback:old', 'callback:null']);
});
