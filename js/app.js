const SPECIES = [
  "Sulcata (African spurred)", "Leopard", "Red-footed", "Yellow-footed", "Cherry head red-footed",
  "Aldabra giant", "Elongated", "Forsten's", "Burmese star", "Indian star", "Radiated",
  "Asian forest (Manouria emys)", "Impressed", "Hermann's", "Greek (spur-thighed)", "Russian (Horsfield's)",
  "Marginated", "Hingeback", "Other"
];
const FOODS = ["Leafy greens","Grass / hay","Flowers","Cactus pad","Pumpkin","Chayote","Fruit","Pellets"];
const POOP = ["Normal, firm","Soft","Runny","Dry / hard","Contains undigested food","None"];
const URATES = ["Clear / liquid","Soft white paste","Gritty / chalky","None"];

/* ---------- Storage ---------- */
let db = null;
const store = { tortoises: [], entries: [] };
function openDB(){
  return new Promise(res => {
    try{
      const r = indexedDB.open("kulalog", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("tortoises", { keyPath:"id" });
        d.createObjectStore("entries", { keyPath:"id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    }catch(e){ res(null); }
  });
}
function getAll(name){
  return new Promise(res => {
    if(!db) return res([]);
    try{
      const rq = db.transaction(name).objectStore(name).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    }catch(e){ res([]); }
  });
}
function dbPut(name, obj){
  return new Promise(res => {
    if(!db) return res(false);
    try{
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).put(obj);
      tx.oncomplete = () => res(true);
      // Out of space aborts the transaction without an error event.
      tx.onerror = tx.onabort = () => res(false);
    }catch(e){ res(false); }
  });
}
function dbDel(name, id){
  return new Promise(res => {
    if(!db) return res(false);
    try{
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).delete(id);
      tx.oncomplete = () => res(true);
      tx.onerror = tx.onabort = () => res(false);
    }catch(e){ res(false); }
  });
}
const settings = { unit: "auto" };
function loadSettings(){ try{ Object.assign(settings, JSON.parse(localStorage.getItem("kulalog-settings") || "{}")); }catch(e){} }
function saveSettings(){ try{ localStorage.setItem("kulalog-settings", JSON.stringify(settings)); }catch(e){} }

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today = () => todayISO();
const fmtW = g => fmtWeight(g, settings.unit);
const age = birth => ageText(birth);
const initial = n => (n || "?").trim().charAt(0).toUpperCase();
const entriesOf = id => sortEntries(store.entries.filter(e => e.tortoiseId === id));
const latestPhoto = list => { const e = list.find(x => x.photo); return e ? e.photo : null; };
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}
function hexAvatar(t, list){
  const p = latestPhoto(list);
  return `<div class="hex" aria-hidden="true">${p ? `<img src="${esc(p)}" alt="">` : esc(initial(t.name))}</div>`;
}

/* ---------- Routing / render ---------- */
let chart = null, metric = "weightG";
const measuresOf = id => entriesOf(id).filter(e => e.kind === "measure");
const caresOf = id => entriesOf(id).filter(e => e.kind === "care");
const careOf = (tid, date) => findCare(store.entries, tid, date);
const daysAgo = iso => daysBetween(iso, today());
function rel(iso){
  const d = daysAgo(iso);
  if(d === 0) return "today"; if(d === 1) return "yesterday"; if(d > 1) return d + " days ago";
  return fmtDate(iso);
}
function route(){
  shownDay = today();
  const m = location.hash.match(/^#t\/(.+)$/);
  if(m && store.tortoises.some(t => t.id === m[1])) renderTortoise(m[1]);
  else renderHome();
  window.scrollTo(0,0);
}
function renderHome(){
  careMonth = null;
  if(chart){ chart.destroy(); chart = null; }
  const ts = [...store.tortoises].sort((a,b) => a.name.localeCompare(b.name));
  const app = $("#app");
  if(!ts.length){
    app.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 120 70" aria-hidden="true">
          <ellipse cx="60" cy="58" rx="48" ry="6" fill="var(--sunk)"/>
          <path d="M22 52 Q24 14 60 12 Q96 14 98 52 Z" fill="var(--shell)"/>
          <g fill="none" stroke="var(--surface)" stroke-width="2.5"><polygon points="50,22 70,22 76,35 70,48 50,48 44,35"/><path d="M44 35 L30 38 M76 35 L90 38 M50 22 L44 15 M70 22 L76 15"/></g>
          <ellipse cx="104" cy="46" rx="10" ry="7" fill="var(--leaf)"/><circle cx="107" cy="44" r="1.6" fill="var(--surface)"/>
          <rect x="30" y="50" width="10" height="9" rx="3" fill="var(--leaf)"/><rect x="80" y="50" width="10" height="9" rx="3" fill="var(--leaf)"/>
        </svg>
        <h2>Start your first logbook</h2>
        <p>Add a tortoise, then log daily care and growth measurements. Everything stays on this device and works offline.</p>
        <button class="btn primary" id="addT">Add tortoise</button>
      </div>`;
  }else{
    app.innerHTML = `
      <div class="home-head">
        <div><h1>Your tortoises</h1><p>${ts.length} in your care</p></div>
        <button class="btn primary" id="addT">Add tortoise</button>
      </div>
      <div class="t-list">${ts.map(t => {
        const ms = measuresOf(t.id), cs = caresOf(t.id);
        const w = latest(ms, "weightG"), p = latest(ms, "plastron");
        const soak = cs.find(e => e.soaked);
        return `<button class="t-card" data-open="${esc(t.id)}">
          ${hexAvatar(t, ms)}
          <div><h2>${esc(t.name)}</h2><div class="sp">${esc(t.species)}</div>
          <div class="sp">${soak ? "Last soaked " + rel(soak.date) : cs.length ? "Not soaked yet" : "No care logged yet"}</div></div>
          <div class="nums"><b>${fmtW(w)}</b><span>${p != null ? "Plastron " + fmtCm(p) : ""}</span></div>
        </button>`; }).join("")}
      </div>`;
  }
  $("#addT").onclick = () => openTortoise();
  app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => location.hash = "t/" + b.dataset.open);
}

function statHTML(label, value, rate, fmt, small){
  let d = "";
  if(rate != null){
    const sign = rate >= 0 ? "+" : "−";
    d = `<div class="d ${rate < 0 ? "neg" : ""}">${sign}${fmt(Math.abs(rate))} per month</div>`;
  }
  return `<div class="stat"><div class="k">${label}</div><div class="v${small ? " sm" : ""}">${value}</div>${d}</div>`;
}
function careMarks(e){
  const m = [];
  if(e.soaked) m.push(`<span class="chip shell">Soaked</span>`);
  const foods = [...(e.food || [])]; if(e.foodNote) foods.push(e.foodNote);
  if(foods.length) m.push(`<span class="chip">${esc(foods.slice(0,2).join(", "))}${foods.length > 2 ? " +" + (foods.length-2) : ""}</span>`);
  if(e.poop) m.push(`<span class="chip${BAD_POOP.includes(e.poop) ? " bad" : ""}">Poop: ${esc(e.poop)}</span>`);
  if(e.urates) m.push(`<span class="chip${BAD_URATES.includes(e.urates) ? " bad" : ""}">Urates: ${esc(e.urates)}</span>`);
  if(e.notes) m.push(`<span class="nt">${esc(e.notes)}</span>`);
  return m.join("");
}
function dayRow(iso, e){
  const d = daysAgo(iso);
  const big = d === 0 ? "Today" : d === 1 ? "Yesterday" : dateObj(iso).toLocaleDateString("en-GB", { weekday:"short" });
  const small = dateObj(iso).toLocaleDateString("en-GB", { day:"numeric", month:"short" });
  return `<li><button class="day${d === 0 ? " today" : ""}" data-day="${esc(iso)}">
    <span class="sr">${e ? "Edit" : "Add"} care for </span><span class="dlabel"><b>${big}</b><small>${small}</small></span>
    <span class="marks">${e ? careMarks(e) : `<span class="none">Nothing logged. Tap to add.</span>`}</span>
  </button></li>`;
}
let careMonth = null;
function weekView(id){
  const cs = caresOf(id);
  const days = []; for(let i = 0; i < 7; i++) days.push(shiftDay(today(), -i));
  const later = cs.filter(e => e.date > today());
  return `<ul class="days">${later.map(e => dayRow(e.date, e)).join("")}${days.map(d => dayRow(d, careOf(id, d))).join("")}</ul>
    <p class="hint" style="margin-top:10px">Older days are in the <button class="linkish" data-cv="month">monthly view</button>.</p>`;
}
function monthView(id){
  const now = today().slice(0, 7);
  const ym = careMonth || now;
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(y, m, 0).getDate();
  const todayIso = today();
  let soaked = 0, fed = 0;
  const cells = [];
  for(let i = 0; i < offset; i++) cells.push(`<span class="cell out" aria-hidden="true"></span>`);
  for(let d = 1; d <= count; d++){
    const iso = ym + "-" + String(d).padStart(2, "0");
    const e = careOf(id, iso);
    const future = iso > todayIso && !e;
    const desc = [];
    let dots = "";
    if(e){
      if(e.soaked){ dots += `<i class="dot soak"></i>`; desc.push("soaked"); soaked++; }
      if(isFed(e)){ dots += `<i class="dot fed"></i>`; desc.push("fed"); fed++; }
      if(e.poop || e.urates){
        const bad = BAD_POOP.includes(e.poop) || BAD_URATES.includes(e.urates);
        dots += `<i class="dot poop${bad ? " bad" : ""}"></i>`; desc.push(bad ? "poop or urates need attention" : "poop checked");
      }
      if(!dots){ dots = `<i class="dot note"></i>`; desc.push("note"); }
    }
    cells.push(`<button class="cell${iso === todayIso ? " today" : ""}" data-day="${esc(iso)}" ${future ? "disabled" : ""}
      aria-label="${fmtDate(iso)}${desc.length ? ": " + desc.join(", ") : ", nothing logged"}">
      <span class="n">${d}</span><span class="dots">${dots}</span></button>`);
  }
  const label = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return `
    <div class="cal-head">
      <button class="icon-btn" data-mnav="-1" aria-label="Previous month">‹</button>
      <b>${label}</b>
      <button class="icon-btn" data-mnav="1" aria-label="Next month" ${ym >= now ? "disabled" : ""}>›</button>
    </div>
    <div class="cal">
      ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(w => `<span class="wd" aria-hidden="true">${w}</span>`).join("")}
      ${cells.join("")}
    </div>
    <div class="cal-legend">
      <span><i class="dot soak"></i>Soaked</span><span><i class="dot fed"></i>Fed</span>
      <span><i class="dot poop"></i>Poop checked</span><span><i class="dot poop bad"></i>Needs attention</span>
    </div>
    <p class="hint">Soaked on ${soaked} ${soaked === 1 ? "day" : "days"} and fed on ${fed} ${fed === 1 ? "day" : "days"} this month.</p>`;
}
function careTab(id){
  const cs = caresOf(id);
  const soak = cs.find(e => e.soaked), fed = cs.find(isFed), poop = cs.find(e => e.poop);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const view = settings.careView === "month" ? "month" : "week";
  return `
    <section class="stats" aria-label="Care summary">
      ${statHTML("Last soaked", soak ? cap(rel(soak.date)) : "Not yet", null, null, true)}
      ${statHTML("Last fed", fed ? cap(rel(fed.date)) : "Not yet", null, null, true)}
      ${statHTML("Last poop check", poop ? cap(rel(poop.date)) : "Not yet", null, null, true)}
    </section>
    <div class="care-head">
      <h2 class="sec-h">${view === "week" ? "Last 7 days" : "Monthly view"}</h2>
      <div class="seg" role="group" aria-label="Care view">
        <button data-cv="week" aria-pressed="${view === "week"}">7 days</button>
        <button data-cv="month" aria-pressed="${view === "month"}">Month</button>
      </div>
    </div>
    ${view === "week" ? weekView(id) : monthView(id)}`;
}
function growthTab(id){
  const ms = measuresOf(id);
  const rateFmtW = g => fmtWeightRate(g, settings.unit);
  return `
    <section class="stats" aria-label="Latest measurements">
      ${statHTML("Weight", fmtW(latest(ms,"weightG")), perMonth(ms,"weightG"), rateFmtW)}
      ${statHTML("Plastron", fmtCm(latest(ms,"plastron")), perMonth(ms,"plastron"), v => v.toFixed(2) + " cm")}
      ${statHTML("Carapace", fmtCm(latest(ms,"scl")), perMonth(ms,"scl"), v => v.toFixed(2) + " cm")}
    </section>
    <section class="chart-card" aria-label="Growth chart">
      <div class="seg" role="group" aria-label="Chart measurement">
        <button data-m="weightG">Weight</button><button data-m="plastron">Plastron</button><button data-m="scl">Carapace</button>
      </div>
      <div id="chartArea"></div>
    </section>
    <div class="care-head"><h2 class="sec-h">Measurements</h2>${ms.length ? `<button class="btn small" id="csvT">Export CSV</button>` : ""}</div>
    ${ms.length ? `<ol class="timeline">${ms.map(entryHTML).join("")}</ol>`
      : `<p class="hint">No measurements yet. Log the first one to start the growth chart.</p>`}`;
}
function renderTortoise(id){
  const t = store.tortoises.find(x => x.id === id);
  const ms = measuresOf(id), all = entriesOf(id);
  const a = age(t.birth);
  const tab = settings.tab === "growth" ? "growth" : "care";
  if(chart){ chart.destroy(); chart = null; }
  $("#app").innerHTML = `
    <button class="btn ghost back" id="backBtn">‹ All tortoises</button>
    <section class="profile">
      ${hexAvatar(t, ms)}
      <div>
        <h1>${esc(t.name)}</h1>
        <div class="sp">${esc(t.species)}</div>
        <div class="meta">
          <span class="chip">${esc(t.sex)}</span>
          ${a ? `<span class="chip">${a}</span>` : ""}
        </div>
      </div>
    </section>
    <div class="actions">
      <button class="btn primary" id="addC">Log today's care</button>
      <button class="btn" id="addM">Log measurement</button>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" id="tab-care" aria-selected="${tab === "care"}" aria-controls="panel">Daily care</button>
      <button role="tab" id="tab-growth" aria-selected="${tab === "growth"}" aria-controls="panel">Growth</button>
    </div>
    <div id="panel" role="tabpanel">${tab === "care" ? careTab(id) : growthTab(id)}</div>
    <div style="margin-top:36px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" id="editT">Edit details</button>
      <button class="btn small ghost danger" id="delT">Delete ${esc(t.name)}</button>
    </div>`;
  $("#backBtn").onclick = () => location.hash = "";
  $("#addC").onclick = () => openCare(id, today());
  $("#addM").onclick = () => openMeasure(id);
  $("#tab-care").onclick = () => { settings.tab = "care"; saveSettings(); renderTortoise(id); };
  $("#tab-growth").onclick = () => { settings.tab = "growth"; saveSettings(); renderTortoise(id); };
  $("#editT").onclick = () => openTortoise(t);
  $("#delT").onclick = async () => {
    const what = all.length === 0 ? "" : all.length === 1 ? " and its 1 record" : ` and all ${all.length} records`;
    if(!confirm(`Delete ${t.name}${what}? This can't be undone.`)) return;
    for(const e of all){ await dbDel("entries", e.id); }
    await dbDel("tortoises", t.id);
    store.entries = store.entries.filter(e => e.tortoiseId !== t.id);
    store.tortoises = store.tortoises.filter(x => x.id !== t.id);
    location.hash = ""; toast(`${t.name} deleted`);
  };
  document.querySelectorAll("[data-day]").forEach(b => b.onclick = () => openCare(id, b.dataset.day));
  document.querySelectorAll("[data-cv]").forEach(b => b.onclick = () => { settings.careView = b.dataset.cv; saveSettings(); renderTortoise(id); });
  document.querySelectorAll("[data-mnav]").forEach(b => b.onclick = () => { careMonth = shiftMonth(careMonth || today().slice(0,7), +b.dataset.mnav); renderTortoise(id); });
  document.querySelectorAll("[data-m]").forEach(b => {
    b.setAttribute("aria-pressed", b.dataset.m === metric);
    b.onclick = () => { metric = b.dataset.m; document.querySelectorAll("[data-m]").forEach(x => x.setAttribute("aria-pressed", x.dataset.m === metric)); drawChart(ms); };
  });
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openMeasure(id, store.entries.find(e => e.id === b.dataset.edit)));
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if(!confirm("Delete this measurement?")) return;
    await dbDel("entries", b.dataset.del);
    store.entries = store.entries.filter(e => e.id !== b.dataset.del);
    renderTortoise(id); toast("Measurement deleted");
  });
  document.querySelectorAll("[data-photo]").forEach(img => img.onclick = () => {
    $("#lbImg").src = img.src; $("#lbTitle").textContent = img.dataset.photo; $("#lightbox").showModal();
  });
  if($("#csvT")) $("#csvT").onclick = () => exportCsv(id);
  if(tab === "growth") drawChart(ms);
}
function entryHTML(e){
  const nums = [];
  if(e.weightG != null) nums.push(`<span>Weight <b>${fmtW(e.weightG)}</b></span>`);
  if(e.plastron != null) nums.push(`<span>Plastron <b>${fmtCm(e.plastron)}</b></span>`);
  if(e.scl != null) nums.push(`<span>Carapace <b>${fmtCm(e.scl)}</b></span>`);
  return `<li class="entry"><div class="entry-card">
    <div class="body">
      <time datetime="${esc(e.date)}">${fmtDate(e.date)}</time>
      ${nums.length ? `<div class="entry-nums">${nums.join("")}</div>` : ""}
      ${e.notes ? `<p class="entry-notes">${esc(e.notes)}</p>` : ""}
      <div class="entry-actions"><button class="btn ghost small" data-edit="${esc(e.id)}">Edit</button><button class="btn ghost small danger" data-del="${esc(e.id)}">Delete</button></div>
    </div>
    ${e.photo ? `<img class="entry-photo" src="${esc(e.photo)}" alt="Photo from ${esc(fmtDate(e.date))}" data-photo="${esc(fmtDate(e.date))}">` : ""}
  </div></li>`;
}
function drawChart(list){
  const area = $("#chartArea");
  if(chart){ chart.destroy(); chart = null; }
  const pts = list.filter(e => e[metric] != null).slice().reverse();
  const label = { weightG:"weight", plastron:"plastron length", scl:"carapace length" }[metric];
  if(pts.length < 2){
    area.innerHTML = `<div class="chart-empty">${pts.length ? "One more" : "Two"} ${label} ${pts.length ? "entry" : "entries"} needed to draw the growth line.</div>`;
    return;
  }
  if(typeof Chart === "undefined"){ area.innerHTML = `<div class="chart-empty">The chart needs an internet connection the first time it loads.</div>`; return; }
  area.innerHTML = `<div class="chart-box"><canvas id="cv" aria-label="Growth chart of ${label}" role="img"></canvas></div>`;
  const cs = getComputedStyle(document.documentElement);
  const c = n => cs.getPropertyValue(n).trim();
  const useKg = metric === "weightG" && useKgFor(Math.max(...pts.map(p => p.weightG)), settings.unit);
  const val = p => metric === "weightG" ? (useKg ? p.weightG/1000 : p.weightG) : p[metric];
  const unit = metric === "weightG" ? (useKg ? "kg" : "g") : "cm";
  chart = new Chart($("#cv"), {
    type: "line",
    data: { datasets: [{
      data: pts.map(p => ({ x: dateObj(p.date).getTime(), y: val(p) })),
      borderColor: c("--leaf"), backgroundColor: c("--shell"),
      pointRadius: 4, pointHoverRadius: 6, borderWidth: 2.5, tension: .25
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: items => new Date(items[0].parsed.x).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }),
        label: item => " " + (unit === "g" ? Math.round(item.parsed.y) : item.parsed.y.toFixed(unit === "kg" ? 2 : 1)) + " " + unit
      }}},
      scales: {
        x: { type: "linear", grid: { color: c("--line") }, ticks: { color: c("--muted"), maxTicksLimit: 5,
          callback: v => new Date(v).toLocaleDateString("en-GB", { month:"short", year:"2-digit" }) } },
        y: { grid: { color: c("--line") }, ticks: { color: c("--muted") }, title: { display: true, text: unit, color: c("--muted") } }
      }
    }
  });
}

/* ---------- Saving ---------- */
// Writes a record and reports whether it was stored. Without IndexedDB (blocked by the browser) the app runs from
// memory and says so once at start, so saves aren't reported as failures there.
const put = async (name, obj) => !db || await dbPut(name, obj);
const SAVE_FAILED = "Couldn't save. Your device may be out of storage space. Free some space and try again.";
function showErr(el, msg){ el.textContent = msg; el.hidden = false; }

/* ---------- Tortoise form ---------- */
let editingT = null;
function openTortoise(t){
  editingT = t || null;
  const f = $("#tForm"); f.reset(); $("#tErr").hidden = true;
  $("#tDlgTitle").textContent = t ? "Edit tortoise" : "Add tortoise";
  $("#tSave").textContent = t ? "Save changes" : "Save tortoise";
  if(t){
    f.elements["name"].value = t.name;
    if(SPECIES.includes(t.species)){ f.elements.species.value = t.species; }
    else { f.elements.species.value = "Other"; f.elements.speciesOther.value = t.species; }
    f.elements.sex.value = t.sex; f.elements.birth.value = t.birth || "";
  }
  $("#speciesOtherWrap").hidden = f.elements.species.value !== "Other";
  $("#tDlg").showModal();
}
$("#speciesSel").innerHTML = SPECIES.map(s => `<option>${esc(s)}</option>`).join("");
$("#speciesSel").onchange = e => $("#speciesOtherWrap").hidden = e.target.value !== "Other";
$("#tForm").onsubmit = async ev => {
  ev.preventDefault();
  const f = ev.target;
  const name = f.elements["name"].value.trim();
  let species = f.elements.species.value === "Other" ? f.elements.speciesOther.value.trim() : f.elements.species.value;
  const err = $("#tErr");
  if(!name){ err.textContent = "Give your tortoise a name."; err.hidden = false; return; }
  if(!species){ err.textContent = "Type the species name, or pick one from the list."; err.hidden = false; return; }
  const t = Object.assign({}, editingT || { id: uid(), createdAt: Date.now() }, { name, species, sex: f.elements.sex.value, birth: f.elements.birth.value || null });
  if(!(await put("tortoises", t))){ showErr(err, SAVE_FAILED); return; }
  if(editingT) store.tortoises[store.tortoises.indexOf(editingT)] = t;
  else { store.tortoises.push(t); requestPersist(); }
  $("#tDlg").close();
  toast(editingT ? "Changes saved" : `${name} added`);
  if(editingT) route(); else location.hash = "t/" + t.id;
};

/* ---------- Measurement form ---------- */
let measureCtx = null, pendingPhoto = null;
function setPhoto(src){
  pendingPhoto = src;
  $("#photoPrev").hidden = !src;
  if(src) $("#photoPrev").src = src; else $("#photoPrev").removeAttribute("src");
  $("#photoRm").hidden = !src;
}
function openMeasure(tid, e){
  measureCtx = { tid, entry: e || null };
  const f = $("#mForm"); f.reset(); $("#mErr").hidden = true; $("#photoIn").value = "";
  $("#mDlgTitle").textContent = e ? "Edit measurement" : "Log measurement";
  f.elements.date.value = e ? e.date : today();
  f.elements.wunit.value = settings.unit === "kg" ? "kg" : "g";
  if(e){
    if(e.plastron != null) f.elements.plastron.value = e.plastron;
    if(e.scl != null) f.elements.scl.value = e.scl;
    if(e.weightG != null){
      if(e.weightG >= 1000){ f.elements.weight.value = +(e.weightG/1000).toFixed(4); f.elements.wunit.value = "kg"; }
      else { f.elements.weight.value = +e.weightG.toFixed(1); f.elements.wunit.value = "g"; }
    }
    f.elements.notes.value = e.notes || "";
  }
  setPhoto(e ? e.photo : null);
  $("#mDlg").showModal();
}
function resizeImage(file, max = 900){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(); };
    img.src = url;
  });
}
$("#photoIn").onchange = async ev => {
  const file = ev.target.files[0]; if(!file) return;
  try{ setPhoto(await resizeImage(file)); }
  catch(e){ const err = $("#mErr"); err.textContent = "This photo format can't be read. Try a JPG or PNG."; err.hidden = false; }
};
$("#photoRm").onclick = () => { setPhoto(null); $("#photoIn").value = ""; };
$("#mForm").onsubmit = async ev => {
  ev.preventDefault();
  const f = ev.target, err = $("#mErr");
  const data = {
    kind: "measure",
    date: f.elements.date.value || today(),
    plastron: toCm(f.elements.plastron.value),
    scl: toCm(f.elements.scl.value),
    weightG: toGrams(f.elements.weight.value, f.elements.wunit.value),
    photo: pendingPhoto, notes: f.elements.notes.value.trim()
  };
  // A field that was filled in but gave no value (not a number, or rounds to 0) is a typo, not an empty field.
  for(const [k, name] of [["plastron", "plastron length"], ["scl", "carapace length"], ["weightG", "weight"]]){
    const raw = f.elements[k === "weightG" ? "weight" : k].value;
    if(raw.trim() && data[k] == null){ showErr(err, `Check the ${name}: use a number like 12.5`); return; }
  }
  if(data.plastron == null && data.scl == null && data.weightG == null && !data.photo){
    err.textContent = "Enter at least one measurement or add a photo."; err.hidden = false; return;
  }
  const e = Object.assign({}, measureCtx.entry || { id: uid(), tortoiseId: measureCtx.tid, createdAt: Date.now() }, data);
  if(!(await put("entries", e))){ showErr(err, SAVE_FAILED); return; }
  if(measureCtx.entry) store.entries[store.entries.indexOf(measureCtx.entry)] = e;
  else store.entries.push(e);
  $("#mDlg").close();
  settings.tab = "growth"; saveSettings();
  toast(measureCtx.entry ? "Measurement updated" : "Measurement saved");
  renderTortoise(measureCtx.tid);
};

/* ---------- Daily care form ---------- */
let careCtx = null;
// A day logged with a food that is no longer in FOODS (e.g. "Weeds" or "Vegetables" from before the list changed)
// shows that food as an extra chip, so saving the day again keeps it.
function renderFoodChips(stored = []){
  const foods = FOODS.concat(stored.filter(x => !FOODS.includes(x)));
  $("#foodChips").innerHTML = foods.map(f => `<label><input type="checkbox" name="food" value="${esc(f)}"><span>${esc(f)}</span></label>`).join("");
}
renderFoodChips();
$("#cForm").elements.poop.insertAdjacentHTML("beforeend", POOP.map(p => `<option>${esc(p)}</option>`).join(""));
$("#cForm").elements.urates.insertAdjacentHTML("beforeend", URATES.map(p => `<option>${esc(p)}</option>`).join(""));
function fillCare(date){
  const f = $("#cForm"); f.reset(); $("#cErr").hidden = true;
  f.elements.date.value = date;
  const e = careOf(careCtx.tid, date);
  renderFoodChips(e ? e.food || [] : []);
  if(e){
    f.elements.soaked.checked = !!e.soaked;
    f.querySelectorAll("[name=food]").forEach(c => c.checked = (e.food || []).includes(c.value));
    f.elements.foodNote.value = e.foodNote || ""; f.elements.poop.value = e.poop || ""; f.elements.urates.value = e.urates || ""; f.elements.notes.value = e.notes || "";
  }
  const d = daysAgo(date);
  $("#cDlgTitle").textContent = d === 0 ? "Today's care" : d === 1 ? "Yesterday's care" : "Care on " + fmtDate(date);
  $("#cHint").hidden = !e; $("#cHint").textContent = e ? "Already logged for this day. Your changes update it." : "";
  $("#cClear").hidden = !e;
}
function openCare(tid, date){
  careCtx = { tid };
  fillCare(date || today());
  $("#cDlg").showModal();
}
$("#cForm").elements.date.onchange = ev => { if(ev.target.value) fillCare(ev.target.value); };
$("#cClear").onclick = async () => {
  const date = $("#cForm").elements.date.value; const e = careOf(careCtx.tid, date);
  if(!e || !confirm(`Clear all care logged on ${fmtDate(date)}?`)) return;
  await dbDel("entries", e.id);
  store.entries = store.entries.filter(x => x.id !== e.id);
  $("#cDlg").close(); toast("Day cleared"); renderTortoise(careCtx.tid);
};
$("#cForm").onsubmit = async ev => {
  ev.preventDefault();
  const f = ev.target, err = $("#cErr");
  const date = f.elements.date.value || today();
  const data = {
    soaked: f.elements.soaked.checked,
    food: [...f.querySelectorAll("[name=food]:checked")].map(c => c.value),
    foodNote: f.elements.foodNote.value.trim(), poop: f.elements.poop.value, urates: f.elements.urates.value, notes: f.elements.notes.value.trim()
  };
  if(isEmptyCare(data)){
    err.textContent = careOf(careCtx.tid, date) ? "Nothing is filled in. Use Clear this day to remove the record." : "Fill in at least one thing before saving.";
    err.hidden = false; return;
  }
  const { entry: e, created, old } = upsertCare(store.entries, careCtx.tid, date, data);
  if(!(await put("entries", e))){ showErr(err, SAVE_FAILED); return; }
  if(created) store.entries.push(e);
  else store.entries[store.entries.indexOf(old)] = e;
  $("#cDlg").close();
  settings.tab = "care"; saveSettings();
  toast(created ? "Care saved" : "Care updated");
  renderTortoise(careCtx.tid);
};

/* ---------- Migrate records from the first prototype ---------- */
async function migrate(){
  if(!store.entries.some(e => !e.kind)) return;
  const r = migrateEntries(store.entries);
  store.entries = r.entries;
  for(const id of r.dels) await dbDel("entries", id);
  for(const e of r.puts) await dbPut("entries", e);
}

/* ---------- Settings & backup ---------- */
$("#openSettings").onclick = () => {
  document.querySelectorAll('[name=unit]').forEach(r => r.checked = r.value === settings.unit);
  showStorageStatus(); $("#sDlg").showModal();
};
document.querySelectorAll('[name=unit]').forEach(r => r.onchange = () => { settings.unit = r.value; saveSettings(); route(); });
function download(name, text, type){
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("#exportJson").onclick = () => {
  const data = buildBackup(store.tortoises, store.entries, $("#incPhotos").checked);
  download(`kulalog-backup-${today()}.json`, JSON.stringify(data), "application/json");
  toast("Backup saved. Keep the file somewhere safe.");
};

function exportCsv(tid){
  const { count, text } = buildCsv(store.tortoises, store.entries, tid);
  if(!count){ toast("No measurements to export yet"); return; }
  const t = tid && store.tortoises.find(x => x.id === tid);
  const slug = t ? fileSlug(t.name) : "";
  download(`kulalog-measurements${slug ? "-" + slug : ""}-${today()}.csv`, text, "text/csv;charset=utf-8");
  toast(`Exported ${plural(count, "measurement", "measurements")}`);
}
$("#exportCsv").onclick = () => exportCsv();

$("#importFile").onchange = async ev => {
  const file = ev.target.files[0]; ev.target.value = "";
  if(!file) return;
  const data = parseBackup(await file.text());
  if(!data){ toast("That isn't a Kulalog backup"); return; }
  const r = mergeBackup(store, data);
  let failed = 0;
  for(const t of r.tortoisePuts) if(!(await put("tortoises", t))) failed++;
  for(const e of r.entryPuts) if(!(await put("entries", e))) failed++;
  if(failed && db){
    // Show what really reached storage, not what was meant to.
    store.tortoises = await getAll("tortoises"); store.entries = await getAll("entries");
  }else{ store.tortoises = r.tortoises; store.entries = r.entries; }
  await migrate();
  $("#sDlg").close(); route();
  toast(failed ? "Couldn't import everything. Your device may be out of storage space."
    : `Imported ${plural(data.tortoises.length, "tortoise", "tortoises")} and ${plural(data.entries.length, "entry", "entries")}`);
  requestPersist();
};

/* ---------- Persistent storage ---------- */
// Ask once there is something worth keeping, so the browser doesn't evict it under storage pressure.
async function requestPersist(){
  if(!navigator.storage || !navigator.storage.persist || !store.tortoises.length) return;
  try{ if(!(await navigator.storage.persisted())) await navigator.storage.persist(); }catch(e){}
}
async function showStorageStatus(){
  const el = $("#storageStatus");
  if(!navigator.storage || !navigator.storage.persisted){ el.hidden = true; return; }
  try{
    const p = await navigator.storage.persisted();
    el.textContent = p ? "Storage is persistent: the browser won't clear your records to free up space."
      : "The browser hasn't granted persistent storage yet, so it may clear records if the device runs low on space. Installing Kulalog to your home screen helps. Keep backups.";
    el.hidden = false;
  }catch(e){ el.hidden = true; }
}

/* ---------- Offline support ---------- */
function registerSW(){
  if(!("serviceWorker" in navigator)) return;
  let accepted = false;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if(accepted){ accepted = false; location.reload(); return; }
    // Another tab applied an update; this page still runs the old code. The first install also changes the
    // controller (no controller -> first worker), and that needs no reload; every later change is an update.
    if(hadController){ $("#updateBar").hidden = false; $("#updateBtn").onclick = () => location.reload(); }
    hadController = true;
  });
  navigator.serviceWorker.register("sw.js").then(reg => {
    const offer = w => {
      $("#updateBar").hidden = false;
      $("#updateBtn").onclick = () => {
        // If another tab already activated this worker, just load the new version.
        if(w.state !== "installed"){ location.reload(); return; }
        accepted = true; w.postMessage("skipWaiting");
      };
    };
    // An update that finished downloading during an earlier visit is applied now, while the app is starting and
    // nothing has been typed in yet. (Waiting for a tap on Reload left installed apps on old versions for good.)
    if(reg.waiting && navigator.serviceWorker.controller){ accepted = true; reg.waiting.postMessage("skipWaiting"); }
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w.addEventListener("statechange", () => { if(w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => {});
}

/* ---------- Chart.js arrives later ---------- */
// Chart.js loads async so a slow CDN never holds up the app. If it arrives after the growth tab was drawn, draw the chart.
const chartScript = document.getElementById("chartjs");
if(chartScript) chartScript.addEventListener("load", () => {
  const m = location.hash.match(/^#t\/(.+)$/);
  if(m && $("#chartArea") && !chart) drawChart(measuresOf(m[1]));
});

/* ---------- A new day while the app stays open ---------- */
// Phones keep an installed app open for days; "Today", "Yesterday" and the 7-day list follow the calendar.
let shownDay = null;
function checkDay(){
  if(shownDay && today() !== shownDay){
    const y = window.scrollY;
    route(); window.scrollTo(0, y);
  }
}
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") checkDay(); });
setInterval(checkDay, 60_000);

/* ---------- Dialog closing ---------- */
document.querySelectorAll("dialog").forEach(d => {
  d.querySelectorAll("[data-close]").forEach(b => b.onclick = () => d.close());
  d.addEventListener("click", ev => { if(ev.target === d) d.close(); });
});

/* ---------- Boot ---------- */
(async () => {
  loadSettings();
  db = await openDB();
  // Stored records get the same checks as an import, so one malformed record (e.g. imported before backups were
  // checked) can't blank a page or inject markup. Records that fail stay in storage untouched but aren't shown.
  store.tortoises = (await getAll("tortoises")).map(cleanTortoise).filter(Boolean);
  store.entries = (await getAll("entries")).map(cleanEntry).filter(Boolean);
  await migrate();
  window.addEventListener("hashchange", route);
  route();
  if(!db) toast("This browser is blocking storage, so records won't be kept after you close Kulalog.");
  requestPersist();
  registerSW();
})();
