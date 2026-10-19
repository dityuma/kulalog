/* Kulalog data logic: pure functions with no DOM or storage access.
   Loaded as a classic script by the app (top-level names become globals)
   and with require() by the unit tests. */

const BAD_POOP = ["Runny","Dry / hard","Contains undigested food"], BAD_URATES = ["Gritty / chalky"];

/* ---------- Numbers and units ---------- */
// Accepts "12.5", "12,5" and surrounding spaces, plus thousands separators: "1.234,5" (Indonesian),
// "1,234.5" (English), "1 234" and "1.234.567". Zero, negatives, junk and trailing text such as "12 kg" give null,
// so the form asks again instead of silently saving a different number.
function num(v){
  let s = String(v ?? "").trim().replace(/(\d)[\s\u00a0\u202f]+(?=\d)/g, "$1");
  const groups = parts => parts.slice(1).every(p => /^\d{3}$/.test(p));
  const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
  if(dot >= 0 && comma >= 0){
    // Both marks: the last one is the decimal mark, the other one groups thousands.
    const [dec, thou] = dot > comma ? [".", ","] : [",", "."];
    const at = s.lastIndexOf(dec), int = s.slice(0, at).split(thou);
    if(s.slice(at + 1).includes(thou) || !groups(int)) return null;
    s = int.join("") + "." + s.slice(at + 1);
  }else if(dot >= 0 || comma >= 0){
    const parts = s.split(dot >= 0 ? "." : ",");
    if(parts.length > 2){
      // The same mark more than once can only group thousands.
      const last = parts[parts.length - 1].match(/^\d{3}(?!\d)/);
      if(!last || !groups(parts.slice(0, -1).concat(last[0]))) return null;
      s = parts.join("");
    }else s = parts.join(".");
  }
  if(!/^\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}
const round1 = v => Math.round(v * 10) / 10;
// Upper bounds well above any tortoise (the largest are about 1.3 m and 400 kg). Anything bigger is a typo,
// and absurd values (1.79e308) would freeze the growth chart.
const MAX_CM = 1000, MAX_G = 1e6;
// Weight typed in the form, stored in grams with 0.1 g precision. Null when it isn't a number, rounds to 0 g or is too big.
const toGrams = (value, unit) => { const w = num(value); const g = w == null ? 0 : round1(unit === "kg" ? w * 1000 : w); return g > 0 && g <= MAX_G ? g : null; };
// Length typed in the form, stored in cm with 0.1 cm precision. Null when it isn't a number, rounds to 0 or is too big.
const toCm = value => { const v = num(value); const cm = v == null ? 0 : round1(v); return cm > 0 && cm <= MAX_CM ? cm : null; };
const useKgFor = (g, unit) => unit === "kg" || (unit === "auto" && g >= 1000);
function fmtWeight(g, unit){
  if(g == null) return "–";
  if(!useKgFor(g, unit)) return Math.round(g).toLocaleString("en-US") + " g";
  return (g/1000).toFixed(2) + " kg";
}
// Growth rates can be small, so grams keep one decimal below 10 g. Under 10 g a month the rate is shown in grams
// even with the Kilograms setting, where it would round to "0.00 kg" and hide a small loss.
const fmtWeightRate = (g, unit) => useKgFor(g, unit) && g >= 10 ? (g/1000).toFixed(2) + " kg" : (g < 10 ? g.toFixed(1) : Math.round(g)) + " g";
// "1 tortoise", "2 tortoises".
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const fmtCm = v => v == null ? "–" : v.toFixed(1) + " cm";

/* ---------- Dates (ISO yyyy-mm-dd in local time) ---------- */
const todayISO = (now = new Date()) => { const d = new Date(now); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const dateObj = iso => new Date(iso + "T00:00:00");
const fmtDate = iso => dateObj(iso).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
function shiftDay(iso, n){ const d = dateObj(iso); d.setDate(d.getDate() + n); return todayISO(d); }
function shiftMonth(ym, n){ const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
const daysBetween = (fromIso, toIso) => Math.round((dateObj(toIso) - dateObj(fromIso)) / 864e5);
function ageText(birth, now = new Date()){
  if(!birth) return null;
  const b = dateObj(birth), n = new Date(now);
  let m = (n.getFullYear()-b.getFullYear())*12 + (n.getMonth()-b.getMonth());
  if(n.getDate() < b.getDate()) m--;
  if(m < 0) return null;
  const y = Math.floor(m/12), mo = m%12;
  if(y === 0) return mo + (mo === 1 ? " month" : " months") + " old";
  return y + " yr" + (mo ? " " + mo + " mo" : "") + " old";
}

/* ---------- Entries ---------- */
// Newest first; same-day entries by creation time.
const sortEntries = list => list.slice().sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
const latest = (list, key) => { const e = list.find(x => x[key] != null); return e ? e[key] : null; };
// Change per 30 days between the oldest and newest value. Needs 2 values at least a week apart.
function perMonth(list, key){
  const pts = list.filter(e => e[key] != null);
  if(pts.length < 2) return null;
  const first = pts[pts.length-1], last = pts[0];
  const days = daysBetween(first.date, last.date);
  if(days < 7) return null;
  return (last[key] - first[key]) / days * 30;
}
const isFed = e => !!((e.food && e.food.length) || e.foodNote);
const isEmptyCare = d => !d.soaked && !(d.food && d.food.length) && !d.foodNote && !d.poop && !d.urates && !d.notes;

/* ---------- One care record per tortoise per day ---------- */
const careId = (tid, date) => "c_" + tid + "_" + date;
const findCare = (entries, tid, date) => entries.find(e => e.kind === "care" && e.tortoiseId === tid && e.date === date);
// Returns the record to save for that day: an updated copy of the day's record (same id and createdAt), or a new one
// with a deterministic id. Nothing in `entries` changes, so a failed save leaves the day as it was; once the record is
// stored the caller replaces `old` with `entry`, or adds `entry` when `created`.
function upsertCare(entries, tid, date, data, now = Date.now()){
  const old = findCare(entries, tid, date) || null;
  const entry = Object.assign({}, old || { id: careId(tid, date), tortoiseId: tid, createdAt: now }, { kind: "care", date }, data);
  return { entry, created: !old, old };
}

/* ---------- Records from the first prototype ---------- */
// Old entries had no `kind` and mixed growth and care fields. Split each into a measurement and/or the day's care record.
// Returns the new entry list plus the ids to delete and the records to write.
function migrateEntries(entries){
  let list = entries.slice();
  const dels = [], puts = new Map();
  for(const e of entries.filter(x => !x.kind)){
    const hasM = e.plastron != null || e.scl != null || e.weightG != null || !!e.photo;
    const hasC = !!(e.soaked || (e.food && e.food.length) || e.foodNote || e.poop || e.urates);
    list = list.filter(x => x !== e);
    dels.push(e.id);
    if(hasM || (!hasC && e.notes)){
      const m = { id: e.id, kind: "measure", tortoiseId: e.tortoiseId, date: e.date, createdAt: e.createdAt,
        plastron: e.plastron ?? null, scl: e.scl ?? null, weightG: e.weightG ?? null, photo: e.photo || null, notes: e.notes || "" };
      list.push(m); puts.set(m.id, m);
    }
    if(hasC){
      let c = findCare(list, e.tortoiseId, e.date);
      if(!c){ c = { id: careId(e.tortoiseId, e.date), kind: "care", tortoiseId: e.tortoiseId, date: e.date, createdAt: e.createdAt,
        soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "" }; list.push(c); }
      c.soaked = c.soaked || !!e.soaked;
      c.food = [...new Set([...(c.food || []), ...(e.food || [])])];
      c.foodNote = [c.foodNote, e.foodNote].filter(Boolean).join(", ");
      c.poop = c.poop || e.poop || ""; c.urates = c.urates || e.urates || "";
      if(!hasM && e.notes) c.notes = [c.notes, e.notes].filter(Boolean).join("\n");
      puts.set(c.id, c);
    }
  }
  return { entries: list, dels: dels.filter(id => !puts.has(id)), puts: [...puts.values()] };
}

/* ---------- Backup ---------- */
function buildBackup(tortoises, entries, includePhotos, now = new Date()){
  return { app: "kulalog", version: 1, exported: new Date(now).toISOString(), tortoises,
    entries: entries.map(e => includePhotos ? e : Object.assign({}, e, { photo: null })) };
}
// Backups are shared between keepers, so everything that ends up in the page is checked here.
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const isDate = v => typeof v === "string" && ISO_DATE.test(v) && !isNaN(dateObj(v)) && todayISO(dateObj(v)) === v;
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
const pos = (v, max) => typeof v === "number" && isFinite(v) && v > 0 && v <= max ? v : null;
const stamp = v => typeof v === "number" && isFinite(v) ? v : 0;
function cleanTortoise(t){
  if(!t || typeof t !== "object" || typeof t.id !== "string" || !SAFE_ID.test(t.id) || typeof t.name !== "string" || !t.name.trim()) return null;
  return { id: t.id, createdAt: stamp(t.createdAt), name: t.name.slice(0, 40), species: str(t.species, 60) || "Other",
    sex: ["Unknown", "Male", "Female"].includes(t.sex) ? t.sex : "Unknown", birth: isDate(t.birth) ? t.birth : null };
}
function cleanEntry(e){
  if(!e || typeof e !== "object" || typeof e.id !== "string" || !SAFE_ID.test(e.id)) return null;
  if(typeof e.tortoiseId !== "string" || !SAFE_ID.test(e.tortoiseId) || !isDate(e.date)) return null;
  if(e.kind !== undefined && e.kind !== "measure" && e.kind !== "care") return null;
  // Built field by field from the record's own keys: unknown fields are dropped, and a JSON "__proto__" key can't
  // become the prototype. Old prototype records (no kind) can hold both growth and care fields; each is checked.
  const has = k => Object.prototype.hasOwnProperty.call(e, k);
  const out = { id: e.id, tortoiseId: e.tortoiseId, date: e.date, createdAt: stamp(e.createdAt) };
  if(e.kind !== undefined) out.kind = e.kind;
  if(has("plastron")) out.plastron = pos(e.plastron, MAX_CM);
  if(has("scl")) out.scl = pos(e.scl, MAX_CM);
  if(has("weightG")) out.weightG = pos(e.weightG, MAX_G);
  if(has("photo")) out.photo = typeof e.photo === "string" && PHOTO.test(e.photo) ? e.photo : null;
  if(has("notes")) out.notes = str(e.notes, 1000);
  if(has("soaked")) out.soaked = e.soaked === true;
  if(has("food")) out.food = Array.isArray(e.food) ? e.food.filter(x => typeof x === "string").map(x => x.slice(0, 60)) : [];
  if(has("foodNote")) out.foodNote = str(e.foodNote, 120);
  if(has("poop")) out.poop = str(e.poop, 60);
  if(has("urates")) out.urates = str(e.urates, 60);
  return out;
}
// Returns { tortoises, entries } with unusable records dropped and every field checked,
// or null when the text isn't a Kulalog backup.
function parseBackup(text){
  let data;
  try{ data = JSON.parse(String(text).replace(/^﻿/, "")); }catch(e){ return null; }
  if(!data || data.app !== "kulalog" || !Array.isArray(data.tortoises)) return null;
  return {
    tortoises: data.tortoises.map(cleanTortoise).filter(Boolean),
    entries: (Array.isArray(data.entries) ? data.entries : []).map(cleanEntry).filter(Boolean)
  };
}
// Adds new records and replaces matching ones. A backup made without photos keeps the photos already on the device.
function mergeBackup(store, data){
  const tortoises = store.tortoises.slice(), entries = store.entries.slice();
  for(const t of data.tortoises){
    const i = tortoises.findIndex(x => x.id === t.id); i >= 0 ? tortoises[i] = t : tortoises.push(t);
  }
  const entryPuts = data.entries.map(src => {
    const e = Object.assign({}, src);
    const i = entries.findIndex(x => x.id === e.id);
    if(i >= 0 && entries[i].photo && !e.photo) e.photo = entries[i].photo;
    i >= 0 ? entries[i] = e : entries.push(e);
    return e;
  });
  return { tortoises, entries, tortoisePuts: data.tortoises, entryPuts };
}

/* ---------- CSV of measurements ---------- */
function csvCell(v){
  if(v == null) return "";
  let s = String(v);
  if(typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// One row per measurement, oldest first per tortoise, weight always in grams. Returns the row count and the file text.
function buildCsv(tortoises, entries, tid){
  const ts = tortoises.filter(t => !tid || t.id === tid).sort((a,b) => a.name.localeCompare(b.name));
  const rows = [["Tortoise","Species","Date","Weight (g)","Plastron (cm)","Carapace SCL (cm)","Notes","Has photo"]];
  for(const t of ts){
    const ms = sortEntries(entries.filter(e => e.tortoiseId === t.id && e.kind === "measure")).reverse();
    for(const e of ms) rows.push([t.name, t.species, e.date, e.weightG, e.plastron, e.scl, e.notes || "", e.photo ? "yes" : "no"]);
  }
  return { count: rows.length - 1, text: "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") };
}
const fileSlug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

if(typeof module !== "undefined" && module.exports){
  module.exports = { BAD_POOP, BAD_URATES, MAX_CM, MAX_G, num, round1, toGrams, toCm, useKgFor, fmtWeight, fmtWeightRate, plural, fmtCm,
    todayISO, dateObj, fmtDate, shiftDay, shiftMonth, daysBetween, ageText,
    sortEntries, latest, perMonth, isFed, isEmptyCare, careId, findCare, upsertCare, migrateEntries,
    buildBackup, parseBackup, cleanTortoise, cleanEntry, mergeBackup, csvCell, buildCsv, fileSlug };
}
