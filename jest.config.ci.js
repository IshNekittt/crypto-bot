/**
 * CI-only Jest configuration.
 *
 * Kept separate from `jest.config.js` on purpose: a plain `npm test` must not
 * create `gh-pages-report/` or `coverage/` directories on a developer machine.
 * CI runs `npm run test:ci`, which is the only entry point that needs them.
 *
 * Outputs consumed by `.github/workflows/ci.yml`:
 *   gh-pages-report/index.html  — self-contained HTML report of every test
 *   coverage/lcov-report/       — HTML coverage report
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text-summary'],
  reporters: [
    'default',
    [
      'jest-html-reporters',
      {
        publicPath: './gh-pages-report',
        filename: 'index.html',
        expand: true,
        openReport: false,
        pageTitle: 'Crypto Bot SMC — Test Report',
      },
    ],
  ],
};
