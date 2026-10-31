/* BOP Guest Log Book – installable app.
   Settings, activities and voucher rules are kept on the phone and refreshed only when the sheet changes.
   Entries are saved on the phone first, then sent to the Google Sheet in the background. */
(function(){
"use strict";
const APP_VERSION = "2.0.0";   // raise this together with VERSION in sw.js whenever you change an app file

/* ---------- Basics ---------- */
const $ = s => document.querySelector(s);
const API_URL = String((window.BOP_CONFIG || {}).API_URL || "").trim();
const S_KEY = "bop_session_v2", Q_KEY = "bop_queue_v1", P_KEY = "bop_pack_v2";
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
  del(k){ try { localStorage.removeItem(k); } catch(e){} }
};
const pad = (n,l) => String(n).padStart(l||2, "0");
/* Screen data kept in memory (and, for the front desk only, on the phone) so tabs open instantly */
const mem = {}, inflight = {};
const ckey = kind => "bop_c_" + kind + "_" + (session ? session.role + "_" + session.name : "");
function cached(kind){ if (mem[kind]) return mem[kind]; if (session && session.role !== "Admin"){ const v = store.get(ckey(kind)); if (v) mem[kind] = v; return v; } return null; }
function keep(kind, data){ mem[kind] = data; if (session && session.role !== "Admin") store.set(ckey(kind), data); }
function dropCaches(){ Object.keys(mem).forEach(k => delete mem[k]); try { Object.keys(localStorage).forEach(k => { if (k.indexOf("bop_c_") === 0) localStorage.removeItem(k); }); } catch(e){} }
const money = n => "₹" + Math.round(Number(n)||0).toLocaleString("en-IN");
const short = n => n>=1e5 ? "₹"+(n/1e5).toFixed(1)+"L" : n>=1e3 ? "₹"+(n/1e3).toFixed(n>=1e4?0:1)+"k" : "₹"+Math.round(n);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const pds = s => { const p = s.split("-").map(Number); return new Date(p[0], p[1]-1, p[2]); };
const clock = d => (d.getHours()%12||12)+":"+pad(d.getMinutes())+" "+(d.getHours()<12?"AM":"PM");
const toMin = t => { const m = /(\d+):(\d+)\s*([AP]M)/i.exec(t||""); if (!m) return 0; let h = +m[1]%12; if (/p/i.test(m[3])) h += 12; return h*60 + +m[2]; };
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const LEAF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19c0-8 6-14 15-14 0 9-6 15-14 15"/><path d="M5 19l8-8"/></svg>';

function toast(msg, bad){ const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600); }
function openSheet(html){ $("#sheet").innerHTML = html; $("#scrim").hidden = false; }
function closeSheet(){ $("#scrim").hidden = true; }

/* This phone's IDs: a long one for the server, three letters for booking numbers */
function randomLetters(n){ const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; let s = ""; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random()*A.length)]; return s; }
let DEV = store.get("bop_dev");
if (!DEV){ DEV = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + randomLetters(12); store.set("bop_dev", DEV); }

/* ---------- Server calls ---------- */
// Every call goes to the Apps Script web app as plain text, which Google accepts from any website
async function api(fn){
  const args = Array.prototype.slice.call(arguments, 1);
  if (!API_URL) throw new Error("The app isn’t connected to the sheet yet. Add the web app URL to config.js.");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(API_URL, {method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify({fn, args}), redirect: "follow", signal: ctl.signal});
  } catch(e){
    const err = new Error("No internet connection."); err.offline = true; throw err;
  } finally { clearTimeout(timer); }
  let out;
  try { out = await res.json(); }
  catch(e){ const err = new Error("The sheet didn’t answer properly. Check the web app URL and that it is deployed for “Anyone”."); err.offline = !res.ok; throw err; }
  if (!out.ok) throw new Error(out.error || "Something went wrong.");
  return out.data;
}
function expired(err){
  if (!/SESSION_EXPIRED/.test(err && err.message || "")) return false;
  dropCaches(); todayData = null; dash = null;
  store.del(S_KEY); session = null; showLogin("Your sign-in ended. Enter your PIN again.");
  return true;
}

/* ---------- Session, stored sheet data and queue ---------- */
let session = store.get(S_KEY);
let pack = store.get(P_KEY);              // {ver, config, vouchers} from the sheet
let config = pack && pack.config;
let queue = store.get(Q_KEY) || [];
let view = "desk", lastSync = 0;

function usePack(p){
  if (!p || !p.config) return;
  pack = p; config = p.config; store.set(P_KEY, p);
}
// Asks the sheet "has anything changed since my copy?" Only new data is downloaded.
async function syncData(force){
  if (!session || inflight.sync) return inflight.sync;
  if (!force && Date.now() - lastSync < 10*60*1000) return;
  inflight.sync = (async () => {
    try {
      const r = await api("sync", session.token, pack ? pack.ver : "");
      lastSync = Date.now();
      if (r.role !== session.role || r.name !== session.name){ session.role = r.role; session.name = r.name; store.set(S_KEY, session); paintUser(); }
      if (r.data){
        const first = !config;
        usePack(r.data);
        if (view === "desk" && (first || !calc().heads)) renderDesk();
        if (!first) toast("Prices and vouchers updated");
      }
    } catch(err){ expired(err); }
    finally { inflight.sync = null; }
  })();
  return inflight.sync;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session){ syncData(); flush(); } });

function saveQueue(){ store.set(Q_KEY, queue); updateSync(); }
function updateSync(){
  const el = $("#sync"); if (!el) return;
  if (!navigator.onLine){ el.className = "sync off"; el.textContent = queue.length ? "Offline, "+queue.length+" to send" : "Offline"; }
  else if (queue.length){ el.className = "sync wait"; el.textContent = queue.length+" to send"; }
  else { el.className = "sync"; el.textContent = "All saved"; }
}
let flushing = false, retryT = null;
async function flush(){
  if (flushing || !queue.length || !session) return;
  flushing = true;
  try {
    const batch = queue.slice(0, 25);
    const res = await api("saveEntries", session.token, batch);
    const ok = new Set(res.saved || []);
    queue = queue.filter(e => !ok.has(e.id));
    saveQueue();
    Object.keys(res.renamed || {}).forEach(a => toast("Entry "+a+" was saved as "+res.renamed[a]+" (the number was already used)"));
    refreshSoon();
  } catch(err){
    if (!expired(err) && !err.offline) toast("Couldn’t send entries: "+err.message, true);
  } finally {
    flushing = false; updateSync();
    clearTimeout(retryT);
    if (queue.length) retryT = setTimeout(flush, 15000);
  }
}
setInterval(flush, 30000);
window.addEventListener("online", () => { updateSync(); flush(); syncData(true); });
window.addEventListener("offline", updateSync);

function nextId(now){
  let dev = store.get("bop_device");
  if (!dev || dev.length < 3){ dev = randomLetters(3); store.set("bop_device", dev); }
  const key = "bop_seq_" + ymd(now);
  const n = (store.get(key) || 0) + 1; store.set(key, n);
  if (n === 1){ try { Object.keys(localStorage).forEach(k => { if (k.indexOf("bop_seq_")===0 && k !== key) store.del(k); }); } catch(e){} }
  return "BOP-" + pad(now.getDate()) + pad(now.getMonth()+1) + "-" + dev + pad(n);
}

/* ---------- Install button (Android Chrome) ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (!session) renderLogin(""); });
window.addEventListener("appinstalled", () => { installEvt = null; toast("App installed. Open it from the home screen."); if (!session) renderLogin(""); });

/* ---------- Login ---------- */
let pin = "";
function showLogin(msg){
  document.body.classList.add("is-login");
  ["desk","today","dash"].forEach(v => $("#v-"+v).hidden = true);
  $("#v-login").hidden = false; $("#dock").hidden = true; $("#who").hidden = true;
  pin = ""; renderLogin(msg || "");
}
function renderLogin(msg){
  if (!API_URL){
    $("#v-login").innerHTML = '<div class="card login"><h2 class="brush">Almost ready</h2><p class="muted">This copy of the app isn’t connected to the Google Sheet yet. Paste the Apps Script web app URL into <b>config.js</b> and upload it again.</p></div>';
    return;
  }
  const dots = Math.max(4, pin.length);
  $("#v-login").innerHTML =
    '<div class="card login"><h2 class="brush">Good to see you</h2><p class="muted">Enter your PIN to open the log book.</p>'+
    '<div class="pins" aria-label="'+pin.length+' digits entered">'+Array.from({length:dots}, (_,i) => '<span class="'+(i<pin.length?"on":"")+'"></span>').join("")+'</div>'+
    '<p class="err" id="pinErr">'+esc(msg)+'</p>'+
    '<div class="pad">'+[1,2,3,4,5,6,7,8,9].map(n => '<button type="button" data-k="'+n+'">'+n+'</button>').join("")+
    '<button type="button" class="sm" data-k="clr">Clear</button><button type="button" data-k="0">0</button><button type="button" class="sm" data-k="del" aria-label="Delete last digit">⌫</button></div>'+
    '<button type="button" class="btn sun wide" id="pinGo"'+(pin.length<4?" disabled":"")+'>Open log book</button>'+
    (installEvt ? '<button type="button" class="btn ghost wide" id="installBtn" style="margin-top:10px">Install app on this phone</button>' : '')+
    '<p class="muted small" style="margin-top:12px">Version '+APP_VERSION+'</p></div>';
}
async function tryLogin(){
  if (pin.length < 4) return;
  $("#pinGo").disabled = true; $("#pinGo").textContent = "Checking…";
  try {
    const r = await api("login", pin, DEV);
    session = {token: r.token, name: r.name, role: r.role};
    store.set(S_KEY, session);
    usePack(r.data); lastSync = Date.now();
    start();
  } catch(err){ pin = ""; renderLogin(err.offline ? "No internet. Signing in needs the internet once; after that the app opens offline." : (err.message || "Couldn’t sign in.")); }
}
$("#v-login").addEventListener("click", e => {
  if (e.target.id === "installBtn" && installEvt){ installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; renderLogin(""); }); return; }
  const b = e.target.closest("[data-k]");
  if (b){ const k = b.dataset.k;
    if (k === "del") pin = pin.slice(0,-1); else if (k === "clr") pin = ""; else if (pin.length < 8) pin += k;
    renderLogin(""); return; }
  if (e.target.id === "pinGo") tryLogin();
});
document.addEventListener("keydown", e => {
  if ($("#v-login").hidden || !API_URL) return;
  if (/^\d$/.test(e.key) && pin.length < 8){ pin += e.key; renderLogin(""); }
  else if (e.key === "Backspace"){ pin = pin.slice(0,-1); renderLogin(""); }
  else if (e.key === "Enter") tryLogin();
});

/* ---------- App shell ---------- */
const ICONS = {
  desk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="10"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V11M10 20V5M16 20v-7M22 20H2"/></svg>'
};
let refreshT = null;
// after a save, refresh only the tab on screen; the others refresh when opened
function refreshSoon(){ clearTimeout(refreshT); refreshT = setTimeout(() => { if (!session) return; if (view === "today") loadToday(true); else if (view === "dash") loadDash(); else delete mem.today; }, 1500); }
function paintUser(){ $("#userBtn").textContent = session.name + (session.role === "Admin" ? ", admin" : ""); }
function start(){
  document.body.classList.remove("is-login");
  $("#v-login").hidden = true; $("#dock").hidden = false; $("#who").hidden = false;
  paintUser();
  const tabs = [["desk","New entry"],["today","Today"],["dash","Dashboard"]];
  $("#tabs").innerHTML = tabs.map(t => '<button type="button" data-tab="'+t[0]+'">'+ICONS[t[0]]+t[1]+'</button>').join("");
  updateSync(); resetDesk(); show("desk"); flush();
  if (!config) $("#v-desk").innerHTML = '<div class="card"><div class="skel" style="width:60%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>';
  syncData();
}
function show(v){
  view = v;
  ["desk","today","dash"].forEach(x => $("#v-"+x).hidden = x !== v);
  document.querySelectorAll("#tabs button").forEach(b => { if (b.dataset.tab === v) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current"); });
  document.body.classList.toggle("no-pay", v !== "desk");
  if (v === "today") loadToday();
  if (v === "dash") loadDash();
  window.scrollTo(0,0);
}
$("#tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); });
$("#userBtn").addEventListener("click", () => {
  openSheet('<h2 class="brush">'+esc(session.name)+'</h2><p class="center muted">Signed in as '+(session.role==="Admin"?"admin":"front desk")+'</p>'+
    (queue.length ? '<p class="hint warn center">'+queue.length+' entries are still waiting to send. They stay on this phone and send after the next sign-in.</p>' : '')+
    '<p class="center muted small">App version '+APP_VERSION+(pack ? ', sheet data '+esc(pack.ver) : '')+(lastSync ? '<br>Last checked with the sheet at '+clock(new Date(lastSync)) : '')+'</p>'+
    '<div class="actions"><button class="btn ghost" data-act="update">Check for updates</button><button class="btn danger" data-act="logout">Sign out</button><button class="btn ghost" data-act="close">Close</button></div>');
});

/* ---------- Desk ---------- */
const st = {};
function resetDesk(keepKind){
  if (st.vrule && st.vheld) releaseVoucher(st.vrule.code);
  const kind = keepKind ? st.kind : "walkin", school = keepKind ? st.school : "private";
  Object.assign(st, {kind, school, name:"", phone:"", heard:"", guests:0, under3:0, students:0, teachers:0, acts:{}, voucher:"", vrule:null, vstate:"", vmsg:"", vheld:false, voffline:false, note:""});
  if (view === "desk" || !keepKind) renderDesk();
}
function actIcon(n){ n = n.toLowerCase();
  if (/pony/.test(n)) return "🐴"; if (/horse/.test(n)) return "🏇"; if (/atv|quad|bike/.test(n)) return "🏍️";
  if (/zip/.test(n)) return "🪂"; if (/cycl/.test(n)) return "🚲"; if (/fish/.test(n)) return "🎣";
  if (/bridge|burma|rope/.test(n)) return "🌉"; if (/combo/.test(n)) return "🎟️"; return "🌿"; }

// The whole bill for one entry. Copied word for word from priceOf in Code.gs,
// so the phone and the sheet always agree. If you change one, change the other.
function priceOf(p, cfg, r) {
  const sch = p.kind === 'school';
  const group = sch ? p.students : p.guests;
  const vMeets = !!(r && group >= (r.minGuests || 0));
  let free = 0, entryFee, entryAmt;
  if (vMeets && r.type === 'Free entry') free = Math.min(r.value, group);
  if (!sch) { entryFee = cfg.entryFee; entryAmt = Math.max(0, p.guests - free) * entryFee; }
  else {
    entryFee = p.school === 'private' ? cfg.schoolFee : (cfg.govtFee || 0);
    entryAmt = Math.max(0, p.students - free) * entryFee + p.teachers * (cfg.teacherFee || 0);
  }
  // activity combos: largest combo first, then smaller ones, on the dearest activities
  const units = [];
  let actAmt = 0;
  cfg.activities.forEach(a => { const n = p.acts[a.name] || 0; actAmt += n * a.price; for (let i = 0; i < n; i++) units.push(a.price); });
  units.sort((a, b) => b - a);
  const tiers = (cfg.combos || []).slice().sort((a, b) => b.n - a.n);
  const left = units.slice(), combos = [];
  let combo = 0;
  tiers.forEach(t => {
    while (left.length >= t.n) {
      const off = left.slice(0, t.n).reduce((s, v) => s + v, 0) - t.price;
      if (off <= 0) break;
      left.splice(0, t.n); combo += off; combos.push(t.n);
    }
  });
  let next = null;   // nudge: how many more activities unlock a combo
  const n = units.length;
  tiers.slice().reverse().forEach(t => { if (!next && n < t.n && t.n - n <= 2) next = { more: t.n - n, n: t.n }; });
  if (!next && n && tiers.length) { const big = tiers[0]; if (n > tiers[tiers.length - 1].n && n < big.n) next = { more: big.n - n, n: big.n }; }
  const entryOnly = !r || !/activ/i.test(r.appliesTo);
  let discount = 0;
  if (vMeets && r.type === 'Percent off') discount = Math.round((entryOnly ? entryAmt : entryAmt + actAmt - combo) * r.value / 100);
  if (vMeets && r.type === 'Flat off') discount = r.value;
  discount = Math.max(0, Math.min(discount, entryOnly ? entryAmt : entryAmt + actAmt - combo));
  const taxable = entryAmt + actAmt - combo - discount;
  const total = Math.round(taxable * (1 + (cfg.gst || 0) / 100)), gst = total - taxable;
  return { entryFee: entryFee, entryAmt: entryAmt, free: free, actAmt: actAmt, combo: combo, combos: combos, comboNext: next,
    discount: discount, taxable: taxable, gst: gst, total: total, vMeets: vMeets, vApplied: vMeets && (free > 0 || discount > 0) };
}

function calc(){
  if (!config) return {heads:0, nActs:0, total:0, combos:[]};
  const p = priceOf(st, config, st.vrule);
  p.heads = st.kind === "school" ? st.students + st.teachers : st.guests + st.under3;
  p.nActs = Object.values(st.acts).reduce((s,n) => s+n, 0);
  return p;
}
const plusGst = v => money(v) + (config.gst ? " + GST" : "");
const comboPrice = t => t.incl ? money(t.shown) + " incl. GST" : plusGst(t.price);
const comboName = list => list.map(n => n+"-activity combo").join(" + ");
function stepper(key, title, sub){
  const v = st[key] || 0;
  return '<div class="row"><div class="lbl"><b>'+title+'</b><small>'+sub+'</small></div><div class="step" data-key="'+key+'">'+
    '<button type="button" data-d="-1" aria-label="Fewer: '+title+'">−</button>'+
    '<input type="number" inputmode="numeric" min="0" value="'+v+'" aria-label="'+title+'">'+
    '<button type="button" data-d="1" aria-label="More: '+title+'">+</button></div></div>';
}
function tile(a){
  const n = st.acts[a.name] || 0;
  return '<button type="button" class="tile'+(n?" on":"")+'" data-act-name="'+esc(a.name)+'" aria-label="Add '+esc(a.name)+'">'+
    '<span class="em" aria-hidden="true">'+actIcon(a.name)+'</span><b>'+esc(a.name)+'</b><small>'+plusGst(a.price)+(a.note?", "+esc(a.note):"")+'</small>'+
    (n ? '<span class="cnt">'+n+'</span><span class="minus" role="button" data-minus="'+esc(a.name)+'" aria-label="Remove one '+esc(a.name)+'">−</span>' : '')+'</button>';
}
function slotLabel(hm){ const p = String(hm).split(":").map(Number); return (p[0]%12||12)+":"+pad(p[1])+" "+(p[0]<12?"AM":"PM"); }
function upcomingSlots(){
  const all = config.batches || [];
  if (!all.length) return {slots:[], over:false};
  const d = new Date(), nm = d.getHours()*60 + d.getMinutes();
  const i = all.findIndex(x => { const p = x.split(":").map(Number); return p[0]*60 + p[1] > nm; });
  if (i < 0) return {slots:[all[all.length-1]], over:true};
  return {slots: all.slice(i, i+3), over:false};
}
function batchBox(){
  const u = upcomingSlots();
  if (!u.slots.length) return '<p class="hint">No batch times set yet. Add them in the Settings tab of the sheet.</p>';
  if (u.slots.indexOf(st.batch) < 0) st.batch = u.slots[0];
  return '<div class="slots">'+u.slots.map((b,i) => '<button type="button" data-batch="'+esc(b)+'" aria-pressed="'+(st.batch===b)+'"><b>'+slotLabel(b)+'</b><small>'+(i===0 ? (u.over ? "Last batch" : "Next") : "Later")+'</small></button>').join("")+'</div>'+
    (u.over ? '<p class="hint">Today’s last batch has started, so entries go under it.</p>' : '');
}
setInterval(() => {
  const box = document.getElementById("batchBox");
  if (box && view === "desk" && session && config) box.innerHTML = batchBox();   // moves on as batches start
}, 30000);
function renderDesk(){
  if (!config) return;
  const k = st.kind;
  let h = '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Who’s visiting</h2></div>'+
    '<div class="seg" id="kindSeg">'+[["walkin","Walk-in"],["school","School"]].map(x => '<button type="button" data-kind="'+x[0]+'" aria-pressed="'+(k===x[0])+'">'+x[1]+'</button>').join("")+'</div>';
  if (k === "school"){
    h += '<div class="fields one"><label class="f"><span>School name</span><input class="inp" data-field="name" value="'+esc(st.name)+'" autocomplete="off"></label></div>'+
      '<div class="seg" style="margin-top:10px" id="schoolSeg"><button type="button" data-school="private" aria-pressed="'+(st.school==="private")+'">Private</button><button type="button" data-school="government" aria-pressed="'+(st.school==="government")+'">Government</button></div>';
  } else {
    h += '<div class="fields"><label class="f"><span>Name (optional)</span><input class="inp" data-field="name" value="'+esc(st.name)+'" autocomplete="off" autocapitalize="words"></label>'+
      '<label class="f"><span>Phone (optional)</span><input class="inp" data-field="phone" value="'+esc(st.phone)+'" inputmode="tel" autocomplete="off" maxlength="14"></label></div>';
  }
  h += '<div class="f dd" style="margin-top:10px"><span id="heardLbl">How did they hear about us? <em class="req">Required</em></span>'+
    '<button type="button" class="inp ddbtn'+(st.heardErr?" bad":"")+(st.heard?" set":"")+'" id="heardBtn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="heardLbl heardBtn">'+esc(st.heard || "Choose one")+'</button>'+
    '<div class="ddpanel" id="heardPanel" role="listbox" aria-labelledby="heardLbl" hidden>'+(config.heard||[]).map(o => '<button type="button" role="option" data-heard="'+esc(o)+'" aria-selected="'+(st.heard===o)+'">'+esc(o)+'</button>').join("")+'</div></div>';
  h += '</div><div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Batch</h2><span class="aside">Next batches</span></div><div id="batchBox">'+batchBox()+'</div></div>';
  h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Guests</h2></div>';
  if (k === "school"){
    const sFee = st.school === "private" ? config.schoolFee : (config.govtFee || 0);
    h += stepper("students","Students", sFee ? plusGst(sFee)+" each" : "Free") + stepper("teachers","Teachers and staff", config.teacherFee ? plusGst(config.teacherFee)+" each" : "Free") +
      '<p class="hint">Tap a number to type it directly.</p>';
  } else {
    h += stepper("guests", "Age 3 and above", plusGst(config.entryFee)+" each"+(config.gst ? " ("+money(Math.round(config.entryFee*(1+config.gst/100)))+")" : "")) +
      stepper("under3","Under 3","Free, still counted");
  }
  h += '</div>';
  if (config.activities.length){
    h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Activities</h2><span class="aside">Tap to add</span></div><div class="tiles" id="tiles">'+config.activities.map(tile).join("")+'</div><div id="comboBox"></div></div>';
  }
  h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Voucher</h2><span class="aside">'+(k === "school" ? "School discount code, if any" : "Only if the guest has one")+'</span></div>'+voucherBox()+'</div>';
  h += '<div class="card"><details class="more"'+(st.note?" open":"")+'><summary>Add a note</summary>'+
    '<div class="fields one" style="margin-top:10px"><label class="f"><span>Note</span><textarea class="inp" data-field="note" maxlength="300">'+esc(st.note)+'</textarea></label></div></details></div>';
  $("#v-desk").innerHTML = h;
  updatePay();
}
function voucherBox(){
  if (st.vrule){
    const v = st.vrule;
    const extra = [v.source, v.issuedTo].filter(Boolean).join(", ");
    return '<div class="vok"><div><b>'+esc(v.code)+'</b><span>'+esc(v.label)+(extra ? ". "+esc(extra) : "")+'</span></div><button type="button" class="vrm" data-vact="remove">Remove</button></div><p class="hint" id="vHint"></p>';
  }
  const busy = st.vstate === "checking";
  return '<div class="vrow"><input class="inp" data-field="voucher" id="vCode" value="'+esc(st.voucher)+'" placeholder="Voucher code" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="30">'+
    '<button type="button" class="btn forest" data-vact="check"'+(busy?" disabled":"")+'>'+(busy?"Checking…":"Check")+'</button></div>'+
    '<p class="hint'+(st.vstate==="bad"?" warn":"")+'" id="vHint">'+esc(st.vmsg || "Type the code and tap Check. The discount is applied automatically.")+'</p>';
}
function voucherHint(){
  const el = $("#vHint"); if (!el || !st.vrule) return;
  const c = calc(), v = st.vrule;
  if (c.vApplied){ el.className = "hint ok"; el.textContent = "Applied. Saves "+money((c.free * c.entryFee + c.discount) * (1 + (config.gst||0)/100))+" including GST."+(st.voffline ? " Checked without internet: the sheet will confirm it when the entry sends." : ""); }
  else if (!c.vMeets){ el.className = "hint warn"; el.textContent = "Needs at least "+v.minGuests+(st.kind === "school" ? " students" : " guests aged 3+")+" to apply."; }
  else { el.className = "hint"; el.textContent = "Add guests to apply it."; }
}

/* Vouchers: the phone keeps the voucher rules with each code scrambled (SHA-256), so a typo or an
   expired code is answered instantly. Codes with a use limit are then confirmed with the sheet,
   which holds the code for this phone so another phone can't use it at the same time. */
async function sha256hex(t){
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}
const prettyYmd = d => { const p = d.split("-").map(Number); return p[2]+" "+MON[p[1]-1]+" "+p[0]; };
async function localVoucher(code){
  const vp = pack && pack.vouchers;
  if (!vp || !window.crypto || !crypto.subtle) return null;
  const ix = vp.codes[(await sha256hex(vp.salt + code)).slice(0, 16)];
  if (ix === undefined) return null;
  const r = vp.rules[ix];
  return {code, type:r[0], value:r[1], appliesTo:r[2], minGuests:r[3], from:r[4], to:r[5], maxUses:r[6], forKind:r[7], source:r[8]};
}
// Same rules as voucherStatus_ in Code.gs (minus the use count, which only the sheet knows)
function evalVoucher(v, kind){
  const t = ymd(new Date());
  if (v.forKind && v.forKind !== "Any" && v.forKind !== kind) return {ok:false, reason: v.forKind === "School" ? "This code is only for school visits." : "This code is only for walk-in guests."};
  if (v.from && t < v.from) return {ok:false, reason:"Not valid yet. It starts on "+prettyYmd(v.from)+"."};
  if (v.to && t > v.to) return {ok:false, reason:"Expired on "+prettyYmd(v.to)+"."};
  if (["Free entry","Percent off","Flat off"].indexOf(v.type) < 0 || !(v.value > 0)) return {ok:false, reason:"This voucher isn’t set up fully. Ask an admin to check its Offer type and Value."};
  if (v.type === "Free entry" && v.value > 50) return {ok:false, reason:"This voucher gives "+v.value+" free entries, which looks like a price. For Free entry, Value is the number of free tickets (usually 1). Ask an admin to fix it."};
  if (v.type === "Percent off" && v.value > 100) return {ok:false, reason:"This voucher’s percentage is over 100. Ask an admin to fix it."};
  let label = v.type === "Free entry" ? v.value + (v.value === 1 ? " free entry" : " free entries")
    : v.type === "Percent off" ? v.value + "% off " + (v.appliesTo === "Entry" ? "entry" : "entry + activities")
    : "₹" + v.value + " off " + (v.appliesTo === "Entry" ? "entry" : "the bill");
  if (v.minGuests > 1) label += " for groups of " + v.minGuests + "+";
  if (v.to) label += ", valid till " + prettyYmd(v.to);
  return Object.assign({}, v, {ok:true, issuedTo:"", label});
}
function applyVoucherResult(res, extra){
  if (res && res.ok){ Object.assign(st, {vrule: res, vstate: "ok", vmsg: "", vheld: false, voffline: false}, extra || {}); }
  else { st.vrule = null; st.vstate = "bad"; st.vmsg = (res && res.reason) || "This voucher can’t be used."; }
  if (view === "desk") renderDesk();
}
function releaseVoucher(code){ if (session) api("releaseVoucher", session.token, code, DEV).catch(() => {}); }
async function checkVoucher(){
  const code = st.voucher.trim().toUpperCase();
  if (!code){ st.vstate = "bad"; st.vmsg = "Type the voucher code first."; renderDesk(); return; }
  st.voucher = code;
  const kind = st.kind === "school" ? "School" : "Walk-in";
  let local = null;
  try { local = await localVoucher(code); } catch(e){}
  if (local){
    const res = evalVoucher(local, kind);
    if (!res.ok || !local.maxUses){ applyVoucherResult(res); return; }     // instant: no server call needed
  }
  // limited-use codes are confirmed (and held) by the sheet; unknown codes may be new or expired
  st.vstate = "checking"; st.vmsg = ""; renderDesk();
  try {
    const res = await api("checkVoucher", session.token, code, kind, DEV);
    applyVoucherResult(res, res.ok && res.maxUses ? {vheld: true} : null);
  } catch(err){
    if (expired(err)) return;
    if (err.offline && local) applyVoucherResult(evalVoucher(local, kind), {voffline: true});
    else applyVoucherResult({ok:false, reason: err.offline ? "No internet, and this code isn’t in the phone’s list. Try again when online, or continue without it." : err.message});
  }
}
function updatePay(){
  if (!config) return;
  const c = calc();
  const parts = [];
  if (c.heads) parts.push(c.heads + (c.heads===1 ? " guest" : " guests"));
  if (c.nActs) parts.push(c.nActs + (c.nActs===1 ? " activity" : " activities"));
  if (c.combo) parts.push("combo applied");
  if (c.vApplied) parts.push("voucher applied");
  const cbx = $("#comboBox");
  if (cbx){
    const names = {}; c.combos.forEach(n => names[n] = (names[n]||0) + 1);
    const applied = Object.keys(names).sort((a,b) => b-a).map(n => (names[n] > 1 ? names[n]+" × " : "")+n+"-activity combo").join(" + ");
    let html = "";
    if (c.combo) html += '<div class="combo on"><b>🎉 '+esc(applied)+' applied</b><span>Guest saves '+money(c.combo * (1 + (config.gst||0)/100))+'</span></div>';
    const tier = c.comboNext && (config.combos||[]).find(t => t.n === c.comboNext.n);
    if (tier) html += '<div class="combo"><b>Add '+c.comboNext.more+' more '+(c.comboNext.more===1?"activity":"activities")+'</b><span>to get the '+tier.n+'-activity combo for '+comboPrice(tier)+'</span></div>';
    cbx.innerHTML = html;
  }
  let btns;
  if (!c.heads) btns = '<button type="button" class="btn sun" disabled>Add guests to start</button>';
  else if (c.total > 0) btns = config.modes.map((m,i) => '<button type="button" class="btn '+(i===0?"ghost":"sun")+'" data-pay="'+esc(m)+'">'+esc(m)+'</button>').join("");
  else btns = '<button type="button" class="btn forest" data-pay="">Save entry</button>';
  document.body.classList.toggle("pay-on", c.heads > 0);   // bar shows only once something is added
  $("#pay").innerHTML = '<div class="tot"><div class="amt">'+money(c.total)+'</div><small>'+(parts.join(", ") || "Nothing added yet")+'</small></div><div class="paybtns">'+btns+'</div>';
  voucherHint();
}
const desk = $("#v-desk");
desk.addEventListener("keydown", e => { if (e.target.id === "vCode" && e.key === "Enter"){ e.preventDefault(); checkVoucher(); } });
desk.addEventListener("click", e => {
  if (e.target.closest("#heardBtn")){ const p = $("#heardPanel"), open = p.hidden; p.hidden = !open; $("#heardBtn").setAttribute("aria-expanded", String(open)); if (open){ const dock = $("#dock").getBoundingClientRect().top, r = p.getBoundingClientRect();
      if (r.bottom > dock - 8) window.scrollBy({top: r.bottom - dock + 16, behavior: "smooth"});
      const sel = p.querySelector('[aria-selected="true"]') || p.querySelector("button"); sel.focus({preventScroll:true}); } return; }
  const hb = e.target.closest("[data-heard]");
  if (hb){ st.heard = hb.dataset.heard; st.heardErr = false; const b = $("#heardBtn"); b.textContent = st.heard; b.classList.add("set"); b.classList.remove("bad");
    $("#heardPanel").querySelectorAll("[data-heard]").forEach(x => x.setAttribute("aria-selected", String(x === hb))); closeHeard(); b.focus(); return; }
  const va = e.target.closest("[data-vact]");
  if (va){ if (va.dataset.vact === "check") checkVoucher(); else { if (st.vrule && st.vheld) releaseVoucher(st.vrule.code); Object.assign(st, {voucher:"", vrule:null, vstate:"", vmsg:"", vheld:false, voffline:false}); renderDesk(); } return; }
  const bb = e.target.closest("[data-batch]");
  if (bb){ st.batch = bb.dataset.batch; $("#batchBox").innerHTML = batchBox(); return; }
  const kb = e.target.closest("[data-kind]");
  if (kb){ if (kb.dataset.kind === st.kind) return; st.kind = kb.dataset.kind; resetDesk(true); renderDesk(); return; }
  const sb = e.target.closest("[data-school]");
  if (sb){ st.school = sb.dataset.school; renderDesk(); return; }
  const d = e.target.closest("[data-d]");
  if (d){ const box = d.closest(".step"), key = box.dataset.key;
    st[key] = Math.max(0, Math.min(999, (st[key]||0) + Number(d.dataset.d)));
    box.querySelector("input").value = st[key]; updatePay(); return; }
  const mi = e.target.closest("[data-minus]");
  if (mi){ e.stopPropagation(); const n = mi.dataset.minus; st.acts[n] = Math.max(0, (st.acts[n]||0) - 1); if (!st.acts[n]) delete st.acts[n]; refreshTile(n); updatePay(); return; }
  const t = e.target.closest("[data-act-name]");
  if (t){ const n = t.dataset.actName; st.acts[n] = Math.min(99, (st.acts[n]||0) + 1); refreshTile(n); updatePay(); }
});
function refreshTile(n){
  const a = config.activities.find(x => x.name === n); if (!a) return;
  const old = [...document.querySelectorAll("#tiles [data-act-name]")].find(x => x.dataset.actName === n);
  if (old) old.outerHTML = tile(a);
}
desk.addEventListener("input", e => {
  const f = e.target.dataset.field;
  if (f){ st[f] = e.target.value; if (f === "voucher" && st.vstate === "bad"){ st.vstate = ""; st.vmsg = ""; const h = $("#vHint"); if (h){ h.className = "hint"; h.textContent = "Tap Check when the code is in."; } } updatePay(); return; }
  const box = e.target.closest(".step");
  if (box){ st[box.dataset.key] = Math.max(0, Math.min(999, Math.floor(Number(e.target.value))||0)); updatePay(); }
});
function closeHeard(){ const p = $("#heardPanel"), b = $("#heardBtn"); if (p) p.hidden = true; if (b) b.setAttribute("aria-expanded","false"); }
document.addEventListener("click", e => { if (!e.target.closest(".dd")) closeHeard(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeHeard(); });
desk.addEventListener("focusin", e => { if (e.target.matches(".step input")) e.target.select(); });

function cleanPhone(p){ let d = String(p||"").replace(/\D/g,""); if (d.length === 12 && d.indexOf("91")===0) d = d.slice(2); return d; }
function makeEntry(mode){
  const c = calc(), now = new Date();
  const type = st.kind === "walkin" ? "Walk-in" : (st.school === "private" ? "School – private" : "School – government");
  const acts = {}; Object.keys(st.acts).forEach(n => { if (st.acts[n] > 0) acts[n] = st.acts[n]; });
  const sch = st.kind === "school";
  return { id: nextId(now), ts: now.getTime(), date: ymd(now), time: clock(now), batch: st.batch ? slotLabel(st.batch) : "", heard: st.heard, type, name: st.name.trim(), phone: cleanPhone(st.phone),
    guests: sch ? 0 : st.guests, under3: sch ? 0 : st.under3, students: sch ? st.students : 0, teachers: sch ? st.teachers : 0,
    free: c.free, entryFee: c.entryFee, entryAmt: c.entryAmt, acts, actAmt: c.actAmt, combo: c.combo, comboLabel: comboName(c.combos), discount: c.discount, gst: c.gst, total: c.total,
    mode: c.total > 0 ? mode : "Free",
    voucher: c.vApplied ? st.vrule.code : "", voucherLabel: c.vApplied ? st.vrule.label : "", voucherOffline: !!(c.vApplied && st.voffline),
    note: st.note.trim(), by: session.name, dev: DEV, status: c.total > 0 ? "Paid" : "Recorded" };
}
function summaryLines(c){
  const L = [];
  if (st.batch) L.push(["Batch", slotLabel(st.batch)]);
  if (st.kind === "school"){
    const tf = config.teacherFee || 0;
    L.push([(st.students - c.free)+" students × "+money(c.entryFee), money((st.students - c.free) * c.entryFee)]);
    if (c.free) L.push([c.free+" free with code "+st.vrule.code, money(0)]);
    if (st.teachers) L.push([st.teachers+" teachers and staff"+(tf ? " × "+money(tf) : ""), tf ? money(st.teachers*tf) : "Free"]);
  }
  else { L.push([(st.guests - c.free)+" × "+money(c.entryFee), money(c.entryAmt)]); if (c.free) L.push([c.free+" free with voucher "+st.vrule.code, money(0)]); }
  if (st.kind !== "school" && st.under3) L.push([st.under3+" under 3","Free"]);
  config.activities.forEach(a => { const n = st.acts[a.name]; if (n) L.push([n+" × "+a.name, money(n*a.price)]); });
  if (c.combo) L.push([comboName(c.combos), "−"+money(c.combo)]);
  if (c.discount) L.push(["Voucher "+st.vrule.code+" ("+st.vrule.label+")", "−"+money(c.discount)]);
  if (c.gst) L.push(["GST "+config.gst+"%", "+"+money(c.gst)]);
  return '<div class="lines">'+L.map(l => '<div><span>'+esc(l[0])+'</span><span>'+l[1]+'</span></div>').join("")+'</div>';
}
$("#pay").addEventListener("click", e => {
  const b = e.target.closest("[data-pay]"); if (!b) return;
  const c = calc(); if (!c.heads) return;
  if (!st.heard){ st.heardErr = true; const b = $("#heardBtn"); if (b){ b.classList.add("bad"); b.scrollIntoView({block:"center", behavior:"smooth"}); setTimeout(() => { const x = $("#heardBtn"); if (x && $("#heardPanel").hidden) x.click(); }, 350); } toast("Ask how they heard about us", true); return; }
  if (st.voucher.trim() && !st.vrule){ toast("Tap Check on the voucher, or clear the code", true); const v = $("#vCode"); if (v) v.focus(); return; }
  if (!c.total){ finish(makeEntry("")); return; }
  const m = b.dataset.pay, cash = /cash/i.test(m);
  openSheet('<h2 class="brush">'+(cash ? "Collect cash" : "Take "+esc(m))+'</h2><div class="samt">'+money(c.total)+'</div>'+
    '<p class="center muted small">'+(cash ? "Count the cash, then confirm." : "Enter this amount on the POS machine or check the UPI payment. Confirm once it shows success.")+'</p>'+summaryLines(c)+
    '<div class="actions"><button type="button" class="btn sun" data-act="confirm" data-mode="'+esc(m)+'">'+(cash ? "Cash received" : esc(m)+" received")+'</button><button type="button" class="btn ghost" data-act="close">Back</button></div>');
});
function finish(entry){
  queue.push(entry); saveQueue();
  const h = entry.guests + entry.under3 + entry.students + entry.teachers;
  const title = !entry.total ? "Entry saved" : /cash/i.test(entry.mode) ? "Cash received" : entry.mode + " received";
  openSheet('<div class="done"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="40" fill="#F2B43C"/><path d="M26 43l11 11 21-23" fill="none" stroke="#1E4A2C" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
    '<h2 class="brush">'+esc(title)+'</h2><div class="samt">'+money(entry.total)+'</div>'+
    '<p><span class="bid">'+esc(entry.id)+'</span><br>'+h+(h===1?" guest":" guests")+(entry.name ? ", "+esc(entry.name) : "")+(entry.batch ? "<br>"+esc(entry.batch)+" batch" : "")+'</p>'+
    '<button type="button" class="btn forest wide" data-act="next">Next guest</button></div>');
  st.vheld = false;               // the sheet releases the hold when the entry arrives
  resetDesk(true); flush();
}

/* ---------- Sheet actions ---------- */
$("#sheet").addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act;
  if (a === "close" || a === "next"){ closeSheet(); if (a === "next") window.scrollTo(0,0); }
  else if (a === "confirm"){ finish(makeEntry(b.dataset.mode)); }
  else if (a === "logout"){
    const tok = session && session.token; closeSheet();
    if (st.vrule && st.vheld) releaseVoucher(st.vrule.code);
    dropCaches(); todayData = null; dash = null;
    store.del(S_KEY); session = null; showLogin("");
    if (tok) api("logout", tok).catch(() => {});
  }
  else if (a === "update"){
    b.disabled = true; b.textContent = "Checking…";
    await syncData(true);
    let fresh = false;
    try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (reg){ await reg.update(); fresh = !!(reg.installing || reg.waiting); } } catch(err){}
    if (fresh){ toast("Updating the app…"); setTimeout(() => location.reload(), 1200); }
    else { closeSheet(); toast(navigator.onLine ? "Everything is up to date" : "No internet. Try again when online.", !navigator.onLine); }
  }
  else if (a === "drop"){ queue = queue.filter(x => x.id !== b.dataset.id); saveQueue(); closeSheet(); renderToday(); toast("Entry removed"); }
  else if (a === "askvoid"){ $("#voidBox").hidden = false; b.hidden = true; $("#voidReason").focus(); }
  else if (a === "dovoid"){
    const reason = ($("#voidReason").value || "").trim();
    if (!reason){ toast("Add a reason first", true); return; }
    b.disabled = true; b.textContent = "Voiding…";
    try { await api("voidEntry", session.token, b.dataset.id, reason); closeSheet(); toast("Entry voided"); loadToday(true); }
    catch(err){ if (!expired(err)){ toast(err.offline ? "Voiding needs the internet. Try again when online." : err.message, true); b.disabled = false; b.textContent = "Void entry"; } }
  }
});

/* ---------- Today ---------- */
let todayData = null, todayList = [];
function describe(o){
  const parts = [];
  if (o.batch) parts.push(o.batch+" batch");
  if (/school/i.test(o.type)) parts.push((o.name || "School")+", "+o.students+" students"+(o.teachers ? " + "+o.teachers+" staff" : ""));
  else { parts.push((o.name || o.type)+", "+(o.guests + o.under3)+(o.guests + o.under3 === 1 ? " guest" : " guests")); }
  const a = Object.keys(o.acts||{}).map(n => n+(o.acts[n]>1 ? " ×"+o.acts[n] : ""));
  if (a.length) parts.push(a.join(", "));
  return parts.join(", ");
}
function tagFor(o){
  if (o.pending) return '<span class="tag wait">To send</span>';
  if (/void/i.test(o.status)) return '<span class="tag void">Void</span>';
  if (/^check/i.test(o.status)) return '<span class="tag check">'+esc(o.status)+'</span>';
  const m = o.mode || "";
  const cls = /cash/i.test(m) ? "cash" : /upi/i.test(m) ? "upi" : /card/i.test(m) ? "card" : "";
  return '<span class="tag '+cls+'">'+esc(m || "—")+'</span>';
}
async function loadToday(){
  const c = cached("today");
  if (c) todayData = c;
  if (view === "today"){ if (todayData) renderToday(); else $("#v-today").innerHTML = '<div class="card"><div class="skel" style="width:60%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>'; }
  if (inflight.today) return inflight.today;
  inflight.today = (async () => {
    try { const d = await api("getToday", session.token); todayData = d; keep("today", d); }
    catch(err){ if (expired(err)) return; if (!todayData) todayData = {entries:[]}; todayData.error = true; }
    finally { inflight.today = null; }
    if (view === "today" && session) renderToday();
  })();
  if (view === "today" && todayData) renderToday();
  return inflight.today;
}
function renderToday(){
  const t = ymd(new Date()), admin = session.role === "Admin";
  const ok = todayData && todayData.date === t;
  const server = (ok ? todayData.entries : []) || [];
  const ids = new Set(server.map(x => x.id));
  const pend = queue.filter(x => x.date === t && !ids.has(x.id)).map(x => Object.assign({}, x, {pending:true}));
  todayList = server.concat(pend).sort((a,b) => toMin(b.time) - toMin(a.time) || (b.id > a.id ? 1 : -1));
  const heads = o => (o.guests||0) + (o.under3||0) + (o.students||0) + (o.teachers||0);
  // head counts: server summary covers all of today; add entries still on this phone
  const sum = ok && todayData.summary ? JSON.parse(JSON.stringify(todayData.summary)) : {guests:0, entries:0, acts:{}, batches:{}};
  pend.filter(o => !/void/i.test(o.status)).forEach(o => {
    const h = heads(o); sum.guests += h; sum.entries++;
    Object.keys(o.acts||{}).forEach(n => sum.acts[n] = (sum.acts[n]||0) + o.acts[n]);
    if (o.batch){ sum.batches[o.batch] = (sum.batches[o.batch]||0) + h; sum.bd = sum.bd || {}; const b = sum.bd[o.batch] || (sum.bd[o.batch] = {g:0, e:0, acts:{}}); b.g += h; b.e++; Object.keys(o.acts||{}).forEach(n => b.acts[n] = (b.acts[n]||0) + o.acts[n]); }
  });
  const nActs = Object.values(sum.acts).reduce((s,n) => s+n, 0);
  const hol = ((config && config.holidays)||{})[t], dow = new Date().getDay();
  const label = hol ? hol : (dow===0||dow===6) ? "Weekend" : "Weekday";
  let h = '<div class="daybar"><strong>'+new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long"})+'</strong>'+freshness("today")+'<span class="pill'+(hol||dow===0||dow===6?" hi":"")+'">'+esc(label)+'</span></div>';
  if (admin){
    const live = todayList.filter(o => !/void/i.test(o.status));
    const total = live.reduce((s,o) => s + (o.total||0), 0);
    const byMode = {}; ((config && config.modes) || []).forEach(m => byMode[m] = 0);
    live.forEach(o => { if (o.total) byMode[o.mode] = (byMode[o.mode]||0) + o.total; });
    h += '<div class="card"><div class="bigs"><div><div class="big">'+sum.guests+'</div><span>guests today</span></div><div><div class="big">'+money(total)+'</div><span>collected</span></div></div>'+
      '<div class="tally">'+Object.keys(byMode).map(m => '<div><b>'+money(byMode[m])+'</b><span>'+esc(m)+'</span></div>').join("")+'<div><b>'+sum.entries+'</b><span>Entries</span></div></div>'+
      '<p class="hint">At closing, match these totals with the cash drawer and the POS settlement.</p></div>';
    if (sum.checks) h += '<div class="banner-wait"><div><b>'+sum.checks+(sum.checks===1?" entry needs":" entries need")+' a check</b>Tap the red tags below to see why. The reason is also in the Note column of the sheet.</div></div>';
  } else {
    h += '<div class="card"><div class="bigs"><div><div class="big">'+sum.guests+'</div><span>guests today</span></div><div><div class="big">'+sum.entries+'</div><span>entries</span></div><div><div class="big">'+nActs+'</div><span>activities</span></div></div></div>';
  }
  if (Object.keys(sum.bd||{}).length) h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Batch view</h2></div><p class="sub">Guests, entries and activities in each batch today</p>'+batchMatrix(sum.bd)+'</div>';
  const actRows = Object.keys(sum.acts).map(n => ({l:n, v:sum.acts[n]})).sort((a,b) => b.v - a.v);
  if (actRows.length) h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Activities today</h2></div>'+hbars(actRows, v => String(v))+'</div>';
  if (pend.length) h += '<div class="banner-wait"><div><b>'+pend.length+' waiting to send</b>Saved on this phone. They send on their own once the internet is back.</div><button type="button" class="btn sun" id="sendNow">Send now</button></div>';
  if (todayData && todayData.error) h += '<p class="hint warn">Couldn’t load the sheet just now. Showing entries saved on this phone.</p>';
  if (!admin) todayList = todayList.slice(0, 10);
  h += '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">'+(admin ? "Entries" : "Last 10 entries")+'</h2><button type="button" class="chip" style="margin-left:auto;color:var(--forest);background:var(--card2);border-color:var(--line)" id="refresh">Refresh</button></div><div class="entries">';
  if (!todayList.length) h += '<div class="empty">No guests logged yet today. New entries show up here straight away.</div>';
  todayList.forEach((o,i) => {
    h += '<button type="button" class="entry'+(/void/i.test(o.status)?" void":"")+'" data-i="'+i+'"><time>'+esc(o.time)+'</time>'+
      '<span class="what"><b>'+esc(o.id)+'</b><small>'+esc(describe(o))+'</small></span>'+
      '<span class="money">'+(admin ? '<b>'+money(o.total)+'</b>' : '<b>'+heads(o)+(heads(o)===1?" guest":" guests")+'</b>')+tagFor(o)+'</span></button>';
  });
  h += '</div></div>';
  $("#v-today").innerHTML = h;
}
$("#v-today").addEventListener("click", e => {
  if (e.target.id === "sendNow"){ flush(); toast("Sending…"); return; }
  if (e.target.id === "refresh"){ loadToday(); return; }
  const r = e.target.closest("[data-i]"); if (!r) return;
  const o = todayList[Number(r.dataset.i)]; if (!o) return;
  const L = [["Time", o.time], ["Type", o.type]];
  if (o.name) L.push(["Name", o.name]); if (o.phone) L.push(["Phone", o.phone]);
  if (o.guests) L.push(["Guests (3+)", o.guests]); if (o.under3) L.push(["Under 3", o.under3]);
  if (o.students) L.push(["Students", o.students]); if (o.teachers) L.push(["Teachers / staff", o.teachers]);
  if (o.free) L.push(["Free with voucher", o.free+(o.voucher ? " ("+o.voucher+")" : "")]);
  Object.keys(o.acts||{}).forEach(n => L.push([n, o.acts[n]]));
  const admin = session.role === "Admin";
  if (o.voucher && !o.free) L.push(["Voucher", o.voucher + (admin && o.discount ? ", "+money(o.discount)+" off" : "")]);
  if (o.heard) L.push(["Heard about us", o.heard]);
  L.push(["Paid by", o.mode || "—"]); if (o.by) L.push(["Entered by", o.by]);
  if (o.status && !o.pending) L.push(["Status", o.status]);
  if (o.note) L.push(["Note", o.note]);
  let act = "";
  if (o.pending) act = '<button type="button" class="btn danger" data-act="drop" data-id="'+esc(o.id)+'">Remove this entry</button>';
  else if (!/void/i.test(o.status)) act = '<button type="button" class="btn danger" data-act="askvoid">Void entry</button>'+
    '<div id="voidBox" hidden><label class="f"><span>Why are you voiding it?</span><input class="inp" id="voidReason" maxlength="120" placeholder="e.g. Entered twice"></label>'+
    '<div class="actions"><button type="button" class="btn danger" data-act="dovoid" data-id="'+esc(o.id)+'">Void entry</button></div></div>';
  openSheet('<h2 class="brush">'+esc(o.id)+'</h2>'+(admin ? '<div class="samt">'+money(o.total)+'</div>' : '')+
    '<div class="lines">'+L.map(l => '<div><span>'+esc(l[0])+'</span><span>'+esc(l[1])+'</span></div>').join("")+'</div>'+
    '<div class="actions">'+act+'<button type="button" class="btn ghost" data-act="close">Close</button></div>');
});

/* ---------- Dashboard ---------- */
let dash = null; const dv = {range:"days", metric:"guests", mx:"30"};
async function loadDash(){
  const c = cached("dash");
  if (c) dash = c;
  if (view === "dash"){ if (dash) renderDash(); else $("#v-dash").innerHTML = '<div class="card"><div class="skel" style="width:70%;height:28px"></div><div class="skel"></div><div class="skel" style="height:140px"></div></div>'; }
  if (inflight.dash) return inflight.dash;
  inflight.dash = (async () => {
    try { const d = await api("getDashboard", session.token); dash = d; keep("dash", d); if (view === "dash") renderDash(); }
    catch(err){ if (!expired(err) && view === "dash" && !dash) $("#v-dash").innerHTML = '<div class="card empty">Couldn’t load the dashboard. '+esc(err.message||"")+'<br><br><button type="button" class="btn sun" id="dashRetry">Try again</button></div>'; }
    finally { inflight.dash = null; if (view === "dash" && dash && session) renderDash(); }
  })();
  if (view === "dash" && dash) renderDash();
  return inflight.dash;
}
function freshness(kind){ return inflight[kind] ? '<span class="upd">Updating…</span>' : ''; }
function barChart(items, fmt){
  const W = 340, H = 170, pt = 18, pb = 22, n = items.length || 1, max = Math.max(1, ...items.map(i => i.v));
  const bw = W/n, gap = Math.max(2, Math.min(10, bw*.28)), step = Math.ceil(n/8);
  let s = '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Bar chart">';
  items.forEach((it,i) => {
    const h = (H-pt-pb)*it.v/max, x = i*bw + gap/2, w = bw - gap, y = H-pb-h;
    s += '<rect class="b'+(it.hi?" hi":"")+'" x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+Math.max(0,h).toFixed(1)+'" rx="3"><title>'+esc(it.t||it.l)+': '+fmt(it.v)+'</title></rect>';
    if (n <= 14 && it.v > 0) s += '<text x="'+(x+w/2).toFixed(1)+'" y="'+(y-4).toFixed(1)+'" text-anchor="middle">'+fmt(it.v)+'</text>';
    if (i % step === 0 || i === n-1) s += '<text x="'+(x+w/2).toFixed(1)+'" y="'+(H-6)+'" text-anchor="middle">'+esc(it.l)+'</text>';
  });
  return s + '<line class="base" x1="0" x2="'+W+'" y1="'+(H-pb)+'" y2="'+(H-pb)+'"/></svg>';
}
function batchMatrix(bd){
  const batches = Object.keys(bd).sort((a,b) => toMin(a) - toMin(b));
  const acts = [];
  batches.forEach(b => Object.keys(bd[b].acts).forEach(n => { if (acts.indexOf(n) < 0) acts.push(n); }));
  const order = ((config && config.activities) || []).map(a => a.name);
  acts.sort((a,b) => (order.indexOf(a)+1 || 99) - (order.indexOf(b)+1 || 99));
  let maxG = 1, maxA = 1;
  batches.forEach(b => { maxG = Math.max(maxG, bd[b].g); acts.forEach(n => maxA = Math.max(maxA, bd[b].acts[n]||0)); });
  const tint = (v, m, col) => v ? ' style="background:color-mix(in srgb, '+col+' '+Math.round(12 + 50*v/m)+'%, transparent)"' : '';
  const tot = {g:0, e:0, acts:{}};
  let rows = batches.map(b => {
    const r = bd[b]; tot.g += r.g; tot.e += r.e;
    return '<tr><th scope="row">'+esc(b)+'</th><td'+tint(r.g, maxG, "var(--chart)")+'><b>'+r.g+'</b></td><td>'+r.e+'</td>'+
      acts.map(n => { const v = r.acts[n]||0; tot.acts[n] = (tot.acts[n]||0) + v; return '<td'+tint(v, maxA, "var(--chart2)")+'>'+(v||"·")+'</td>'; }).join("")+'</tr>';
  }).join("");
  rows += '<tr class="tot"><th scope="row">Total</th><td><b>'+tot.g+'</b></td><td>'+tot.e+'</td>'+acts.map(n => '<td>'+tot.acts[n]+'</td>').join("")+'</tr>';
  return '<div class="mxwrap"><table class="mx"><thead><tr><th scope="col">Batch</th><th scope="col">Guests</th><th scope="col">Entries</th>'+
    acts.map(n => '<th scope="col"><span aria-hidden="true">'+actIcon(n)+'</span> '+esc(n)+'</th>').join("")+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function hbars(rows, fmt){
  const max = Math.max(1, ...rows.map(r => r.v));
  return rows.map(r => '<div class="hbar"><span>'+esc(r.l)+'</span><div class="track"><div class="fill'+(r.hi?" hi":"")+'" style="width:'+(r.v/max*100).toFixed(1)+'%"></div></div><b>'+fmt(r.v)+'</b></div>').join("");
}
function renderDash(){
  const days = dash.days || [], admin = dash.role ? dash.role === "Admin" : session.role === "Admin";
  if (!days.length){ $("#v-dash").innerHTML = '<div class="card empty">No entries yet. Trends appear here once the desk starts logging guests.</div>'; return; }
  if (!admin && dv.metric === "money") dv.metric = "guests";
  const by = {}; days.forEach(d => by[d.d] = d);
  const nActs = d => Object.values(d.acts||{}).reduce((s,n) => s+n, 0);
  const pick = d => dv.metric === "money" ? (d.total||0) : dv.metric === "visits" ? d.bookings : dv.metric === "acts" ? nActs(d) : d.guests;
  const val = s => by[s] ? pick(by[s]) : 0;
  const fmt = dv.metric === "money" ? short : (v => String(Math.round(v)));
  const fmtAvg = dv.metric === "money" ? short : (v => (v >= 10 ? Math.round(v) : Math.round(v*10)/10).toLocaleString("en-IN"));
  const mName = {guests:"Guests", visits:"Visits (entries)", acts:"Activities", money:"Money collected"}[dv.metric];
  const T = pds(dash.today), closed = DOW.indexOf(dash.closedDay);
  const typeOf = s => (dash.holidays||{})[s] ? "Holiday" : ([0,6].indexOf(pds(s).getDay()) >= 0 ? "Weekend" : "Weekday");
  let items = [], sub = "";
  if (dv.range === "days"){
    for (let k = 29; k >= 0; k--){ const d = new Date(T); d.setDate(T.getDate()-k); if (d.getDay() === closed) continue; const s = ymd(d); items.push({l:String(d.getDate()), v:val(s), hi:typeOf(s) !== "Weekday", t:d.toDateString()}); }
    sub = "Last 30 days" + (closed >= 0 ? ", closed "+dash.closedDay+"s left out" : "");
  } else if (dv.range === "weeks"){
    const mon = new Date(T); mon.setDate(T.getDate() - ((T.getDay()+6)%7));
    for (let k = 11; k >= 0; k--){ const a = new Date(mon); a.setDate(mon.getDate()-7*k); let v = 0; for (let j = 0; j < 7; j++){ const d = new Date(a); d.setDate(a.getDate()+j); v += val(ymd(d)); } items.push({l:a.getDate()+" "+MON[a.getMonth()], v, t:"Week of "+a.toDateString()}); }
    sub = "Last 12 weeks, Monday to Sunday";
  } else {
    const a = new Date(T.getFullYear(), T.getMonth()-11, 1);
    for (let k = 0; k < 12; k++){ const m = new Date(a.getFullYear(), a.getMonth()+k, 1), key = m.getFullYear()+"-"+pad(m.getMonth()+1); items.push({l:MON[m.getMonth()], v:days.filter(d => d.d.slice(0,7) === key).reduce((s,d) => s + pick(d), 0)}); }
    sub = "Last 12 months";
  }
  const groups = {Weekday:[], Weekend:[], Holiday:[]}, dowG = {};
  days.forEach(d => { if (d.d === dash.today) return; const ty = d.type || typeOf(d.d); (groups[ty] || groups.Weekday).push(d); if (ty !== "Holiday"){ const w = pds(d.d).getDay(); (dowG[w] = dowG[w] || []).push(d); } });
  const avg = arr => arr.length ? arr.reduce((s,d) => s + pick(d), 0) / arr.length : 0;
  const avgG = arr => arr.length ? arr.reduce((s,d) => s + d.guests, 0) / arr.length : 0;
  const aWd = avg(groups.Weekday), aWe = avg(groups.Weekend), aHo = avg(groups.Holiday);
  const cut = s => { const d = new Date(T); d.setDate(T.getDate()-s); return ymd(d); };
  const last30 = days.filter(d => d.d >= cut(29)), last90 = days.filter(d => d.d >= cut(89));
  const actNames = dash.activities || [];
  const actRows = actNames.map(n => ({l:n, v:last30.reduce((s,d) => s + ((d.acts||{})[n]||0), 0)})).filter(r => r.v).sort((a,b) => b.v-a.v);
  const actTot = actRows.reduce((s,r) => s+r.v, 0), paying = last30.reduce((s,d) => s + d.paying + d.under3, 0);
  const sch = last90.reduce((o,d) => { o.n += d.schools; o.st += d.schoolStudents; o.p += d.pvtSchools; o.t += d.teachers; o.r += d.schoolRev||0; return o; }, {n:0,st:0,p:0,t:0,r:0});
  const t30 = last30.reduce((o,d) => { o.g += d.guests; o.b += d.bookings; o.r += d.total||0; o.v += d.voids; o.disc += d.discount||0; o.free += d.free; return o; }, {g:0,b:0,r:0,v:0,disc:0,free:0});
  // batch view for the chosen period
  const mxFrom = dv.mx === "today" ? dash.today : cut(Number(dv.mx) - 1);
  const bd = {};
  days.filter(d => d.d >= mxFrom).forEach(d => Object.keys(d.bd||{}).forEach(b => { const x = d.bd[b], y = bd[b] || (bd[b] = {g:0, e:0, acts:{}}); y.g += x.g; y.e += x.e; Object.keys(x.acts).forEach(n => y.acts[n] = (y.acts[n]||0) + x.acts[n]); }));
  const hsum = {}; last30.forEach(d => Object.keys(d.heard||{}).forEach(k => hsum[k] = (hsum[k]||0) + d.heard[k]));
  const heardRows = Object.keys(hsum).map(k => ({l:k, v:hsum[k], hi:/didn|not say/i.test(k)})).sort((a,b) => b.v - a.v);
  const ratio = avgG(groups.Weekday) ? avgG(groups.Weekend)/avgG(groups.Weekday) : 0;
  const head = ratio >= 1.5 ? "A weekend day brings about "+Math.round(ratio)+"× a weekday" : "Last 30 days at a glance";
  const metrics = [["guests","Guests"],["visits","Visits"],["acts","Activities"]].concat(admin ? [["money","Money"]] : []);
  let payCard = "";
  if (admin){
    const modes = {}; last30.forEach(d => Object.keys(d.modes||{}).forEach(m => modes[m] = (modes[m]||0) + d.modes[m]));
    const payRows = Object.keys(modes).map(m => ({l:m, v:modes[m], hi:/cash/i.test(m)})).sort((a,b) => b.v-a.v);
    const payTot = payRows.reduce((s,r) => s+r.v, 0) || 1;
    payCard = '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">How people paid</h2></div><p class="sub">Last 30 days</p>'+hbars(payRows, short)+
      '<p class="hint">'+payRows.map(r => esc(r.l)+" "+Math.round(r.v/payTot*100)+"%").join(", ")+'. Voucher discounts: '+money(t30.disc)+'. Voucher free entries: '+t30.free+'. Voided entries: '+t30.v+'.</p></div>';
  }
  let h = (inflight.dash ? '<div class="daybar">'+freshness("dash")+'</div>' : '')+'<div class="card"><h2 class="insight brush">'+esc(head)+'</h2>'+
      '<div class="tally"><div><b>'+t30.g.toLocaleString("en-IN")+'</b><span>Guests</span></div><div><b>'+t30.b.toLocaleString("en-IN")+'</b><span>Visits</span></div><div><b>'+actTot.toLocaleString("en-IN")+'</b><span>Activities</span></div>'+
      (admin ? '<div><b>'+short(t30.r)+'</b><span>Collected</span></div>' : '')+'</div><p class="hint">Last 30 days</p></div>'+
    '<div class="card"><div class="seg" id="rangeSeg">'+[["days","Days"],["weeks","Weeks"],["months","Months"]].map(x => '<button type="button" data-range="'+x[0]+'" aria-pressed="'+(dv.range===x[0])+'">'+x[1]+'</button>').join("")+'</div>'+
    '<div class="seg" id="metricSeg">'+metrics.map(x => '<button type="button" data-metric="'+x[0]+'" aria-pressed="'+(dv.metric===x[0])+'">'+x[1]+'</button>').join("")+'</div>'+
    '<div class="chart" style="margin-top:14px"><p class="sub" style="margin:0 0 6px">'+mName+', '+sub.charAt(0).toLowerCase()+sub.slice(1)+'</p>'+barChart(items, fmt)+
    (dv.range === "days" ? '<div class="legend"><span><i></i>Weekday</span><span><i class="hi"></i>Weekend or holiday</span></div>' : '')+'</div></div>'+
    '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Batch view</h2></div>'+
      '<div class="seg" id="mxSeg">'+[["today","Today"],["7","7 days"],["30","30 days"]].map(x => '<button type="button" data-mx="'+x[0]+'" aria-pressed="'+(dv.mx===x[0])+'">'+x[1]+'</button>').join("")+'</div>'+
      '<div style="margin-top:10px">'+(Object.keys(bd).length ? batchMatrix(bd) : '<p class="muted">No entries with a batch for this period yet.</p>')+'</div></div>'+
    (heardRows.length ? '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">How guests heard about us</h2></div><p class="sub">Last 30 days, number of visits</p>'+hbars(heardRows, v => v.toLocaleString("en-IN"))+'</div>' : '')+
    '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Activities</h2></div><p class="sub">Last 30 days: '+actTot+' activities, about '+(paying ? Math.round(actTot/paying*100) : 0)+' per 100 guests</p>'+
      (actRows.length ? hbars(actRows, v => String(v)) : '<p class="muted">No activities logged yet.</p>')+'</div>'+
    '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">Average per open day</h2></div><p class="sub">'+mName+'</p>'+hbars([{l:"Weekday",v:aWd},{l:"Weekend",v:aWe,hi:true},{l:"Holiday",v:aHo,hi:true}], fmtAvg)+'</div>'+
    '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">By day of the week</h2></div><p class="sub">'+mName+', average, holidays left out</p>'+
      hbars([[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]].filter(p => p[0] !== closed).map(p => ({l:p[1], v:avg(dowG[p[0]]||[]), hi:p[0]===0||p[0]===6})), fmtAvg)+'</div>'+
    payCard+
    '<div class="card"><div class="card-h">'+LEAF+'<h2 class="brush">School visits</h2></div><p class="sub">Last 90 days</p>'+
      '<div class="tally"><div><b>'+sch.n+'</b><span>Visits</span></div><div><b>'+sch.st+'</b><span>Students</span></div><div><b>'+sch.p+' / '+(sch.n-sch.p)+'</b><span>Private / govt</span></div>'+
      (admin ? '<div><b>'+short(sch.r)+'</b><span>From schools</span></div>' : '<div><b>'+sch.t+'</b><span>Teachers</span></div>')+'</div></div>'+
    (admin ? '<p class="hint center" style="margin-top:14px">The Daily Summary tab in the Google Sheet is refreshed every hour during opening hours.</p>' : '');
  $("#v-dash").innerHTML = h;
}
$("#v-dash").addEventListener("click", e => {
  if (e.target.id === "dashRetry"){ loadDash(); return; }
  const r = e.target.closest("[data-range]"), m = e.target.closest("[data-metric]");
  if (r){ dv.range = r.dataset.range; renderDash(); }
  if (m){ dv.metric = m.dataset.metric; renderDash(); }
  const x = e.target.closest("[data-mx]");
  if (x){ dv.mx = x.dataset.mx; renderDash(); }
});

/* ---------- Boot ---------- */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (session && session.token) start(); else showLogin("");
})();
