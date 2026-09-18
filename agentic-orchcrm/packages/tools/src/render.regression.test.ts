import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditPrintLayout, shrinkOverflowingPages } from './render.js';

test('day-card overflow reduces photography without scaling typography', async () => {
  const photo='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="blue"/></svg>').toString('base64');
  const card=(day:number)=>`<article class="day-card"><img src="${photo}"><div style="height:300px"><h2>Day ${day}</h2><p>Discover local heritage through guided activities and observation.</p></div></article>`;
  const html=`<html><head><style>*{box-sizing:border-box}body{margin:0}section{width:794px;height:1123px;padding:40px;overflow:hidden}img{display:block;width:100%;height:230px}article{margin-bottom:20px}</style></head><body><section><h1>Itinerary</h1>${card(1)}${card(2)}</section></body></html>`;
  const opts={minPages:1,maxPages:1};
  const before=await auditPrintLayout(html,opts);
  const repaired=await shrinkOverflowingPages(html,before.issues,opts);
  assert.ok(repaired,JSON.stringify(before));
  assert.equal((await auditPrintLayout(repaired,opts)).ok,true);
  assert.ok(!repaired.includes('data-shrink-wrap'));
});

test('large nested itinerary splits cards rather than repeatedly moving its entire body', async () => {
  const cards=Array.from({length:6},(_,i)=>`<article><h2>Day ${i+1}</h2><p>${'Explore coastal heritage with guided learning and discovery. '.repeat(36)}</p></article>`).join('');
  const html=`<html><head><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}section{width:794px;height:1123px;padding:40px;overflow:hidden}article{padding:10px;margin-bottom:20px}p{line-height:1.5}</style></head><body><section><header>Itinerary</header><main>${cards}</main></section></body></html>`;
  const opts={minPages:1,maxPages:12};
  const before=await auditPrintLayout(html,opts);
  assert.ok(before.issues.some(issue=>issue.includes('clips_or_overflows')));
  const repaired=await shrinkOverflowingPages(html,before.issues,opts);
  assert.ok(repaired,JSON.stringify(before));
  const after=await auditPrintLayout(repaired,opts);
  assert.equal(after.ok,true,JSON.stringify(after));
  assert.ok(after.pageCount>1);
  for(let day=1;day<=6;day++) assert.equal((repaired.match(new RegExp('<h2>Day '+day+'</h2>','g'))||[]).length,1);
});

test('oversized important-rule logos are resized without duplicating a destination photo', async () => {
  const logo='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="blue"/></svg>').toString('base64');
  const html=`<html><head><style>body{margin:0}section{width:794px;height:1123px;position:relative;background:#abc}.logo{width:700px!important;height:400px!important;min-width:700px!important;position:absolute;top:20px;left:20px}h1{position:absolute;top:800px}</style></head><body><section><img class="logo" src="${logo}"><h1>Goa educational journey</h1></section></body></html>`;
  const opts={minPages:1,maxPages:1,protectedLogoUrls:[logo]};
  const before=await auditPrintLayout(html.replace('Goa educational journey','Goa educational journey: explore coastal heritage and learn together through guided experiences'),opts);
  const repaired=await shrinkOverflowingPages(html.replace('Goa educational journey','Goa educational journey: explore coastal heritage and learn together through guided experiences'),before.issues,opts);
  assert.ok(repaired,JSON.stringify(before));
  assert.equal((await auditPrintLayout(repaired,opts)).ok,true);
  assert.equal((repaired.match(/<img\b/g)||[]).length,1);
});

test('empty panels and narrow copy are repaired together without losing text', async () => {
  const copy='Explore coastal heritage, local communities and conservation through guided activities. '.repeat(9);
  const html=`<html><head><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}section{width:794px;height:1123px;padding:40px;overflow:hidden}.columns{display:grid;grid-template-columns:140px 1fr;gap:24px}p{margin:0;line-height:1.5}.empty{height:120px;border:1px solid #ccc}</style></head><body><section><h1>Practical information</h1><div class="empty"></div><div class="columns"><p>${copy}</p><p>${copy.repeat(2)}</p></div></section></body></html>`;
  const opts={minPages:1,maxPages:4};
  const before=await auditPrintLayout(html,opts);
  assert.ok(before.issues.includes('page_1_contains_empty_panel'),JSON.stringify(before));
  assert.ok(before.issues.includes('page_1_has_narrow_long_copy'),JSON.stringify(before));
  const repaired=await shrinkOverflowingPages(html,before.issues,opts);
  assert.ok(repaired);
  assert.equal((await auditPrintLayout(repaired,opts)).ok,true);
  assert.ok(repaired.includes(copy));
  assert.ok(!repaired.includes('<div class="empty">'));
  assert.equal(await shrinkOverflowingPages(html,before.issues,{minPages:5,maxPages:5}),null,'Repair must enforce the caller page-count contract');
});

test('a recovered photo is not replaced because of a stale failure index', async () => {
  const photo='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="blue"/></svg>').toString('base64');
  const html=`<html><head><style>body{margin:0}section{width:794px;height:1123px}img{width:600px;height:800px}</style></head><body><section><h1>Goa</h1><img src="${photo}" alt="Goa coast"></section></body></html>`;
  const repaired=await shrinkOverflowingPages(html,['image_1_failed_to_load'],{minPages:1,maxPages:1});
  assert.ok(repaired);
  assert.ok(repaired.includes(photo));
  assert.ok(!repaired.includes('Journey highlight'));
});

test('narrow long copy is widened instead of aborting the repair pipeline', async () => {
  const copy='Explore coastal heritage, local communities and conservation through guided activities. '.repeat(9);
  const html=`<html><head><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}section{width:794px;height:1123px;padding:40px;overflow:hidden}.columns{display:grid;grid-template-columns:140px 1fr;gap:24px}p{margin:0;line-height:1.5}</style></head><body><section><h1>Practical information</h1><div class="columns"><p>${copy}</p><p>${copy.repeat(2)}</p></div></section></body></html>`;
  const opts={minPages:1,maxPages:4};
  const before=await auditPrintLayout(html,opts);
  assert.ok(before.issues.includes('page_1_has_narrow_long_copy'),JSON.stringify(before));
  const repaired=await shrinkOverflowingPages(html,before.issues,opts);
  assert.ok(repaired,'Narrow copy must no longer veto the local repair');
  assert.equal((await auditPrintLayout(repaired,opts)).ok,true);
  assert.ok(repaired.includes(copy));
});

test('photographic CSS cover and oversized route image retain their AI layout', async () => {
  const photo = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#168abb"/></svg>').toString('base64');
  const html = `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0}
    section{width:794px;height:1123px;padding:40px;overflow:hidden;page-break-after:always}
    .cover{background-image:url("${photo}");background-size:cover}
    .map{width:1000px;height:auto}
  </style></head><body><section class="cover"><h1>Goa</h1></section>
  <section><h2>Your Route</h2><img class="map" src="${photo}" alt="Route map"></section></body></html>`;
  const options = { minPages: 2, maxPages: 2 };
  const before = await auditPrintLayout(html, options);
  assert.ok(!before.issues.includes('page_1_is_sparse'), JSON.stringify(before));
  assert.ok(before.issues.some(issue => issue.startsWith('page_2_clips_or_overflows')), JSON.stringify(before));
  const repaired = await shrinkOverflowingPages(html, before.issues, options);
  assert.ok(repaired, 'Expected map sizing repair');
  const after = await auditPrintLayout(repaired, options);
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.ok(repaired.includes(photo), 'The original image must remain');
});

test('short paired cards are reflowed and a logo intersecting text is moved', async () => {
  const logo = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#168abb"/></svg>').toString('base64');
  const copy = 'Explore the coastal landscape and its heritage with guided learning activities. '.repeat(8);
  const html = `<!doctype html><html><head><style>
  *{box-sizing:border-box}body{margin:0;font:16px Arial}section{position:relative;width:794px;height:1123px;padding:40px;overflow:hidden;page-break-after:always}
  .cover{background:#eef}.logo{position:absolute;top:40px;left:40px;width:60px;height:40px}.cover h1{margin:0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{padding:20px;background:#eef;border-radius:12px}p{line-height:1.5}
  </style></head><body><section class="cover"><h1>Goa learning journey</h1><img class="logo" src="${logo}"><p>${copy}</p></section>
  <section><header>Itinerary</header><div class="grid"><article class="card"><h2>Day 1</h2><p>${copy}</p></article><article class="card"><h2>Day 2</h2><p>${copy}</p></article></div></section></body></html>`;
  const options = {minPages:2,maxPages:4,protectedLogoUrls:[logo]};
  const before = await auditPrintLayout(html,options);
  assert.ok(before.issues.includes('logo_overlaps_text'),JSON.stringify(before));
  assert.ok(before.issues.includes('page_2_is_underfilled'),JSON.stringify(before));
  assert.ok(before.issues.includes('page_2_itinerary_columns_inconsistent'),JSON.stringify(before));
  const repaired = await shrinkOverflowingPages(html,before.issues,options);
  assert.ok(repaired,JSON.stringify(before));
  const after = await auditPrintLayout(repaired,options);
  assert.equal(after.ok,true,JSON.stringify(after));
  assert.ok(!repaired.includes('data-underfill-art'));
  assert.ok(repaired.includes('Day 1') && repaired.includes('Day 2'));
  if (process.env.BROCHURE_QA_SCREENSHOT) {
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']});
    try {
      const page = await browser.newPage();
      await page.setViewport({width:794,height:1123});
      await page.setContent(repaired);
      await page.screenshot({path:process.env.BROCHURE_QA_SCREENSHOT as `${string}.png`,fullPage:true});
    } finally { await browser.close(); }
  }
});
