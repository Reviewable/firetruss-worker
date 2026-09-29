import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['src/**'],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.es2019,
      },
      ecmaVersion: 2019
    }
  },
  {
    // The tests run under Node rather than in a worker, and reach for `globalThis` to stand up the
    // globals `worker.js` expects at import time.
    files: ['src/**/*.test.js', 'src/**/*.test.setup.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2020
    }
  },
  {
    files: ['Gruntfile.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];
