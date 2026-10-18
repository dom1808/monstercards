import {doc,getDocFromServer} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import {EMPTY,clone,encode,canonical,digest,validate} from './app-snapshot.mjs';
const keyTarget=key=>{
 if(key==='mcp_save_v1')return ['mcp'];if(key==='mcp_tcg_save_v1')return ['pocket'];if(key==='mcp_live_save_v1')return ['live'];
 if(key==='mcp_lorcana_save_v1')return ['lorcana','lc1'];const lc=key.match(/^mcp_lorcana_(lc\d+)_save_v1$/);if(lc)return ['lorcana',lc[1]];
 if(key==='mcp_op01_test_save_v1')return ['onepiece','op01'];const op=key.match(/^mcp_((?:op|prb)\d+)_save_v1$/);if(op)return ['onepiece',op[1]];return null;
};
export function applyGameRecords(before,changes){
 const data=clone(before),seen=new Set();for(const {key,value} of changes){if(seen.has(key)||typeof value!=='string')throw Error('Ungültige Spielbuchung');seen.add(key);const parsed=JSON.parse(value),target=keyTarget(key);
  if(target){const [world,set]=target;if(world==='pocket'||world==='live')data.collections[world].sets=clone(parsed.sets);else {const inventory={owned:clone(parsed.owned),packs:parsed.packs};if(world==='mcp')data.collections.mcp=inventory;else data.collections[world].sets[set]=inventory;}}
  else if(key==='mcp_rewards_v60')data.wallet={...parsed,gifts:parsed.gifts||{}};
  else if(key==='mcp_promo_rewards_v1')data.promos=clone(parsed);
  else if(key==='mcp_decks_v1')data.aux.decks=clone(parsed);
  else if(key==='mcp_battle_v1')data.aux.battle=clone(parsed);
  else throw Error('Unbekannter Spielstandschlüssel: '+key);
 }return validate(data);
}
export function gameRecords(data){
 validate(data);const records={'mcp_save_v1':JSON.stringify({v:2,...data.collections.mcp}),'mcp_tcg_save_v1':JSON.stringify({sets:data.collections.pocket.sets,lang:'de'}),'mcp_live_save_v1':JSON.stringify({sets:data.collections.live.sets,lang:'de'}),'mcp_rewards_v60':JSON.stringify(data.wallet),'mcp_promo_rewards_v1':JSON.stringify(data.promos)};
 for(const [id,save]of Object.entries(data.collections.lorcana.sets)){if(!/^lc\d+$/.test(id))throw Error('Set hat noch keine bestätigte App-Speicherzuordnung: '+id);records[id==='lc1'?'mcp_lorcana_save_v1':'mcp_lorcana_'+id+'_save_v1']=JSON.stringify(save);}
 for(const [id,save]of Object.entries(data.collections.onepiece.sets)){if(!/^(op|prb)\d+$/.test(id))throw Error('Set hat noch keine bestätigte App-Speicherzuordnung: '+id);records[id==='op01'?'mcp_op01_test_save_v1':'mcp_'+id+'_save_v1']=JSON.stringify(save);}
 if(data.aux.decks!==null)records.mcp_decks_v1=JSON.stringify(data.aux.decks);if(data.aux.battle!==null)records.mcp_battle_v1=JSON.stringify(data.aux.battle);return records;
}
export function readGameRecords(records){return applyGameRecords(clone(EMPTY),Object.entries(records).map(([key,value])=>({key,value})));}
const contextTarget=key=>{if(key==='mcp')return ['mcp'];for(const [prefix,world]of [['mcp_tcg_save_v1:','pocket'],['mcp_live_save_v1:','live'],['lc:','lorcana'],['op:','onepiece']])if(key.startsWith(prefix))return [world,key.slice(prefix.length)];throw Error('Unbekannter Setkontext');};
const inventory=(data,[world,set])=>world==='mcp'?data.collections.mcp:data.collections[world].sets[set]||{owned:{},packs:0};
const total=owned=>Object.values(owned).reduce((a,b)=>a+b,0);
function validateGameChange(before,after,command,catalog){
 const expected=clone(before),d=command.details;
 if(command.kind==='open'){
  if(!Number.isSafeInteger(d.packs)||d.packs<1||!Number.isSafeInteger(d.cost)||d.cost<1)throw Error('Ungültiger Packkauf');
  const keys=command.changes.map(c=>keyTarget(c.key)).filter(Boolean);if(keys.length!==1)throw Error('Packkauf braucht genau einen Sammlungsbereich');
  const loc=keys[0];if((d.world==='lc'?'lorcana':d.world==='op'?'onepiece':d.world)!==loc[0])throw Error('Falsche Kartenwelt');
  let set=loc[1];if(loc[0]==='pocket'||loc[0]==='live'){const changed=Object.keys(after.collections[loc[0]].sets).filter(id=>canonical(after.collections[loc[0]].sets[id])!==canonical(before.collections[loc[0]].sets[id]||{owned:{},packs:0}));if(changed.length!==1)throw Error('Mehrere Sets bei Packkauf');set=changed[0];}
  const actual=inventory(after,[loc[0],set]),old=inventory(before,[loc[0],set]);if(actual.packs!==old.packs+d.packs||total(actual.owned)<=total(old.owned)||Object.entries(old.owned).some(([id,n])=>(actual.owned[id]||0)<n))throw Error('Karten und Packs widersprechen Kauf');
  if(loc[0]==='mcp')expected.collections.mcp=clone(actual);else expected.collections[loc[0]].sets[set]=clone(actual);
  expected.wallet.units-=d.cost*1000;if(['pocket','live'].includes(loc[0]))expected.promos[loc[0]].packs+=d.packs;
 }else if(['trade-tokens','trade-wish'].includes(command.kind)){
  const loc=contextTarget(d.set),old=inventory(before,loc),actual=inventory(after,loc),wanted=inventory(expected,loc);let qty=0,units=0,group=null;
  for(const item of d.items){const c=catalog(d.set,item.id);if(!c||c.promo||!c.eligible||c.value!==item.value||c.group!==item.group||!Number.isSafeInteger(item.quantity)||item.quantity<1)throw Error('Unzulässiges Tauschmaterial');
   const ids=[...new Set(c.ids)],prior=ids.reduce((n,id)=>n+(old.owned[id]||0),0),next=ids.reduce((n,id)=>n+(actual.owned[id]||0),0);if(next!==prior-item.quantity||next<1)throw Error('Letzte Kopie ist geschützt');
   for(const id of ids){if(Object.hasOwn(actual.owned,id))wanted.owned[id]=actual.owned[id];else delete wanted.owned[id];}qty+=item.quantity;units+=item.quantity*c.value;if(group!==null&&group!==c.group&&command.kind==='trade-wish')throw Error('Unpassende Wunschtauschgruppe');group=c.group;
  }
  if(command.kind==='trade-wish'){const target=catalog(d.set,d.target);if(!target||target.promo||!target.eligible||target.group!==group||qty!==4||target.ids.some(id=>old.owned[id]>0)||target.ids.reduce((n,id)=>n+(actual.owned[id]||0),0)!==1)throw Error('Ungültige Wunschkarte');for(const id of target.ids)if(Object.hasOwn(actual.owned,id))wanted.owned[id]=actual.owned[id];}
  else {if(d.units!==units)throw Error('Tauschwert widerspricht Katalog');expected.wallet.units+=units;}
 }else if(command.kind==='aux'){expected.aux=clone(after.aux);
 }else if(command.kind==='promo'){
  const old=before.promos[d.world],actual=after.promos[d.world];if(!old||old.packs!==actual.packs)throw Error('Ungültiger Promovorgang');
  if(old.pending===null&&actual.pending&&old.claimed===actual.claimed&&canonical(old.owned)===canonical(actual.owned))expected.promos[d.world].pending=clone(actual.pending);
  else {if(!old.pending||old.claimed+1!==actual.claimed||actual.pending!==null||old.claimed>=Math.floor(old.packs/20))throw Error('Keine offene Promoauswahl');const changed=Object.keys(actual.owned).filter(id=>(actual.owned[id]||0)!==(old.owned[id]||0));if(changed.length!==1||!old.pending.ids.includes(changed[0])||actual.owned[changed[0]]!==(old.owned[changed[0]]||0)+1)throw Error('Falsche Promokarte');expected.promos[d.world]=clone(actual);}
 }else throw Error('Spielaktion noch nicht angeschlossen');
 if(canonical(expected)!==canonical(after))throw Error('Unerwartete zusätzliche Spielstandänderung');
 return after;
}
export function createGameDriver({account,scope,readLocal,catalog=()=>null}){
 const uid=account.auth.currentUser?.uid;if(!uid||scope!=='mcp_account_v150:'+uid+':'||account.live)throw Error('Nur isolierter, UID-getrennter Spieltest erlaubt');let base;
 const op=id=>account.production?doc(account.db,'users',uid,'operations',id):doc(account.db,'integrationTests','v150','players',uid,'operations',id);
 const proof=command=>digest(canonical({uid:command.uid,id:command.id,kind:command.kind,baseRevision:command.baseRevision,details:command.details,changes:command.changes}));
 function guard(){if(account.auth.currentUser?.uid!==uid)throw Error('Konto gewechselt');}
 async function read(){guard();base=await account.load();if(!base.data||base.meta.deletionRequested||account.status!=='Gespeichert')throw Error('Nur Ansicht');if((await encode(readLocal())).digest!==base.meta.dataDigest)throw Error('Lokale Kontokopie weicht ab: neu laden');return {uid,revision:base.meta.revision,writer:true};}
 async function commit(command){guard();if(command.uid!==uid||!base||command.baseRevision!==base.meta.revision)throw Error('Vorgang gehört zu anderem Stand');
  const data=validateGameChange(base.data,applyGameRecords(base.data,command.changes),command,catalog),redeem=command.kind==='promo'&&base.data.promos[command.details.world].pending!==null,kind=command.kind==='trade-tokens'?'trade':redeem?'promo':'save',units=kind==='trade'?command.details.units:0,claimId=redeem?command.details.world+'-'+data.promos[command.details.world].claimed:'';
  if(redeem&&command.id!=='promo-'+claimId)throw Error('Falsche einmalige Promo-Belegkennung');
  const binding={uid,kind:'game-'+kind,source:base.meta.dataDigest,proof:await proof(command),units};await account.commitGame(data,{operationId:command.id,expected:base.meta,kind,binding,claimId});guard();return {uid,operationId:command.id,committed:true};
 }
 async function resolve(command){guard();if(command.uid!==uid)throw Error('Fremder Vorgang');const receipt=await getDocFromServer(op(command.id));guard();
  if(receipt.exists()){const r=receipt.data();if(r.revision!==command.baseRevision+1||r.binding?.uid!==uid||r.binding?.proof!==await proof(command))throw Error('Vorgangsbeleg passt nicht');return {uid,operationId:command.id,committed:true};}
  const latest=await account.load();if(latest.meta.revision>command.baseRevision)return {uid,operationId:command.id,committed:false};throw Error('Vorgang noch nicht eindeutig abgeschlossen; gleiche Kennung beibehalten');
 }
 return Object.freeze({uid,build:'normal',read,commit,resolve});
}
