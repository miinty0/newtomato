const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function ui(config, fail = false) {
  const list={children:[],set innerHTML(value){this.children=[]},appendChild(value){this.children.push(value)}};
  const nodes={'rc-select-list':list,'rc-select-label':{},'rc-scrape-btn':{},'rc-fh-dropdown':{classList:{remove(){}}}};
  const selected=[],dispatches=[],toasts=[];
  const ctx=vm.createContext({
    CATEGORY_NAMES:{17:'Giám bảo',261:'Đô thị hằng ngày'},rcSelectValue:'',
    document:{getElementById:id=>nodes[id],createElement:()=>({dataset:{}})},
    slugify:value=>value.toLowerCase(),selectRcOption:(...args)=>selected.push(args),
    ghRaw:async file=>{assert.equal(file,'data/valid_rank_cats.json');if(fail)throw Error('HTTP 503');return config},
    ghDispatchWorkflow:async(...args)=>dispatches.push(args),toast:(...args)=>toasts.push(args),
    console:{error(){}},
  });
  const start=html.indexOf('let RC_VALID_CAT_IDS = new Set();');
  const end=html.indexOf('\nfunction toggleRcSelect',start);
  const extract=name=>{const a=html.indexOf('function '+name+'(');return html.slice(a,html.indexOf('\n}',a)+2)};
  vm.runInContext(html.slice(start,end)+'\n'+extract('jumpToRcCat')+'\n'+extract('triggerRankCatScrape').replace('function triggerRankCatScrape','async function triggerRankCatScrape'),ctx);
  return {ctx,list,nodes,selected,dispatches,toasts};
}
test('Rankcat dropdown uses the complete valid-ID union, including names missing from catalogue',async()=>{
  const {ctx,list,selected}=ui({rankMold2:[{cat_id:17,gender:1},{cat_id:261}],rankMold1:[{cat_id:'17'},{cat_id:3001,gender:1}]});
  await vm.runInContext('initRcSelect()',ctx);
  assert.deepEqual(list.children.map(e=>e.textContent),['17 - Giám bảo','261 - Đô thị hằng ngày','3001 - Danh mục 3001']);
  vm.runInContext('jumpToRcCat(3001)',ctx);
  assert.deepEqual(selected[0],[3001,'Danh mục 3001']);
});
test('Scrape button dispatches the existing workflow with the selected ID',async()=>{
  const {ctx,dispatches}=ui({rankMold2:[{cat_id:17,gender:1}],rankMold1:[]});
  await vm.runInContext('initRcSelect()',ctx);
  ctx.rcSelectValue=17;
  await vm.runInContext('triggerRankCatScrape()',ctx);
  assert.equal(dispatches.length,1);
  assert.equal(dispatches[0][0],'scrape-rankcat.yml');
  assert.equal(dispatches[0][1].rank_cat_id,'17');
});
test('a failed valid-ID fetch does not expose all categories or allow scraping unconfirmed IDs',async()=>{
  const {ctx,list,nodes,dispatches}=ui({},true);
  await vm.runInContext('initRcSelect()',ctx);
  assert.equal(list.children.length,0);
  assert.equal(nodes['rc-scrape-btn'].disabled,true);
  ctx.rcSelectValue=17;
  await vm.runInContext('triggerRankCatScrape()',ctx);
  assert.equal(dispatches.length,0);
});
async function scrapeCalls(id,config) {
  const source=fs.readFileSync(path.join(__dirname,'scraper.js'),'utf8');
  const requests=[];
  const fileSystem={
    existsSync:file=>file.endsWith('valid_rank_cats.json'),
    readFileSync:()=>JSON.stringify(config),writeFileSync(){},mkdirSync(){},
  };
  const ctx=vm.createContext({
    require:name=>name==='fs'?fileSystem:require(name),__dirname:'/test',URL,URLSearchParams,
    process:{argv:['node','scraper'],env:{}},console:{log(){}},setTimeout,
  });
  ctx.requests=requests;
  vm.runInContext(source.slice(0,source.lastIndexOf('main().catch(')),ctx);
  vm.runInContext("httpGet=async url=>{requests.push(url);return {status:200,data:JSON.stringify({code:0,data:{total_num:0,book_list:[]}})}}; sleep=async()=>{};",ctx);
  await vm.runInContext('scrapeRankCat('+id+')',ctx);
  return requests.filter(url=>url.includes('/api/rank/category/list')).map(url=>{
    const params=new URL(url).searchParams;
    return [params.get('category_id'),params.get('rankMold'),params.get('gender')];
  });
}
test('scraper sends gender=1 for a category available only with gender=1',async()=>{
  const calls=await scrapeCalls(17,{rankMold2:[{cat_id:17,gender:1}],rankMold1:[]});
  assert.deepEqual(calls,[['17','2','1']]);
});
test('scraper uses the configured gender separately for each mold, including mixed-gender category 261',async()=>{
  const calls=await scrapeCalls(261,{rankMold2:[{cat_id:261}],rankMold1:[{cat_id:261,gender:1}]});
  assert.deepEqual(calls,[['261','2','0'],['261','1','1']]);
});
test('updated index inline scripts compile',()=>{
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!/\bsrc=/.test(match[1]))new vm.Script(match[2]);
});
