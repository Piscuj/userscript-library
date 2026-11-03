// ==UserScript==
// @name         YouTube Watch Later Sort
// @namespace    piscuj.youtube.watch-later-sort
// @version      1.0.1
// @description  Sort your YouTube Watch Later playlist from shortest to longest video and save the order.
// @updateURL    https://piscuj.github.io/userscript-library/scripts/youtube-watch-later-sort/script.meta.js
// @downloadURL  https://piscuj.github.io/userscript-library/scripts/youtube-watch-later-sort/script.user.js
// @match        https://www.youtube.com/*
// @match        https://piscuj.github.io/userscript-library/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.openInTab
// @grant        GM_info
// @grant        unsafeWindow
// @sandbox      JavaScript
// @run-at       document-idle
// @noframes
// @license      MIT
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

const cc=createControlReporter({"id":"youtube-watch-later-sort","version":"1.0.1","services":["youtube"]},typeof window==='undefined'?globalThis:{Date,crypto:window.crypto,navigator:window.navigator,location:window.location,document:window.document,window,pageWindow:typeof unsafeWindow==='object'?unsafeWindow:window,addEventListener:window.addEventListener.bind(window),postMessage:window.postMessage.bind(window),setInterval:window.setInterval.bind(window),GM:typeof GM==='object'?GM:undefined,GM_info:typeof GM_info==='object'?GM_info:undefined,GM_getValue:typeof GM_getValue==='function'?GM_getValue:undefined,GM_setValue:typeof GM_setValue==='function'?GM_setValue:undefined});
if(cc.onLibrary())return;
(function () {
  'use strict';
  const page=typeof unsafeWindow==='object'?unsafeWindow:window;
  const PLAYLIST_ID='WL', BATCH_SIZE=25, BATCH_PAUSE_MS=250, MAX_PAGES=200, RETRY_DELAYS_MS=[2000,4000,8000];
  // pure:start
  function parseDuration(text) {
    const match=/^\s*(\d+(?::\d{2}){1,2})\s*$/.exec(String(text??''));
    return match?match[1].split(':').reduce((total,part)=>total*60+Number(part),0):null;
  }
  function findValues(node,key,found=[]) {
    if(!node||typeof node!=='object')return found;
    for(const [name,value] of Object.entries(node)) {
      if(name===key)found.push(value);
      findValues(value,key,found);
    }
    return found;
  }
  function firstDuration(values) {
    for(const value of values) {
      const seconds=parseDuration(value?.text);
      if(seconds!==null)return seconds;
    }
    return null;
  }
  function fromLockup(lockup) {
    return {
      videoId:lockup.contentId,
      setVideoId:findValues(lockup,'setVideoId')[0]??null,
      seconds:firstDuration(findValues(lockup,'thumbnailBadgeViewModel')),
    };
  }
  function fromRenderer(renderer) {
    const seconds=Number(renderer.lengthSeconds);
    return {
      videoId:renderer.videoId,
      setVideoId:renderer.setVideoId??null,
      seconds:renderer.lengthSeconds!=null&&Number.isFinite(seconds)?seconds:parseDuration(renderer.lengthText?.simpleText),
    };
  }
  // YouTube serves playlists as lockupViewModel or the older playlistVideoRenderer.
  function parsePlaylistPage(response) {
    const items=[];
    let continuation=null;
    const visit=node=>{
      if(!node||typeof node!=='object')return;
      for(const [name,value] of Object.entries(node)) {
        if(name==='lockupViewModel'&&value?.contentType==='LOCKUP_CONTENT_TYPE_VIDEO')items.push(fromLockup(value));
        else if(name==='playlistVideoRenderer')items.push(fromRenderer(value));
        else if(name==='continuationItemRenderer'||name==='continuationItemViewModel')continuation??=findValues(value,'continuationCommand')[0]?.token??null;
        else visit(value);
      }
    };
    visit(response);
    return {items,continuation};
  }
  function sortByLength(items) {
    return items.map((item,index)=>({item,index}))
      .sort((a,b)=>(a.item.seconds??Infinity)-(b.item.seconds??Infinity)||a.index-b.index)
      .map(entry=>entry.item);
  }
  // Items in the longest run already in target order stay put, so only the rest move.
  function itemsInPlace(items,target) {
    const rank=new Map(target.map((item,index)=>[item.setVideoId,index]));
    const tails=[],previous=new Array(items.length).fill(-1);
    items.forEach((item,index)=>{
      const value=rank.get(item.setVideoId);
      let low=0,high=tails.length;
      while(low<high) {
        const middle=(low+high)>>1;
        if(rank.get(items[tails[middle]].setVideoId)<value)low=middle+1;else high=middle;
      }
      if(low>0)previous[index]=tails[low-1];
      tails[low]=index;
    });
    const kept=new Set();
    for(let index=tails.length?tails[tails.length-1]:-1;index>=0;index=previous[index])kept.add(items[index].setVideoId);
    return kept;
  }
  function planMoves(items) {
    const target=sortByLength(items),kept=itemsInPlace(items,target),moves=[];
    target.forEach((item,index)=>{
      if(kept.has(item.setVideoId))return;
      const move={action:'ACTION_MOVE_VIDEO_AFTER',setVideoId:item.setVideoId};
      if(index>0)move.movedSetVideoIdPredecessor=target[index-1].setVideoId;
      moves.push(move);
    });
    return moves;
  }
  // pure:end

  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const config=key=>{
    const value=page.ytcfg?.get?.(key);
    return value==null?value:JSON.parse(JSON.stringify(value));
  };
  function readCookie(name) {
    const prefix=name+'=';
    return document.cookie.split('; ').find(part=>part.startsWith(prefix))?.slice(prefix.length)??null;
  }
  async function authorization() {
    const secret=readCookie('SAPISID')??readCookie('__Secure-3PAPISID');
    if(!secret||config('LOGGED_IN')===false)throw Error('Sign in to YouTube, then try again.');
    const timestamp=Math.floor(Date.now()/1000);
    const digest=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(timestamp+' '+secret+' '+location.origin));
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    return 'SAPISIDHASH '+timestamp+'_'+hash;
  }
  async function callYouTube(path,body) {
    const context=config('INNERTUBE_CONTEXT');
    if(!context)throw Error('YouTube is still loading. Try again in a moment.');
    for(let attempt=0;;attempt++) {
      const headers={'Content-Type':'application/json','Authorization':await authorization(),'X-Origin':location.origin,'X-Goog-AuthUser':String(config('SESSION_INDEX')??0)};
      const pageId=config('DELEGATED_SESSION_ID');
      if(pageId)headers['X-Goog-PageId']=pageId;
      // Firefox's userscript world can't resolve relative URLs, and page code can't read script-owned objects.
      const init=page.JSON.parse(JSON.stringify({method:'POST',credentials:'same-origin',headers,body:JSON.stringify({context,...body})}));
      const response=await page.fetch(location.origin+'/youtubei/v1/'+path+'?prettyPrint=false',init);
      if(response.ok)return JSON.parse(await response.text());
      if((response.status!==429&&response.status<500)||attempt>=RETRY_DELAYS_MS.length)throw Error('YouTube refused the request (HTTP '+response.status+').');
      await pause(RETRY_DELAYS_MS[attempt]);
    }
  }
  async function readWatchLater(onProgress) {
    const items=[],seen=new Set();
    let request={browseId:'VL'+PLAYLIST_ID};
    for(let pageNumber=0;pageNumber<MAX_PAGES;pageNumber++) {
      const response=await callYouTube('browse',request);
      if(response.alerts?.some(alert=>alert.alertRenderer?.type==='ERROR'))throw Error('YouTube couldn’t open Watch Later, so nothing was moved.');
      const parsed=parsePlaylistPage(response);
      for(const item of parsed.items) {
        if(!item.setVideoId)throw Error('YouTube changed its playlist format, so nothing was moved. The script needs an update.');
        if(!seen.has(item.setVideoId)){seen.add(item.setVideoId);items.push(item);}
      }
      onProgress(items.length);
      if(!parsed.continuation)return items;
      request={continuation:parsed.continuation};
    }
    throw Error('Watch Later is too long to read completely, so nothing was moved.');
  }
  async function applyMoves(moves,onProgress,shouldStop) {
    for(let start=0;start<moves.length;start+=BATCH_SIZE) {
      if(shouldStop())return false;
      const response=await callYouTube('browse/edit_playlist',{playlistId:PLAYLIST_ID,actions:moves.slice(start,start+BATCH_SIZE)});
      if(response.status!=='STATUS_SUCCEEDED')throw Error('YouTube did not accept a move.');
      onProgress(Math.min(start+BATCH_SIZE,moves.length));
      await pause(BATCH_PAUSE_MS);
    }
    return true;
  }

  const isWatchLater=()=>location.pathname==='/playlist'&&new URLSearchParams(location.search).get('list')===PLAYLIST_ID;
  const plural=(count,word)=>count+' '+word+(count===1?'':'s');
  let panel=null,status=null,actions=null,busy=false,stopRequested=false;
  function button(label,onClick,primary) {
    const element=document.createElement('button');
    element.type='button';
    element.textContent=label;
    Object.assign(element.style,{minHeight:'36px',padding:'0 14px',border:'0',borderRadius:'18px',font:'500 14px Roboto,Arial,sans-serif',cursor:'pointer',background:primary?'#fff':'#3f3f3f',color:primary?'#0f0f0f':'#fff'});
    element.addEventListener('click',onClick);
    return element;
  }
  function show(message,buttons) {
    status.textContent=message;
    status.hidden=!message;
    actions.replaceChildren(...buttons);
  }
  const showStart=()=>show('',[button('Sort by length',()=>{void prepare();},true)]);
  const closeButton=()=>button('Close',showStart,false);
  function fail(error) {
    busy=false;
    show(error.message,[closeButton()]);
  }
  async function prepare() {
    busy=true;
    show('Reading Watch Later…',[]);
    try {
      const items=await readWatchLater(count=>{status.textContent='Reading Watch Later… '+plural(count,'video');});
      const moves=planMoves(items);
      busy=false;
      if(!items.length){show('Watch Later is empty.',[closeButton()]);return;}
      if(!moves.length){show('Already sorted: '+plural(items.length,'video')+'.',[closeButton()]);return;}
      const unknown=items.filter(item=>item.seconds===null).length;
      show('Sort '+plural(items.length,'video')+' from shortest to longest? This needs '+plural(moves.length,'move')+' and replaces the saved order, which can’t be restored.'+(unknown?' '+plural(unknown,'video')+' without a length (such as live streams) will go last.':''),
        [button('Sort',()=>{void run(moves);},true),button('Cancel',showStart,false)]);
    } catch(error) { fail(error); }
  }
  async function run(moves) {
    busy=true;
    stopRequested=false;
    show('Moving 0 of '+moves.length+'…',[button('Stop',()=>{stopRequested=true;status.textContent='Stopping…';},false)]);
    try {
      const finished=await applyMoves(moves,done=>{if(!stopRequested)status.textContent='Moving '+done+' of '+moves.length+'…';},()=>stopRequested);
      if(!finished){busy=false;show('Stopped. The list is partly sorted; sort again to finish.',[button('Reload',()=>location.reload(),true),closeButton()]);return;}
      show('Checking the saved order…',[]);
      const items=await readWatchLater(()=>{});
      const left=planMoves(items).length;
      busy=false;
      if(left)show('Not fully sorted: '+plural(left,'video')+' still out of place. Sort again to finish.',[closeButton()]);
      else show('Sorted '+plural(items.length,'video')+'.',[button('Reload',()=>location.reload(),true)]);
    } catch(error) {
      fail(Error(error.message+' The list may be partly sorted; sort again to finish.'));
    }
  }
  function createPanel() {
    panel=document.createElement('div');
    panel.setAttribute('role','group');
    panel.setAttribute('aria-label','Sort Watch Later');
    Object.assign(panel.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:'2300',maxWidth:'min(340px,calc(100vw - 32px))',padding:'8px',borderRadius:'12px',background:'#212121',color:'#fff',boxShadow:'0 2px 10px rgba(0,0,0,.4)',font:'400 14px/20px Roboto,Arial,sans-serif'});
    status=document.createElement('p');
    status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');
    Object.assign(status.style,{margin:'4px 6px 8px'});
    actions=document.createElement('div');
    Object.assign(actions.style,{display:'flex',flexWrap:'wrap',justifyContent:'flex-end',gap:'8px'});
    panel.append(status,actions);
    document.body.append(panel);
    showStart();
  }
  // YouTube navigates without page loads, and a running sort must stay visible.
  function syncPanel() {
    if(isWatchLater()||busy) {
      if(!panel)createPanel();
      panel.hidden=false;
    } else if(panel) {
      panel.hidden=true;
      showStart();
    }
  }
  document.addEventListener('yt-navigate-finish',syncPanel);
  syncPanel();
})();
})();
