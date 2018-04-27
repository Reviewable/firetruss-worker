/* eslint-env node */
'use strict';

const buble = require('rollup-plugin-buble');
const nodeResolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');

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
        sourceMap: true,
        sourceMapRelativePaths: true,
        globals: {
          firebase: 'Firebase'
        },
        plugins: [
          commonjs(),
          buble({
            transforms: {
              dangerousForOf: true
            }
          }),
          nodeResolve({
            jsnext: true,
            skip: ['firebase']
          })
        ]
      },
      worker: {
        options: {
          format: 'umd',
          moduleName: 'Fireworker'
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

    release: {
      options: {
        additionalFiles: ['bower.json'],
        afterBump: ['replace --release=<%= version %>'],
        beforeRelease: ['default']
      }
    }

  });

  grunt.registerTask('default', [
    'eslint', 'clean:dist', 'rollup', 'uglify', 'gitadd'
  ]);

};
