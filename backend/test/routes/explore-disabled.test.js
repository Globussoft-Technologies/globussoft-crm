const fs = require('fs');
const path = require('path');

const SERVER_JS = path.resolve(__dirname, '..', '..', 'server.js');

describe('Explore API disabled', () => {
  const serverSource = fs.readFileSync(SERVER_JS, 'utf8');
  const activeSource = serverSource.replace(/^\s*\/\/.*$/gm, '');

  it('does not mount /api/explore', () => {
    expect(activeSource).not.toMatch(/app\.use\(["']\/api\/explore["']/);
  });

  it('does not exempt /explore from the global authentication guard', () => {
    expect(activeSource).not.toMatch(/^\s*["']\/explore["'],?\s*$/m);
  });
});
