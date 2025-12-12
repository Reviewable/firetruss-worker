'use strict';

const nodeResolve = require('@rollup/plugin-node-resolve').nodeResolve;
const commonjs = require('@rollup/plugin-commonjs');

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    ext: {version: 'dev'},

    clean: {
      dist: ['dist']
    },

    replace: {
      version: {
        src: 'src/worker.js',
        overwrite: true,
        replacements: [{
          from: /const VERSION = '.*?';/,
          to: () => `const VERSION = '${grunt.option('release')}';`
        }]
      }
    },

    eslint: {
      all: {
        options: {
          maxWarnings: 0
        },
        src: ['src/**/*.js'],
      }
    },

    rollup: {
      options: {
        sourcemap: true,
        globals: {
          firebase: 'Firebase'
        },
        plugins: [
          commonjs(),
          nodeResolve({
            resolveOnly: ['bogus']  // an empty array argument gets ignored
          })
        ]
      },
      worker: {
        options: {
          format: 'umd',
          name: 'Fireworker'
        },
        files: {
          'dist/worker.umd.js': ['src/worker.js']
        }
      },
      workernext: {
        options: {
          format: 'es'
        },
        files: {
          'dist/worker.es2015.js': ['src/worker.js']
        }
      }
    },

    uglify: {
      options: {
        mangle: true,
        compress: true,
        sourceMap: true,
        sourceMapIn: src => src + '.map',
        sourceMapName: dest => dest + '.map',
      },
      worker: {
        src: 'dist/worker.umd.js',
        dest: 'dist/worker.umd.min.js'
      }
    },

    gitadd: {
      dist: {
        src: 'dist/*'
      }
    },

    watch: {
      dev: {
        files: ['src/**/*.js'],
        tasks: ['default'],
        options: {spawn: false}
      }
    },

  });

  grunt.registerTask('default', [
    'eslint', 'clean:dist', 'rollup', 'uglify', 'gitadd'
  ]);

};
