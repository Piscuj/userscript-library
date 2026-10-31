// ==UserScript==
// @name         Intervals.icu Liftosaur Details
// @namespace    piscuj.intervals.liftosaur-details
// @version      0.8.1
// @description  Liftosaur sets in Intervals.icu with workout volume and volume-weighted RPE sync.
// @match        https://intervals.icu/*
// @match        https://www.intervals.icu/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      www.liftosaur.com
// @run-at       document-idle
// @noframes
// @license      MIT
// @updateURL    https://piscuj.github.io/userscript-library/scripts/intervals-liftosaur-details/script.meta.js
// @downloadURL  https://piscuj.github.io/userscript-library/scripts/intervals-liftosaur-details/script.user.js
// @match        https://piscuj.github.io/userscript-library/*
// @grant        GM_info
// @grant GM.openInTab
// @sandbox JavaScript
// ==/UserScript==

(function(){
const Promise=(async()=>{})().constructor;
  function createBrowserLockStore(factory){
    let db=null,opening=null;
    function open(){
      if(db)return Promise.resolve();if(opening)return opening;
      opening=new Promise((resolve,reject)=>{
        if(!factory){reject(new Error('Browser coordination storage is unavailable.'));return;}
        let finished=false;const timer=setTimeout(()=>fail(new Error('Browser coordination storage timed out.')),10000);
        function fail(error){if(finished)return;finished=true;clearTimeout(timer);reject(error);}
        try{
          const request=factory.open('piscuj-liftosaur-coordination-v1',1);
          request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('leases'))request.result.createObjectStore('leases');};
          request.onerror=()=>{fail(request.error||new Error('Cannot open browser coordination storage.'));};
          request.onblocked=()=>{fail(new Error('Another tab blocked browser coordination storage.'));};
          request.onsuccess=()=>{
            if(finished){request.result.close();return;}
            finished=true;clearTimeout(timer);db=request.result;
            db.onversionchange=()=>{db.close();db=null;opening=null;};resolve();
          };
        }catch(error){fail(error);}
      }).catch(error=>{opening=null;throw error;});
      return opening;
    }
    return {async change(key,mutate){
      await open();
      return new Promise((resolve,reject)=>{
        try{
          const tx=db.transaction('leases','readwrite'),store=tx.objectStore('leases'),request=store.get(key);let result;
          request.onsuccess=()=>{
            try{
              const choice=mutate(request.result?JSON.parse(request.result):null);result=choice.result;
              if(choice.row===null)store.delete(key);
              else if(choice.row!==undefined)store.put(JSON.stringify(choice.row),key);
            }catch(error){reject(error);tx.abort();}
          };
          tx.oncomplete=()=>{resolve(result);};
          tx.onabort=tx.onerror=()=>{reject(tx.error||new Error('Browser coordination transaction failed.'));};
        }catch(error){reject(error);}
      });
    }};
  }
  function createLeaseLock({store,prefix='',now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),every=setInterval,cancel=clearInterval,leaseMs=120000,renewMs=20000,waitMs=150000}){
    let sequence=0;
    return async(key,job)=>{
      const name=prefix+key,owner=now()+':'+(++sequence)+':'+Math.random(),started=now();
      while(!await store.change(name,row=>!row||row.expires<=now()?{row:{owner,expires:now()+leaseMs},result:true}:{result:false})){
        if(now()-started>=waitMs)throw new Error('Another tab is still syncing. Retry in a moment.');
        await sleep(120);
      }
      let lost=null,renewing=false;
      const assertHeld=async()=>{
        if(lost)throw lost;
        const held=await store.change(name,row=>row?.owner===owner?{row:{owner,expires:now()+leaseMs},result:true}:{result:false});
        if(!held){lost=new Error('Sync ownership moved to another tab. Retry this activity.');throw lost;}
      };
      const timer=every(()=>{
        if(renewing)return;renewing=true;
        assertHeld().catch(error=>{lost=error;}).finally(()=>{renewing=false;});
      },renewMs);
      try{const value=await job(assertHeld);if(lost)throw lost;return value;}
      finally{
        cancel(timer);
        try{await store.change(name,row=>row?.owner===owner?{row:null,result:true}:{result:false});}catch{}
      }
    };
  }
/* Bundled into each script. No remote telemetry or shared credential storage. */
function createControlReporter(config, env) {
  'use strict';
  env=env||globalThis;
  const ORIGIN = 'https://piscuj.github.io';
  const PATH = '/userscript-library/';
  const KEY = 'script-control:v1:';
  const WIRE = 'userscript-control:';
  const services = config.services;
  const reportLock=createLeaseLock({store:createBrowserLockStore(env.pageWindow?.indexedDB||globalThis.indexedDB),prefix:'control-report:'});
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
        return await reportLock(config.id,job);
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

const cc=createControlReporter({"id":"intervals-liftosaur-details","version":"0.8.1","old":"0.6.0","services":["intervals","liftosaur"]},typeof window==='undefined'?globalThis:{Date,crypto:window.crypto,navigator:window.navigator,location:window.location,document:window.document,window,pageWindow:typeof unsafeWindow==='object'?unsafeWindow:window,addEventListener:window.addEventListener.bind(window),postMessage:window.postMessage.bind(window),setInterval:window.setInterval.bind(window),GM:typeof GM==='object'?GM:undefined,GM_info:typeof GM_info==='object'?GM_info:undefined,GM_getValue:typeof GM_getValue==='function'?GM_getValue:undefined,GM_setValue:typeof GM_setValue==='function'?GM_setValue:undefined});
if(cc.onLibrary())return;
(function () {
  'use strict';
  // Tampermonkey may expose the page's global Promise in Firefox. Async
  // functions still use this script's intrinsic constructor; keep them aligned.
  const Promise=(async()=>{})().constructor;
  const VERSION = '0.8.1', PREFIX = 'liftosaur:v1:';
  function formatSet(set){return String(set?.raw||'Not completed').replace(/^1x/,'').replace(/^(\d+(?:[|\-]\d+)?\+?)\s+([+-]?\d+(?:\.\d+)?(?:kg|lb)\+?)/,'$1x$2');}
  // Liftosaur Weight_getOneRepMax / Weight_rpeMultiplier and History_maxSetBy:
  // https://github.com/astashov/liftosaur/blob/master/src/models/weight.ts
  // https://github.com/astashov/liftosaur/blob/master/src/models/history.ts
  function estimate1RM(set,target) {
    if(!set||set.unknown||!(set.kg>0)||!(set.reps>0))return null;
    const reps=set.left===null?set.reps:Math.round((set.reps+set.left)/2);
    if(reps===1)return {kg:set.kg,value:set.weight,unit:set.unit,rpe:set.rpe??target?.rpe??10};
    const rpe=set.rpe??target?.rpe??10;
    const x=10-Math.max(1,Math.min(10,rpe))+(Math.max(1,Math.min(24,reps))-1);
    const multiplier=x>=16?0.5:x<=2.92?(0.347619*x*x-4.60714*x+99.9667)/100:(-2.64249*x+97.0955)/100;
    const value=Number((Math.round((set.weight/multiplier)/0.05)*0.05).toFixed(4));
    return {value,unit:set.unit,kg:value*(set.unit==='lb'?0.45359237:1),rpe};
  }
  function liftHighlights(stats) {
    let best=null;
    stats.completed.forEach((set,index)=>{
      if(set.unknown||!(set.reps>0)||!(set.kg>0))return;
      const candidate={set,index};
      const estimate=estimate1RM(set,stats.target[index]);
      if(estimate&&(!best||estimate.kg>best.estimate.kg+1e-9||(Math.abs(estimate.kg-best.estimate.kg)<1e-9&&set.reps>best.set.reps)))best={...candidate,estimate};
    });return {best};
  }
  function parseSets(text) {
    const sets=[];
    for(const raw of String(text||'').split(',').map(s=>s.trim()).filter(Boolean)) {
      const reps=raw.match(/^(\d+)x(\d+)(?:([|-])(\d+))?(\+)?(?:\s|$)/);
      if(!reps || +reps[1]>500){sets.push({raw,unknown:true});continue;}
      const weight=raw.match(/(?:^|\s)([+-]?\d+(?:\.\d+)?)(kg|lb)\+?(?=\s|$)/);
      const rpe=raw.match(/@(\d+(?:\.\d+)?)(\+)?/);
      const timer=raw.match(/(?:^|\s)(\d+s|\?)\+?\|(\d+s|\?)(?=\s|$)/);
      const value={raw:raw.replace(/^\d+x/,'1x'),reps:+reps[2],left:reps[3]==='|'?+reps[4]:null,min:+reps[2],max:reps[3]==='-'?+reps[4]:+reps[2],weight:weight?+weight[1]:null,unit:weight?.[2]||null,rpe:rpe?+rpe[1]:null,seconds:timer&&timer[1]!=='?'?parseInt(timer[1]):null};
      value.kg=weight?value.weight*(value.unit==='lb'?0.45359237:1):null;
      for(let i=0;i<+reps[1];i++)sets.push({...value});
    }
    return sets;
  }
  function compareSet(actual,target) {
    if(!target||target.unknown||actual?.unknown)return null;
    if(!actual)return false;
    const criteria=[actual.reps>=target.min];
    if(target.left!==null)criteria.push((actual.left??actual.reps)>=target.left);
    else if(actual.left!==null)criteria.push(actual.left>=target.min);
    if(target.kg!==null)criteria.push(actual.kg===null?null:actual.kg+0.00001>=target.kg);
    if(target.rpe!==null)criteria.push(actual.rpe===null?null:actual.rpe<=target.rpe);
    if(target.seconds!==null)criteria.push(actual.seconds===null?null:actual.seconds>=target.seconds);
    return criteria.includes(false)?false:criteria.includes(null)?null:true;
  }
  function volume(sets) {
    let kg=0,partial=false;
    for(const set of sets){if(set.unknown || set.kg===null || set.kg<0){partial=true;continue;}kg+=(set.reps+(set.left??0))*set.kg;}
    return {kg,partial};
  }
  function exerciseStats(exercise) {
    const completed=parseSets(exercise.completed),warmup=parseSets(exercise.warmup),target=parseSets(exercise.target);
    const work=volume(completed),warm=volume(warmup);
    return {completed,warmup,target,work,warm,total:{kg:work.kg+warm.kg,partial:work.partial||warm.partial}};
  }
  function workoutVolume(record) {
    return record.exercises.reduce((sum,e)=>{const s=exerciseStats(e);sum.kg+=s.total.kg;sum.work+=s.work.kg;sum.warm+=s.warm.kg;sum.partial ||= s.total.partial;return sum;},{kg:0,work:0,warm:0,partial:false});
  }
  function weightedRPE(record){
    let weighted=0,ratedVolume=0,totalVolume=0,unknownLoad=0,ratedSets=0;
    for(const exercise of record.exercises){const stats=exerciseStats(exercise);
      for(const set of [...stats.completed,...stats.warmup]){
        if(set.unknown||set.kg===null||set.kg<0){unknownLoad++;continue;}
        const v=(set.reps+(set.left??0))*set.kg;totalVolume+=v;
        if(v>0&&Number.isFinite(set.rpe)&&set.rpe>=1&&set.rpe<=10){weighted+=v*set.rpe;ratedVolume+=v;ratedSets++;}
      }
    }
    return {value:ratedVolume?weighted/ratedVolume:null,ratedVolume,totalVolume,unknownLoad,ratedSets,coverage:totalVolume?ratedVolume/totalVolume:0};
  }
  function nativeValues(record){const v=workoutVolume(record),r=weightedRPE(record),values={};
    if(!v.partial&&v.kg>0)values.kg_lifted=Math.round(v.kg);
    if(r.value!==null&&!r.unknownLoad)values.icu_rpe=Math.max(1,Math.min(10,Math.round(r.value)));
    return values;
  }
  function nativePatch(activity,values,previous={},force=false){const patch={};
    for(const field of ['kg_lifted','icu_rpe']){if(values[field]===undefined||Number(activity[field])===values[field])continue;
      if(force||activity[field]==null||(field==='icu_rpe'&&activity[field]===0)||(previous[field]!==undefined&&Number(activity[field])===previous[field]))patch[field]=values[field];
    }return patch;
  }
  function createNativeSync({get,set,update,refresh,lock=(_key,job)=>job()}){
    return async function run(scope,activity,record,force=false){
      const key=PREFIX+scope+':native:'+activity.icu_athlete_id+':'+activity.id,values=nativeValues(record),fingerprint=JSON.stringify([record.id,values]);
      if(!Object.keys(values).length)return {status:'No complete volume or usable logged RPE is available for native fields.',values};
      // Read-only precheck: fields that already match need no cross-tab lease.
      if(!Object.keys(nativePatch(activity,values,(await get(key))?.values||{},force)).length)return {status:'Native fields already match, or a different manual value was kept.',values};
      return lock(key,async assertHeld=>{
        const saved=await get(key)||{},before=saved.values||{};
        let patch=nativePatch(activity,values,before,force);
        if(saved.fingerprint===fingerprint&&Object.keys(patch).length){await refresh(activity);patch=nativePatch(activity,values,before,force);}
        if(!Object.keys(patch).length)return {status:'Native fields already match, or a different manual value was kept.',values};
        if(assertHeld)await assertHeld();
        await update(activity,patch);
        // Record ownership after the write, even if verification later loses the connection.
        await set(key,{values:{...before,...patch},fingerprint});
        await refresh(activity);
        for(const [field,value]of Object.entries(patch))if(Number(activity[field])!==value)throw new Error('Saved native '+field+' could not be verified. Reload Intervals before retrying.');
        return {status:'Native fields saved: '+Object.entries(patch).map(([k,v])=>k==='kg_lifted'?v.toLocaleString()+' kg':'RPE '+v).join(' / '),values,patch};
      });
    };
  }
  function splitSections(text) {
    const parts = []; let start = 0, quoted = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"' && text[i-1] !== '\\') quoted = !quoted;
      if (text[i] === '/' && !quoted) { parts.push(text.slice(start,i).trim()); start=i+1; }
    }
    parts.push(text.slice(start).trim()); return parts;
  }
  function parseRecord(record) {
    if (record?.id == null || typeof record.text !== 'string') throw new Error('Unexpected Liftosaur history record.');
    const lines = record.text.replace(/\r\n?/g,'\n').split('\n');
    const index = lines.findIndex(line => /^\s*\d{4}-\d{2}-\d{2}[T ]/.test(line));
    if (index < 0) throw new Error('Workout date is missing. Use View original to inspect this record.');
    const header = splitSections(lines[index]);
    const stamp = header[0].trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)[ ]?([+-]\d{2}:\d{2}|Z)$/, '$1T$2$3');
    const start = Date.parse(stamp);
    if (!Number.isFinite(start)) throw new Error('Unsupported Liftosaur workout date.');
    const meta = {};
    for (const section of header.slice(1)) {
      const m = section.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
    const duration = /^\d+s$/.test(meta.duration || '') ? Number(meta.duration.slice(0,-1)) : null;
    const exercises = []; let notes = [];
    const workoutNotes = lines.slice(0,index).filter(l=>/^\s*\/\//.test(l)).map(l=>l.replace(/^\s*\/\/ ?/, '')).join('\n');
    for (const line of lines.slice(index+1)) {
      const raw = line.trim(); if (!raw || raw === '}') continue;
      if (raw.startsWith('//')) { notes.push(raw.replace(/^\/\/ ?/,'')); continue; }
      const sections = splitSections(raw); const exercise = {name:sections[0],completed:[],warmup:'',target:'',notes:notes.join('\n'),extra:[]}; notes=[];
      for (const section of sections.slice(1)) {
        if (/^warmup:\s*/.test(section)) exercise.warmup=section.replace(/^warmup:\s*/,'');
        else if (/^target:\s*/.test(section)) exercise.target=section.replace(/^target:\s*/,'');
        else if (/^\w+:/.test(section)) exercise.extra.push(section);
        else exercise.completed.push(section);
      }
      exercise.completed=exercise.completed.join(' / '); exercises.push(exercise);
    }
    return {id:String(record.id),text:record.text,start,duration,program:meta.program||'',day:meta.dayName||(meta.day?`Day ${meta.day}`:''),exercises,notes:workoutNotes};
  }
  function rankRecords(records, activity) {
    const start = Date.parse(activity.start_date);
    return records.map(record=>{
      const diff=Math.abs(record.start-start)/1000;
      const end=start+Number(activity.elapsed_time||activity.moving_time||0)*1000;
      const overlap=record.duration==null?null:Math.max(0,Math.min(end,record.start+record.duration*1000)-Math.max(start,record.start))/1000;
      return {...record,difference:diff,overlap};
    }).sort((a,b)=>a.difference-b.difference);
  }
  function automaticMatch(ranked) {
    const closest=ranked.filter(r=>Number.isFinite(r.difference)&&r.difference<=2*60*60)
      .sort((a,b)=>a.difference-b.difference||a.start-b.start||String(a.id).localeCompare(String(b.id)))[0];
    return closest?.id??null;
  }
  function queryWindow(activity) {
    const time=Date.parse(activity.start_date);
    if (!Number.isFinite(time)) throw new Error('The activity start time is unavailable.');
    const day=new Date(time).toISOString().slice(0,10), midnight=Date.parse(day+'T00:00:00Z');
    return {day,start:midnight-86400000,end:midnight+2*86400000};
  }
  const RECHECK_MS=10*60*1000,RECHECK_UNTIL_MS=24*60*60*1000;
  function createCache({get,set,fetchHistory,lock=(_key,job)=>job(),now=Date.now}) {
    const pending=new Map();
    const storageKey=(scope,type,id)=>PREFIX+scope+':'+type+':'+id;
    const activityKey=(scope,activity)=>storageKey(scope,'activity',String(activity.icu_athlete_id)+':'+String(activity.id));
    const withMatch=saved=>({...saved,selected:saved.manual?saved.selected:saved.selected||automaticMatch(saved.records),source:'cache'});
    // An automatic "no workout" can predate the Liftosaur upload. Recheck it every
    // 10 minutes until one lookup has run a day after the activity ended.
    function stale(saved,activity,at=now()){
      if(!saved||saved.manual||!Array.isArray(saved.records)||withMatch(saved).selected)return false;
      const ended=Date.parse(activity.start_date)+Number(activity.elapsed_time||activity.moving_time||0)*1000;
      return saved.fetchedAt<ended+RECHECK_UNTIL_MS&&at-saved.fetchedAt>=RECHECK_MS;
    }
    async function load(scope,activity,{force=false}={}) {
      const key=activityKey(scope,activity);
      if (pending.has(key)) return pending.get(key);
      const promise=lock(key,async()=>{
        const previous=await get(key),refetch=force||stale(previous,activity);
        if (previous && !refetch) {
          const value=withMatch(previous);
          if(!previous.manual&&!previous.selected&&value.selected)await set(key,{...previous,selected:value.selected});
          return value;
        }
        const window=queryWindow(activity), dayKey=storageKey(scope,'day',window.day);
        const day=await lock(dayKey,async()=>{
          const cached=await get(dayKey);
          if(cached && !refetch) return cached;
          const snapshot=await get(storageKey(scope,'history','all'));
          const records=!refetch&&snapshot&&Date.parse(activity.start_date)<=snapshot.coveredThrough
            ? snapshot.records.filter(r=>{try{const t=parseRecord(r).start;return t>=window.start&&t<window.end;}catch{return false;}})
            : await fetchHistory(window);
          // Store the complete response before linking. A failed request never becomes an empty cache.
          const value={records,fetchedAt:now()}; await set(dayKey,value); return value;
        });
        const parsed=[],unsupported=[];
        for(const record of day.records) { try { parsed.push(parseRecord(record)); } catch { unsupported.push(record); } }
        const ranked=rankRecords(parsed,activity);
        // Preserve explicit links through refresh; never silently choose another session.
        const selected=previous?.manual ? (ranked.some(r=>r.id===previous.selected)?previous.selected:null) : previous?.selected&&ranked.some(r=>r.id===previous.selected)?previous.selected:automaticMatch(ranked);
        const result={records:ranked,unsupported,selected,manual:previous?.manual===true,fetchedAt:day.fetchedAt,linkedAt:now()};
        await set(key,result); return {...result,source:'import'};
      });
      pending.set(key,promise);
      try {return await promise;} finally {pending.delete(key);}
    }
    async function select(scope,activity,id) {
      const key=activityKey(scope,activity);
      return lock(key,async()=>{
        const entry=await get(key);
        if(!entry || (id!==null && !entry.records.some(r=>r.id===id))) throw new Error('Workout is not in the saved list.');
        const value={...entry,selected:id,manual:true}; await set(key,value); return {...value,source:'cache'};
      });
    }
    async function ingest(scope,activity,records,fetchedAt){
      const key=activityKey(scope,activity),current=await get(key);
      // A later per-activity Refresh must not be overwritten by an older full-history
      // snapshot, and an entry already built from this snapshot needs no lease or rewrite.
      if(current?.fetchedAt>=fetchedAt&&Array.isArray(current.records))return withMatch(current);
      return lock(key,async()=>{
        const previous=await get(key),window=queryWindow(activity),parsed=[],unsupported=[];
        if(previous?.fetchedAt>=fetchedAt&&Array.isArray(previous.records))return withMatch(previous);
        for(const raw of records){try{const r=parseRecord(raw);if(r.start>=window.start&&r.start<window.end)parsed.push(r);}catch{unsupported.push(raw);}}
        if(previous?.manual&&previous.selected&&!parsed.some(r=>r.id===previous.selected)){
          const selected=previous.records.find(r=>r.id===previous.selected);if(selected)parsed.push(selected);
        }
        const ranked=rankRecords(parsed,activity),selected=previous?.manual?previous.selected:previous?.selected&&ranked.some(r=>r.id===previous.selected)?previous.selected:automaticMatch(ranked);
        const value={records:ranked,unsupported,selected,manual:previous?.manual===true,fetchedAt,linkedAt:now()};
        await set(key,value);return {...value,source:'cache'};
      });
    }
    function peek(scope,activity){
      const saved=get(activityKey(scope,activity));
      return saved&&Array.isArray(saved.records)?withMatch(saved):null;
    }
    return {load,select,ingest,peek,stale};
  }
  function createHistoryCache({get,set,fetchHistory,lock=(_key,job)=>job(),now=Date.now}){
    return (scope,{through=now(),force=false}={})=>{
      const key=PREFIX+scope+':history:all';
      return lock(key,async()=>{
        const previous=await get(key);if(previous&&!force&&through<=previous.coveredThrough)return previous;
        const end=now(),start=previous&&!force?Math.max(0,previous.coveredThrough-2*60*60*1000):undefined;
        const incoming=await fetchHistory({start,end});
        const records=force||!previous?incoming:[...new Map([...previous.records,...incoming].map(r=>[String(r.id),r])).values()];
        const value={records,fetchedAt:end,coveredThrough:end};await set(key,value);return value;
      });
    };
  }
  const isStrength=a=>/^(WeightTraining|Weightlifting|StrengthTraining|Strength)$/.test(a.type||'');
  async function backfillActivities({scope,athlete,store,history,cache,sync,enabled=()=>true,progress=()=>{}}){
    if(athlete?.icu_permission!=='WRITE')throw new Error('Write access to this athlete is required.');
    const activities=[...store.activities].filter(a=>isStrength(a)&&String(a.icu_athlete_id)===String(athlete.id)&&!a.deleted&&Number.isFinite(Date.parse(a.start_date))&&Date.parse(a.start_date)<=Date.now());
    const counts={total:activities.length,processed:0,matched:0,unmatched:0,failed:0,written:0};
    if(!activities.length)return counts;
    const snapshot=await history(scope,{through:activities.reduce((latest,a)=>Math.max(latest,Date.parse(a.start_date)),0)}),days=new Map();
    for(const raw of snapshot.records){try{const day=new Date(parseRecord(raw).start).toISOString().slice(0,10);if(!days.has(day))days.set(day,[]);days.get(day).push(raw);}catch{}}
    let failures=0;
    for(const activity of activities){
      if(!enabled())throw new Error('Background sync paused in Settings.');
      try{
        const window=queryWindow(activity),nearby=[];
        for(let t=window.start;t<window.end;t+=86400000)nearby.push(...(days.get(new Date(t).toISOString().slice(0,10))||[]));
        const result=await cache.ingest(scope,activity,nearby,snapshot.fetchedAt),record=result.records.find(r=>r.id===result.selected);
        if(record){const saved=await sync(scope,activity,record);counts.matched++;if(saved.patch&&Object.keys(saved.patch).length)counts.written++;}
        else counts.unmatched++;
        failures=0;
      }catch(e){counts.failed++;failures++;counts.lastError=e.message||String(e);}
      counts.processed++;progress({...counts});
      if(failures>=3){counts.pending=counts.total-counts.processed;break;}
    }
    return counts;
  }
  function formatVolume(v){return (v.partial?'At least ':'')+Math.round(v.kg).toLocaleString(undefined,{maximumFractionDigits:0})+' kg';}
  function workoutTime(record){return new Date(record.start).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:'short'});}
  function createBrowserLockStore(factory){
    let db=null,opening=null;
    function open(){
      if(db)return Promise.resolve();if(opening)return opening;
      opening=new Promise((resolve,reject)=>{
        if(!factory){reject(new Error('Browser coordination storage is unavailable.'));return;}
        let finished=false;const timer=setTimeout(()=>fail(new Error('Browser coordination storage timed out.')),10000);
        function fail(error){if(finished)return;finished=true;clearTimeout(timer);reject(error);}
        try{
          const request=factory.open('piscuj-liftosaur-coordination-v1',1);
          request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('leases'))request.result.createObjectStore('leases');};
          request.onerror=()=>{fail(request.error||new Error('Cannot open browser coordination storage.'));};
          request.onblocked=()=>{fail(new Error('Another tab blocked browser coordination storage.'));};
          request.onsuccess=()=>{
            if(finished){request.result.close();return;}
            finished=true;clearTimeout(timer);db=request.result;
            db.onversionchange=()=>{db.close();db=null;opening=null;};resolve();
          };
        }catch(error){fail(error);}
      }).catch(error=>{opening=null;throw error;});
      return opening;
    }
    return {async change(key,mutate){
      await open();
      return new Promise((resolve,reject)=>{
        try{
          const tx=db.transaction('leases','readwrite'),store=tx.objectStore('leases'),request=store.get(key);let result;
          request.onsuccess=()=>{
            try{
              const choice=mutate(request.result?JSON.parse(request.result):null);result=choice.result;
              if(choice.row===null)store.delete(key);
              else if(choice.row!==undefined)store.put(JSON.stringify(choice.row),key);
            }catch(error){reject(error);tx.abort();}
          };
          tx.oncomplete=()=>{resolve(result);};
          tx.onabort=tx.onerror=()=>{reject(tx.error||new Error('Browser coordination transaction failed.'));};
        }catch(error){reject(error);}
      });
    }};
  }
  function createLeaseLock({store,prefix='',now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),every=setInterval,cancel=clearInterval,leaseMs=120000,renewMs=20000,waitMs=150000}){
    let sequence=0;
    return async(key,job)=>{
      const name=prefix+key,owner=now()+':'+(++sequence)+':'+Math.random(),started=now();
      while(!await store.change(name,row=>!row||row.expires<=now()?{row:{owner,expires:now()+leaseMs},result:true}:{result:false})){
        if(now()-started>=waitMs)throw new Error('Another tab is still syncing. Retry in a moment.');
        await sleep(120);
      }
      let lost=null,renewing=false;
      const assertHeld=async()=>{
        if(lost)throw lost;
        const held=await store.change(name,row=>row?.owner===owner?{row:{owner,expires:now()+leaseMs},result:true}:{result:false});
        if(!held){lost=new Error('Sync ownership moved to another tab. Retry this activity.');throw lost;}
      };
      const timer=every(()=>{
        if(renewing)return;renewing=true;
        assertHeld().catch(error=>{lost=error;}).finally(()=>{renewing=false;});
      },renewMs);
      try{const value=await job(assertHeld);if(lost)throw lost;return value;}
      finally{
        cancel(timer);
        try{await store.change(name,row=>row?.owner===owner?{row:null,result:true}:{result:false});}catch{}
      }
    };
  }
  function pageCall(target,method,args,label=method,timeoutMs=30000){
    // Page callbacks return only undefined. Do not assimilate page response
    // objects or return a userscript promise to the application's promise chain.
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve();};
      const timer=setTimeout(()=>finish(new Error(label+': timed out. Retry from Liftosaur Settings.')),timeoutMs);
      const fail=error=>{finish(new Error(label+': '+String(error?.message||error)));};
      try{
        const pending=target[method](...args);
        if(pending&&typeof pending.then==='function')pending.then(()=>{finish();},fail);
        else finish();
      }catch(error){fail(error);}
    });
  }
  function nativeTabForEvent(event,container,custom){
    if(!container||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return null;
    if(event.type==='keydown'&&!['Enter',' ','Spacebar'].includes(event.key))return null;
    if(event.type!=='keydown'&&event.button!=null&&event.button!==0)return null;
    const path=typeof event.composedPath==='function'?event.composedPath():[event.target];
    for(const node of path){
      const tab=node?.closest?.('[role="tab"]');
      if(tab&&tab!==custom&&container.contains(tab))return tab;
    }
    return null;
  }
  // Intervals' ActivityPage receives only `activity`; its store reaches child components
  // through a slot. The athlete's shared activity store saves any activity by id.
  function nativeBridge(activity,candidates){
    const store=candidates.find(s=>typeof s?.updateActivity==='function'&&typeof s?.refreshActivity==='function'&&(s.athlete?.id==null||String(s.athlete.id)===String(activity.icu_athlete_id)));
    if(!store)return {error:'Native activity update bridge is unavailable. Reload Intervals or update this script.'};
    if((activity.athlete?.icu_permission??store.athlete?.icu_permission)!=='WRITE')return {error:'Native sync requires write access to this athlete.'};
    return {store};
  }
  const core={nativeBridge,splitSections,parseRecord,rankRecords,automaticMatch,queryWindow,createCache,createHistoryCache,backfillActivities,createBrowserLockStore,createLeaseLock,pageCall,nativeTabForEvent,parseSets,compareSet,volume,exerciseStats,workoutVolume,formatVolume,workoutTime,formatSet,estimate1RM,liftHighlights,weightedRPE,nativeValues,nativePatch,createNativeSync};
  if(typeof module==='object' && module.exports) {module.exports=core;return;}
  if(typeof document==='undefined') return;

  const get=key=>{const value=GM_getValue(key,null);return value==null?null:JSON.parse(JSON.stringify(value));};
  const set=(key,value)=>{GM_setValue(key,value);};
  const page=typeof unsafeWindow==='object'?unsafeWindow:window;
  let credentials=get(PREFIX+'credentials'), current=null, result=null, error='', busy=false, settingsOpen=false, choosing=false;
  let panel=null, body=null, lastIdentity='', generation=0, queued=false;
  let customTab=null,nativeContent=null,tabBar=null,tabActive=false,activePath='',tabContainer=null;
  const nativeStates=new Map();
  let syncEnabled=get(PREFIX+'native-sync-enabled')!==false,syncStatus='',syncBusy=false,syncFailed=false;
  const syncAttempts=new Set();
  let bulkBusy=false,bulkStatus='',bulkNoticeTimer,bulkNoticeAllowed=false;
  const bulkNoticeShown=new Set();
  const bulkSeen=new Map(),bulkLoaded=new Set();
  const attempts=new Set(), viewResults=new Map();
  const lock=createLeaseLock({store:createBrowserLockStore(indexedDB),prefix:'icu-'});
  async function fetchHistory(window) {
    const ccToken=cc.scope('liftosaur',null),ccCredential=credentials?.scope;
    try{
    const key=credentials?.key;
    if(!key) throw new Error('Add your Liftosaur API key in Settings.');
    const all=[], cursors=new Set(); let cursor;
    for(let pageNumber=0;pageNumber<100;pageNumber++) {
      const params=new URLSearchParams({limit:'200'});
      if(window.start!=null)params.set('startDate',String(window.start));
      if(window.end!=null)params.set('endDate',String(window.end));
      if(cursor!=null) params.set('cursor',String(cursor));
      const data=await new Promise((resolve,reject)=>GM_xmlhttpRequest({
        method:'GET',url:'https://www.liftosaur.com/api/v1/history?'+params,headers:{Authorization:'Bearer '+key,Accept:'application/json'},
        timeout:30000,anonymous:true,redirect:'error',
        onload:r=>{
          if(r.status!==200) {if(credentials?.scope===ccCredential)cc.write(ccToken,'failed',r.status===401?'Credential rejected':r.status===403?'Subscription required':'Service request failed');reject(new Error(r.status===401?'Liftosaur rejected the key. Check Settings.':r.status===403?'Liftosaur API requires an active Premium subscription.':r.status===429?'Liftosaur rate limit reached. Your cache is kept; try Refresh later.':'Liftosaur request failed (HTTP '+r.status+'). Your cache is kept.'));return;}
          try {const data=JSON.parse(r.responseText)?.data;if(!Array.isArray(data?.records)||typeof data.hasMore!=='boolean')throw new Error();if(credentials?.scope===ccCredential)cc.write(ccToken,'connected','Credential accepted; identity unavailable');resolve(data);} catch {reject(new Error('Unexpected Liftosaur response. Your cache is kept.'));}
        },onerror:()=>reject(new Error('Could not connect to Liftosaur. Check your connection and Tampermonkey permission.')),
        ontimeout:()=>reject(new Error('Liftosaur timed out. Use Refresh to try again.'))
      }));
      all.push(...data.records);
      if(!data.hasMore) return [...new Map(all.map(r=>[String(r.id),r])).values()];
      if(data.nextCursor==null || cursors.has(String(data.nextCursor))) throw new Error('Liftosaur pagination did not advance. No incomplete result was cached.');
      cursor=data.nextCursor;cursors.add(String(cursor));
    }
    throw new Error('Too many history pages. No incomplete result was cached.');
    }catch(error){if(credentials?.scope===ccCredential)cc.write(ccToken,'failed',/key/i.test(error.message)?'Credential rejected':/Premium/.test(error.message)?'Subscription required':'Connection or response check failed');throw error;}
  }
  const cache=createCache({get,set,fetchHistory,lock});
  const historyCache=createHistoryCache({get,set,fetchHistory,lock});
  function walk(vnode,visit,seen=new Set()) {
    if(!vnode||typeof vnode!=='object'||seen.has(vnode))return;
    seen.add(vnode); if(visit(vnode)===false)return;
    if(vnode.component?.subTree)walk(vnode.component.subTree,visit,seen);
    if(Array.isArray(vnode.children))for(const child of vnode.children)walk(child,visit,seen);
    if(vnode.suspense?.activeBranch)walk(vnode.suspense.activeBranch,visit,seen);
  }
  const usableActivity=(activity,id)=>activity&&String(activity.id)===id&&activity.type&&activity.icu_athlete_id!=null;
  let lastFound=null;
  function discover() {
    const route=location.pathname.match(/^\/activities\/([^/]+)(?:\/|$)/);
    if(!route)return null;
    // Reuse the mounted component and re-read its live props instead of walking
    // the whole Vue tree on every mutation and poll.
    const component=lastFound?.component,props=component?.props;
    if(component&&!component.isUnmounted&&lastFound.el.isConnected&&usableActivity(props.activity,route[1]))return {...lastFound,activity:props.activity,store:props.activityStore??lastFound.store};
    let found=null,store;
    for(const root of page.document.querySelectorAll('[data-v-app]')) {
      walk(root.__vue_app__?._container?._vnode||root._vnode,vnode=>{
        const props=vnode.component?.props||vnode.props,activity=props?.activity;
        if(usableActivity(activity,route[1]) && vnode.el?.isConnected) {
          const name=vnode.component?.type?.__name||vnode.type?.__name;
          store??=props.activityStore;
          if(name==='ActivityDetail'||!found)found={activity,el:vnode.el,store:props.activityStore,component:vnode.component};
        }
      });
    }
    // The outer page component sets the panel position; any matching child may carry the store.
    if(found)found.store??=store;
    lastFound=found;
    return found;
  }
  function discoverSyncStore(){
    const stores=[],targets=[];let selected;
    const usable=s=>s?.athlete?.icu_permission==='WRITE'&&Array.isArray(s.activities)&&typeof s.ensureActivities==='function'&&typeof s.updateActivity==='function'&&typeof s.refreshActivity==='function';
    const pick=target=>{const choices=[...new Set(stores)].filter(usable);return target!=null?choices.find(s=>String(s.athlete.id)===String(target)):choices.length===1?choices[0]:null;};
    const roots=[...page.document.querySelectorAll('[data-v-app]')];
    for(const root of roots){
      const pinia=root.__vue_app__?.config?.globalProperties?.$pinia;
      selected=pinia?._s?.get('current-athlete')?.athlete?.id??selected;
      if(pinia?._s)for(const value of pinia._s.values())if(value?.ensureActivities&&value?.updateActivity)stores.push(value);
    }
    // Pinia normally holds the store; walk component props only as a fallback.
    const direct=pick(selected??current?.activity.icu_athlete_id);
    if(direct)return direct;
    for(const root of roots)walk(root.__vue_app__?._container?._vnode||root._vnode,vnode=>{
      const props=vnode.component?.props||vnode.props;
      if(props?.activityStore)stores.push(props.activityStore);
      if(props?.athlete?.id!=null)targets.push(props.athlete.id);
    });
    return pick(selected??current?.activity.icu_athlete_id??targets[0]);
  }
  function showBulkStatus(text,done=false){
    bulkStatus=text;
    if(settingsOpen&&panel?.isConnected)render();
    if(!bulkNoticeAllowed)return;
    let notice=document.querySelector('#lft-background-status');
    if(!notice){notice=el('div');notice.id='lft-background-status';notice.setAttribute('role','status');notice.style.cssText='position:fixed;bottom:16px;right:16px;z-index:10000;max-width:min(440px,90vw);padding:10px 14px;border:1px solid #8888;border-radius:7px;background:#24212f;color:#eee;font:13px/1.4 system-ui;box-shadow:0 3px 12px #0004';document.body.append(notice);
      // Progress updates never extend the notice or recreate it after dismissal.
      bulkNoticeTimer=setTimeout(()=>{bulkNoticeAllowed=false;notice.remove();},2000);
    }
    notice.textContent=text;
  }
  function activitySignature(store){return store.activities.filter(isStrength).map(a=>a.id+':'+a.start_date).sort().join('|');}
  const AUTO_SYNC_MS=30000,FULL_LOAD_MS=12*60*60*1000;let lastAutoSync=0;
  async function syncAllWorkouts(force=false){
    if(bulkBusy||!syncEnabled||!credentials?.scope)return;
    // Automatic checks only need to notice newly loaded activities; don't rescan per mutation.
    if(!force&&Date.now()-lastAutoSync<AUTO_SYNC_MS)return;
    const store=discoverSyncStore();if(!store)return;
    if(!force)lastAutoSync=Date.now();
    const scope=credentials.scope,athlete=store.athlete,key=scope+':'+athlete.id,signature=activitySignature(store);
    if(!force&&bulkSeen.get(key)===signature)return;
    // Loading every Intervals activity is the costly step. Each tab still checks the
    // activities it has loaded; the full scan runs on demand or twice a day.
    const fullKey=PREFIX+scope+':full-load:'+athlete.id,fullLoad=force||(!bulkLoaded.has(key)&&!(Date.now()-(get(fullKey)||0)<FULL_LOAD_MS));
    // Quiet checks of already-synced activities show no notice.
    bulkNoticeAllowed=force||(fullLoad&&!bulkNoticeShown.has(key));if(fullLoad)bulkNoticeShown.add(key);
    bulkBusy=true;bulkSeen.set(key,signature);
    showBulkStatus('Liftosaur: checking '+(fullLoad?'all':'loaded')+' weight-training activities…');
    try{
      await lock(PREFIX+key+':background',async()=>{
        if(fullLoad){
          await pageCall(store,'ensureActivities',['1980-01-01',new Date(Date.now()+86400000).toISOString().slice(0,10)],'Loading Intervals history');bulkLoaded.add(key);
        }
        if(force)await historyCache(scope,{force:true});
        const run=createNativeSync({get,set,lock,update:(a,p)=>pageCall(store,'updateActivity',[a.id,p],'Saving native fields'),refresh:a=>pageCall(store,'refreshActivity',[a],'Verifying native fields')});
        const counts=await backfillActivities({scope,athlete,store,history:historyCache,cache,sync:run,enabled:()=>syncEnabled&&credentials?.scope===scope,
          progress:c=>showBulkStatus('Liftosaur: '+c.processed+'/'+c.total+' checked · '+c.matched+' matched'+(c.failed?' · '+c.failed+' failed':''))});
        bulkSeen.set(key,activitySignature(store));
        const text='Liftosaur: '+counts.matched+' matched · '+counts.written+' updated · '+counts.unmatched+' without a workout within 2h'+(counts.failed?' · '+counts.failed+' failed: '+counts.lastError:'')+(counts.pending?' · '+counts.pending+' pending; retry from Settings':'');
        set(PREFIX+scope+':background:'+athlete.id,{...counts,finishedAt:Date.now(),status:text});showBulkStatus(text,true);
        // Only a clean pass over the fully loaded history lets other tabs skip the full load.
        if(bulkLoaded.has(key)&&!counts.failed&&!counts.pending)set(fullKey,Date.now());
        if(!counts.failed&&!counts.pending&&counts.written>0)cc.record('intervals',{id:athlete.id,label:athlete.name,role:'selected athlete'},'success','Background native fields verified');
        viewResults.clear();attempts.clear();result=null;
      });
    }catch(e){showBulkStatus('Liftosaur background sync: '+(e.message||'Failed. Retry from Liftosaur Settings.'),true);}
    finally{bulkBusy=false;schedule();}
  }
  const strength=isStrength;
  function el(tag,text,cls) {const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;}
  function button(label,handler,disabled=false) {const b=el('button',label);b.type='button';b.disabled=disabled;b.addEventListener('click',handler);return b;}
  function style() {
    if(document.getElementById('lft-style'))return;
    const node=el('style');node.id='lft-style';node.textContent=`
      #lft-panel{font-family:inherit;font-size:14px;line-height:1.5;color:inherit;background:var(--icu-surface,#24262b);border:1px solid var(--icu-border-solid,#555);border-radius:8px;margin:14px 8px;padding:16px;max-width:100%;box-sizing:border-box}
      #lft-panel *{box-sizing:border-box}#lft-panel .lft-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#lft-panel h2{font-size:18px;margin:0;flex:1}#lft-panel h3{font-size:16px;margin:0 0 8px}#lft-panel p{margin:8px 0}#lft-panel .lft-muted{opacity:.72;font-size:12px}#lft-panel button,#lft-panel input,#lft-panel select{font:inherit;color:inherit;border:1px solid #7778;background:transparent;border-radius:5px;padding:6px 10px;min-height:36px}#lft-panel button{cursor:pointer}#lft-panel button:hover{background:#8882}#lft-panel button:disabled{opacity:.45;cursor:default}#lft-panel button:focus-visible,#lft-panel input:focus-visible{outline:2px solid #70c8b9;outline-offset:2px}#lft-panel .lft-body{margin-top:12px}#lft-panel .lft-error{color:#ff9e95}#lft-panel .lft-scroll{overflow-x:auto}#lft-panel table{width:100%;border-collapse:collapse;text-align:left}#lft-panel th,#lft-panel td{padding:10px 8px;border-bottom:1px solid #8884;vertical-align:top}#lft-panel th{font-size:12px;opacity:.72}#lft-panel td:first-child{font-weight:600;width:35%}#lft-panel details{margin:5px 0;font-size:12px}#lft-panel summary{cursor:pointer}#lft-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;max-height:400px;overflow:auto}#lft-panel .lft-notes{white-space:pre-wrap;overflow-wrap:anywhere;font-weight:normal}#lft-panel .lft-settings input{display:block;width:min(100%,480px);margin:8px 0}#lft-panel .lft-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}#lft-panel .lft-choice{display:block;width:100%;text-align:left;margin:6px 0}#lft-panel .lft-badge{font-size:11px;border-radius:16px;background:#72c6b826;color:#72c6b8;padding:3px 8px}#lft-panel .lft-version{margin-left:auto}#lft-panel option{color:#111;background:#fff}
      @media(max-width:600px){#lft-panel{margin:10px 0;padding:12px}#lft-panel .lft-header h2{flex-basis:100%}#lft-panel td,#lft-panel th{padding:8px 4px}#lft-panel td:first-child{width:40%}}
      .lft-native-hidden{display:none!important}#lft-panel[hidden]{display:none!important}#lft-tab{flex-shrink:0;cursor:pointer;font:inherit;letter-spacing:.08em;text-transform:uppercase;border:0;background:transparent;min-width:100px;height:48px;color:inherit;position:relative}#lft-tab[aria-selected=true]{color:rgb(var(--v-theme-primary,110,190,180));border-bottom:2px solid currentColor}.lft-custom-active .v-tab:not(#lft-tab){color:inherit!important}.lft-custom-active .v-tab:not(#lft-tab) .v-tab__slider{opacity:0!important}#lft-panel td:first-child{width:24%}#lft-panel .lft-volume{white-space:nowrap;width:17%;font-variant-numeric:tabular-nums}#lft-panel .lft-set{padding:5px 0;display:grid;grid-template-columns:18px 1fr;gap:2px 6px;font-variant-numeric:tabular-nums}#lft-panel .lft-target{grid-column:2;font-size:12px;opacity:.78}#lft-panel .lft-set-number{font-size:11px;opacity:.65;padding-top:2px}#lft-panel .lft-met{color:#40b877}#lft-panel .lft-missed{color:#e46969}#lft-panel .lft-unrated{color:inherit}#lft-panel .lft-total{display:flex;flex-wrap:wrap;gap:6px 24px;align-items:center;margin:16px 0;padding:12px 0;border-top:1px solid #8884;border-bottom:1px solid #8884}#lft-panel .lft-total strong{font-size:18px}#lft-panel .lft-settings{padding:12px;border:1px solid #8884;border-radius:6px;margin-bottom:16px}
      @media(max-width:600px){#lft-panel table{font-size:12px}#lft-panel td:first-child{width:23%}#lft-panel .lft-volume{white-space:normal}#lft-panel .lft-set{grid-template-columns:12px 1fr;gap:2px}#lft-panel .lft-target{font-size:11px}}
      #lft-tab{height:36px;min-width:0;font-weight:500;line-height:normal;border-bottom:0;align-self:center;display:flex;align-items:center;justify-content:center}#lft-tab[aria-selected=true]{border-bottom:0}#lft-tab[aria-selected=true]::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;background:currentColor}#lft-panel{padding:10px 12px;margin:8px 8px;line-height:1.35}#lft-panel h2{font-size:16px}#lft-panel .lft-header{gap:6px}#lft-panel .lft-header button{min-height:28px;padding:3px 8px;font-size:12px}#lft-panel .lft-body{margin-top:6px}#lft-panel h3{font-size:14px;margin:0}#lft-panel .lft-workout-header{display:flex;align-items:baseline;flex-wrap:wrap;gap:3px 14px}#lft-panel .lft-workout-time{font-size:12px;opacity:.75;white-space:nowrap}#lft-panel .lft-total{margin:8px 0 4px;padding:7px 0;gap:4px 18px}#lft-panel .lft-total strong{font-size:16px}#lft-panel th,#lft-panel td{padding:6px 7px}#lft-panel .lft-set{padding:3px 0;grid-template-columns:16px minmax(105px,auto) minmax(0,1fr);gap:2px 7px;align-items:baseline}#lft-panel .lft-target{grid-column:auto;font-size:12px;overflow-wrap:anywhere}#lft-panel .lft-set-number{padding-top:0}#lft-panel details{margin:3px 0}#lft-panel td:first-child{width:22%}#lft-panel .lft-volume{width:15%}#lft-panel p{margin:5px 0}
      @media(max-width:700px){#lft-panel{padding:8px;margin:6px 0}#lft-panel .lft-set{grid-template-columns:12px 1fr;padding:2px 0;gap:1px 4px}#lft-panel .lft-target{grid-column:2;font-size:11px}#lft-panel th,#lft-panel td{padding:5px 4px}#lft-panel .lft-header h2{flex-basis:auto}#lft-panel .lft-workout-time{white-space:normal}}
      
      #lft-tab:focus-visible{outline:2px solid var(--lft-active-color,#64b5f6);outline-offset:-4px}#lft-tab{isolation:isolate;color:var(--lft-inactive-color,inherit)!important}#lft-tab[aria-selected=true]{color:var(--lft-active-color,#64b5f6)!important;border-bottom:0}#lft-tab[aria-selected=true]::after{content:none}#lft-tab .v-tab__slider{position:absolute;bottom:0;left:0;right:0;width:100%;height:var(--lft-slider-height,2px);background:currentColor;transform:none!important;opacity:0;pointer-events:none}#lft-tab[aria-selected=true] .v-tab__slider{opacity:1}.lft-custom-active .v-tab:not(#lft-tab){color:var(--lft-inactive-color,inherit)!important}
      #lft-panel .lft-highlights{font-size:12px;font-weight:400;line-height:1.4;opacity:.78;margin-top:5px}#lft-panel .lft-highlights div{margin:2px 0}#lft-panel .lft-highlight-set{font-size:11px;display:block}
      #lft-panel .lft-header{float:right;margin:0 0 4px 10px}#lft-panel .lft-body{margin-top:0}#lft-panel .lft-workout-header{min-height:28px;align-items:center}#lft-panel .lft-total{clear:both;margin-top:5px}#lft-panel .lft-load{font-size:14px;font-weight:600}#lft-panel .lft-settings{clear:both}
    `;document.head.append(node);
  }
  function details(label,text) {const d=el('details');d.append(el('summary',label),el('pre',text));return d;}
  function displayTime(time){return new Date(time).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function setLines(actual,target=[]) {
    const list=el('div',null,'lft-sets');
    for(let i=0;i<Math.max(actual.length,target.length);i++){
      const status=compareSet(actual[i],target[i]),line=el('div',null,'lft-set '+(status===true?'lft-met':status===false?'lft-missed':'lft-unrated'));
      line.title=status===true?'Target met: reps and load reached; logged RPE is at or below target.':status===false?'Target missed: reps, load, RPE or set duration did not meet the prescription.':'No comparable target or incomplete data.';
      line.append(el('span',String(i+1), 'lft-set-number'),el('span',formatSet(actual[i]),'lft-completed'));
      if(target[i])line.append(el('span','Target: '+formatSet(target[i]),'lft-target'));
      list.append(line);
    }
    return list;
  }
  function render() {
    if(!panel)return;panel.replaceChildren();
    const header=el('div',null,'lft-header');
    header.append(button('Settings',()=>{settingsOpen=!settingsOpen;render();}));
    panel.append(header);body=el('div',null,'lft-body');panel.append(body);
    if(settingsOpen||!credentials?.key)renderSettings();
    if(error)body.append(el('p',error,'lft-error'));
    if(busy)body.append(el('p',result?'Refreshing from Liftosaur. Your saved workout stays visible.':'Fetching completed workouts from Liftosaur\u2026'));
    if(!result) {
      if(!error&&credentials?.key)body.append(el('p',busy?'Loading workout history…':'No workout details loaded. Use Settings → Refresh to retry.'));
      return;
    }
    const selected=result.records.find(r=>r.id===result.selected);
    if((settingsOpen&&choosing)||!selected) {
      body.append(el('p',result.records.length?'Choose the Liftosaur session that belongs to this activity:':'No completed Liftosaur workouts found around this activity. This result is cached too. Use Refresh after finishing or syncing your workout.'));
      for(const record of result.records)body.append(button(`${record.id===result.selected?'Selected - ':''}${record.program||'Workout'}${record.day?' / '+record.day:''} / ${displayTime(record.start)} / ${Math.round(record.difference/60)} min from watch start`,async()=>{
        const activity=current.activity,scope=credentials.scope,token=generation;error='';
        try{const value=await cache.select(scope,activity,record.id);if(token!==generation)return;result=value;viewResults.set(identity(),value);choosing=false;render();schedule();}catch(e){if(token===generation){error=e.message;render();}}
      },busy));
    }
    if(selected) {
      const workoutHeader=el('div',null,'lft-workout-header');workoutHeader.append(el('h3',[selected.program,selected.day].filter(Boolean).join(' / ')||'Completed workout'));
      const started=el('time','Liftosaur: '+workoutTime(selected),'lft-workout-time');started.dateTime=new Date(selected.start).toISOString();started.title='Liftosaur workout start in your local time zone';workoutHeader.append(started);body.append(workoutHeader);
      const total=workoutVolume(selected),totalNode=el('div',null,'lft-total');
      totalNode.append(el('strong','Total volume: '+formatVolume(total)));
      const average=weightedRPE(selected),rpeNode=el('span','Weighted RPE: '+(average.value===null?'Unavailable':average.value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})),'lft-load');
      rpeNode.title='Sum of (logged set RPE x completed set volume) / volume of sets with logged RPE. Completed reps x kg; both sides counted. No target RPE or zero is substituted for missing RPE. '+Math.round(average.coverage*100)+'% of known volume has RPE. Native Intervals RPE is rounded to a whole number.';totalNode.append(rpeNode);
      if(average.coverage<1&&average.value!==null)rpeNode.append(el('span',' ('+Math.round(average.coverage*100)+'% rated volume)','lft-muted'));
      totalNode.title='Completed reps x logged weight, including warmups. Both sides are added when recorded separately. Pounds are converted to kilograms. No equipment multiplier is guessed.';body.append(totalNode);
      if(total.partial)body.append(el('p','Some sets have no usable load. Volume includes only the sets with known weights.','lft-muted'));
      // Native write problems must be visible without opening Settings.
      if(syncFailed&&syncStatus)body.append(el('p',syncStatus+' Weight Lifted and RPE were not filled.','lft-error'));
      if(selected.notes)body.append(el('p',selected.notes,'lft-notes'));
      if(selected.exercises.length) {
        const scroll=el('div',null,'lft-scroll'),table=el('table'),head=el('thead'),headRow=el('tr');
        for(const title of ['Exercise','Completed sets / target','Volume']){const th=el('th',title);th.scope='col';headRow.append(th);}head.append(headRow);table.append(head);
        const tbody=el('tbody');
        for(const exercise of selected.exercises) {
          const stats=exerciseStats(exercise),row=el('tr'),name=el('td',exercise.name),sets=el('td');
          const highlights=liftHighlights(stats),info=el('div',null,'lft-highlights');
          info.title='Working sets from this workout. e1RM uses Liftosaur\'s RPE-based formula, averaging unilateral reps. Logged RPE takes precedence, then target RPE, otherwise 10. Warmups are excluded.';
          const best=el('div',highlights.best?'Best e1RM: '+highlights.best.estimate.value.toLocaleString(undefined,{maximumFractionDigits:2})+highlights.best.estimate.unit:'Best e1RM: unavailable');
          info.append(best);name.append(info);
          sets.append(setLines(stats.completed,stats.target));
          if(exercise.notes)name.append(el('div',exercise.notes,'lft-notes lft-muted'));
          if(exercise.warmup){const warm=el('details');warm.append(el('summary','Warmup sets'),setLines(stats.warmup));sets.append(warm);}
          for(const extra of exercise.extra)sets.append(el('p',extra,'lft-muted'));
          const amount=el('td',formatVolume(stats.total),'lft-volume');
          if(stats.warmup.length)amount.append(el('div','Warmup '+formatVolume(stats.warm),'lft-muted'));
          row.append(name,sets,amount);tbody.append(row);
        }
        table.append(tbody);scroll.append(table);body.append(scroll);
      }else body.append(el('p','This workout contains no completed exercises.'));
      if(settingsOpen)body.append(details('View original Liftosaur record',selected.text));
    }
    for(const record of result.unsupported||[])body.append(details('Unrecognized workout format \u00b7 '+record.id,record.text));
  }
  function renderSettings() {
    const actions=el('div',null,'lft-actions');
    actions.append(button(busy?'Loading...':'Refresh',()=>load(true),busy||!credentials?.key));
    if(result?.records.length)actions.append(button(choosing?'Hide workout choices':'Choose another workout',()=>{choosing=!choosing;render();},busy));
    body.append(actions);
    const form=el('form',null,'lft-settings'),label=el('label','Liftosaur API key');
    const input=el('input');input.type='password';input.autocomplete='off';input.spellcheck=false;input.placeholder=credentials?.key?'Key saved \u2014 enter only to replace':'lftsk_\u2026';input.setAttribute('aria-label','Liftosaur API key');label.append(input);form.append(label);
    form.append(el('p','Saved privately in Tampermonkey and sent only to www.liftosaur.com. A replacement key uses a separate workout cache.','lft-muted'));
    const save=button('Save key',()=>{});save.type='submit';form.append(save);
    form.addEventListener('submit',async event=>{
      event.preventDefault();const key=input.value.trim();if(!key){settingsOpen=false;render();return;}
      if(!/^lftsk_[A-Za-z0-9_-]+$/.test(key)){error='Enter a Liftosaur key beginning with lftsk_.';render();return;}
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      const scope=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
      cc.invalidate('liftosaur');credentials={key,scope};set(PREFIX+'credentials',credentials);input.value='';settingsOpen=false;error='';result=null;generation++;busy=false;lastIdentity=identity();if(panel)panel.dataset.identity=lastIdentity;attempts.delete(identity());render();load(false);
    });body.append(form);
    body.append(el('p','Targets: green = prescribed reps and load met, with RPE at or below the target. Red = missed; grey = unavailable or no target. Volume uses logged load x completed reps, includes warmups, and adds both sides if recorded.','lft-muted'));
    body.append(el('p','Weighted RPE = sum(logged set RPE x completed volume) / rated volume. Sets without logged RPE are excluded, including unrated warmups. Native RPE is rounded directly from the unrounded average to the nearest integer.','lft-muted'));
    const syncLabel=el('label'),syncToggle=el('input');syncToggle.type='checkbox';syncToggle.checked=syncEnabled;syncToggle.style.cssText='display:inline;width:auto;margin-right:6px';syncToggle.addEventListener('change',()=>{syncEnabled=syncToggle.checked;set(PREFIX+'native-sync-enabled',syncEnabled);if(syncEnabled)syncNative(false);});syncLabel.append(syncToggle,document.createTextNode('Automatically fill native Weight Lifted and RPE'));body.append(syncLabel);
    body.append(el('p','Fills blank fields and updates values previously saved by this script. Other manual values are kept. Weight Lifted uses total volume; RPE uses the derived volume-weighted average, not a self-reported session rating.','lft-muted'));
    body.append(button(syncBusy?'Saving native fields...':'Fill native fields now',()=>syncNative(true),syncBusy||!result?.selected));
    if(syncStatus)body.append(el('p',syncStatus,'lft-muted'));
    body.append(el('p','The closest Liftosaur workout starting within 2 hours is assigned automatically. Change workout keeps your manual choice. Background sync checks all completed weight-training activities, including older calendar weeks.','lft-muted'));
    body.append(button(bulkBusy?'Updating all weight trainings…':'Refresh and sync all weight trainings',()=>syncAllWorkouts(true),bulkBusy||!syncEnabled));
    if(bulkStatus)body.append(el('p',bulkStatus,'lft-muted'));
    body.append(el('p','v'+VERSION,'lft-muted'));
  }
  function identity(){return current?String(current.activity.icu_athlete_id)+':'+String(current.activity.id)+':'+(credentials?.scope||'none'):'';}
  async function syncNative(force=false){
    const selected=result?.records?.find(r=>r.id===result.selected);
    if(!current||!credentials?.scope||!selected||syncBusy||bulkBusy||(!force&&!syncEnabled))return;
    const context=current,scope=credentials.scope,id=identity(),values=nativeValues(selected),attempt=id+':'+JSON.stringify([selected.id,values]);
    if(!force&&syncAttempts.has(attempt))return;
    const bridge=nativeBridge(context.activity,[context.store,discoverSyncStore()]);
    // The store can register after the page renders; retry an unavailable bridge on the next refresh.
    if(!bridge.error||!/unavailable/.test(bridge.error))syncAttempts.add(attempt);
    if(bridge.error){if(syncStatus!==bridge.error){syncStatus=bridge.error;syncFailed=true;render();}return;}
    syncBusy=true;syncFailed=false;syncStatus='Saving native fields...';if(settingsOpen)render();
    const run=createNativeSync({get,set,lock,update:(a,p)=>pageCall(bridge.store,'updateActivity',[a.id,p],'Saving native fields'),refresh:a=>pageCall(bridge.store,'refreshActivity',[a],'Verifying native fields')});
    try{const saved=await run(scope,context.activity,selected,force);if(identity()===id){syncStatus=saved.status;if(saved.patch)cc.record('intervals',{id:context.activity.icu_athlete_id,label:context.activity.athlete?.name,role:'selected athlete'},'success','Native fields saved and verified');}}
    catch(e){if(identity()===id){syncStatus='Native sync failed: '+(e.message||'Check your connection and use Fill native fields now to retry.');syncFailed=true;}}
    finally{syncBusy=false;if(identity()===id)render();else schedule();}
  }
  function activateTab(active,updateHash=true) {
    tabActive=active;
    if(updateHash){const url=new URL(location.href);url.hash=active?'liftosaur':'';history.replaceState(history.state,'',url.href);}
    applyTabState();
  }
  function applyTabState() {
    if(!customTab||!nativeContent||!panel)return;
    nativeContent.classList.toggle('lft-native-hidden',tabActive);panel.hidden=!tabActive;
    tabBar?.classList.toggle('lft-custom-active',tabActive);
    customTab.setAttribute('aria-selected',String(tabActive));customTab.tabIndex=0;
    customTab.classList.toggle('v-tab-item--selected',tabActive);customTab.classList.toggle('v-tab--selected',tabActive);customTab.classList.toggle('text-primary',tabActive);
    for(const tab of tabContainer.querySelectorAll('[role="tab"]:not(#lft-tab)')){
      if(tabActive){if(!nativeStates.has(tab))nativeStates.set(tab,{selected:tab.getAttribute('aria-selected'),tabindex:tab.getAttribute('tabindex')});tab.setAttribute('aria-selected','false');tab.tabIndex=-1;}
      else if(nativeStates.has(tab)){const state=nativeStates.get(tab);if(state.selected!==null)tab.setAttribute('aria-selected',state.selected);if(state.tabindex!==null)tab.setAttribute('tabindex',state.tabindex);else tab.removeAttribute('tabindex');nativeStates.delete(tab);}
    }
  }
  function releaseToNativeTab(event){
    if(tabActive&&nativeTabForEvent(event,tabContainer,customTab))activateTab(false);
  }
  function cleanupTab() {
    tabActive=false;applyTabState();customTab?.remove();customTab=null;
    nativeContent?.classList.remove('lft-native-hidden');tabBar?.classList.remove('lft-custom-active');nativeContent=null;tabBar=null;tabContainer=null;nativeStates.clear();
  }
  function mountTab(found) {
    const scope=found.el.closest?.('.activity-page')||found.el;
    const bar=scope.querySelector('.tab-bar'),container=bar?.querySelector('[role="tablist"] .v-slide-group__content'),content=bar?.parentElement.querySelector(':scope > .tab-content');
    if(!container||!content)return false;
    if(customTab?.isConnected&&tabContainer===container){
      if(nativeContent!==content){nativeContent?.classList.remove('lft-native-hidden');nativeContent=content;content.after(panel);}
      tabBar=bar;alignTab();applyTabState();return true;
    }
    const wanted=tabActive;cleanupTab();tabActive=wanted;
    tabContainer=container;nativeContent=content;tabBar=bar;
    customTab=button('Liftosaur',()=>activateTab(true));customTab.id='lft-tab';customTab.setAttribute('role','tab');customTab.setAttribute('aria-controls','lft-panel');
    customTab.className='v-btn v-theme--dark v-btn--density-default v-btn--size-default v-btn--variant-text v-tab';
    const label=el('span','Liftosaur','v-btn__content'),slider=el('div',null,'v-tab__slider');label.append(slider);
    customTab.replaceChildren(el('span',null,'v-btn__overlay'),el('span',null,'v-btn__underlay'),label);
    const add=container.querySelector('button[title="Add Tab"]');container.insertBefore(customTab,add||null);alignedKey='';alignTab();
    customTab.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const tabs=[...container.querySelectorAll('[role="tab"]')];const i=tabs.indexOf(customTab);tabs[(i+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length]?.focus();}});
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','lft-tab');
    content.after(panel);applyTabState();return true;
  }
  let alignedKey='';
  function alignTab(){
    const ref=tabContainer?.querySelector('[role="tab"]:not(#lft-tab)');if(!ref||!customTab)return;
    // Computed styles and the class toggle below force a style recalculation; only
    // resample when the tab, selection or theme classes changed.
    const selectedTab=tabContainer.querySelector('[role="tab"].v-tab--selected:not(#lft-tab)');
    const key=ref.className+'|'+(selectedTab?[...tabContainer.children].indexOf(selectedTab)+selectedTab.className:'');
    if(key===alignedKey)return;alignedKey=key;
    const computed=getComputedStyle(ref);
    for(const property of ['height','minHeight','minWidth','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft'])if(customTab.style[property]!==computed[property])customTab.style[property]=computed[property];
    // Sample the app's actual active/inactive colors without our overlay rule.
    const active=tabBar.classList.contains('lft-custom-active');if(active)tabBar.classList.remove('lft-custom-active');
    try{
      const selected=tabContainer.querySelector('[role="tab"].v-tab--selected:not(#lft-tab)')||ref;
      const inactive=tabContainer.querySelector('[role="tab"]:not(.v-tab--selected):not(#lft-tab)');
      tabBar.style.setProperty('--lft-active-color',getComputedStyle(selected).color);
      if(inactive)tabBar.style.setProperty('--lft-inactive-color',getComputedStyle(inactive).color);
      const slider=selected.querySelector('.v-tab__slider');
      if(slider)customTab.style.setProperty('--lft-slider-height',getComputedStyle(slider).height);
    }finally{if(active)tabBar.classList.add('lft-custom-active');}
  }
  async function load(force=false) {
    if(!current||!credentials?.key||busy)return;
    const id=identity();
    if(!force){
      if(result)return;
      try{
        const saved=cache.peek(credentials.scope,current.activity);
        // A stale "no workout" stays visible while one recheck runs below.
        if(saved){result=saved;error='';viewResults.set(id,saved);render();if(!cache.stale(saved,current.activity))return;}
      }catch(e){error='Reading saved workout: '+(e.message||String(e));render();return;}
    }
    // Visible details must not wait for the all-activities scan. Cache activity
    // and day leases still coordinate concurrent foreground/background reads.
    if(!force&&attempts.has(id))return;attempts.add(id);
    const activity={...current.activity},scope=credentials.scope,token=generation;busy=true;error='';render();
    try {const value=await cache.load(scope,activity,{force});viewResults.set(id,value);if(token===generation){result=value;cc.record('intervals',cc.intervals(page),'success','Workout details loaded');}}
    catch(e) {if(token===generation)error=e.message||'Could not load this workout.';}
    finally {if(token===generation){busy=false;render();}else schedule();}
  }
  function refreshPage() {
    queued=false;style();const ccAthlete=cc.intervals(page);cc.observe('intervals',ccAthlete);const found=discover();syncAllWorkouts(false);
    if(!found||!strength(found.activity)) {
      if(current){generation++;current=null;result=null;error='';busy=false;lastIdentity='';cleanupTab();panel?.remove();panel=null;activePath='';}
      return;
    }
    current=found;const id=identity();
    tabActive=location.hash==='#liftosaur';activePath=location.pathname;
    if(id!==lastIdentity){generation++;lastIdentity=id;result=viewResults.get(id)||null;error='';busy=false;choosing=false;syncStatus='';syncFailed=false;}
    if(!result&&viewResults.has(id)){result=viewResults.get(id);render();}
    if(!panel?.isConnected){panel=el('section');panel.id='lft-panel';panel.setAttribute('aria-label','Liftosaur exercises');
      const chart=found.el.querySelector?.('.activity-chart-area, .activity-charts');
      if(chart)chart.parentElement.insertBefore(panel,chart);else (found.el.nodeType===1?found.el:document.querySelector('main')).append(panel);
      render();
    }else if(id!==panel.dataset.identity)render();
    panel.dataset.identity=id;load(false);
    if(!mountTab(found))panel.hidden=false;
    syncNative(false);
  }
  function schedule(){if(!queued){queued=true;setTimeout(refreshPage,200);}}
  // Capture pointer intent before Vue's native tab handlers, including clicks on
  // an already-selected Timeline and retargeted Firefox events. Never cancel
  // the native event: Vue Router continues to own native tab navigation.
  document.addEventListener('pointerdown',releaseToNativeTab,true);
  document.addEventListener('click',releaseToNativeTab,true);
  document.addEventListener('keydown',releaseToNativeTab,true);
  new MutationObserver(records=>{
    if(records.some(r=>!r.target.closest?.('#lft-panel,#lft-background-status') && [...r.addedNodes,...r.removedNodes].some(n=>n.id!=='lft-panel'&&n.id!=='lft-style'&&n.id!=='lft-tab'&&n.id!=='lft-background-status')))schedule();
  }).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('popstate',schedule);window.addEventListener('hashchange',()=>{tabActive=location.hash==='#liftosaur';applyTabState();});setInterval(()=>{if(!document.hidden)schedule();},2000);
  GM_registerMenuCommand('Liftosaur settings',()=>{settingsOpen=true;if(panel){activateTab(true);render();panel.scrollIntoView({block:'center'});}else alert('Open a completed strength activity to configure Liftosaur.');});
  GM_registerMenuCommand('Refresh and sync all weight trainings',()=>syncAllWorkouts(true));
  cc.start(async()=>{const a=cc.intervals(page);cc.record('intervals',a,a?'connected':'failed',a?'Athlete context readable':'Open a signed-in Intervals tab');if(!credentials?.key){cc.record('liftosaur',null,'failed','Credential not configured');return;}await fetchHistory({start:Date.now()-1000,end:Date.now()});});
  refreshPage();
})();
})();
