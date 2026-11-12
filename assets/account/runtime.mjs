import {createPersonalService} from './personal-sync.mjs';
import {createPersonalController} from './personal-lists.mjs';
import {createIntegration} from './client.mjs';
import {createGameDriver,gameRecords,readGameRecords} from './game-driver.mjs';
import {clone,encode,canonical,summary} from './app-snapshot.mjs';
import {sendEmailVerification,reload} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {createRoundService,roundAvailable} from './rounds.mjs';
export function createRuntime({storage,config}){
 if(document.documentElement.dataset.mcpBuild==='developer')throw Error('Dev-Spielstände sind von Konten ausgeschlossen');
 const io=storage.localStorage,selectedKey='mcp_account_selected_v150';let usable=false;try{io?.setItem('mcp_account_probe_v150','1');usable=io?.getItem('mcp_account_probe_v150')==='1';io?.removeItem('mcp_account_probe_v150');}catch{}
 const account=createIntegration({target:config.target||'spark',config:config.firebase,confirmation:config.target==='spark-empty-test'?'LEERE TESTSPIELSTÄNDE':undefined,persistent:usable,deviceStore:io,build:'normal'});
 let view={signedIn:false,selected:false,verified:false,started:false,canWrite:false,name:'Spieler',welcome:false,deletion:false,storageReady:usable,notice:''},prepared=null,catalog=null,driver=null,roundService=null,roundGate=null,roundUid=null;
 const emit=()=>window.dispatchEvent(new Event('mcp-account-change'));
 let personalController=null,personalUid=null;
 function personalConnect(){
  const uid=account.auth.currentUser?.uid;
  if(config.personalSync!==true||!uid||storage.accountUid!==uid||!account.auth.currentUser.emailVerified||view.deletion||account.live||storage.prefix.includes('mcp_dev_v1:')||storage.prefix.includes('mcp_v150_stage:')&&account.production)return null;
  if(!navigator.locks)throw Error('Kontolisten benötigen sichere lokale Schreibsperren; vorhandene Listen bleiben lokal erhalten');
  if(personalController&&personalUid===uid)return personalController;
  personalController?.dispose();personalUid=uid;
  const scope=()=>{if(account.auth.currentUser?.uid!==uid||storage.accountUid!==uid||account.cache?.meta?.deletionRequested)throw Error('Konto gewechselt oder gesperrt');return uid;};
  const service=createPersonalService(account,{selected:scope,prefix:storage.prefix,enabled:true});
  personalController=createPersonalController({uid,io,scope,lock:fn=>storage.requestLock('mcp_personal_sync_v1',fn),service,notify:()=>window.dispatchEvent(new Event('mcp-personal-sync-change'))});
  return personalController;
 }

 async function setupRounds(close=false){
  const uid=account.auth.currentUser?.uid;
  if(config.rounds!==true||account.live||!uid||storage.accountUid!==uid||!view.verified||!view.started||view.deletion){account.roundsEnabled=false;roundService=null;view.rounds=false;view.roundsNotice='Die Sammlerrunde ist nur im bestätigten Kontospiel verfügbar.';return;}
  if(roundUid!==uid){roundUid=uid;roundGate=null;roundService=null;account.roundsEnabled=false;}
  if(!roundGate)roundGate=roundAvailable(account).then(enabled=>{if(account.auth.currentUser?.uid!==uid||storage.accountUid!==uid)throw Error('Konto gewechselt');account.roundsEnabled=enabled;view.rounds=enabled;view.roundsNotice=enabled?'':'Sammlerrunde noch nicht freigeschaltet. Packs funktionieren weiterhin; die Monatszählung beginnt mit der Freischaltung.';roundService=enabled?createRoundService(account,{enabled:true}):null;return enabled;}).catch(e=>{roundGate=null;account.roundsEnabled=false;view.rounds=false;view.roundsNotice='Sammlerrunde nicht erreichbar · erneut verbinden';throw e;});
  await roundGate;
  if(close&&roundService){try{await roundService.onAppStart();}catch(e){view.roundsNotice='Monatsabschluss nicht abgeschlossen · beim nächsten Start erneut versuchen';}}
 }
 async function rounds(){await setupRounds();if(!roundService)throw Error(view.roundsNotice||'Sammlerrunde nicht verfügbar');return roundService;}
 const roundStatus=async()=>{const r=await rounds();return r.status();},roundList=async p=>{const r=await rounds();return r.list(p);},roundJoin=async options=>{const r=await rounds();return r.join(options);},roundShare=async()=>{const r=await rounds();return r.share();},roundLeave=async()=>{const r=await rounds();return r.leave();};
 const roundCached=()=>roundService?.cached()||null,roundScope=()=>{if(!roundService||account.auth.currentUser?.uid!==storage.accountUid)throw Error('Konto gewechselt');return roundService.scope();};
 const requireStorage=()=>{if(!usable)throw Error('Dauerhaftes Speichern ist gesperrt. Gastspielen bleibt möglich.');};
 function select(uid){io.setItem(selectedKey,uid);if(io.getItem(selectedKey)!==uid)throw Error('Kontowahl nicht dauerhaft gespeichert');}
 function getState(){const user=account.auth.currentUser;return {...view,pendingImport:!!user&&!!io?.getItem('mcp_account_import_pending_v150:'+user.uid),hasProgress:account.cache?.meta.hasProgress,imported:account.cache?.meta.imported,signedIn:!!user,verified:user?.emailVerified===true,selected:!!storage.accountUid&&(!user||user.uid===storage.accountUid),canWrite:!!user&&user.uid===storage.accountUid&&account.status==='Gespeichert'&&account.online&&!view.deletion,name:account.cache?.meta.name||view.name};}
 async function refresh(){const user=account.auth.currentUser;view.signedIn=!!user;view.verified=user?.emailVerified===true;if(user?.emailVerified){await account.profile();await account.load();view.name=account.cache.meta.name;view.started=account.cache.meta.stage==='active';view.deletion=account.cache.meta.deletionRequested===true;view.deletionState=view.deletion?(await account.deletionRequestStatus()).state:null;view.welcome=view.started?await account.welcomeClaimed():false;}emit();return getState();}
 function wallet(){if(storage.accountUid&&account.cache?.data){storage.writeConfirmedWallet(account.cache.data.wallet);window.MCP?.v150?.refreshWallet?.();}}
 function localData(){return readGameRecords(storage.readProgressRecords());}
 async function installGame(resolver){catalog=resolver;if(!storage.accountUid||!account.auth.currentUser||view.deletion||account.live)return null;driver=createGameDriver({account,scope:'mcp_account_v150:'+storage.accountUid+':',readLocal:localData,catalog});window.MCPGameRemote=driver;return driver;}
 async function boot(){
  await account.auth.authStateReady();const selected=io?.getItem(selectedKey);if(!account.auth.currentUser){if(selected)storage.activateCachedAccount(selected);view.notice=selected?'Bitte erneut anmelden. Dein Gaststand bleibt getrennt.':'';emit();return;}
  if(selected&&selected!==account.auth.currentUser.uid)io.removeItem(selectedKey);
  account.restoreDeviceLease();await refresh();
  if(selected&&account.auth.currentUser.uid===selected){if(view.deletion){storage.activateCachedAccount(selected);view.notice='Löschung angefragt · Bearbeitung innerhalb von sieben Tagen';}else if(view.started){if(account.status==='Gespeichert'&&!account.live)await account.claimDaily();storage.activateAccount(selected,gameRecords(account.cache.data));}else{io.removeItem(selectedKey);}}
  try{await setupRounds(true);}catch(e){view.roundsNotice='Sammlerrunde nicht erreichbar · erneut verbinden';}
  account.onChange=()=>{view.notice=account.status;emit();};emit();
 }
 async function signIn(email,password){requireStorage();io.setItem('mcp_account_used_v150','1');await account.login(email,password);
  // Ein bereits geladener Kern hält Mengen im RAM: niemals nur dessen Präfix wechseln.
  // Erst nach erfolgreicher Anmeldung neu starten; fremde Caches/Belege bleiben erhalten.
  if(storage.accountUid){if(storage.accountUid!==account.auth.currentUser.uid)io.removeItem(selectedKey);prepared=null;driver=null;window.MCPGameRemote=null;location.reload();return new Promise(()=>{});}
  account.restoreDeviceLease();view.notice=account.auth.currentUser.emailVerified?'Angemeldet. Wähle deinen Spielstand.':'Bitte zuerst deine E-Mail bestätigen.';await refresh();return getState();}
 async function sendVerification(){const user=account.auth.currentUser;if(!user)throw Error('Zuerst anmelden');if(!user.emailVerified)await sendEmailVerification(user);view.notice='Bestätigungs-Mail angefordert. Öffne den Link in deinem Postfach und prüfe danach erneut.';emit();}
 async function checkVerification(){const user=account.auth.currentUser;if(!user)throw Error('Zuerst anmelden');await reload(user);await user.getIdToken(true);await refresh();if(!user.emailVerified)throw Error('E-Mail noch nicht bestätigt');view.notice='E-Mail bestätigt.';emit();}
 async function resetPassword(email){await account.reset(email);view.notice='Falls diese Adresse zu einem Konto gehört, wurde eine Reset-Mail angefordert.';emit();}
 async function startEmpty(){requireStorage();await refresh();await account.startEmpty();select(account.auth.currentUser.uid);location.reload();}
 async function openAccount(){requireStorage();await refresh();if(!view.started||view.deletion)throw Error('Kein freigegebener Kontospielstand');select(account.auth.currentUser.uid);location.reload();}
 async function takeOver(){await account.takeOver();if(storage.accountUid)location.reload();else await refresh();}
 async function logout(){roundService=null;roundGate=null;roundUid=null;account.roundsEnabled=false;await account.logout();io?.removeItem(selectedKey);view={...view,signedIn:false,selected:false,rounds:false,notice:'Abgemeldet.'};location.reload();}
 async function claimWelcome(){if(window.MCPGameBoundary?.state().pending)throw Error('Zuerst ausstehende Speicherung klären');await account.claimWelcome();await refresh();wallet();}
 async function claimGift(){if(window.MCPGameBoundary?.state().pending)throw Error('Zuerst ausstehende Speicherung klären');await account.claimGift();await refresh();wallet();window.MCP?.v150?.refreshGift?.();}
 async function rename(name){await account.rename(name);await refresh();}
 async function inspectImport(){requireStorage();await refresh();const retry=getState().pendingImport;if(storage.accountUid||view.deletion||!retry&&(account.cache.meta.hasProgress||account.cache.meta.imported))throw Error('Eine Übernahme ist nur ohne eigenen Kontofortschritt oder Belohnungen möglich');
  const uid=account.auth.currentUser.uid,pending=io.getItem('mcp_account_import_pending_v150:'+uid);
  if(pending){prepared=JSON.parse(pending);if(prepared.uid!==uid||(await encode(prepared.data)).digest!==prepared.digest)throw Error('Gesicherter Übernahmevorgang beschädigt');}
  else{const records=storage.readProgressRecords(),data=readGameRecords(records),encoded=await encode(data);prepared={format:'mcp-original-guest-v150',uid,records,data,digest:encoded.digest,operation:{id:'import-'+crypto.randomUUID(),binding:{uid,kind:'import',source:encoded.digest}}};}
  const backupKey='mcp_account_backup_v150:'+uid+':'+prepared.digest,raw=JSON.stringify(prepared);io.setItem(backupKey,raw);if(io.getItem(backupKey)!==raw)throw Error('Originalsicherung nicht bestätigt');
  return {summary:summary(prepared.data),backup:clone(prepared),digest:prepared.digest};
 }
 async function importSelected(confirmation){requireStorage();if(confirmation!==true||!prepared)throw Error('Sicherung und Übernahme ausdrücklich bestätigen');const uid=account.auth.currentUser?.uid;if(uid!==prepared.uid)throw Error('Konto gewechselt');const raw=JSON.stringify(prepared),key='mcp_account_import_pending_v150:'+uid;io.setItem(key,raw);if(io.getItem(key)!==raw)throw Error('Übernahmevorgang nicht dauerhaft gesichert');
  if(io.getItem('mcp_account_backup_v150:'+uid+':'+prepared.digest)!==raw)throw Error('Originalsicherung nicht mehr bestätigt');
  const current=await account.load();if(current.meta.stage==='active'&&!current.meta.imported&&!current.meta.hasProgress)await account.takeOver();
  await account.importPrepared(prepared.data,async backup=>{const original=io.getItem('mcp_account_backup_v150:'+uid+':'+prepared.digest);if(original!==raw||backup.digest!==prepared.digest)throw Error('Originalsicherung nicht mehr bestätigt');return backup.digest;},{operation:prepared.operation});io.removeItem(key);select(uid);location.reload();
 }
 async function submitDeletion(password,confirmed){if(!confirmed)throw Error('Bitte die Folgen bestätigen');await account.submitDeletionRequest(password,'KONTOLÖSCHUNG BEANTRAGEN');await refresh();view.notice='Löschung angefragt · Bearbeitung innerhalb von sieben Tagen. Abschluss über euren bestehenden privaten Kontakt.';emit();}
 async function deletionStatus(){return account.deletionRequestStatus();}
 async function resolvePending(){await account.takeOver();if(!driver)await installGame(catalog);await window.MCPGameBoundary.resolve(driver);location.reload();}
 async function prepareAction(){if(!driver||!storage.accountUid)throw Error('Kontospielstand noch nicht geladen');const loaded=await account.load();if(account.status!=='Gespeichert'||loaded.meta.deletionRequested)throw Error('Nur Ansicht: Gerät zuerst übernehmen');await setupRounds();if(!account.live){await account.claimDaily();wallet();}}
 window.addEventListener('offline',()=>{account.offline(true).then(()=>{view.notice='Offline · Sammlung nur ansehen';emit();});});window.addEventListener('online',()=>{roundGate=null;account.offline(false).then(async()=>{try{await setupRounds();}catch{}view.notice='Verbindung wieder da · aktuellen Stand laden';emit();});});
 return Object.freeze({state:getState,boot,signIn,sendVerification,checkVerification,resetPassword,startEmpty,openAccount,takeOver,logout,defer:logout,claimWelcome,claimGift,rename,inspectImport,importSelected,submitDeletion,deletionStatus,resolvePending,prepareAction,installGame,personalConnect,roundStatus,roundList,roundJoin,roundShare,roundLeave,roundCached,roundScope});
}
