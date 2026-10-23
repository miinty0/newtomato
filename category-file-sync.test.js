const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildCategoryFileIndex, blobSha } = require('./build-category-file-index');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function environment({summary = true, fail = false, truncated = false, hold = null} = {}) {
  const storage = new Map();
  const listeners = {};
  const elements = {};
  const calls = [];
  const bodies = {
    a: { update_time:'2026-10-23 10:00:00', books:[] },
    b: { update_time:'2026-10-23 11:00:00', books:[] },
    c: { update_time:'2026-10-23 12:00:00', books:[] },
  };
  const entries = [
    {path:'category_24.json',type:'blob',sha:'a'},
    {path:'category_3001.json',type:'blob',sha:'b'},
    {path:'rank_cat_8.json',type:'blob',sha:'c'},
  ];
  if (summary) entries.push({path:'category-file-index.json',type:'blob',sha:'index'});
  const index = {version:1,category:{24:{sha:'a',update_time:bodies.a.update_time}},rankcat:{8:{sha:'c',update_time:bodies.c.update_time}}};
  const ctx = vm.createContext({
    CFG:{user:'u',repo:'r',token:'token'},
    CATEGORY_NAMES:{24:'Mau xuyên',3001:'Mới',8:'Khoa học'},
    catData:{99:{},24:{}},rcData:{99:{},8:{}},
    window:{addEventListener:(key,handler)=>listeners[key]=handler},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:id=>elements[id] ||= {hidden:true,textContent:'',innerHTML:'',classList:{toggle(){}}}},
    console:{warn(){},error(){}},AbortController,setTimeout,clearTimeout,
    b64DecodeUTF8:value=>Buffer.from(value,'base64').toString('utf8'),
    escapeHTML:v=>String(v),htmlJSString:v=>JSON.stringify(String(v)),categoryVisitedToday:()=>true,
    fetch:async url=>{
      calls.push(url);
      if(hold) await hold;
      let value;
      if(url.endsWith('/git/trees/data')) value={tree:[{path:'data',type:'tree',sha:'dir'}]};
      else if(url.endsWith('/git/trees/dir')) value={truncated,tree:entries};
      else if(url.includes('/git/blobs/')){
        const sha=url.split('/').at(-1);
        if(fail && sha==='b') return {ok:false,status:503};
        const body=sha==='index'?index:bodies[sha];
        assert.ok(body,'unexpected blob '+sha);
        value={encoding:'base64',content:Buffer.from(JSON.stringify(body)).toString('base64')};
      } else throw Error('Unexpected request '+url);
      return {ok:true,json:async()=>value};
    },
  });
  const sync=html.slice(html.indexOf('// Complete snapshot of the two saved-data lists'),html.indexOf("const FH_KEY = 'fq_fetch_history';"));
  vm.runInContext(sync+"\nconst FH_KEY='fq_fetch_history', RC_FH_KEY='fq_rankcat_fetch_history';\n"+[
    'loadFetchHistory','saveFetchHistory','loadRcHistory','saveRcHistory','renderFetchHistory','renderRcHistory',
  ].map(extract).join('\n'),ctx);
  vm.runInContext("saveFetchHistory({24:{name:'old',date:'2020-01-01',sha:'old'},99:{name:'deleted',date:'2020-01-01'}}); saveRcHistory({99:{name:'deleted',date:'2020-01-01'}})",ctx);
  return {ctx,calls,elements,listeners,storage};
}
test('generator matches Git blob SHA, reflects additions/deletions, and leaves output untouched on bad JSON',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'newtomato-index-'));
  try {
    fs.writeFileSync(path.join(temp,'category_24.json'),JSON.stringify({update_time:'2026-10-23 10:00:00',books:[]}));
    fs.writeFileSync(path.join(temp,'rank_cat_8.json'),JSON.stringify({update_time:'2026-10-23 12:00:00'}));
    fs.writeFileSync(path.join(temp,'read.json'),'[]');
    let index=buildCategoryFileIndex(temp);
    assert.equal(index.category[24].sha,blobSha(fs.readFileSync(path.join(temp,'category_24.json'))));
    assert.equal(blobSha(Buffer.from('test\n')),'9daeafb9864cf43055ae93beb0afd6c7d144bfa4');
    assert.deepEqual(Object.keys(index.rankcat),['8']);
    fs.unlinkSync(path.join(temp,'category_24.json'));
    fs.writeFileSync(path.join(temp,'category_3001.json'),'{"update_time":null}');
    index=buildCategoryFileIndex(temp);
    assert.deepEqual(Object.keys(index.category),['3001']);
    const before=fs.readFileSync(path.join(temp,'category-file-index.json'),'utf8');
    fs.writeFileSync(path.join(temp,'category_2.json'),'{broken');
    assert.throws(()=>buildCategoryFileIndex(temp));
    assert.equal(fs.readFileSync(path.join(temp,'category-file-index.json'),'utf8'),before);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
test('startup reconciliation adds, updates and deletes across BOTH lists; stale summary reads only changed files',async()=>{
  const {ctx,calls,elements}=environment();
  await vm.runInContext('synchronizeCategoryFileLists()',ctx);
  assert.equal(vm.runInContext('categoryFileSyncPending',ctx),false);
  assert.equal(elements['category-file-sync-status'].hidden,true);
  assert.equal(vm.runInContext("Object.keys(loadFetchHistory()).join(',')",ctx),'24,3001');
  assert.equal(vm.runInContext("Object.keys(loadRcHistory()).join(',')",ctx),'8');
  assert.equal(vm.runInContext("loadFetchHistory()[24].date",ctx),'2026-10-23T02:00:00.000Z');
  assert.ok(elements['fh-list'].innerHTML.includes('3001 - Mới'));
  assert.ok(elements['rc-fh-list'].innerHTML.includes('8 - Khoa học'));
  assert.ok(!('99' in ctx.catData) && !('24' in ctx.catData) && !('99' in ctx.rcData));
  assert.ok(calls.some(url=>url.endsWith('/git/blobs/b')));
  assert.ok(!calls.some(url=>/\/git\/blobs\/[ac]$/.test(url)));
});
test('missing summary bootstraps from files, then unchanged SHAs avoid all file blob reads',async()=>{
  const {ctx,calls}=environment({summary:false});
  await vm.runInContext('synchronizeCategoryFileLists()',ctx);
  assert.equal(calls.filter(url=>url.includes('/git/blobs/')).length,3);
  calls.length=0;
  await vm.runInContext('synchronizeCategoryFileLists()',ctx);
  assert.equal(calls.filter(url=>url.includes('/git/blobs/')).length,0);
});
test('partial fetch failure and truncated listing preserve old history and show a persistent error',async()=>{
  for(const options of [{fail:true},{truncated:true}]){
    const {ctx,elements}=environment(options);
    const old=vm.runInContext('JSON.stringify([loadFetchHistory(),loadRcHistory()])',ctx);
    await vm.runInContext('synchronizeCategoryFileLists()',ctx);
    assert.equal(vm.runInContext('JSON.stringify([loadFetchHistory(),loadRcHistory()])',ctx),old);
    assert.equal(elements['category-file-sync-status'].hidden,false);
    assert.ok(elements['category-file-sync-status'].textContent.includes('Chưa dò xong'));
    assert.equal(vm.runInContext('categoryFileSyncPending',ctx),false);
  }
});
test('unload guard is active while the scan runs and released afterward',async()=>{
  let release;
  const hold=new Promise(resolve=>release=resolve);
  const {ctx,listeners}=environment({hold});
  const running=vm.runInContext('synchronizeCategoryFileLists()',ctx);
  let prevented=false;
  const event={preventDefault(){prevented=true}};
  listeners.beforeunload(event);
  assert.equal(prevented,true);
  release();
  await running;
  prevented=false;
  listeners.beforeunload(event);
  assert.equal(prevented,false);
});
test('startup starts sync on every page load; tabs no longer own discovery or bulk refresh',()=>{
  const init=html.slice(html.indexOf('async function initApp()'));
  assert.ok(init.includes('await synchronizeCategoryFileLists();'));
  assert.ok(!html.includes('detectExistingCategories'));
  assert.ok(!html.includes('detectExistingRankCats'));
  assert.ok(!html.includes('refreshLastFetched'));
  assert.ok(!html.includes('id="fh-refresh-btn"'));
  assert.ok(!html.includes('id="rc-fh-refresh-btn"'));
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(match[1])) new vm.Script(match[2]);
  }
});
