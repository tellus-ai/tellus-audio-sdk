// Keep Nitrogen's generated files consistent with the SDK's whitespace convention.
const fs = require('node:fs');
const path = require('node:path');

function normalize(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) normalize(file);
    else {
      const contents = fs.readFileSync(file, 'utf8');
      const normalized = contents.replace(/[ \t]+$/gm, '');
      if (normalized !== contents) fs.writeFileSync(file, normalized);
    }
  }
}
normalize(path.join(__dirname, '../platforms/mobile/nitrogen/generated'));
