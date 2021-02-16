const fs = require('fs');
const { compile } = require('json-schema-to-typescript');
const manifest = require('./manifest.json');

compile(manifest.options.schema, 'Config')
  .then((ts) => fs.writeFileSync('src/config.d.ts', ts));
