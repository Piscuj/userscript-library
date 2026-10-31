// ==UserScript==
// @name         Pomelo to Fitatu
// @namespace    local.pomelo-fitatu
// @version      0.3.5
// @description  Copy Pomelo meals, nutrition and ingredients to the matching Fitatu diary date.
// @updateURL    https://piscuj.github.io/userscript-library/scripts/pomelo-fitatu/script.meta.js
// @downloadURL  https://piscuj.github.io/userscript-library/scripts/pomelo-fitatu/script.user.js
// @match        https://konto.pomelo.com.pl/*
// @match        https://www.fitatu.com/app/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.addValueChangeListener
// @grant        GM.openInTab
// @sandbox      JavaScript
// @run-at       document-idle
// @noframes
// @license      MIT
// @match        https://piscuj.github.io/userscript-library/*
// @grant        GM_info
// ==/UserScript==

(function(){
/* Bundled into each script. No remote telemetry or shared credential storage. */
function createControlReporter(config, env) {
  'use strict';
  env=env||globalThis;
  const ORIGIN = 'https://piscuj.github.io';
  const PATH = '/userscript-library/';
  const KEY = 'script-control:v1:';
  const WIRE = 'userscript-control:';
  const services = config.services;
  const clean = (v, max = 100) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  const now = () => env.Date.now();
  const get = async (k, fallback) => {
    try { return await (env.GM?.getValue ? env.GM.getValue(k, fallback) : env.GM_getValue(k, fallback)); } catch { return fallback; }
  };
  const set = async (k, value) => {
    if (env.GM?.setValue) await env.GM.setValue(k, value); else await env.GM_setValue(k, value);
  };
  const version = clean(env.GM_info?.script?.version || config.version);
  const tab = env.crypto?.randomUUID?.() || String(Math.random()).slice(2);
  const context = new Map();
  let queue = Promise.resolve(), probe = null, processing = false, lastCommand = '', lastObservation = new Map();
  function account(value) {
    const id = value?.id == null ? 'unknown' : clean(value.id);
    return {id, label: clean(value?.label || (id === 'unknown' ? 'Identity unavailable' : 'Athlete ' + id)), evidence: id === 'unknown' ? 'unavailable' : 'observed', role: clean(value?.role || 'account')};
  }
  function scope(service, identity) {
    if (!services.includes(service)) return null;
    const a = account(identity), prior = context.get(service);
    if (!prior || prior.account.id !== a.id) context.set(service, {account:a, generation:(prior?.generation || 0) + 1});
    else prior.account = a;
    const current = context.get(service);
    return {service, account:a, generation:current.generation};
  }
  function valid(token) { return token && context.get(token.service)?.generation === token.generation && context.get(token.service)?.account.id === token.account.id; }
  function enqueue(job) {
    queue = queue.catch(() => {}).then(async () => {
      try {
        const locks = env.navigator?.locks;
        return locks?.request ? await locks.request('control-report:' + config.id, job) : await job();
      } catch { /* Reporting must not interrupt the script's primary function. */ }
    });
    return queue;
  }
  function write(token, event, detail = '') {
    if (!valid(token)) return Promise.resolve();
    return enqueue(async () => {
      if (!valid(token)) return;
      const key = KEY + token.service, old = await get(key, []);
      const rows = Array.isArray(old) ? old.filter(r => r?.account?.id !== token.account.id) : [];
      const previous = Array.isArray(old) ? old.find(r => r?.account?.id === token.account.id) : null;
      const row = {...previous, service:token.service, account:token.account, observedAt:now(), serviceVersion:version, tab};
      if (event === 'connected' || event === 'failed') row.check = {at:now(), state:event, label:clean(detail)};
      if (event === 'success') row.success = {at:now(), label:clean(detail)};
      rows.push(row); await set(key, rows.sort((a,b) => b.observedAt-a.observedAt).slice(0,10));
    });
  }
  function observe(service, identity) {
    const token = scope(service, identity); if (!token) return null;
    const signature = token.account.id + ':' + token.account.label;
    const prior = lastObservation.get(service);
    if (!prior || prior.signature !== signature || now()-prior.at >= 30000) {
      lastObservation.set(service,{signature,at:now()}); void write(token,'observed');
    }
    return token;
  }
  function record(service, identity, event, detail) { const token = scope(service,identity); return write(token,event,detail); }
  function invalidate(service,label='Credential changed; recheck required') {
    const prior=context.get(service),identity=prior?.account;
    context.set(service,{account:account(identity),generation:(prior?.generation||0)+1});
    return write(scope(service,identity),'failed',label);
  }
  async function snapshot() {
    await queue;
    const rows = (await Promise.all(services.map(s => get(KEY+s,[])))).flat();
    // Never expose arbitrary stored objects or raw errors to the library page.
    const reports = rows.filter(r => services.includes(r?.service) && Number.isFinite(r.observedAt)).map(r => {
      const result = {service:r.service, account:account(r.account), observedAt:r.observedAt, serviceVersion:clean(r.serviceVersion)};
      for (const key of ['check','success']) if (r[key] && Number.isFinite(r[key].at)) {
        result[key] = {at:r[key].at,label:clean(r[key].label)};
        if (key === 'check') result[key].state = r[key].state === 'connected' ? 'connected' : 'failed';
      }
      return result;
    });
    return {schema:1, scriptId:config.id, version, reports:reports.slice(0,40),capabilities:env.GM?.openInTab?['openUpdates']:[]};
  }
  async function command() {
    if (!probe || processing) return;
    const request = await get(KEY+'command',null);
    if (!request || request.id === lastCommand || request.action !== 'check' || !Number.isFinite(request.at) || now()-request.at > 20000 || request.at > now()+1000) return;
    lastCommand=request.id; processing=true;
    try { await probe(); } catch { /* Probes record their own sanitized outcome. */ } finally { processing=false; }
  }
  function onLibrary() {
    if (env.location?.origin !== ORIGIN || env.location?.pathname !== PATH) return false;
    const seen=new Set();
    env.addEventListener('message', async event => {
      // Firefox USERSCRIPT_WORLD wraps the source Window differently from both
      // window and unsafeWindow. The exact library origin/route is the boundary;
      // replies always go to this page, never to the requesting source window.
      if (event.origin !== ORIGIN) return;
      let req=event.data;
      if(typeof req==='string'){
        if(!req.startsWith(WIRE)||req.length>65536)return;
        try{req=JSON.parse(req.slice(WIRE.length));}catch{return;}
      }
      if(req?.channel!=='userscript-control-request'||req?.schema!==1)return;
      if (typeof req.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(req.requestId) || (req.scriptId && req.scriptId !== config.id)) return;
      if (!['snapshot','check','forget','updates'].includes(req.action)) return;
      if(seen.has(req.requestId))return;
      seen.add(req.requestId);if(seen.size>128)seen.delete(seen.values().next().value);
      if (req.action === 'forget') await enqueue(async () => {for (const service of services) await set(KEY+service,[]);});
      if (req.action === 'check') try { await set(KEY+'command',{id:req.requestId,action:'check',at:now()}); } catch {}
      if(req.action==='updates'&&env.GM?.openInTab){
        for(const id of (Array.isArray(req.ids)?req.ids:[]).filter(id=>typeof id==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)).slice(0,20))await env.GM.openInTab(ORIGIN+PATH+'scripts/'+id+'/script.user.js',{active:false,insert:true});
      }
      const data = await snapshot();
      // A primitive string crosses Firefox's USERSCRIPT_WORLD without exposing
      // sandbox objects to the page or requiring cloneInto/exportFunction.
      env.postMessage(WIRE+JSON.stringify({channel:'userscript-control-response',requestId:req.requestId,...data}),ORIGIN);
    });
    return true;
  }
  function intervals(page = env) {
    try {
      for (const root of page.document.querySelectorAll('[data-v-app]')) {
        const pinia = root.__vue_app__?.config?.globalProperties?.$pinia;
        const athlete = pinia?._s?.get('current-athlete')?.athlete;
        if (athlete?.id != null) return {id:String(athlete.id),label:athlete.name || athlete.firstname || 'Athlete '+athlete.id,role:'selected athlete'};
      }
    } catch {}
    return null;
  }
  function start(fn) {
    probe=fn;
    env.setInterval?.(() => {void command();},2500);
  }
  return {onLibrary,observe,scope,valid,write,record,invalidate,snapshot,intervals,start,flush:()=>queue};
}

const cc=createControlReporter({"id":"pomelo-fitatu","version":"0.3.5","old":"0.2.6","services":["pomelo","fitatu"]},typeof window==='undefined'?globalThis:{Date,crypto:window.crypto,navigator:window.navigator,location:window.location,document:window.document,window,pageWindow:typeof unsafeWindow==='object'?unsafeWindow:window,addEventListener:window.addEventListener.bind(window),postMessage:window.postMessage.bind(window),setInterval:window.setInterval.bind(window),GM:typeof GM==='object'?GM:undefined,GM_info:typeof GM_info==='object'?GM_info:undefined,GM_getValue:typeof GM_getValue==='function'?GM_getValue:undefined,GM_setValue:typeof GM_setValue==='function'?GM_setValue:undefined});
if(cc.onLibrary())return;
(async function () {
  'use strict';
  const VERSION='0.3.5', STORE='pomelo-fitatu-state-v1', REGISTRY='pomelo-fitatu-products-v1', DAY_PREFIX='pomelo-fitatu-day-v1:';
  const MAP={'Śniadanie':'Śniadanie','II Śniadanie':'II śniadanie','Obiad':'Lunch','Podwieczorek':'Podwieczorek','Kolacja':'Kolacja'};
  const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const visible=e=>{
    if(!e||!e.isConnected||e.closest('[hidden],[aria-hidden="true"],[inert]'))return false;
    const rect=e.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return false;
    for(let node=e;node&&node.nodeType===1;node=node.parentElement){const css=getComputedStyle(node);if(css.display==='none'||css.visibility==='hidden'||css.opacity==='0')return false;}
    return true;
  };
  const all=(q,root=document)=>Array.from(root.querySelectorAll(q)).filter(visible);
  const text=(root=document)=>{const node=root===document?document.body:root;return norm(node?.innerText||node?.textContent);};
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  async function until(fn,label,timeout=18000) {
    const end=Date.now()+timeout;
    while(Date.now()<end) { const value=fn(); if(value)return value; await pause(150); }
    throw Error('Timed out: '+label+'. Nothing will be retried automatically.');
  }
  function exactText(label,root=document) {
    return all('button,a,p,h2,h3,h4,span,div',root).filter(e=>norm(e.textContent)===label)
      .sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];
  }
  function clickText(labels,root=document) {
    for(const label of labels) { const e=exactText(label,root); if(e){e.click();return;} }
    throw Error('Cannot find '+labels.join(' / '));
  }
  function saveButtons(root=document) {return all('button',root).filter(e=>/^(Save|Zapisz)$/i.test(norm(e.textContent)));}
  // Use the native setter and input/change events so reactive forms see edits.
  function setField(field,value) {
    if(!field || field.disabled || field.readOnly)throw Error('Field is not editable');
    field.focus();
    const prototype=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,String(value));
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
    field.blur();
    if(field.value!==String(value) && Number(field.value)!==Number(value))throw Error('The page rejected a value; enter it manually and review.');
  }
  function parseDish(raw,name,sourceMeal,date) {
    const number=label=>{
      const match=raw.match(new RegExp(label+'\\s+([0-9]+(?:[.,][0-9]+)?)\\s*(?:kcal|g)'));
      if(!match)throw Error('Missing '+label+' for '+name);
      return Number(match[1].replace(',','.'));
    };
    const day=date.split('-').reverse().slice(0,2).join('.');
    if(!raw.includes(day)||!raw.includes(sourceMeal))throw Error('Dish date or meal does not match the selected day');
    const ingredients=raw.match(/Skład\s+([\s\S]*?)\s+Wartości odżywcze/);
    if(!ingredients||!norm(ingredients[1]))throw Error('Missing ingredients for '+name);
    const d={date,name,sourceMeal,targetMeal:MAP[sourceMeal],brand:'Pomelo',kcal:number('Wartość energetyczna'),fat:number('Tłuszcze'),carbs:number('Węglowodany'),protein:number('Białko'),ingredients:norm(ingredients[1]),status:'ready'};
    if(!d.targetMeal||d.kcal<=0||[d.fat,d.carbs,d.protein].some(n=>n<0))throw Error('Invalid dish data');
    return d;
  }
  const fingerprint=d=>JSON.stringify([d.name,d.kcal,d.fat,d.carbs,d.protein,d.ingredients]);
  const isPomelo=location.hostname==='konto.pomelo.com.pl';
  const ccService=isPomelo?'pomelo':'fitatu';
  cc.observe(ccService,null);
  cc.start(async()=>{const readable=isPomelo?!!pomeloDate()&&!!document.querySelector('main'):!!fitatuDate()&&all('section.planner-section h2').length>=5;cc.record(ccService,null,readable?'connected':'failed',readable?'Selected day readable; identity unavailable':'Open a signed-in day page');});
  let state=await GM.getValue(STORE,{items:[],date:null,active:null}), registry=await GM.getValue(REGISTRY,{}),busy=false;
  const pomeloDate=()=>location.pathname.match(/^\/my-account\/my-orders\/details\/(\d{4}-\d{2}-\d{2})\//)?.[1]||null;
  let viewDate=null,restoring=false,routeReady=false,needsDayCheck=false,otherImportDate=null;
  let owner=sessionStorage.getItem('pomelo-fitatu-tab');
  if(!owner){owner=crypto.randomUUID();sessionStorage.setItem('pomelo-fitatu-tab',owner);}
  const SESSION_KEY='pomelo-fitatu-check-session-v1';
  let checkSessionId=sessionStorage.getItem(SESSION_KEY);
  if(!checkSessionId){checkSessionId=crypto.randomUUID();sessionStorage.setItem(SESSION_KEY,checkSessionId);}
  const host=document.createElement('div');host.id='pomelo-fitatu-panel';
  const shadow=host.attachShadow({mode:'open'});document.documentElement.append(host);
  function refreshRoute(){
    cc.observe(ccService,null);
    // Pomelo often enters order details using SPA navigation after login or an
    // order-list visit. Inject on the whole account origin, show only on a day.
    const orderDay=/^\/my-account\/my-orders\/details\/\d{4}-\d{2}-\d{2}\//.test(location.pathname);
    host.style.display=isPomelo&&!orderDay?'none':'';
    if(!host.isConnected)document.documentElement.append(host);
    if(routeReady&&isPomelo&&!orderDay)viewDate=null;
    if(routeReady&&isPomelo&&orderDay&&pomeloDate()!==viewDate&&!restoring&&!busy){activatePomeloDay().then(autoCheckSelectedDay).catch(e=>{state.error=e.message;render();});}
    if(routeReady&&!isPomelo)refreshFitatuSummary().catch(()=>{});
    if(routeReady&&isPomelo&&orderDay&&!busy&&!restoring){
      const signature=JSON.stringify([pomeloDate(),readMenuTotals(),state.items.map(d=>[d.kcal,d.protein,d.carbs,d.fat])]);
      if(signature!==totalsViewSignature){totalsViewSignature=signature;render();}
      if(state.autoSkipped&&pomeloMenuChosen(pomeloDate())===true){needsDayCheck=true;autoCheckSelectedDay();}
    }
  }
  refreshRoute();
  window.addEventListener('popstate',refreshRoute);
  window.addEventListener('pageshow',refreshRoute);
  setInterval(refreshRoute,750);
  let minimized=true,scanTab=null,totalsViewSignature='';
  const css=`:host{position:fixed;right:14px;bottom:14px;width:min(760px,calc(100% - 28px));box-sizing:border-box;z-index:2147483000;color:#e9f1f7;font:12px/1.4 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums}*{box-sizing:border-box}aside{width:100%;background:#101c27;border:1px solid #314656;border-radius:18px;box-shadow:0 18px 70px #0006;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(120deg,#1b3540,#162735)}.brand{display:flex;align-items:center;gap:10px}.logo{display:grid;place-items:center;background:#a6efcd;color:#173e31;font-size:21px;width:31px;height:31px;border-radius:10px}h2{font-size:14px;letter-spacing:-.2px;margin:0}.version{font-size:10px;color:#9eb6c6;font-weight:400;margin-left:6px}button{font:inherit;border:0;border-radius:8px;padding:8px 11px;background:#a6efcd;color:#143c2e;cursor:pointer;font-weight:650;white-space:nowrap}button:hover:not(:disabled){filter:brightness(1.08)}button:disabled{cursor:not-allowed;opacity:.38}.secondary{background:#263c4c;color:#d2e3ee}.toggle{background:transparent;color:#b6cbd8;padding:4px 8px;font-size:19px}.toolbar{display:flex;align-items:center;gap:8px;padding:12px 14px;flex-wrap:wrap}.date{font-size:12px;font-weight:650;margin-right:auto}.date small{display:block;font-size:10px;color:#94adbf;font-weight:400}.message{padding:0 14px 10px;color:#9eb8c9;font-size:11px}.error{color:#ffc3b9}.scroll{max-height:58vh;overflow:auto;border-top:1px solid #263b4b}table{border-collapse:collapse;width:100%;min-width:570px}th{text-align:right;background:#162736;color:#89a5b9;font-size:9px;text-transform:uppercase;letter-spacing:.6px;font-weight:650;padding:9px 7px;position:sticky;top:0;z-index:1}th:first-child{width:25px}th.dish-head{text-align:left}td{border-top:1px solid #233746;padding:11px 7px;text-align:right;vertical-align:top}tbody tr:nth-child(even){background:#12212e}tbody tr:hover{background:#172c39}.dish{width:100%;min-width:178px;text-align:left}.name{font-size:12px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}.meal{font-size:10px;color:#92afc3;margin-top:4px}.pill{display:inline-flex;align-items:center;gap:4px;border-radius:20px;font-size:9px;line-height:1.6;padding:2px 7px;background:#223e35;color:#abe8c7;margin-top:5px}.pill.pending{background:#4b2b13;color:#ffbb78}.pill.check{background:#343a35;color:#d6cf9b}.pill.wait{background:#283749;color:#abc3df}.number{font-size:11px;white-space:nowrap}.kcal{color:#b6eed4;font-weight:700}.action{min-width:100px}.send{font-size:10px;padding:7px 9px}.added{background:#203c33;color:#b2dec7;opacity:1!important}input{accent-color:#a6efcd;margin:2px 0 0}summary{font-size:10px;color:#a6c7dd;cursor:pointer;margin-top:5px}.ingredients{font-size:11px;color:#c3d5e1;white-space:normal;margin-top:7px;line-height:1.5;max-width:300px}.empty{padding:24px 16px;color:#8da8bb;text-align:center}.footer{padding:8px 14px;display:flex;gap:8px;align-items:center;justify-content:space-between;background:#142431;color:#8ca6b8;font-size:10px}.footer button{font-size:10px;padding:5px 9px}@media(max-width:600px){:host{right:10px;bottom:10px;width:calc(100% - 20px)}.toolbar{gap:6px}.date{flex-basis:100%}.scroll{max-height:58vh}}`;
  const completed=d=>checked()&&d.presence?.date===state.date&&!!d.presence.found;
  const checked=()=>state.scan?.status==='complete'&&state.scan.date===state.date&&state.scan.menuToken===state.menuToken;
  const canSend=d=>totalsCheck().ok&&checked()&&!completed(d)&&!busy&&!state.active&&!state.transfer?.running&&!otherImportDate;
  function badge(d,i){
    if(state.active?.index===i)return ['wait',state.active.phase];
    if(completed(d))return ['','Added'];
    if(state.scan?.status==='pending')return ['check','Checking Fitatu…'];
    if(!checked())return ['check','Fitatu check needed'];
    if(d.queued)return ['wait','Queued'];
    return ['pending','To be send'];
  }
  function dishRow(d,i){
    if(!isPomelo&&!d.queued&&state.active?.index!==i)return '';
    const [tone,status]=badge(d,i),done=completed(d);
    return `<tr><td>${isPomelo?`<input class="choose" type="checkbox" data-index="${i}" aria-label="Select ${esc(d.name)}" ${d.selected?'checked':''} ${canSend(d)?'':'disabled'}>`:''}</td><td class="dish"><div class="name">${esc(d.name)}</div><div class="meal-line"><span class="meal">${esc(d.targetMeal)}</span><details><summary>Ingredients</summary><div class="ingredients">${esc(d.ingredients)}</div></details></div>${!done?`<span class="pill ${tone}">${esc(status)}</span>`:''}</td><td class="number kcal">${d.kcal}</td><td class="number">${d.protein}</td><td class="number">${d.carbs}</td><td class="number">${d.fat}</td><td class="action">${isPomelo?`<button class="send ${done?'added':''}" data-index="${i}" ${canSend(d)?'':'disabled'}>${done?'✓ Added':'Send to Fitatu'}</button>`:`<span class="pill ${tone}">${done?'✓ Added':esc(d.status==='error'?'Paused':'Automatic')}</span>`}</td></tr>`;
  }
  const headerCss=`header.panel-header{display:block;padding:8px 10px;overflow-x:auto}.header-line{display:flex;align-items:center;gap:10px;white-space:nowrap;min-width:max-content}.header-line .brand{gap:6px;flex-shrink:0}.header-line .logo{width:18px;height:18px;border-radius:5px;font-size:13px}.header-line h2{font-size:11px;line-height:20px;white-space:nowrap}.header-line .version{font-size:9px;margin-left:3px}.header-actions{display:flex;align-items:center;gap:6px;margin-left:auto}.collapse-toggle{display:flex;align-items:center;gap:4px;border:1px solid #49606f;background:#253d4b;color:#dbe8ef;border-radius:6px;font-size:10px;padding:5px 7px;line-height:1.2}.day-date{font-size:11px;font-weight:650;white-space:nowrap}.meal-count{font-size:10px;color:#9bb4c5;line-height:1.4;white-space:nowrap}.meal-count.complete{color:#b4edd0;font-weight:600}.complete-check{display:inline-grid;place-items:center;width:13px;height:13px;border-radius:50%;background:#1c5b40;color:#b7f1d0;font-size:10px;margin-right:3px}.header-actions button{font-size:10px;padding:6px 8px}.header-actions .load{background:#2b4353;color:#e1edf5}.send:not(.added),#send-selected{background:#f2c75d;color:#33260a}.message{padding-top:9px}.nutrition-check{padding:8px 12px;font-size:10px;border-top:1px solid #324b58}.nutrition-check.matched{color:#afe7c6}.nutrition-check.blocked{color:#ffc7a3;background:#39291e}.nutrition-check div{margin-top:3px}input:disabled{opacity:.35;filter:grayscale(1);cursor:not-allowed}.totals-row td,.totals-row th{position:sticky;top:auto;bottom:0;z-index:2;border-top:1px solid #587081;background:#1b303e;padding:10px 7px;font-weight:700;font-size:11px;text-transform:none;letter-spacing:0}.totals-row .total-label{text-align:left;color:#d8e7f1}.mini{width:auto;min-width:0;border-radius:12px;overflow:hidden}.mini-toggle{display:flex;align-items:center;gap:7px;background:#19333e;color:#c1f2d8;padding:8px 10px;font-size:11px;line-height:16px;border-radius:11px;white-space:nowrap}.mini-monogram{font-size:10px;font-weight:750;letter-spacing:.3px}.mini-date{font-size:11px;font-weight:650}.mini-count{font-size:10px}.mini-toggle:hover{background:#214655}`;
  const REVERSE_KEY='pomelo-fitatu-reverse-v1';
  let reverseCache={};try{reverseCache=JSON.parse(sessionStorage.getItem(REVERSE_KEY)||'{}');}catch{}
  let reverseView={date:null,status:'unknown',matched:0,total:0},reverseJob=null,reverseEpoch=0;
  const fitatuDate=()=>location.pathname.match(/^\/app\/planner\/(\d{4}-\d{2}-\d{2})(?:\/|$)/)?.[1]||null;
  const menuSignature=menu=>JSON.stringify([menu.menuToken,menu.items.map(d=>[norm(d.name),MAP[d.sourceMeal]||d.targetMeal])]);
  function reverseMatch(d){
    const section=sectionFor(MAP[d.sourceMeal]||d.targetMeal);if(!section)return false;
    const expected=norm(d.name).toLocaleLowerCase('pl');
    return all('a,span,div,p,li',section).some(e=>{
      const value=text(e).toLocaleLowerCase('pl');
      return value===expected||value===expected+' (pomelo)'||value.startsWith(expected+' (pomelo) ')||new RegExp('^'+expected.replace(/[.*+?^${}()|[\]\\]/g,'\\  function render(){')+'\\s+1\\s*×\\s*(package|opakowanie)\\b','i').test(value);
    });
  }
  function renderFitatuSummary(){
    if(workerRunning(state)&&state.date){delete reverseCache[state.date];sessionStorage.setItem(REVERSE_KEY,JSON.stringify(reverseCache));}
    const date=fitatuDate(),working=workerRunning(state)&&(!date||state.date===date),r=reverseView;
    const complete=!working&&r.date===date&&r.status==='complete'&&r.total===5&&r.matched===5;
    const label=working?'Importing…':!date?'Open a diary day':r.date!==date||r.status==='checking'?'Checking…':r.status==='unknown'?'Pomelo not loaded':r.status==='error'?'Check failed':`${r.matched}/${r.total} meals match`;
    const detail=working?(state.error||state.active?.phase||state.notice||'Import in progress'):r.status==='unknown'?'Open this date in Pomelo to load its meals.':r.status==='error'?r.error:complete?'All five Pomelo meals are in their matching Fitatu meals.':'Compared by dish name and mapped meal. Refresh to check again.';
    host.style.width='auto';
    shadow.innerHTML=`<style>${css}${headerCss}.fitatu-mini{max-width:calc(100vw - 28px)}.fitatu-summary{display:flex;align-items:center;gap:7px;padding:8px 10px;flex-wrap:wrap;color:#bdd2e0}.fitatu-summary .status{font-size:10px;color:${complete?'#b4edd0':'#b8c9d7'}}.fitatu-summary button{padding:4px 7px;font-size:10px;background:#294554;color:#dbeaf2}.fitatu-error{max-width:330px;padding:0 10px 8px;color:#ffc3b9;font-size:10px}</style><aside class="mini fitatu-mini"><div class="fitatu-summary" title="${esc(detail)}"><span class="mini-monogram">P → F</span><span class="mini-date">${esc(date||state.date||'—')}</span><span class="status" role="status">${complete?'<span class="complete-check" aria-label="All five meals match Pomelo">✓</span>':''}${esc(label)}</span>${date&&!working?`<button id="reverse-refresh" aria-label="Refresh Pomelo comparison" ${r.date===date&&r.status==='checking'?'disabled':''}>Refresh</button>`:''}${working?`<button id="check" ${busy?'disabled':''}>Check and resume</button><button id="cancel" ${busy?'disabled':''}>Stop</button>`:''}</div>${working&&state.error?`<div class="fitatu-error">${esc(state.error)}</div>`:''}</aside>`;
    shadow.getElementById('reverse-refresh')?.addEventListener('click',()=>refreshFitatuSummary(true));
    shadow.getElementById('check')?.addEventListener('click',()=>guard(async()=>{await resume();if(!state.active)await runQueue();}));
    shadow.getElementById('cancel')?.addEventListener('click',()=>guard(async()=>{if(confirm('Stop this import? Products already saved will remain in Fitatu.')){state.active=null;if(state.transfer){state.transfer.running=false;state.transfer.cancelled=true;}state.error='';state.notice='Stopped.';await save();}}));
  }
  async function refreshFitatuSummary(force=false){
    if(isPomelo)return;
    const date=fitatuDate();
    if(reverseView.date!==date){reverseEpoch++;reverseView={date,status:'checking',matched:0,total:0};render();}
    if(!date){if(reverseView.date){reverseEpoch++;reverseView={date:null,status:'unknown',matched:0,total:0};render();}return;}
    if(workerRunning(state)){render();return;}
    const snapshot=await GM.getValue(dayKey(date),null);
    if(fitatuDate()!==date)return;
    const menu=snapshot?.items?.length===5?snapshot:state.date===date&&state.items.length===5&&state.readComplete!==false?state:null;
    if(!menu){
      if(reverseView.date!==date||reverseView.status!=='unknown'){reverseEpoch++;reverseView={date,status:'unknown',matched:0,total:0};render();}return;
    }
    const signature=menuSignature(menu),key=date+'|'+signature;
    if(force){delete reverseCache[date];reverseEpoch++;}
    if(!force&&reverseCache[date]?.signature===signature){reverseView={...reverseCache[date],date};render();return;}
    if(reverseJob?.key===key&&reverseJob.epoch===reverseEpoch)return;
    if(!force&&reverseView.date===date&&reverseView.signature===signature&&reverseView.status==='error')return;
    const epoch=++reverseEpoch;reverseJob={key,epoch};reverseView={date,signature,status:'checking',total:5,matched:0};render();
    try{
      await until(()=>{if(fitatuDate()!==date||epoch!==reverseEpoch)throw Error('Selected day changed');return all('section.planner-section h2').length>=5&&!all('section.planner-section h2').some(h=>norm(h.textContent)==='...');},'Fitatu meal list',25000);
      // Let a route change finish rendering before reading its meal sections.
      await pause(250);
      if(fitatuDate()!==date||epoch!==reverseEpoch)return;
      if(/An error occurred while retrieving|Wystąpił błąd/.test(text()))throw Error('Fitatu could not load this day');
      for(const section of all('section.planner-section')){
        if(fitatuDate()!==date||epoch!==reverseEpoch)return;
        if(section.classList.contains('planner-section--filled')&&!section.classList.contains('planner-section--expanded')){all('h2',section)[0]?.click();await pause(150);}
      }
      if(fitatuDate()!==date||epoch!==reverseEpoch)return;
      const matches=menu.items.map(reverseMatch);
      reverseView={date,signature,status:'complete',total:5,matched:matches.filter(Boolean).length,checkedAt:Date.now()};
      cc.record('fitatu',null,'connected','Diary comparison completed; identity unavailable');
      reverseCache[date]=reverseView;sessionStorage.setItem(REVERSE_KEY,JSON.stringify(reverseCache));render();
    }catch(e){if(fitatuDate()===date&&epoch===reverseEpoch){reverseView={date,signature,status:'error',total:5,matched:0,error:e.message};render();}}
    finally{if(reverseJob?.epoch===epoch)reverseJob=null;}
  }

  function render(){
    if(!isPomelo){renderFitatuSummary();return;}
    const nutrition=totalsCheck();
    const count=state.items.filter(completed).length,selected=state.items.filter(d=>d.selected&&!completed(d)).length;
    const active=!!state.active||!!state.transfer?.running,allAdded=state.items.length===5&&count===5&&checked();
    const subtitle=state.items.length?`${state.items.length} meals${checked()?' · '+count+' added':state.scan?.status==='pending'?' · checking':busy?' · loading':''}${state.items.length===5&&!nutrition.ok?' · totals blocked':''}`:(state.autoSkipped?'Menu not selected · Refresh to load':state.error?'0 meals':isPomelo?'0 meals · loading':'0 meals');
    const tick=allAdded?'<span class="complete-check" aria-label="All meals added">✓</span>':'';
    host.style.width=minimized?'auto':'';
    if(minimized){
      shadow.innerHTML=`<style>${css}${headerCss}</style><aside class="mini"><button id="toggle" class="mini-toggle" aria-label="Open Pomelo to Fitatu panel" title="Open Pomelo → Fitatu"><span class="mini-monogram">P → F</span><span class="mini-date">${esc(state.date||'—')}</span><span class="mini-count">${tick}${subtitle}</span><span aria-hidden="true">▴</span></button></aside>`;
      shadow.getElementById('toggle').onclick=()=>{minimized=false;render();};return;
    }
    const available=state.items.filter(d=>!completed(d)),visibleItems=state.items.filter((d,i)=>isPomelo||d.queued||state.active?.index===i),rows=state.items.map(dishRow).join('');
    shadow.innerHTML=`<style>${css}${headerCss}.meal-line{display:flex;align-items:baseline;gap:9px;margin-top:3px}.meal-line .meal{margin:0;white-space:nowrap}.meal-line summary{margin-top:0;white-space:nowrap}.meal-line details{min-width:0}.meal-line .ingredients{margin-top:6px}</style><aside><header class="panel-header"><div class="header-line"><div class="brand"><span class="logo">↗</span><h2>Pomelo → Fitatu <span class="version">v${VERSION}</span></h2></div><span class="day-date">${esc(state.date||'Your daily menu')}</span><span class="meal-count ${allAdded?'complete':''}">${tick}${subtitle}</span><div class="header-actions">${isPomelo?`<button id="read" class="load" ${busy||active||otherImportDate?'disabled':''}>${busy?'Loading…':'Refresh'}</button>`:''}<button id="toggle" class="collapse-toggle" aria-label="Minimize panel" title="Minimize panel"><span aria-hidden="true">▾</span> Minimize</button></div></div></header>${totalsNotice(nutrition)}${state.error?`<div class="message error">${esc(state.error)}</div>`:otherImportDate?`<div class="message">Import running for ${esc(otherImportDate)}.</div>`:state.notice?`<div class="message">${esc(state.notice)}</div>`:''}${rows?`<div class="scroll"><table><thead><tr><th>${isPomelo?'<input type="checkbox" id="select-all" aria-label="Select all available dishes" '+(!available.length||!nutrition.ok||!checked()||busy||active||otherImportDate?'disabled':'')+' '+(available.length&&available.every(d=>d.selected)?'checked':'')+'>':''}</th><th class="dish-head"><button id="send-selected" ${!selected||!nutrition.ok||!checked()||busy||active||otherImportDate?'disabled':''}>Send selected${selected?' ('+selected+')':''}</button></th><th>kcal</th><th title="Protein in grams">Protein</th><th title="Carbohydrates in grams">Carbs</th><th title="Fat in grams">Fat</th><th></th></tr></thead><tbody>${rows}</tbody>${totalsRow(visibleItems)}</table></div>`:`<div class="empty">${isPomelo?'Meals load automatically for the selected day.':'Send meals from Pomelo to start the automatic import.'}</div>`}${active?`<div class="footer"><span></span><div>${!isPomelo&&state.active?.owner===owner?`<button id="check" class="secondary" ${busy?'disabled':''}>Check and resume</button>`:''}<button id="cancel" class="secondary" ${busy?'disabled':''}>Stop</button></div></div>`:''}</aside>`;
    shadow.getElementById('toggle').onclick=()=>{minimized=true;render();};
    shadow.getElementById('read')?.addEventListener('click',()=>guard(readDay));
    shadow.querySelectorAll('.choose').forEach(b=>b.onchange=()=>{state.items[Number(b.dataset.index)].selected=b.checked;save();});
    shadow.querySelectorAll('.send').forEach(b=>b.onclick=()=>guard(()=>sendDishes([Number(b.dataset.index)])));
    shadow.getElementById('send-selected')?.addEventListener('click',()=>guard(()=>sendDishes(state.items.flatMap((d,i)=>d.selected?[i]:[]))));
    const selectAll=shadow.getElementById('select-all');if(selectAll)selectAll.indeterminate=!!selected&&selected<available.length;
    selectAll?.addEventListener('change',e=>{state.items.forEach(d=>{if(!completed(d))d.selected=e.target.checked;});save();});
    shadow.getElementById('check')?.addEventListener('click',()=>guard(async()=>{await resume();if(!state.active)await runQueue();}));
    shadow.getElementById('cancel')?.addEventListener('click',()=>guard(async()=>{
      if(confirm('Stop this import? Products already saved will remain in Fitatu.')){state.active=null;if(state.transfer){state.transfer.running=false;state.transfer.cancelled=true;}state.error='';state.notice='Stopped. Refresh to recheck this day.';await save();}
    }));
  }
  async function closeScanTab(){if(isPomelo&&scanTab&&state.scan?.status!=='pending'){try{scanTab.close?.();}catch{}scanTab=null;}}
  async function save(){await GM.setValue(STORE,state);await cacheDay(state);render();}
  async function guard(action) {
    if(busy)return;busy=true;state.error='';render();
    try{await action();}catch(e){cc.record(ccService,null,'failed','Operation paused; check service page');state.error=e.message;state.notice='Paused. Check the page before continuing.';await save();}
    finally{busy=false;const latest=await GM.getValue(STORE,state);if(!isPomelo||latest.date===pomeloDate())state=latest;render();await closeScanTab();if(isPomelo&&pomeloDate()!==viewDate){await activatePomeloDay();await autoCheckSelectedDay();}}
  }
  async function phase(value){state.active.phase=value;await save();}
  const current=()=>state.items[state.active.index];
  function dialogFor(name){return all('[role="dialog"]').find(e=>all('h2',e).some(h=>norm(h.textContent)===name));}
  async function closeDish(dialog,name){
    const buttons=all('button',dialog);
    const close=buttons.find(b=>/close|zamknij/i.test([b.getAttribute('aria-label'),b.title,norm(b.textContent)].join(' ')))
      ||all('header button,[role="banner"] button',dialog)[0]
      ||buttons.find(b=>!b.disabled&&!norm(b.textContent));
    if(close)close.click();
    else (document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
    // Pomelo keeps empty dialog portals mounted after closing. The dish heading,
    // rather than the portal's bounding box, determines whether details closed.
    await until(()=>!dialogFor(name),'close dish details',6000);
  }
  async function sendDishes(indices){
    await ensureDayContext();
    requireMatchingTotals();
    if(state.active)throw Error('Finish or stop the active Fitatu product before sending more dishes.');
    if(!checked())throw Error('Check this day in Fitatu before sending.');
    const chosen=[...new Set(indices)].filter(i=>state.items[i]&&!completed(state.items[i]));
    if(!chosen.length)throw Error('Select at least one dish to send.');
    const token=crypto.randomUUID();
    chosen.forEach(i=>{state.items[i].queued=true;state.items[i].selected=false;});
    state.transfer={token,indices:chosen,date:state.date,running:true};state.error='';state.notice=`Sending ${chosen.length} dish${chosen.length===1?'':'es'} to Fitatu…`;
    await save();
    await GM.openInTab(`https://www.fitatu.com/app/planner/${state.date}?pomelo-import=${token}`,{active:true,insert:true,setParent:true});
  }
  function selectedEntries(){
    const paragraphs=all('main p').map(p=>norm(p.textContent)),meals=Object.keys(MAP),editable=[];
    for(const sourceMeal of meals){const i=paragraphs.indexOf(sourceMeal),name=paragraphs[i+1];if(i<0||!name||MAP[name])break;editable.push({sourceMeal,name,targetMeal:MAP[sourceMeal]});}
    if(editable.length===meals.length)return editable;
    const locked=[];
    for(const sourceMeal of meals){
      const heading=all('h2,h3,h4').find(h=>norm(h.textContent)===sourceMeal);
      if(!heading)return null;
      // Locked-day cards use h3 + product-tile-v2 rather than editable p/name pairs.
      const wrapper=heading.parentElement;
      const tile=all('.product-tile-v2',wrapper)[0];
      const image=tile&&all('img[alt]',tile).find(img=>norm(img.alt));
      const name=image&&norm(image.alt);
      if(!name)return null;
      locked.push({sourceMeal,name,targetMeal:MAP[sourceMeal],locked:true});
    }
    return locked.length===meals.length?locked:null;
  }
  function pomeloDayReady(date){
    if(pomeloDate()!==date||/Trwa wczytywanie danych/i.test(text()))return false;
    const tiles=all('[data-date][data-cy*="day-tile"]');
    if(tiles.length){
      const explicit=tiles.find(e=>e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-current')==='date'||e.getAttribute('data-selected')==='true');
      if(explicit)return explicit.getAttribute('data-date')===date;
      // Pomelo marks the selected calendar tile by making it taller. Do not
      // confuse Swiper's active slide (the viewport anchor) with the selection.
      const heights=tiles.map(e=>({e,height:e.getBoundingClientRect().height})).sort((a,b)=>b.height-a.height);
      if(heights.length>1&&heights[0].height>heights[1].height+4)return heights[0].e.getAttribute('data-date')===date;
      return tiles.some(e=>e.getAttribute('data-date')===date);
    }
    // Older layouts have no calendar date attributes. The dish modal below
    // must still confirm the actual menu date before anything is stored.
    return text().includes(date.split('-').reverse().join('-'));
  }
  const NUTRIENTS=[['kcal','Kcal'],['protein','Protein'],['carbs','Carbs'],['fat','Fat']];
  function parseMenuTotals(raw){
    const labels={kcal:'Kalorie',protein:'Białko',carbs:'(?:Węglowodany|Węgl\\.)',fat:'Tłuszcze'},result={};
    for(const [key] of NUTRIENTS){
      const unit=key==='kcal'?'kcal':'g';
      const match=norm(raw).match(new RegExp(labels[key]+'\\s+([0-9]+(?:[ \\u00a0\\u202f][0-9]{3})*(?:[.,][0-9]+)?)\\s*'+unit+'\\b','i'));
      if(!match)return null;
      const token=match[1].replace(/\s/g,'').replace(',','.');
      const value=Number(token),decimals=token.includes('.')?token.split('.')[1].length:0;
      if(!Number.isFinite(value)||value<0||decimals>4)return null;
      result[key]={value,decimals};
    }
    return result;
  }
  function readMenuTotals(){
    const heading=all('h2,h3,h4').find(e=>norm(e.textContent)==='Wartości odżywcze menu');
    for(let root=heading?.parentElement;root&&root!==document.body;root=root.parentElement){
      if(root.querySelectorAll('[data-cy="CircleDiagram_div"]').length===4){
        const cards=all('[data-cy="CircleDiagram_div"]',root);
        if(cards.length!==4)return null;
        // Read the four labelled summary cards, excluding chart percentages,
        // dish cards, extras and unrelated page totals.
        return parseMenuTotals(cards.map(card=>text(card)).join(' '));
      }
    }
    return null;
  }
  function roundedUnits(value,decimals){return Math.round((value+Number.EPSILON*Math.max(1,Math.abs(value)))*10**decimals);}
  function compareMenuTotals(items,source,date){
    if(items?.length!==5||items.some(d=>d.date!==date||NUTRIENTS.some(([key])=>!Number.isFinite(d[key])||d[key]<0)))return {ok:false,reason:'Load all five meals to verify totals.',differences:[]};
    if(!source||NUTRIENTS.some(([key])=>!source[key]||!Number.isFinite(source[key].value)||source[key].value<0||!Number.isInteger(source[key].decimals)||source[key].decimals<0||source[key].decimals>4))return {ok:false,reason:'Pomelo menu totals could not be read. Use Refresh.',differences:[]};
    const sum=totals(items),differences=[];
    for(const [key,label] of NUTRIENTS){
      const {value,decimals}=source[key],site=roundedUnits(value,decimals),list=roundedUnits(sum[key],decimals);
      // Allow one least-significant displayed unit in either direction.
      // The site may round its unrounded recipe total differently from the
      // sum of the already-rounded individual dish values (e.g. 197.2/197.3).
      if(Math.abs(site-list)>1)differences.push({key,label,site:(site/10**decimals).toFixed(decimals),list:(list/10**decimals).toFixed(decimals),unit:key==='kcal'?'kcal':'g'});
    }
    return {ok:!differences.length,reason:differences.length?'Menu totals differ beyond rounding tolerance. Sending is blocked.':'Menu totals match Pomelo (rounding tolerance).',differences};
  }
  function totalsCheck(value=state){
    if(isPomelo){
      if(!pomeloDayReady(value.date))return {ok:false,reason:'Wait for the selected Pomelo day.',differences:[]};
      return compareMenuTotals(value.items,readMenuTotals(),value.date);
    }
    const proof=value.menuTotals;
    return compareMenuTotals(value.items,proof?.date===value.date&&proof?.menuToken===value.menuToken?proof.source:null,value.date);
  }
  function requireMatchingTotals(){
    const check=totalsCheck();
    if(!check.ok)throw Error(check.reason+(check.differences.length?' '+check.differences.map(d=>`${d.label}: Pomelo ${d.site}, list ${d.list} ${d.unit}`).join('; '):''));
    if(isPomelo)state.menuTotals={date:state.date,menuToken:state.menuToken,source:readMenuTotals()};
  }
  function totalsNotice(check){
    if(!state.items.length)return '';
    return `<div class="nutrition-check ${check.ok?'matched':'blocked'}" role="status">${check.ok?'✓':'!'} ${esc(check.reason)}${check.differences.length?`<div>${check.differences.map(d=>`${esc(d.label)}: Pomelo <b>${d.site}</b> · list <b>${d.list}</b> ${d.unit}`).join(' · ')}</div><div>Use Refresh to reload the menu.</div>`:''}</div>`;
  }
  function pomeloMenuChosen(date){
    const tile=all('[data-date][data-cy*="day-tile"]').find(e=>e.getAttribute('data-date')===date);
    if(tile){
      if(tile.querySelector('[data-testid="IconForkSpoonOutline"]')||/Wybierz menu/i.test([tile.title,tile.getAttribute('aria-label'),text(tile)].join(' ')))return false;
      if(tile.querySelector('[data-testid="IconCheckCircleOutline"]')||/Menu zostało wybrane/i.test([tile.title,tile.getAttribute('aria-label'),text(tile)].join(' ')))return true;
      // Locked historical menus do not always display a selection tick.
      if(pomeloDayReady(date)&&selectedEntries()?.every(d=>d.locked))return true;
      return null;
    }
    return null;
  }

  function totals(items){
    const result={};
    for(const key of ['kcal','protein','carbs','fat'])result[key]=items.reduce((sum,d)=>sum+Math.round(Number(d[key]||0)*100),0)/100;
    return result;
  }
  const formatTotal=value=>Number(value.toFixed(2)).toString();
  function totalsRow(items){
    const sum=totals(items);
    return `<tfoot><tr class="totals-row"><td></td><th scope="row" class="total-label">Total</th><td class="number kcal">${formatTotal(sum.kcal)}</td><td class="number">${formatTotal(sum.protein)}</td><td class="number">${formatTotal(sum.carbs)}</td><td class="number">${formatTotal(sum.fat)}</td><td></td></tr></tfoot>`;
  }
  async function readDay() {
    cc.observe('pomelo',null);
    await ensureDayContext();
    if(state.active||state.transfer?.running)throw Error('Wait for the current Fitatu import to finish.');
    const match=location.pathname.match(/\/details\/(\d{4}-\d{2}-\d{2})\//);
    if(!match)throw Error('Open a Pomelo order day first.');
    const date=match[1];state.autoSkipped=false;
    if(all('[role="dialog"]').some(d=>all('h2',d).length))throw Error('Close the open dish details, then read the day again.');
    const entries=await until(()=>{if(pomeloDate()!==date)throw Error('The selected day changed.');return pomeloDayReady(date)&&selectedEntries();},'selected Pomelo meals',22000);
    const menuToken=crypto.randomUUID(),items=[];
    for(const entry of entries){
      if(pomeloDate()!==date)throw Error('The selected day changed. Import was stopped.');
      state.notice='Reading '+entry.sourceMeal+'…';render();
      const title=exactText(entry.sourceMeal);title?.scrollIntoView({block:'center'});
      const findImage=()=>all('img').find(e=>norm(e.alt)===norm(entry.name));
      let image=findImage();
      if(!image){title?.click();await pause(200);title?.scrollIntoView({block:'center'});image=await until(findImage,'selected dish image: '+entry.sourceMeal,22000);}
      image.scrollIntoView({block:'center'});
      image.click();
      const dialog=await until(()=>dialogFor(entry.name),'dish details');
      if(!/Białko\s+[\d.,]+\s*g/.test(dialog.innerText)){clickText(['Wartości odżywcze'],dialog);await until(()=>/Białko\s+[\d.,]+\s*g/.test(dialog.innerText),'precise nutrition');}
      if(!/Skład\s+\S[\s\S]*Wartości odżywcze/.test(dialog.innerText)){clickText(['Skład'],dialog);await pause(150);}
      let dish;try{dish=parseDish(dialog.innerText,entry.name,entry.sourceMeal,date);}finally{await closeDish(dialog,entry.name);}
      if(pomeloDate()!==date)throw Error('The selected day changed. Import was stopped.');
      items.push(dish);
      state={date,menuToken,checkSession:checkSessionId,items:[...items],readComplete:false,active:null,scan:null,notice:`Imported ${items.length} of ${entries.length} dishes…`,error:''};await save();
    }
    if(pomeloDate()!==date)throw Error('The selected day changed. Import was stopped.');
    state={date,menuToken,checkSession:checkSessionId,items,menuTotals:{date,menuToken,source:readMenuTotals()},readComplete:true,active:null,scan:null,notice:'Checking Fitatu…',error:''};await save();
    await requestScan();
  }
  function sectionFor(target){return all('section.planner-section').find(s=>all('h2',s).some(h=>norm(h.textContent).toLocaleLowerCase('pl')===norm(target).toLocaleLowerCase('pl')));}
  async function plannerReady(d){
    if(location.pathname!=='/app/planner/'+d.date){location.assign('https://www.fitatu.com/app/planner/'+d.date);return false;}
    await until(()=>sectionFor(d.targetMeal),'meal list');
    if(/An error occurred while retrieving|Wystąpił błąd/.test(text()))throw Error('Fitatu could not load this day. Reopen it before continuing.');
    return true;
  }
  async function prepare(index){
    state=await GM.getValue(STORE,state);registry=await GM.getValue(REGISTRY,{});
    if(state.active)throw Error('Another product is being prepared.');
    requireMatchingTotals();
    const d=state.items[index];if(!d)throw Error('Menu is missing');d.targetMeal=MAP[d.sourceMeal]||d.targetMeal;
    state.active={index,owner,phase:'prepare',productId:null};state.notice='Opening '+d.targetMeal;await save();
    await prepareOnPlanner();
  }
  async function prepareOnPlanner(){
    requireMatchingTotals();
    const d=current();if(!await plannerReady(d))return;
    await expandPlanner();const section=sectionFor(d.targetMeal),presentMeal=findInDiary(d);
    if(presentMeal){
      d.status='already present';d.presence={found:true,meal:presentMeal,date:d.date,checkedAt:Date.now()};state.active=null;state.notice='';await save();return;
    }
    const add=section.querySelector('.planner-section__add-btn');if(!add)throw Error('Cannot find the meal’s add button');
    add.click();await until(()=>location.pathname==='/app/search'&&all('input[type="text"],input:not([type])').length,'product search');
    const params=new URLSearchParams(location.search);
    if(params.get('date')!==d.date||!params.get('meal'))throw Error('Fitatu opened a different date');
    state.active.meal=params.get('meal');await save();
    clickText(['Own','Własne']);
    const search=all('input').find(e=>e.type==='text'||e.type==='search');if(!search)throw Error('Search field missing');
    setField(search,d.name);await pause(1800);
    const existing=all('p,span,div').filter(e=>!e.children.length&&norm(e.textContent)===`${d.name} (Pomelo)`)[0]
      ||all('p,span,div').filter(e=>norm(e.textContent).startsWith(`${d.name} (Pomelo)`)&&!Array.from(e.children).some(c=>norm(c.textContent).startsWith(`${d.name} (Pomelo)`)))[0];
    const record=registry[fingerprint(d)];
    if(existing){
      if(!record?.id)throw Error('An existing own product has this name. Review it manually; the script will not create a duplicate.');
      existing.click();await until(()=>location.pathname.includes('/product/'),'saved product');
      const id=location.pathname.match(/\/product\/(\d+)/)?.[1];if(id!==record.id)throw Error('A different same-name product opened');
      state.active.productId=id;state.active.existing=true;await phase('saving existing product');await commitProduct();return;
    }
    if(record?.id)throw Error('A previously saved product was not found. Check Own products manually.');
    clickText(['New product','Nowy produkt']);
    await until(()=>location.pathname.includes('/new-product/')&&all('input[type="number"]').length===9,'new product form');
    await fillProduct(d);await phase('saving product');await commitProduct();
  }
  function fields(){return all('input[type="number"]');}
  function textFields(){return all('input').filter(e=>e.type==='text'||!e.type);}
  function verifyForm(d){
    const nums=fields(),strings=textFields();
    if(nums.length!==9||strings.length!==2)throw Error('Fitatu’s form layout changed');
    if(strings[0].value!==d.name||strings[1].value!=='Pomelo')throw Error('Name or brand differs from Pomelo');
    for(const [i,v] of [[0,d.kcal],[1,d.kcal],[2,d.fat],[4,d.carbs],[7,d.protein]])if(nums[i].value===''||Math.abs(Number(nums[i].value)-v)>0.00001)throw Error('A nutrition field differs. Saving was stopped.');
    const button=all('button').find(e=>/^(package|opakowanie)$/i.test(norm(e.textContent)));
    if(!button?.className.includes('--selected'))throw Error('Select package / opakowanie first');
  }
  async function fillProduct(d){
    const strings=textFields();if(strings.length!==2||fields().length!==9)throw Error('Unexpected Fitatu product form');
    setField(strings[0],d.name);setField(strings[1],'Pomelo');clickText(['package','opakowanie']);await pause(100);
    const nums=fields();
    for(const [i,value] of [[0,d.kcal],[1,d.kcal],[2,d.fat],[4,d.carbs],[7,d.protein]]){setField(nums[i],value);await pause(40);}
    verifyForm(d);
  }
  async function commitProduct(){
    requireMatchingTotals();
    if(state.active?.owner!==owner)throw Error('This tab does not own the import');
    const d=current();
    if(!state.active.existing){
      if(location.pathname!==`/app/new-product/${state.active.meal}/${d.date}`)throw Error('The product form date or meal changed. Stop and prepare it again.');
      verifyForm(d);await phase('saving product');
      const button=saveButtons()[0];if(!button)throw Error('Save button missing');button.click();
      await until(()=>location.pathname.includes('/product/'),'product save');
      await rememberProduct();
    }
    await metadataAndAdd();
  }
  async function rememberProduct(){
    const id=location.pathname.match(/\/product\/(\d+)/)?.[1];
    await until(()=>all('p').some(e=>norm(e.textContent)===`${current().name} (Pomelo)`),'saved product name');
    if(!id)throw Error('Cannot confirm the saved product ID');
    state.active.productId=id;registry[fingerprint(current())]={id};await GM.setValue(REGISTRY,registry);await phase('ingredients');
  }
  async function metadataAndAdd(){
    requireMatchingTotals();
    const d=current(),id=state.active.productId;
    if(!id||location.pathname!==`/app/search-item/${d.date}/${state.active.meal}/product/${id}`)throw Error('The saved product, date or meal changed. Open the original product before continuing.');
    await until(()=>all('button').some(e=>/^(Edit|Edytuj)$/i.test(norm(e.textContent))),'product details');
    const textarea=all('textarea')[0];
    if(textarea){
      await phase('ingredients');setField(textarea,d.ingredients);
      if(norm(textarea.value)!==norm(d.ingredients))throw Error('Ingredients were not accepted');
      const saveIngredient=saveButtons()[0];if(!saveIngredient)throw Error('Ingredient save button missing');
      await phase('saving ingredients');saveIngredient.click();
      await until(()=>!visible(textarea)&&text().includes(norm(d.ingredients)),'ingredient save');
    }else if(!text().includes(norm(d.ingredients)))throw Error('Saved ingredients differ. Review them manually.');
    const category=all('select').find(e=>Array.from(e.options).some(o=>/^(Ready meals|Dania gotowe)$/i.test(norm(o.textContent))));
    if(category){
      const option=Array.from(category.options).find(o=>/^(Ready meals|Dania gotowe)$/i.test(norm(o.textContent)));
      setField(category,option.value);await phase('saving category');
      const button=saveButtons()[0];if(!button)throw Error('Category save button missing');button.click();await until(()=>!visible(category),'category save');
    }
    const rows=all('.simple-measure').filter(row=>Array.from(row.querySelectorAll('.measure__text')).some(e=>/^(1× package|1× opakowanie)$/i.test(norm(e.textContent))));
    const row=rows.find(row=>{const value=Array.from(row.querySelectorAll('.measure__text')).map(e=>norm(e.textContent)).find(s=>/^[\d.,]+\s*g$/.test(s));return value&&Math.abs(Number(value.replace(/\s*g$/,'').replace(',','.'))-d.kcal)<=0.051;});
    const arrow=row?.querySelector('.measure__arrow-icon');if(!arrow)throw Error('Cannot find the correct one-package serving');
    await phase('adding package');arrow.click();
    await until(()=>location.pathname==='/app/planner/'+d.date,'diary confirmation');await verifyDiary();
  }
  async function verifyDiary(){
    const d=current();if(location.pathname!=='/app/planner/'+d.date)throw Error('Open the matching diary day to check the addition');
    const section=await until(()=>sectionFor(d.targetMeal),'target meal');
    if(section.classList.contains('planner-section--filled')&&!section.classList.contains('planner-section--expanded')){all('h2',section)[0].click();}
    await until(()=>text(section).includes(d.name),'saved diary entry');
    const matches=all('li,div,p',section).filter(e=>text(e).includes(d.name)&&/1\s*×\s*(package|opakowanie)/i.test(text(e))&&text(e).includes(Math.round(d.kcal)+' kcal'));
    if(!matches.length)throw Error('Diary entry differs from one package. Check it manually.');
    cc.record('fitatu',null,'success','Meal addition verified');
    d.status='done';d.presence={found:true,meal:d.targetMeal,date:d.date,checkedAt:Date.now()};state.active=null;state.notice='';state.error='';await save();
  }
  async function resume(){
    if(!state.active||state.active.owner!==owner)throw Error('This import belongs to another tab.');
    if(state.active.phase==='prepare')return prepareOnPlanner();
    if(state.active.phase==='review'||state.active.phase==='saving existing product')return commitProduct();
    if(state.active.phase==='saving product'){
      if(!location.pathname.includes('/product/'))throw Error('Product save is unconfirmed. Check Own products manually; do not save again blindly.');
      await rememberProduct();return metadataAndAdd();
    }
    if(state.active.phase==='adding package')return verifyDiary(); // read-only recovery; never repeat a possibly successful addition
    if(['ingredients','saving ingredients','saving category'].includes(state.active.phase))return metadataAndAdd();
    throw Error('Review this step manually. Stop the import before preparing it again.');
  }
  async function requestScan(){
    await ensureDayContext();
    if(!state.items.length){
      if(!isPomelo)return;
      const date=state.date;
      state.probeItems=await until(()=>{
        if(pomeloDate()!==date)return null;
        if(!pomeloDayReady(date))return null;
        const entries=selectedEntries();return entries&&entries.map(entry=>({...entry,date}));
      },'selected Pomelo day',18000);
      if(pomeloDate()!==date)return;
    }
    if(state.active||state.transfer?.running)throw Error('Wait for the current import to finish.');
    const token=crypto.randomUUID();
    state.scan={token,date:state.date,menuToken:state.menuToken,session:state.checkSession,status:'pending'};state.error='';state.notice='Checking this day in Fitatu…';await save();
    scanTab=await GM.openInTab(`https://www.fitatu.com/app/planner/${state.date}?pomelo-check=${token}`,{active:false,insert:true,setParent:true});
    setTimeout(async()=>{
      const latest=await GM.getValue(STORE,state);
      if(latest.scan?.token===token&&latest.scan.status==='pending'){
        latest.scan.status='error';latest.error='Fitatu check is taking too long. Sign in to Fitatu, then refresh Pomelo to retry.';await GM.setValue(STORE,latest);
        if(!busy){state=latest;render();await closeScanTab();}
      }
    },45000);
  }
  async function expandPlanner(){
    await until(()=>all('section.planner-section h2').length>=5&&!all('section.planner-section h2').some(h=>norm(h.textContent)==='...'),'Fitatu meal list',25000);
    if(/An error occurred while retrieving|Wystąpił błąd/.test(text()))throw Error('Fitatu could not load this day.');
    for(const section of all('section.planner-section')){
      if(section.classList.contains('planner-section--filled')&&!section.classList.contains('planner-section--expanded')){all('h2',section)[0]?.click();await pause(150);}
    }
  }
  function findInDiary(d){
    const name=norm(d.name).toLocaleLowerCase('pl');
    for(const section of all('section.planner-section')){
      if(text(section).toLocaleLowerCase('pl').includes(name))return norm(all('h2',section)[0]?.textContent)||d.targetMeal;
    }
    return null;
  }
  async function scanDiary(){
    state=await GM.getValue(STORE,state);
    const scan=state.scan;if(!scan||scan.status!=='pending'||state.active||state.transfer?.running)return;
    if(location.pathname!=='/app/planner/'+scan.date)return;
    try{
      await expandPlanner();
      const candidates=state.items.length?state.items:state.probeItems||[];
      if(!candidates.length)return;
      const findings=candidates.map(d=>findInDiary(d));
      const latest=await GM.getValue(STORE,state);
      if(latest.scan?.token!==scan.token||latest.scan.status!=='pending'||latest.menuToken!==scan.menuToken||latest.date!==scan.date||latest.active||latest.transfer?.running)return;
      const checkedAt=Date.now();
      latest.items.forEach((d,i)=>{
        const meal=findings[i];d.targetMeal=MAP[d.sourceMeal]||d.targetMeal;d.presence={found:!!meal,meal,date:scan.date,checkedAt};
        if(meal){d.status='already present';d.selected=false;}else d.status=d.queued?'queued':'ready';
      });
      latest.scan={...scan,status:'complete',checkedAt,probe:!latest.items.length,matched:findings.filter(Boolean).length};latest.error='';latest.notice='';
      state=latest;cc.record('fitatu',null,'connected','Selected diary checked; identity unavailable');await save();
    }catch(e){
      const latest=await GM.getValue(STORE,state);
      if(latest.scan?.token===scan.token){latest.scan.status='error';latest.error='Could not check Fitatu. Open this date there, then refresh Pomelo to retry.';state=latest;await save();}
    }
  }
  async function runQueue(){
    if(!state.transfer?.running||state.transfer.owner!==owner)return;
    while(state.transfer?.running&&state.transfer.owner===owner&&!state.active){
      const index=state.transfer.indices.find(i=>state.items[i]&&!['done','already present'].includes(state.items[i].status));
      if(index===undefined){state.transfer.running=false;state.transfer.completed=true;state.notice='';await save();return;}
      await prepare(index);
      if(state.active)return; // full-page navigation or an unresolved write
    }
  }
  async function startTransfer(){
    const token=new URLSearchParams(location.search).get('pomelo-import');
    state=await GM.getValue(STORE,state);
    if(!token||state.active||state.transfer?.token!==token||state.transfer.completed||state.transfer.cancelled)return;
    state.transfer.owner=owner;state.transfer.running=true;await save();await pause(150);
    state=await GM.getValue(STORE,state);if(state.transfer?.owner!==owner)return;
    await runQueue();
  }
  const dayKey=date=>DAY_PREFIX+date;
  const workerRunning=value=>!!value?.active||!!value?.transfer?.running;
  async function cacheDay(value){
    if(!value?.date||value.items?.length!==5||value.readComplete===false)return;
    await GM.setValue(dayKey(value.date),{date:value.date,readComplete:true,menuToken:value.menuToken,checkSession:value.checkSession,menuTotals:value.menuTotals,scan:value.scan?.status==='complete'?value.scan:null,items:value.items.map(d=>({...d,selected:false,queued:false}))});
  }
  function emptyDay(date){return {date,checkSession:checkSessionId,items:[],active:null,scan:null,transfer:null,menuToken:crypto.randomUUID(),notice:'',error:'',readComplete:false};}
  async function ensureDayContext(){
    const latest=await GM.getValue(STORE,state),date=isPomelo?pomeloDate():state.date;
    if(isPomelo&&(!date||state.date!==date))throw Error('The selected Pomelo day changed. Wait for the panel to update.');
    if(workerRunning(latest)&&latest.date!==date)throw Error('An import is running for '+latest.date+'. Wait for it to finish.');
    if(latest.date===date&&latest.menuToken===state.menuToken)state=latest;
    otherImportDate=workerRunning(latest)&&latest.date!==date?latest.date:null;
  }
  async function activatePomeloDay(force=false){
    if(!isPomelo||restoring)return;
    const date=pomeloDate();if(!date||(!force&&date===viewDate))return;
    restoring=true;
    try{
      const worker=await GM.getValue(STORE,state);await cacheDay(worker);
      viewDate=date;otherImportDate=workerRunning(worker)&&worker.date!==date?worker.date:null;
      if(worker.date===date&&workerRunning(worker)){state=worker;needsDayCheck=true;}
      else{
        const saved=await GM.getValue(dayKey(date),null);state=emptyDay(date);
        if(saved?.items?.length===5){
          const reusable=saved.checkSession===checkSessionId&&saved.scan?.status==='complete'&&saved.scan.date===date&&saved.scan.menuToken===saved.menuToken;
          state.items=saved.items.map(d=>({...d,targetMeal:MAP[d.sourceMeal]||d.targetMeal,status:reusable?d.status:'ready',presence:reusable?d.presence:null,selected:false,queued:false}));
          state.readComplete=true;state.menuTotals=saved.menuTotals;needsDayCheck=!reusable;
          if(reusable){state.menuToken=saved.menuToken;state.scan=saved.scan;}
        }else needsDayCheck=true;
      }
      render();await closeScanTab();
    }finally{restoring=false;}
  }
  async function autoCheckSelectedDay(){
    if(!isPomelo||!pomeloDate()||busy||restoring||otherImportDate||!needsDayCheck||workerRunning(state))return;
    needsDayCheck=false;
    await guard(async()=>{
      const date=state.date;
      const choice=await until(()=>{if(pomeloDate()!==date)throw Error('The selected day changed.');const chosen=pomeloMenuChosen(date);return chosen===null?null:{chosen};},'Pomelo menu selection indicator',18000);
      if(!choice.chosen){state={...emptyDay(date),autoSkipped:true,notice:'Menu not selected in Pomelo. Use Refresh to load the default meals.'};await save();return;}
      state.autoSkipped=false;
      if(!state.items.length)await readDay();else await requestScan();
    });
  }
  async function receiveState(value){
    await cacheDay(value);
    if(!isPomelo){state=value;render();await refreshFitatuSummary();if(state.scan?.status==='pending'&&location.pathname==='/app/planner/'+state.date&&!workerRunning(state))guard(scanDiary);return;}
    const date=pomeloDate();
    if(date!==viewDate){await activatePomeloDay();await autoCheckSelectedDay();return;}
    otherImportDate=workerRunning(value)&&value.date!==date?value.date:null;
    if(value.date===date)state=value;
    render();await closeScanTab();
    if(value.date===date&&state.scan?.status==='complete'&&state.scan.probe&&state.scan.matched>0&&!state.items.length&&!otherImportDate){needsDayCheck=false;await guard(readDay);return;}
    await autoCheckSelectedDay();
  }

  await cacheDay(state); // migrate the last complete pre-history menu once
  state.items.forEach(d=>{d.targetMeal=MAP[d.sourceMeal]||d.targetMeal;});
  if(isPomelo)await activatePomeloDay(true);
  render();routeReady=true;
  await GM.addValueChangeListener(STORE,(_key,_old,value,remote)=>{if(remote&&!busy)receiveState(value).catch(e=>{state.error=e.message;render();});});
  if(isPomelo)await autoCheckSelectedDay();
  else{
    await refreshFitatuSummary();
    if(state.active?.owner===owner&&state.active.phase==='prepare')await guard(async()=>{await prepareOnPlanner();if(!state.active)await runQueue();});
    else if(!workerRunning(state)&&state.scan?.status==='pending'&&location.pathname==='/app/planner/'+state.date&&!new URLSearchParams(location.search).has('pomelo-import')){
      await guard(scanDiary);
    }
    else await guard(startTransfer);
  }
})();
})();
