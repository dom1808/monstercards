import {doc,getDocFromServer,runTransaction,serverTimestamp} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import {validateSetFavorites,applySetFavorite} from './set-favorites.mjs';
import {operationDigest} from './personal-lists.mjs';
export function createSetFavoritesService(account,{selected=()=>null,prefix='',enabled=false}={}){
 const a=account,uid=a.auth.currentUser?.uid,root=a.production?['users',uid]:['integrationTests','v150','players',uid];
 const ref=()=>doc(a.db,...root,'preferences','setFavoritesV1'),receipt=id=>doc(a.db,...root,'setFavoriteOps',id),proof=()=>doc(a.db,...root,'private','setFavoritesWriter');
 function guard(write=false){if(!enabled||!uid||selected()!==uid||a.auth.currentUser?.uid!==uid||!a.auth.currentUser.emailVerified||a.live||a.cache?.meta?.deletionRequested||prefix.includes('mcp_dev_v1:')||prefix.includes('mcp_v150_stage:')&&a.production||globalThis.document?.documentElement?.dataset?.mcpBuild==='developer')throw Error('Setfavoriten für diesen Speicher gesperrt');if(!a.online)throw Error('Offline · Setfavoriten bleiben vorgemerkt');if(write&&a.status!=='Gespeichert')throw Error('Nur Ansicht · dieses Gerät zuerst übernehmen');}
 function decode(s){if(!s.exists())return{revision:0,data:{schema:1,entries:{}}};const d=s.data();if(d.schema!==1||!Number.isSafeInteger(d.revision)||d.revision<1)throw Error('Unbekannter Kontofavoritenstand');return{revision:d.revision,data:validateSetFavorites({schema:1,entries:d.entries})};}
 async function read(){guard();const s=await getDocFromServer(ref());guard();return decode(s);}
 async function attempt(op,observed){guard(true);const digest=await operationDigest(op),device=JSON.parse(a.deviceStore?.getItem('mcp_account_lease_v150:'+uid)||'null');if(device?.uid!==uid||!Number.isSafeInteger(device.epoch)||!/^[a-f0-9]{64}$/.test(device.secret||''))throw Error('Gerätefreigabe fehlt · nichts überschrieben');
  return runTransaction(a.db,async tx=>{guard(true);const [done,s,m]=await Promise.all([tx.get(receipt(op.id)),tx.get(ref()),tx.get(doc(a.db,...root))]);guard(true);const old=decode(s);observed.revision=old.revision;
   if(done.exists()){const r=done.data();if(r.schema!==1||r.digest!==digest||r.revision>old.revision)throw Error('Favoritenbeleg widerspricht ursprünglichem Vorgang');return{...old,alreadyApplied:true};}
   if(!m.exists()||m.data().stage!=='active'||m.data().deletionRequested||m.data().epoch!==device.epoch)throw Error('Gerätefreigabe geändert · Vormerkung bleibt erhalten');
   const data=applySetFavorite(old.data,op),revision=old.revision+1;if(!Number.isSafeInteger(revision))throw Error('Favoritenrevision ausgeschöpft');
   tx.set(ref(),{schema:1,revision,entries:data.entries,lastOp:op.id,updatedAt:serverTimestamp()});tx.set(receipt(op.id),{schema:1,revision,digest,key:op.world+':'+op.setId,entry:data.entries[op.world+':'+op.setId],before:op.before});tx.set(proof(),{revision,epoch:device.epoch,secret:device.secret});return{revision,data};
  });
 }
 async function apply(op){for(let retry=0;retry<3;retry++){const observed={revision:-1};try{return await attempt(op,observed);}catch(e){if(e.code!=='permission-denied'||observed.revision<0||retry===2)throw e;const latest=await read();if(latest.revision<=observed.revision)throw e;}}throw Error('Setfavoriten gleichzeitig geändert · Vormerkung erhalten');}
 return{read,apply};
}
