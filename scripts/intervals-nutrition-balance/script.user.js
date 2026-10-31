// ==UserScript==
// @name Intervals.icu Nutrition Balance
// @namespace piscuj.intervals.nutrition-balance
// @version 0.4.2
// @description Weekly calorie balance and protein, fat and carb averages in the Intervals.icu calendar.
// @match https://intervals.icu/*
// @match https://www.intervals.icu/*
// @grant GM_getValue
// @grant GM_setValue
// @grant unsafeWindow
// @run-at document-idle
// @noframes
// @license MIT
// @updateURL https://piscuj.github.io/userscript-library/scripts/intervals-nutrition-balance/script.meta.js
// @downloadURL https://piscuj.github.io/userscript-library/scripts/intervals-nutrition-balance/script.user.js
// @match        https://piscuj.github.io/userscript-library/*
// @grant        GM_info
// @grant GM.openInTab
// @sandbox JavaScript
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

const cc=createControlReporter({"id":"intervals-nutrition-balance","version":"0.4.2","old":"0.2.2","services":["intervals"]},typeof window==='undefined'?globalThis:{Date,crypto:window.crypto,navigator:window.navigator,location:window.location,document:window.document,window,pageWindow:typeof unsafeWindow==='object'?unsafeWindow:window,addEventListener:window.addEventListener.bind(window),postMessage:window.postMessage.bind(window),setInterval:window.setInterval.bind(window),GM:typeof GM==='object'?GM:undefined,GM_info:typeof GM_info==='object'?GM_info:undefined,GM_getValue:typeof GM_getValue==='function'?GM_getValue:undefined,GM_setValue:typeof GM_setValue==='function'?GM_setValue:undefined});
if(cc.onLibrary())return;
(function () {
  'use strict';
  const page=pageObject(typeof unsafeWindow==='object'?unsafeWindow:window);
  const document=window.document;
  const BASE = 2200, CLASS = 'icu-calorie-balance', STYLE = CLASS + '-style';
  const MACROS = [
    {key:'protein',name:'Protein',color:'#ff7078',lightColor:'#b42336'},
    {key:'fatTotal',name:'Fat',color:'#ffbd45',lightColor:'#8a5700'},
    {key:'carbohydrates',name:'Carbs',color:'#22d3ee',lightColor:'#007386'}
  ];
  const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const localDate = d => d && typeof d.toISODate === 'function' ? d.toISODate() : null;
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const format = value => {
    const rounded = Math.round(value);
    return (rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '') + Math.abs(rounded).toLocaleString('en-GB');
  };
  function calorieMap(activities) {
    const map = new Map(), seen = new Set();
    for (const activity of activities) {
      if (activity.id != null && seen.has(activity.id)) continue;
      if (activity.id != null) seen.add(activity.id);
      const day = String(activity.start_date_local || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const previous = map.get(day) ?? 0;
      map.set(day, previous === null || !number(activity.calories) ? null : previous + activity.calories);
    }
    return map;
  }
  function balance(day, active, currentDay) {
    const date = localDate(day.date), intake = day.wellness?.kcalConsumed;
    if (!date || date > currentDay || !number(intake)) return null;
    const out = active.has(date) ? active.get(date) : 0;
    return out === null ? null : {date, intake, out, value: intake - (BASE + out)};
  }
  function weekBalance(days, active, currentDay) {
    const rows = days.map(day => balance(day, active, currentDay)).filter(Boolean);
    return rows.length ? {value: rows.reduce((sum,r) => sum+r.value,0)/rows.length, count:rows.length} : null;
  }
  function weekMacros(days,currentDay) {
    return MACROS.map(macro => {
      const values=days.filter(day=>{const date=localDate(day.date);return date && date<=currentDay;})
        .map(day=>day.wellness?.[macro.key]).filter(number);
      return {...macro,count:values.length,value:values.length?values.reduce((sum,v)=>sum+v,0)/values.length:null};
    });
  }
  // Intervals' production Vue renderer keeps the root VNode on its app container.
  // Walk only the rendered tree, without changing any application state or data.
  function walk(vnode, visit, seen = new Set()) {
    if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return;
    seen.add(vnode);
    if (visit(vnode) === false) return;
    if (vnode.component?.subTree) walk(vnode.component.subTree, visit, seen);
    if (Array.isArray(vnode.children)) for (const child of vnode.children) walk(child, visit, seen);
    if (vnode.suspense?.activeBranch) walk(vnode.suspense.activeBranch, visit, seen);
  }
  // Firefox exposes native DOM through Xray wrappers, hiding page-added Vue properties.
  // Only unwrap objects read from the page; keep DOM creation in the userscript document.
  function pageObject(value) {
    try { return value?.wrappedJSObject || value; } catch { return value; }
  }
  function vueApplication(root) {
    try { return pageObject(root)?.__vue_app__ || null; } catch { return null; }
  }
  // The page and userscript can expose distinct wrappers for the same DOM node.
  function keepNode(keep,node) { node.setAttribute('data-icu-balance-refresh',keep); }
  function isKeptNode(keep,node) { return node.getAttribute('data-icu-balance-refresh')===keep; }
  function firstElement(vnode) {
    let element=null;
    walk(vnode,node=>{
      if(element)return false;
      if(node.el?.nodeType===1){element=node.el;return false;}
    });
    return element;
  }
  // Use rendered order, independent of summary component names and summary props.
  function dayWeekHeader(element,calendarElement) {
    const week=element.closest('.week');
    const side=week && [...week.children].find(node=>node.classList.contains('border-top'));
    if(side)return side;
    const scope=calendarElement?.closest('.cal') || calendarElement;
    if(!scope?.querySelectorAll)return null;
    let header=null;
    for(const top of scope.querySelectorAll('.summary-top')) {
      if(top.compareDocumentPosition(element)&4)header=top.firstElementChild || top;
    }
    return header;
  }
  function addWeekDay(weeks,header,day) {
    const date=localDate(day?.date);
    if(!header || !date)return;
    let key=header.getAttribute('data-icu-week-key');
    if(!key){key='week-'+(++weekKey);header.setAttribute('data-icu-week-key',key);}
    if(!weeks.has(key))weeks.set(key,{header,days:new Map()});
    weeks.get(key).days.set(date,day);
  }
  let weekKey=0, refreshId=0;
  function mountStyle() {
    if (document.getElementById(STYLE)) return;
    const style = document.createElement('style');
    style.id = STYLE;
    style.textContent = `.${CLASS},.icu-week-macros{display:inline-flex;align-items:center;gap:4px;font-size:inherit;line-height:inherit;font-weight:inherit;vertical-align:middle;margin:0 6px;font-variant-numeric:tabular-nums}.${CLASS}{white-space:nowrap}.${CLASS} i{font-size:1.15em;font-style:normal}.icu-week-macros{gap:0;flex-wrap:nowrap;white-space:nowrap}.icu-week-macros>span{white-space:nowrap}`;
    document.head.append(style);
  }
  function typography(el,reference) {
    if (!reference) return;
    const style=getComputedStyle(reference);
    for (const key of ['fontSize','fontWeight','lineHeight']) if(el.style[key]!==style[key]) el.style[key]=style[key];
  }
  function badge(parent, value, title, weekly, keep, reference=null, calendarEl=null) {
    let el = [...parent.children].find(node => node.classList.contains(CLASS));
    if (!el) {
      el = document.createElement('span');
      el.className = CLASS;
      el.innerHTML = '<i class="mdi mdi-scale" aria-hidden="true"></i><span></span>';
      parent.append(el);
    }
    if(reference?.parentElement===parent && reference.nextElementSibling!==el) reference.insertAdjacentElement('afterend',el);
    typography(el,reference);
    const native=calendarEl?.querySelector('.day .mdi-scale')?.closest('.summary-grid');
    const light=!!calendarEl?.closest('.v-theme--light');
    const color=native?getComputedStyle(native).color:(light?'#7c3aed':'#bb92ff');
    if(el.style.color!==color)el.style.color=color;
    const text = `${format(value)} ${weekly ? 'kcal/day' : 'kcal'}`;
    const label = `${weekly ? 'Average daily calorie balance' : 'Calorie balance'}: ${text}`;
    if (el.lastElementChild.textContent !== text) el.lastElementChild.textContent = text;
    if (el.title !== title) el.title = title;
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label',label);
    keepNode(keep,el);
  }
  function macroBadges(parent,averages,keep,reference,calendarEl) {
    if (!averages.some(m=>m.value!==null)) return;
    let group=[...parent.children].find(node=>node.classList.contains('icu-week-macros'));
    if(!group){group=document.createElement('span');group.className='icu-week-macros';parent.append(group);}
    typography(group,reference);
    let rendered=0;
    for(const macro of averages){
      let el=group.querySelector(`[data-macro="${macro.key}"]`);
      if(macro.value===null){el?.remove();continue;}
      if(!el){
        el=document.createElement('span');el.dataset.macro=macro.key;
        group.append(el);
      }
      if(group.children[rendered]!==el)group.insertBefore(el,group.children[rendered]||null);
      const color=calendarEl?.closest('.v-theme--light')?macro.lightColor:macro.color;
      if(el.style.color!==color) el.style.color=color;
      const text=Math.round(macro.value).toLocaleString('en-GB')+'g';
      const display=(rendered++?'/':'')+text;
      if(el.textContent!==display)el.textContent=display;
      const title=`Average ${macro.name.toLowerCase()}: ${text}/day across ${macro.count} logged ${macro.count===1?'day':'days'}. Missing entries and future days excluded.`;
      if(el.title!==title){el.title=title;el.setAttribute('aria-label',title);}
    }
    keepNode(keep,group);
  }
  function refresh() {
    mountStyle();ccCalendarReadable=false;
    const keep = String(++refreshId), currentDay = today(), calendars = [];
    const ccAccount=cc.intervals(page); cc.observe('intervals',ccAccount);
    for (const root of document.querySelectorAll('[data-v-app]')) {
      const app = vueApplication(root);
      if (!app) continue;
      walk(app._container?._vnode, vnode => {
        const type = vnode.component?.type || vnode.type;
        if ((type?.__name || type?.name) === 'ActivityCalendar') {calendars.push(vnode);return false;}
      });
    }
    for (const calendar of calendars) {
      const props = calendar.component?.props || calendar.props;
      if (props?.plan || !Array.isArray(props?.activities)) continue;
      ccCalendarReadable=true;
      const active = calorieMap(props.activities), weeks = new Map();
      const calendarElement=firstElement(calendar);
      walk(calendar.component?.subTree, vnode => {
        const type = vnode.component?.type || vnode.type;
        if ((type?.__name || type?.name) !== 'ActivityCalendarDay') return;
        const dayProps = vnode.component?.props || vnode.props;
        const el = vnode.el;
        if (!el || el.nodeType !== 1 || !el.isConnected || dayProps?.plan) return false;
        addWeekDay(weeks,dayWeekHeader(el,calendarElement),dayProps.day);
        return false;
      });
      for (const {header,days:dayMap} of weeks.values()) {
        const days=[...dayMap.values()];
        const summary = weekBalance(days,active,currentDay);
        if (header) {
          const reference=header.querySelector('.summary-grid, .data');
          if(summary) badge(header,summary.value,`Average daily calorie balance: ${format(summary.value)} kcal/day across ${summary.count} logged ${summary.count === 1 ? 'day' : 'days'}. Intake \u2212 (${BASE} + active kcal). Includes today when logged; missing intake and future days are excluded.`,true,keep,reference,calendarElement);
          macroBadges(header,weekMacros(days,currentDay),keep,reference,calendarElement);
        }
      }
    }
    if(ccCalendarReadable&&(!ccLastRender || Date.now()-ccLastRender>30000)){ccLastRender=Date.now();cc.record('intervals',ccAccount,'connected','Calendar readable');cc.record('intervals',ccAccount,'success','Calendar rendered');}
    for (const el of document.querySelectorAll('.'+CLASS+', .icu-week-macros')) if (!isKeptNode(keep,el)) el.remove();
  }
  let ccLastRender=0,ccCalendarReadable=false;
  cc.start(async()=>{refresh();cc.record('intervals',cc.intervals(page),ccCalendarReadable?'connected':'failed',ccCalendarReadable?'Calendar readable':'Open a signed-in calendar');});
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(() => {queued=false;refresh();},150);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.('.'+CLASS+', .icu-week-macros') &&
      [...record.addedNodes,...record.removedNodes].some(node => !(node.nodeType === 1 && (node.classList.contains(CLASS) || node.classList.contains('icu-week-macros') || node.id === STYLE))))) schedule();
  });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  refresh();
  // Also catches edits to data hidden by the calendar's display options and midnight.
  setInterval(() => {if (!document.hidden) schedule();},2000);
})();
})();
