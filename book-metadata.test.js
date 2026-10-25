const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const m = require('./book-metadata');
const page = {
  bookId: '7687985684388252696', author: '可以放香菜嘛', bookName: '宝贝乖乖坐好',
  categoryV2: JSON.stringify([{Name:'快穿'}, {Name:'总裁'}, {Name:'1v1'}]),
  abstract: '介绍\n第二段', thumbUri: 'https://p3-reading-sign.fqnovelpic.com/novel-pic/p2o123~resize.image?signature=x',
  creationStatus: 1, lastPublishTime: '1792777412',
  chapterListWithVolume: [[{firstPassTime:'1790000271', realChapterOrder:'1'}]],
};
const html = p => `<script>window.__INITIAL_STATE__=${JSON.stringify({page:p})};</script>`;
const info = () => m.parseDetailPage(html(page)).info;
test('real schema reads author, every tag, status, exact times and permanent image', () => {
  const b = info();
  assert.equal(b.author, page.author); assert.equal(b.status, 'Ongoing');
  assert.deepEqual(b.tags, ['快穿','总裁','1v1']);
  assert.equal(b.first_chapter_time, 1790000271); assert.equal(b.last_chapter_time, 1792777412);
  assert.equal(b.thumb_url, 'https://p6-novel.byteimg.com/thumb/novel-pic/p2o123');
  assert.deepEqual(m.missingFields({...b, hot_rank:2}), []);
});
test('raw thumb_uri paths and signed CDN images normalize alike', () => {
  assert.equal(m.normalizeThumbUrl('novel-pic/p2o123'), info().thumb_url);
});
test('unrelated undefined or broken JSON does not discard intact fields', () => {
  const source = html(page).replace('"author":', '"unused":undefined,"author":');
  assert.deepEqual(m.parseDetailPage(source).info, info());
});
test('unescaped app mount inside abstract only discards damaged abstract', () => {
  const source = html(page).replace('介绍\\n第二段', '介绍<div id="app"></div>');
  const b = m.parseDetailPage(source).info;
  assert.equal(b.abstract, undefined); assert.equal(b.author, page.author);
  assert.deepEqual(b.tags, info().tags); assert.equal(b.first_chapter_time, 1790000271);
});
test('all required fields, placeholders and corrupt tags are checked', () => {
  const b = {...info(), hot_rank:2};
  for (const field of Object.keys(b)) {
    assert.ok(m.missingFields({...b, [field]:null}).includes(field), field);
  }
  assert.ok(m.missingFields({...b, tags:['好','坏�']}).includes('tags'));
  assert.ok(m.missingFields({...b, book_name:'ID:123'}).includes('book_name'));
  assert.ok(m.missingFields({...b, author:'Unknown'}).includes('author'));
});
test('repair fills only missing/broken fields, preserving existing values and positions', () => {
  const b = {...info(), hot_rank:3, author:'已有作者', tags:['已有标签'], abstract:'�'};
  m.fillMissing(b, {...info(), hot_rank:1});
  assert.equal(b.author,'已有作者'); assert.deepEqual(b.tags,['已有标签']);
  assert.equal(b.abstract,page.abstract); assert.equal(b.hot_rank,3);
});
test('rankcat validates currentPos without demanding a daily hot_rank', () => {
  const b = {...info(), rankMold:2, currentPos:1, rankPosDiff:0};
  assert.deepEqual(m.missingFields(b), []);
  delete b.currentPos; assert.deepEqual(m.missingFields(b), ['currentPos']);
});
test('blocked/hidden handling and zero completed status', () => {
  assert.equal(m.parseDetailPage('').kind,'blocked');
  assert.equal(m.parseDetailPage(html({status:null})).kind,'hidden');
  assert.equal(m.parseDetailPage(html({...page,creationStatus:0})).info.status,'Completed');
});
test('legacy completed cache maps old description and hdImage', () => {
  const b = m.legacyDetail({description:'简介',hdImage:page.thumbUri});
  assert.equal(b.abstract,'简介'); assert.equal(b.thumb_url, info().thumb_url);
});
test('refetch integration repairs missing status/times, keeps valid metadata and updates cache', async () => {
  const files = new Map();
  const dataDir = '/fixture/data';
  const book = {...info(), status:'Unknown', first_chapter_time:null, last_chapter_time:null, author:'保留作者', hot_rank:2};
  files.set(dataDir+'/latest.json', JSON.stringify({books:[book]}));
  files.set(dataDir+'/cache.json', JSON.stringify({[page.bookId]:{author:'Unknown'}}));
  const fakeFs = {
    existsSync:p=>p===dataDir || files.has(p), mkdirSync(){},
    readdirSync:()=>['latest.json','cache.json'],
    readFileSync:p=>{if(!files.has(p))throw Error('missing'); return files.get(p);},
    writeFileSync:(p,s)=>files.set(p,s),
  };
  const src = fs.readFileSync(__dirname+'/refetch-missing-details.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.runMain = main;');
  const ctx = {__dirname:'/fixture', console:{log(){}}, process:{argv:[]}, setTimeout:cb=>cb(),
    require:n=>n==='fs'?fakeFs:n==='./book-metadata'?m:require(n)};
  vm.createContext(ctx);
  vm.runInContext(src+`\nhttpGet = async () => ({status:200, data:${JSON.stringify(html({...page,creationStatus:0}))}});`,ctx);
  await ctx.runMain();
  const repaired = JSON.parse(files.get(dataDir+'/latest.json')).books[0];
  assert.equal(repaired.author,'保留作者'); assert.equal(repaired.status,'Completed');
  assert.equal(repaired.first_chapter_time,1790000271); assert.equal(repaired.last_chapter_time,1792777412);
  assert.equal(JSON.parse(files.get(dataDir+'/cache.json'))[page.bookId].author,page.author);
});
test('scraper daily uses only requested list fields plus detail page', async () => {
  const src = fs.readFileSync(__dirname+'/scraper.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.scrape = scrapeOnce;');
  let count = 0;
  const ctx = {__dirname:'/fixture', console:{log(){}}, process:{argv:[]}, setTimeout:cb=>cb(), URLSearchParams,
    require:n=>n==='fs'?{existsSync:()=>false}:n==='./book-metadata'?m:require(n)};
  vm.createContext(ctx);
  vm.runInContext(src+`\nfetchHotRankList = async () => ${JSON.stringify([{book_id:page.bookId,creation_status:1,last_chapter_time:'1792776668',thumb_uri:'novel-pic/listImage',_sortRank:3}])};
    httpGet = async () => ({status:200,data:${JSON.stringify(html(page))}});`,ctx);
  const result = await ctx.scrape(null,new Set(),new Set(),-1);
  const b = result.books[0];
  assert.equal(b.book_id,page.bookId); assert.equal(b.author,page.author);
  assert.equal(b.hot_rank,3); assert.equal(b.last_chapter_time,1792776668);
  assert.equal(b.thumb_url,'https://p6-novel.byteimg.com/thumb/novel-pic/listImage');
  assert.equal(result.books.length,1);
  assert.ok(!src.includes('top_book_list'));
});
test('refetch skips books whose only missing field is hot_rank', async () => {
  const files = new Map();
  const dataDir = '/fixture/data';
  files.set(dataDir+'/category_24.json', JSON.stringify({category_id:24,books:[{...info(),hot_rank:null}]}));
  const fakeFs = {existsSync:p=>p===dataDir||files.has(p), mkdirSync(){}, readdirSync:()=>['category_24.json'],
    readFileSync:p=>{if(!files.has(p))throw Error('missing');return files.get(p);}, writeFileSync:(p,s)=>files.set(p,s)};
  const src = fs.readFileSync(__dirname+'/refetch-missing-details.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.runMain = main;');
  const urls = [];
  const ctx = {__dirname:'/fixture',console:{log(){}},process:{argv:[]},setTimeout:cb=>cb(),
    require:n=>n==='fs'?fakeFs:n==='./book-metadata'?m:require(n),
    fakeGet:async url=>{urls.push(url);return {status:200,data:JSON.stringify({code:0,data:{book_list:[{book_id:'123'},{book_id:page.bookId}]}})};}};
  vm.createContext(ctx); vm.runInContext(src+'\nhttpGet = fakeGet;',ctx); await ctx.runMain();
  assert.equal(JSON.parse(files.get(dataDir+'/category_24.json')).books[0].hot_rank,null);
  assert.deepEqual(urls, []);
});
test('scraper rankcat maps creationStatus, signed thumbUri and currentPos', async () => {
  const files = new Map();
  files.set('/fixture/data/valid_rank_cats.json',JSON.stringify({rankMold2:[{cat_id:24,gender:0}],rankMold1:[]}));
  const fakeFs = {existsSync:p=>files.has(p),readFileSync:p=>files.get(p),writeFileSync:(p,s)=>files.set(p,s)};
  const src = fs.readFileSync(__dirname+'/scraper.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.scrape = scrapeRankCat;');
  const ctx = {__dirname:'/fixture', console:{log(){}},process:{argv:[]},setTimeout:cb=>cb(),URLSearchParams,
    require:n=>n==='fs'?fakeFs:n==='./book-metadata'?m:require(n)};
  vm.createContext(ctx);
  vm.runInContext(src+`\nfetchRankCatPage = async () => ({totalNum:1,list:${JSON.stringify([{bookId:page.bookId,creationStatus:'1',currentPos:1,rankPosDiff:0,lastChapterUpdateTime:'1792776668',thumbUri:page.thumbUri}])}});
    httpGet = async () => ({status:200,data:${JSON.stringify(html(page))}});`,ctx);
  const result = await ctx.scrape(24);
  const b = result.books[0];
  assert.equal(b.author,page.author); assert.equal(b.status,'Ongoing');
  assert.equal(b.currentPos,1); assert.equal(b.rankPosDiff,0);
  assert.equal(b.last_chapter_time,1792776668); assert.equal(b.thumb_url,info().thumb_url);
});

async function simulateCooldown(results, count = 6) {
  const files = new Map();
  const books = Array.from({length:count}, (_, i)=>String(i+1)).map(book_id=>({...info(),book_id,hot_rank:1,abstract:''}));
  files.set('/fixture/data/latest.json',JSON.stringify({books}));
  const events = [], calls = [], logs = [];
  const fakeFs = {existsSync:p=>p==='/fixture/data'||files.has(p),mkdirSync(){},readdirSync:()=>['latest.json'],
    readFileSync:p=>{if(!files.has(p))throw Error('missing');return files.get(p);},
    writeFileSync:(p,s)=>{events.push('save');files.set(p,s);}};
  const src = fs.readFileSync(__dirname+'/refetch-missing-details.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.runMain = main;');
  const ctx = {__dirname:'/fixture',process:{argv:[]},console:{log:s=>logs.push(s)},
    setTimeout:(cb,ms)=>{events.push(ms);cb();},
    require:n=>n==='fs'?fakeFs:n==='./book-metadata'?m:require(n),
    fakeFetch:async id=>{calls.push(id);const next=results.shift();assert.notEqual(next,undefined,'unexpected retry');return next==='blocked'?{kind:'blocked',reason:'empty response'}:{kind:'ok',info:{book_id:id,abstract:'已修复'}};}};
  vm.createContext(ctx); vm.runInContext(src+'\nfetchDetailWithRetry = fakeFetch;',ctx);
  await ctx.runMain();
  return {events,calls,logs,files};
}
test('five consecutive empty/error pages checkpoint, wait fifteen minutes and retry from first failed book', async () => {
  const r = await simulateCooldown(['ok',...Array(5).fill('blocked'),...Array(5).fill('ok')]);
  assert.deepEqual(r.calls,['1','2','3','4','5','6','2','3','4','5','6']);
  assert.equal(r.events.filter(e=>e===900000).length,1);
  assert.equal(r.events[r.events.indexOf(900000)-1],'save');
  assert.ok(r.logs.some(s=>s.includes('complete=6')&&s.includes('chưa xử lý=0')));
  assert.ok(JSON.parse(r.files.get('/fixture/data/latest.json')).books.every(b=>b.abstract==='已修复'));
});
test('a successful response resets the blocked streak before five consecutive failures', async () => {
  const r = await simulateCooldown(['blocked','blocked','blocked','blocked','ok','blocked']);
  assert.equal(r.events.filter(e=>e===900000).length,0);
  assert.deepEqual(r.calls,['1','2','3','4','5','6']);
});
test('if the block continues after resuming, pause again and retry the same first book', async () => {
  const r = await simulateCooldown([...Array(10).fill('blocked'),...Array(6).fill('ok')]);
  assert.equal(r.events.filter(e=>e===900000).length,2);
  assert.deepEqual(r.calls,['1','2','3','4','5','1','2','3','4','5','1','2','3','4','5','6']);
});
test('after five cooldowns a sixth blocked streak exits normally and saves earlier work', async () => {
  const r = await simulateCooldown(['ok',...Array(30).fill('blocked')],7);
  assert.equal(r.events.filter(e=>e===900000).length,5);
  assert.equal(r.calls.length,31);
  assert.equal(r.calls.includes('7'),false);
  assert.equal(r.events.at(-1),'save');
  assert.ok(r.logs.some(s=>s.includes('Đã nghỉ đủ 5 lượt')));
  assert.ok(r.logs.some(s=>s.includes('complete=1')&&s.includes('chưa xử lý=1')));
  assert.ok(!r.logs.some(s=>s.includes('Đã duyệt toàn bộ candidate.')));
  const books = JSON.parse(r.files.get('/fixture/data/latest.json')).books;
  assert.equal(books[0].abstract,'已修复');
  assert.ok(books.slice(1).every(b=>b.abstract===''));
});

test('only missing hot_rank/currentPos is excluded, while missing or corrupt metadata still qualifies', () => {
  const src = fs.readFileSync(__dirname+'/refetch-missing-details.js','utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.checkMissing = isMissingDetail;');
  const ctx = {__dirname:'/fixture', require:n=>n==='./book-metadata'?m:require(n)};
  vm.createContext(ctx); vm.runInContext(src,ctx);
  const daily = {...info(),hot_rank:null};
  const rankcat = {...info(),rankMold:2,currentPos:null,rankPosDiff:0};
  assert.equal(ctx.checkMissing(daily),false);
  assert.equal(ctx.checkMissing(rankcat),false);
  assert.equal(ctx.checkMissing({...daily,hot_rank:'�'}),false);
  assert.equal(ctx.checkMissing({...rankcat,currentPos:'�'}),false);
  assert.equal(ctx.checkMissing({...daily,author:'Unknown'}),true);
  assert.equal(ctx.checkMissing({...rankcat,abstract:'�'}),true);
});


test('hidden chapter 1 uses the smallest available order across unsorted volumes', () => {
  const chapters = [
    [{realChapterOrder:'10',firstPassTime:'1790000010'}, {realChapterOrder:3,firstPassTime:'1790000003'}],
    [{firstPassTime:'1790000002',realChapterOrder:'2'}],
  ];
  const b = m.parseDetailPage(html({...page,chapterListWithVolume:chapters})).info;
  assert.equal(b.first_chapter_time,1790000002);
});
test('choose by chapter order, not by earliest timestamp or array position', () => {
  const b = m.parseDetailPage(html({...page,chapterListWithVolume:[[
    {realChapterOrder:8,firstPassTime:'1700000000'},
    {realChapterOrder:4,firstPassTime:'1790000000'},
  ]]})).info;
  assert.equal(b.first_chapter_time,1790000000);
});
test('use the smallest chapter order whose firstPassTime is readable', () => {
  const b = m.parseDetailPage(html({...page,chapterListWithVolume:[[
    {realChapterOrder:0,firstPassTime:'1700000000'},
    {realChapterOrder:2,firstPassTime:null},
    {realChapterOrder:3,firstPassTime:'�'},
    {realChapterOrder:4,firstPassTime:'1790000004'},
    {realChapterOrder:5,firstPassTime:'1790000005'},
  ]]})).info;
  assert.equal(b.first_chapter_time,1790000004);
});
test('malformed state still recovers smallest available chapter order and handles braces in titles', () => {
  const source = html({...page,chapterListWithVolume:[[
    {realChapterOrder:'12',title:'chapter {12}',firstPassTime:'1790000012'},
    {firstPassTime:'1790000003',title:'chapter {3}',realChapterOrder:'3'},
  ]]}).replace('"author":','"unused":undefined,"author":');
  const b = m.parseDetailPage(source).info;
  assert.equal(b.first_chapter_time,1790000003);
  assert.equal(b.author,page.author);
});
test('no readable chapter timestamp remains missing for a later refetch', () => {
  const b = m.parseDetailPage(html({...page,chapterListWithVolume:[[
    {realChapterOrder:'2',firstPassTime:''},
    {realChapterOrder:'3',firstPassTime:'bad'},
  ]]})).info;
  assert.equal(b.first_chapter_time,undefined);
});
