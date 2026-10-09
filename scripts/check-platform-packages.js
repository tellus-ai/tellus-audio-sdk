const path = require('node:path');
const { checkPackageContents } = require('../dist/installer/check-package-contents');
for (const platform of ['desktop', 'web', 'mobile']) checkPackageContents(path.resolve(__dirname, '..', 'platforms', platform));
