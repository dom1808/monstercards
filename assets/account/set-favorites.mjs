// Set references only. This format never contains cards, balances or import data.
export const SET_FAVORITES_KEY='mcp_set_favorites_v1';
export function setFavoriteKey(world,setId){
 if(!['mcp','pocket','live','lc','op'].includes(world)||typeof setId!=='string'||!/^[A-Za-z0-9_.-]{1,120}$/.test(setId))throw Error('Ungültige Setreferenz');
 return world+':'+setId;
}
export function validateSetFavorites(data){
 if(!data||data.schema!==1||Object.keys(data).sort().join(',')!=='entries,schema'||!data.entries||Array.isArray(data.entries)||typeof data.entries!=='object'||Object.keys(data.entries).length>2000)throw Error('Unbekannte Setfavoriten · Original bleibt erhalten');
 for(const [key,e]of Object.entries(data.entries))if(!e||Object.keys(e).sort().join(',')!=='lastOp,name,selected,setId,world'||key!==setFavoriteKey(e.world,e.setId)||typeof e.selected!=='boolean'||typeof e.name!=='string'||!e.name.trim()||e.name.length>200||typeof e.lastOp!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(e.lastOp))throw Error('Ungültiger Setfavorit · Original bleibt erhalten');
 return structuredClone(data);
}
export function applySetFavorite(data,op){
 const next=validateSetFavorites(data),key=setFavoriteKey(op.world,op.setId);
 if(Object.keys(op).sort().join(',')!=='before,id,name,selected,setId,world'||typeof op.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(op.id)||typeof op.selected!=='boolean'||typeof op.name!=='string'||!op.name.trim()||op.name.length>200||!(op.before===null||typeof op.before==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(op.before)))throw Error('Ungültiger Favoritenvorgang');
 if((next.entries[key]?.lastOp||null)!==op.before)throw Error('Dieses Set wurde inzwischen auf einem anderen Gerät geändert · Vormerkung erhalten');
 next.entries[key]={world:op.world,setId:op.setId,name:op.name,selected:op.selected,lastOp:op.id};return validateSetFavorites(next);
}
export function createSetFavoritesController({uid=null,io,scope=()=>{},lock=fn=>fn(),service=null,canEdit=()=>true,notify=()=>{}}){
 let disposed=false,error='',ready=!service,running=null;
 const check=()=>{if(disposed)throw Error('Setfavoriten: Konto gewechselt');scope();};
 const read=()=>{check();const raw=io.getItem(SET_FAVORITES_KEY),envelope=raw?JSON.parse(raw):{schema:1,uid,revision:0,data:{schema:1,entries:{}},pending:[]},queue=envelope.pending,base={schema:envelope.schema,uid:envelope.uid,revision:envelope.revision,data:envelope.data};
  if(Object.keys(envelope).sort().join(',')!=='data,pending,revision,schema,uid'||base.schema!==1||base.uid!==uid||!Number.isSafeInteger(base.revision)||base.revision<0||!Array.isArray(queue)||queue.length>2000)throw Error('Unbekannter Setfavoriten-Speicher · nichts überschrieben');validateSetFavorites(base.data);
  let projected=base.data;for(const op of queue)projected=applySetFavorite(projected,op);return{base,queue,projected};};
 const write=(key,value)=>{check();const raw=JSON.stringify(value);io.setItem(key,raw);if(io.getItem(key)!==raw)throw Error('Setfavoriten konnten nicht gesichert werden');};
 // One envelope per confirmed operation: a lost response leaves the same durable op ID queued.
 const save=(base,queue)=>write(SET_FAVORITES_KEY,{...base,pending:queue});
 function state(){try{const s=read();return{data:s.projected,pending:s.queue.length,error,ready,canEdit:ready&&!error&&canEdit(),synced:!!service};}catch(e){return{data:{schema:1,entries:{}},pending:0,error:e.message,ready:false,canEdit:false,synced:!!service};}}
 async function refresh(){if(running)return running;running=Promise.resolve().then(()=>lock(async()=>{try{check();let s=read();if(service){const remote=await service.read();check();const hadPending=s.queue.length>0;if(remote.revision<s.base.revision)throw Error('Älterer Kontofavoritenstand · Original erhalten');
    // The durable pending ID is acknowledged before removal; retries use its original receipt.
    while(s.queue.length){const op=s.queue[0],result=await service.apply(op);check();s={base:{schema:1,uid,revision:result.revision,data:result.data},queue:s.queue.slice(1)};save(s.base,s.queue);}
    const latest=hadPending?await service.read():remote;check();if(latest.revision<s.base.revision)throw Error('Älterer Kontofavoritenstand');save({schema:1,uid,revision:latest.revision,data:latest.data},[]);
   }ready=true;error='';}catch(e){error=e.code==='permission-denied'?'Kontofavoriten nicht freigegeben oder Gerätefreigabe geändert · Vormerkung erhalten':e.message;}finally{notify();}})).finally(()=>{running=null;});return running;}
 async function set(world,setId,name,selected){await lock(async()=>{check();if(!state().canEdit)throw Error(state().error||'Dieses Gerät zuerst übernehmen und Favoriten laden');const s=read(),key=setFavoriteKey(world,setId),op={id:'sf-'+crypto.randomUUID(),world,setId,name,selected,before:s.projected.entries[key]?.lastOp||null};const data=applySetFavorite(s.projected,op);
   if(service)save(s.base,[...s.queue,op]);else save({schema:1,uid,revision:s.base.revision+1,data},[]);});notify();if(service)void refresh();}
 return{state,set,start:refresh,refresh,dispose(){disposed=true;}};
}
