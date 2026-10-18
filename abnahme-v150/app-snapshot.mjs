// Reines Testdatenformat. Keine Browser-Spielstände, Kataloge oder Zugangsdaten lesen.
export const PARTS = 5;
export const MAX_FRAGMENT = 600_000;
export const EMPTY = Object.freeze({schema:2,aux:{decks:null,battle:null},collections:{mcp:{owned:{},packs:0},pocket:{sets:{}},live:{sets:{}},lorcana:{sets:{}},onepiece:{sets:{}}},wallet:{v:1,units:0,lastDay:'',gifts:{}},promos:{schema:1,pocket:{packs:0,claimed:0,owned:{},pending:null},live:{packs:0,claimed:0,owned:{},pending:null}}});
export const clone = x => structuredClone(x);
const plain = x => !!x && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const natural = x => Number.isSafeInteger(x) && x>=0;
function keys(x, allowed) { if (!plain(x) || Object.keys(x).some(k=>!allowed.includes(k)) || allowed.some(k=>!Object.hasOwn(x,k))) throw Error('Ungültige Struktur'); }
function counts(x) { if(!plain(x) || Object.entries(x).some(([k,v])=>!k || k.length>160 || k.startsWith('mcp_dev_v1:') || !natural(v))) throw Error('Ungültige Kartenmengen'); }
function pack(x) { keys(x,['owned','packs']); counts(x.owned); if(!natural(x.packs)) throw Error('Ungültige Packzahl'); }
export function validate(data) {
  keys(data,['schema','collections','wallet','promos','aux']);keys(data.aux,['decks','battle']);for(const v of Object.values(data.aux))if(v!==null&&!plain(v))throw Error('Ungültiger Zusatzspielstand');
  if(data.schema!==2) throw Error('Unbekanntes Schema');
  keys(data.collections,['mcp','pocket','live','lorcana','onepiece']); pack(data.collections.mcp);
  for(const world of ['pocket','live','lorcana','onepiece']) {
    keys(data.collections[world],['sets']);
    if(!plain(data.collections[world].sets)) throw Error('Ungültige Sets');
    for(const [id,set] of Object.entries(data.collections[world].sets)) { if(!id || id.length>160 || id.includes('mcp_dev_v1:')) throw Error('Ungültige Set-ID'); pack(set); }
  }
  keys(data.wallet,['v','units','lastDay','gifts']);
  if(data.wallet.v!==1 || !natural(data.wallet.units) || typeof data.wallet.lastDay!=='string' || !plain(data.wallet.gifts) || Object.values(data.wallet.gifts).some(v=>v!==true)) throw Error('Ungültiges Wallet');
  keys(data.promos,['schema','pocket','live']);
  if(data.promos.schema!==1) throw Error('Ungültige Promos');
  for(const world of ['pocket','live']) {
    const p=data.promos[world]; keys(p,['packs','claimed','owned','pending']); counts(p.owned);
    if(!natural(p.packs)||!natural(p.claimed)||p.claimed>Math.floor(p.packs/20)) throw Error('Ungültige Ansprüche');
    if(p.pending!==null) { keys(p.pending,['set','ids']); if(typeof p.pending.set!=='string'||!Array.isArray(p.pending.ids)||p.pending.ids.length<1||p.pending.ids.length>3||new Set(p.pending.ids).size!==p.pending.ids.length||p.pending.ids.some(id=>typeof id!=='string'||!id)) throw Error('Ungültige offene Auswahl'); }
  }
  if(JSON.stringify(data).includes('mcp_dev_v1:')) throw Error('Entwicklerspeicher ist ausgeschlossen');
  return data;
}
export function canonical(x) {
  return JSON.stringify(x,(_,v)=>plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
}
export async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
}
export async function encode(data) {
  validate(data);
  const json=canonical(data), bytes=new TextEncoder().encode(json);
  // Budget vor Base64-Konvertierung und vor jedem Schreibzugriff prüfen.
  if(bytes.length>2_200_000) throw Error('Spielstand überschreitet das vorbereitete Größenbudget');
  let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const base64=btoa(binary), width=Math.ceil(base64.length/PARTS);
  const fragments=Array.from({length:PARTS},(_,i)=>base64.slice(i*width,(i+1)*width));
  if(fragments.some(x=>x.length>MAX_FRAGMENT)) throw Error('Dokument zu groß');
  return {json,digest:await digest(json),fragments};
}
export async function decode(fragments,expected) {
  if(fragments.length!==PARTS || fragments.some(x=>typeof x!=='string'||x.length>MAX_FRAGMENT)) throw Error('Unvollständiger Spielstand');
  const binary=atob(fragments.join('')), json=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)));
  if(await digest(json)!==expected) throw Error('Prüfsumme stimmt nicht');
  return validate(JSON.parse(json));
}
export function summary(data) {
  validate(data);
  let cards=0,packs=0; for(const [world,c] of Object.entries(data.collections)) for(const set of world==='mcp'?[c]:Object.values(c.sets)) { cards+=Object.values(set.owned).reduce((a,b)=>a+b,0); packs+=set.packs; }
  return {cards,packs,units:data.wallet.units,day:data.wallet.lastDay,gifts:clone(data.wallet.gifts),promos:clone(data.promos)};
}
const fixtures=new WeakSet();
export async function prepareImport(guest,backupSink) {
  if(!fixtures.has(guest)||guest.build!=='normal'||guest.prefix!=='mcp_fixture_v1:'||guest.source!=='isolated-fixture') throw Error('Nur isolierte Gast-Testdaten erlaubt');
  const data=clone(guest.data), encoded=await encode(data);
  const backup={format:'mcp-emulator-fixture-backup-v1',source:guest.source,data,digest:encoded.digest,json:encoded.json};
  if(await backupSink(clone(backup))!==encoded.digest) throw Error('Sicherung nicht bestätigt; keine Übernahme');
  return {data,encoded,summary:summary(data),source:'isolated-fixture'};
}
