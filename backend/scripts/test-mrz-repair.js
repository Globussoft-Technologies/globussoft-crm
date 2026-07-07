const { parseMrz, parseTd3 } = require('../lib/mrzParser');

const l1 = 'PKSHAMSIK<KMAJID<KALKLLLLLLLLLLLLLLLLLLLLLLL';
const l2 = 'Q34G56789ARE2703I983MI4042022<<<<<<<KLKLLLLL';

console.log('original:', parseTd3(l1, l2, 26));

const re = /[KLI1|\\]/g;
const f1 = l1.replace(re, '<');
const f2 = l2.replace(re, '<');
console.log('fixed all:', parseTd3(f1, f2, 26));
console.log('parseMrz fixed:', parseMrz(`${f1}\n${f2}`, { nowYearLast2: 26 }));
