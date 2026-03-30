const fs = require('fs');

if (!fs.existsSync('results.json')) {
  console.log("No results.json found yet.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync('results.json', 'utf-8'));
const failedTests = [];

data.suites.forEach(suite => {
  suite.specs.forEach(spec => {
    if (!spec.ok) failedTests.push(`${suite.file} - ${spec.title}`);
  });
  
  if (suite.suites) {
    suite.suites.forEach(subSuite => {
      subSuite.specs.forEach(spec => {
        if (!spec.ok) failedTests.push(`${subSuite.file} - ${spec.title}`);
      });
    });
  }
});

console.log(`Failed Tests Count: ${failedTests.length}`);
console.log(failedTests.join('\n'));
