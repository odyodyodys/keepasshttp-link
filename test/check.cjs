// Prints a one-line summary of artifacts/report.json; exit 1 on any error.
const r = require('./artifacts/report.json');
const errs = Object.entries(r.results).filter(([, v]) => v.error || v.pass === false).map(([k, v]) => k + ': ' + (v.error ? v.error.split('\n')[0] : 'pass=false'));
const sum = {};
for (const [k, v] of Object.entries(r.results)) {
  sum[k] = { getLogins: v.getLoginsOnLoad ?? v.getLoginsTotal, fillsU: v.fillsUsername, fillsP: v.fillsPassword, items: v.autocompleteItemsOnFocus, pass: v.pass };
}
console.log(JSON.stringify({ mock: r.mock, fatal: r.fatal ? r.fatal.split('\n')[0] : null, associated: !!(r.association && r.association.associated), errors: errs, results: sum }, null, 1));
process.exit(r.fatal || errs.length ? 1 : 0);
