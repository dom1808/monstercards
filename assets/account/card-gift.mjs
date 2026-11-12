// Private card gifts: same snapshot transaction and journal; explicit trusted-client quantity model.
import {doc,serverTimestamp,getDocFromServer,getDocsFromServer,collection,query,where,limit} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import {clone,canonical,digest,encode} from './app-snapshot.mjs';
import {createGameDriver,applyGameRecords} from './game-driver.mjs';
const same=(a,b)=>canonical(a)===canonical(b),idGuard=id=>{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,60}$/.test(id))throw Error('Ungültige Geschenkkennung');return id;};
export function identity(value){if(!value||Object.keys(value).sort().join(',')!=='cardId,category,printKey,setId,variant,world'||!['mcp','pocket','live','lc','op'].includes(value.world)||value.category!=='regular'||!['string','number'].includes(typeof value.cardId)||typeof value.cardId==='number'&&!Number.isSafeInteger(value.cardId)||!String(value.cardId)||String(value.cardId).length>512||['setId','printKey','variant'].some(k=>typeof value[k]!=='string'||!value[k]||value[k].length>4096))throw Error('Vollständige reguläre Druckidentität erforderlich');return clone(value);}
function playerData(d,uid){if(d?.schema!==1||!Array.isArray(d.uids)||d.uids.length<2||d.uids.length>3||new Set(d.uids).size!==d.uids.length||!d.uids.includes(uid)||!d.names||Object.keys(d.names).length!==d.uids.length||d.uids.some(id=>typeof id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(id)||!Object.hasOwn(d.names,id)||typeof d.names[id]!=='string'||[...d.names[id].trim()].length<3||[...d.names[id].trim()].length>24||/[\u0000-\u001f\u007f]/.test(d.names[id])))throw Error('Schenken noch nicht freigeschaltet · private Spielerliste fehlt oder ist ungültig');return d.uids.map(id=>({uid:id,name:d.names[id].trim()}));}
export const proof=command=>digest(canonical({uid:command.uid,id:command.id,kind:command.kind,baseRevision:command.baseRevision,details:command.details,changes:command.changes}));
const giftRef=(a,id)=>doc(a.db,'cardGifts',id),slotRef=(a,uid)=>doc(a.db,'cardGiftSlots',uid);
function guard(a,uid,prefix=''){if(!a.online||a.live||a.auth.currentUser?.uid!==uid||!a.auth.currentUser.emailVerified||a.cache?.meta?.deletionRequested||prefix.includes('mcp_dev_v1:')||prefix.includes('mcp_v150_stage:')||globalThis.document?.documentElement?.dataset?.mcpBuild==='developer')throw Error('Nur online im synchronisierten eigenen Konto');}
export async function prepareCardGift(tx,a,uid,next,plan){
 guard(a,uid);idGuard(plan.id);const gref=giftRef(a,plan.id),sref=slotRef(a,plan.sender),[gs,ss,players]=await Promise.all([tx.get(gref),tx.get(sref),tx.get(doc(a.db,'cardGiftConfig','players'))]);const roster=playerData(players.exists()?players.data():null,uid);if(!roster.some(p=>p.uid===plan.receiver))throw Error('Empfänger nicht für Geschenke freigegeben');
 if(plan.kind==='send'){
  if(uid!==plan.sender||uid===plan.receiver||gs.exists()||ss.exists()&&ss.data().open)throw Error('Geschenk oder offener Senderplatz bereits vorhanden');
  const card=identity(plan.card),g={schema:1,quantity:1,sender:uid,receiver:plan.receiver,card,state:'offered',sendOp:next.lastOp,sendProof:plan.proof,sendRevision:next.revision,createdAt:serverTimestamp(),receiveOp:'',receiveProof:'',receiveRevision:0,acceptedAt:null};
  return()=>{tx.set(gref,g);tx.set(sref,{giftId:plan.id,open:true});};
 }
 if(plan.kind!=='accept'||!gs.exists())throw Error('Unbekanntes Geschenk');const g=gs.data();
 if(g.state!=='offered'||g.sender!==plan.sender||g.receiver!==uid||!ss.exists()||!ss.data().open||ss.data().giftId!==plan.id||!same(g.card,plan.card))throw Error('Geschenk nicht offen oder falscher Empfänger');
 return()=>{tx.update(gref,{state:'accepted',receiveOp:next.lastOp,receiveProof:plan.proof,receiveRevision:next.revision,acceptedAt:serverTimestamp()});tx.set(sref,{giftId:plan.id,open:false});};
}
export function createCardGiftDriver({account,scope,readLocal,catalog,prefix=''}){
 const uid=account.auth.currentUser?.uid,base=createGameDriver({account,scope,readLocal,catalog});
 async function read(){guard(account,uid,prefix);return base.read();}
 async function commit(command){guard(account,uid,prefix);if(!['card-send','card-accept'].includes(command.kind))return base.commit(command);
  const d=command.details,card=identity(d.card),sign=command.kind==='card-send'?-1:1;if(command.id!==(sign<0?'cg-send-':'cg-accept-')+idGuard(d.giftId)||d.sender===d.receiver||(sign<0?d.sender:d.receiver)!==uid)throw Error('Falsche feste Geschenk-/Vorgangsbindung');
  const entry=(catalog.gift||catalog)(d.set,d.inventoryId);if(!entry||entry.promo||!same(entry.identity,card)||!entry.ids.includes(d.inventoryId))throw Error('Unbekannte Druck-/Bestandszuordnung');
  const before=account.cache?.data;if(!before||command.uid!==uid||command.baseRevision!==account.cache.meta.revision||(await encode(readLocal())).digest!==account.cache.meta.dataDigest)throw Error('Aktuellen eigenen Stand laden');
  const expected=clone(before),world={lc:'lorcana',op:'onepiece'}[card.world]||card.world;let inv;
  if(world==='mcp')inv=expected.collections.mcp;else inv=expected.collections[world].sets[card.setId]??={owned:{},packs:0};const n=inv.owned[d.inventoryId]||0;
  if(sign<0&&n<2)throw Error('Letzte Kopie ist geschützt');if(!Number.isSafeInteger(n+sign))throw Error('Mengengrenze');inv.owned[d.inventoryId]=n+sign;
  const after=applyGameRecords(before,command.changes);if(!same(expected,after))throw Error('Genau eine Karte, sonst keine Bestands-/Walletänderung');
  const binding={uid,kind:'game-save',source:account.cache.meta.dataDigest,proof:await proof(command),units:0};
  await account.commitGame(after,{operationId:command.id,expected:account.cache.meta,kind:'save',binding,cardGift:{kind:sign<0?'send':'accept',id:d.giftId,sender:d.sender,receiver:d.receiver,card,proof:binding.proof}});
  guard(account,uid,prefix);return{uid,operationId:command.id,committed:true};
 }
 async function resolve(command){guard(account,uid,prefix);return base.resolve(command);}
 async function status(id){guard(account,uid,prefix);const snap=await getDocFromServer(giftRef(account,idGuard(id)));guard(account,uid,prefix);if(!snap.exists())return null;const g=snap.data();if(g.sender!==uid&&g.receiver!==uid)throw Error('Fremdes Geschenk');if(g.sender===uid||g.state==='accepted'&&g.receiver===uid){const sent=g.sender===uid,r=await getDocFromServer(doc(account.db,...(account.production?['users',uid]:['integrationTests','v150','players',uid]),'operations',sent?g.sendOp:g.receiveOp));guard(account,uid,prefix);if(!r.exists()||r.data().revision!==(sent?g.sendRevision:g.receiveRevision)||r.data().binding?.proof!==(sent?g.sendProof:g.receiveProof))throw Error('Geschenkbeleg unklar');}return g;}
 async function prepareGift({kind,id,card,receiver}){
  const players=await loadPlayers();if(!players.some(p=>p.uid===receiver))throw Error('Empfänger nicht freigegeben');
  guard(account,uid,prefix);card=identity(card);const saved=await status(id);
  if(kind==='card-send'){
   if(receiver===uid)throw Error('Kein Selbstgeschenk');
   if(saved){if(saved.sender!==uid||saved.receiver!==receiver||!same(saved.card,card))throw Error('Geschenkkennung anders verwendet');return{alreadySent:true,reload:true};}
   const slot=await getDocFromServer(slotRef(account,uid));guard(account,uid,prefix);if(slot.exists()&&slot.data().open)throw Error('Geschenk oder offener Senderplatz bereits vorhanden');
   const world={lc:'lorcana',op:'onepiece'}[card.world]||card.world,n=world==='mcp'?readLocal().collections.mcp.owned[String(card.cardId)]:readLocal().collections[world].sets[card.setId]?.owned[String(card.cardId)];
   if(!(n>=2))throw Error('Letzte Kopie ist geschützt');
  }else if(kind==='card-accept'){
   if(!saved||saved.receiver!==uid||!same(saved.card,card))throw Error('Kein eigenes passendes Geschenk');
   if(saved.state==='accepted')return{alreadyAccepted:true,reload:true};
  }else throw Error('Unbekannte Geschenkaktion');
  return null;
 }
 async function loadPlayers(){guard(account,uid,prefix);const s=await getDocFromServer(doc(account.db,'cardGiftConfig','players'));guard(account,uid,prefix);return playerData(s.exists()?s.data():null,uid);}
 async function overview(){const players=await loadPlayers(),[incoming,slot]=await Promise.all([getDocsFromServer(query(collection(account.db,'cardGifts'),where('receiver','==',uid),where('state','==','offered'),limit(20))),getDocFromServer(slotRef(account,uid))]);guard(account,uid,prefix);const outgoing=slot.exists()?await status(slot.data().giftId):null;return{players,incoming:incoming.docs.map(s=>({id:s.id,...s.data()})),outgoing:outgoing?{id:slot.data().giftId,...outgoing}:null};}
 return{...base,read,commit,resolve,status,prepareGift,overview};
}
