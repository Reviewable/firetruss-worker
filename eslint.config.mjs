import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['src/**'],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.es2015,
      },
      ecmaVersion: 2015
    }
  },
  {
    files: ['Gruntfile.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];
