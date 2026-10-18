import {initializeApp,deleteApp} from 'firebase/app';
import {initializeAuth,inMemoryPersistence,indexedDBLocalPersistence,browserLocalPersistence,connectAuthEmulator,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,sendEmailVerification,sendPasswordResetEmail,reload,updateProfile,EmailAuthProvider,reauthenticateWithCredential} from 'firebase/auth';
import {initializeFirestore,memoryLocalCache,connectFirestoreEmulator,doc,getDocFromServer,runTransaction,disableNetwork,enableNetwork,onSnapshot,serverTimestamp} from 'firebase/firestore';
import {EMPTY,PARTS,clone,encode,decode,summary,prepareImport} from './app-snapshot.mjs';
import {operationId as checkId,checkOperation,sameBinding,selectionDigest} from './operations.mjs';

export const PROJECT='demo-mcp-konto';
const unique=()=>crypto.randomUUID().replaceAll('-','');
const secret=()=>unique()+unique();
const emailGuard=email=>{if(typeof email!=='string'||!email.endsWith('.invalid')) throw Error('Nur .invalid-Testadressen erlaubt');};
const nameGuard=name=>{if(typeof name!=='string'||/[\u0000-\u001f\u007f]/.test(name))throw Error('Spielername muss 3–24 Zeichen haben');name=name.trim();if(Array.from(name).length<3||Array.from(name).length>24)throw Error('Spielername muss 3–24 Zeichen haben');return name;};
export const TEST_ROOT='integrationTests/v150';
export const LIVE_UIDS=["V82me2X6djakYOkHbY8OV6eWrct2"];
export function createIntegration({target='emulator',build='normal',prefix='mcp_integration_v150:',persistent=false,config,confirmation,deviceStore}={}) {
 if(build!=='normal'||prefix!=='mcp_integration_v150:'||globalThis.document?.documentElement?.dataset?.mcpBuild==='developer')throw Error('Dev- und echte Gastspeicher ausgeschlossen');
 if(!['emulator','spark-empty-test','spark'].includes(target))throw Error('Unzulässiges Ziel');
 const live=target==='spark-empty-test',real=target!=='emulator',production=target==='spark';
 if(real&&(config?.projectId!=='monster-cards-pocket'||live&&confirmation!=='LEERE TESTSPIELSTÄNDE'))throw Error('Gezielte Spark-Anbindung nicht bestätigt');
 const app=initializeApp(real?config:{projectId:PROJECT,apiKey:'emulator-only-fake-key',authDomain:'127.0.0.1'},persistent?(production?'mcp-account-v150':live?'mcp-v150-empty-test':'mcp-v150-emulator'):'mcp-v150-'+unique());
 const auth=initializeAuth(app,{persistence:persistent?[indexedDBLocalPersistence,browserLocalPersistence]:inMemoryPersistence});
 const db=initializeFirestore(app,{localCache:memoryLocalCache()});
 if(!real){connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectFirestoreEmulator(db,'127.0.0.1',8080);}
 const account=new AccountLabor(app,auth,db);account.live=live;account.production=production;account.deviceStore=deviceStore;return account;
}

class AccountLabor {
  #lease=null;
  #stop=null;
  constructor(app,auth,db) { this.app=app;this.auth=auth;this.db=db;this.mode='guest';this.status='Gastspiel';this.cache=null;this.online=true; }
  #user() { const u=this.auth.currentUser;if(this.live&&u&&!LIVE_UIDS.includes(u.uid))throw Error('Konto nicht für leeren Test freigegeben');if(!u?.emailVerified) throw Error('Bestätigte Anmeldung erforderlich');return u; }
  #ref(uid,...parts) {return this.production?doc(this.db,'users',uid,...parts):doc(this.db,'integrationTests','v150','players',uid,...parts);}
  #assert(uid) { if(this.#user().uid!==uid) throw Error('Konto während Vorgang gewechselt'); if(!this.online) throw Error('Offline: nur Ansicht'); }
  async register(email,password,name) {
    if(this.live||this.production)throw Error('Spielerkonten werden administrativ angelegt');emailGuard(email); name=nameGuard(name); this.#clear();
    if(this.auth.currentUser)await signOut(this.auth);
    const {user}=await createUserWithEmailAndPassword(this.auth,email,password);
    await updateProfile(user,{displayName:name}); await sendEmailVerification(user);return user;
  }
  async login(email,password) { if(!this.live&&!this.production)emailGuard(email);this.#clear();if(this.auth.currentUser)await signOut(this.auth);return (await signInWithEmailAndPassword(this.auth,email,password)).user; }
  async reset(email) {if(this.live)throw Error('Kein Mailversand aus Integrationstest');if(!this.production)emailGuard(email);await sendPasswordResetEmail(this.auth,email);}
  #clear() {this.#stop?.();this.#stop=null;this.#lease=null;this.cache=null;this.pendingOperation=null;this.pendingDeletion=null;this.mode='guest';this.status='Gastspiel';}
  async logout() {const uid=this.auth.currentUser?.uid;if(uid)this.deviceStore?.removeItem('mcp_account_lease_v150:'+uid);this.#clear();await signOut(this.auth);}
  async defer() {await this.logout();}
  async profile() {
    const u=this.#user(), ref=this.#ref(u.uid);
    return runTransaction(this.db,async tx=>{
      this.#assert(u.uid);const existing=await tx.get(ref);
      if(existing.exists()) return existing.data();
      const m={uid:u.uid,name:nameGuard(u.displayName||'Spieler'),environment:this.production?'account-v150':'integration-test',stage:'unstarted',dailyDay:'',giftClaimed:false,revision:0,dataRevision:0,epoch:0,hasProgress:false,imported:false,importDigest:'',dataDigest:'',walletUnits:0,promoPacks:{pocket:0,live:0},promoClaimed:{pocket:0,live:0},lastOp:'create',action:'create',claimId:''};
      tx.set(ref,m);return m;
    });
  }
  async load() {
    const uid=this.#user().uid;this.#assert(uid);
    // Ein verifizierter Server-Lesesatz statt unabhängiger Watch-/Cache-Abfragen.
    // Validierung erst nach erfolgreicher Transaktion: bei paralleler Änderung
    // darf Firestore den gesamten Lesesatz wiederholen, bevor Zustand sichtbar wird.
    const snapshot=await runTransaction(this.db,async tx=>{
      this.#assert(uid);
      const profile=await tx.get(this.#ref(uid));
      if(!profile.exists())throw Error('Profil fehlt');
      const meta=profile.data();let parts=null;
      if(meta.stage==='active'&&!meta.deletionRequested){
        const chunks=await Promise.all(Array.from({length:PARTS},(_,i)=>tx.get(this.#ref(uid,'snapshots',String(i)))));
        parts=chunks.map(chunk=>chunk.exists()?chunk.data():null);
      }
      return {meta,parts};
    },{maxAttempts:3});
    this.#assert(uid);
    const m=snapshot.meta;let data=null;
    if(m.stage==='active'&&!m.deletionRequested){
      if(!snapshot.parts||snapshot.parts.some(part=>!part||part.generation!==m.dataRevision))throw Error('Ladekonflikt: Datenstand '+m.dataRevision+' / Teile '+(snapshot.parts||[]).map(part=>part?part.generation:'fehlt').join(','));
      data=await decode(snapshot.parts.map(part=>part.fragment),m.dataDigest);
      const s=summary(data);
      if(s.day!==(m.dailyDay||'')||(s.gifts['thanks-2026-10']===true)!==(m.giftClaimed===true))throw Error('Belohnungsmarker widersprechen Spielstand');
      if(s.units!==m.walletUnits||['pocket','live'].some(w=>data.promos[w].packs!==m.promoPacks[w]||data.promos[w].claimed!==m.promoClaimed[w]))throw Error('Metadaten widersprechen Spielstand');
    }
    this.#assert(uid);this.cache={uid,meta:m,data};this.mode='account';
    this.status=this.#lease?.uid===uid&&this.#lease.epoch===m.epoch?'Gespeichert':'Nur Ansicht';
    if(m.deletionRequested){this.#lease=null;this.status='Löschung angefragt · Bearbeitung innerhalb von sieben Tagen';}
    this.#stop?.();
    this.#stop=onSnapshot(this.#ref(uid),snap=>{
      if(!this.online||this.auth.currentUser?.uid!==uid||!snap.exists()||snap.metadata.hasPendingWrites)return;
      const observed=snap.data();
      if(observed.revision<this.cache?.meta.revision)return;
      if(observed.deletionRequested){this.#lease=null;this.cache={uid,meta:observed,data:null};this.status='Löschung angefragt · Bearbeitung innerhalb von sieben Tagen';}
      else if(this.#lease?.uid!==uid||this.#lease.epoch!==observed.epoch)this.status='Nur Ansicht';
      else if(observed.revision!==this.cache?.meta.revision)this.status='Stand geändert · neu laden';
      else this.status='Gespeichert';
      this.onChange?.();
    },()=>{this.status='Zugriff unterbrochen · nur Ansicht';this.onChange?.();});
    return clone(this.cache);
  }
  async takeOver({afterLoad}={}) {
    const loaded=await this.load();if(!loaded.data) throw Error('Spielstand noch ungestartet');
    if(afterLoad) await afterLoad();
    const token=secret(),uid=loaded.uid;
    await this.#control('takeover',loaded.meta,token);
    this.#lease={uid,secret:token,epoch:loaded.meta.epoch+1};this.persistDeviceLease();await this.load();
  }
  async rename(name) {
    name=nameGuard(name);
    const loaded=await this.load();await this.#control('profile',loaded.meta,null,name);await this.load();
  }
  async #control(action,expected,token,name=expected.name) {
    if(expected.deletionRequested)throw Error('Löschung beantragt: Konto gesperrt');
    const uid=this.#user().uid,op=unique();
    await runTransaction(this.db,async tx=>{
      this.#assert(uid);const ref=this.#ref(uid),old=(await tx.get(ref)).data();
      if(old.revision!==expected.revision) throw Error('Versionskonflikt: erst aktuellen Stand laden');
      const m={...old,name,revision:old.revision+1,epoch:old.epoch+(action==='takeover'?1:0),lastOp:op,action,claimId:''};
      tx.set(ref,m);tx.set(this.#ref(uid,'operations',op),{kind:action,revision:m.revision,digest:m.dataDigest,claimId:''});
      if(token) {tx.set(this.#ref(uid,'private','lease'),{epoch:m.epoch,secret:token});tx.set(this.#ref(uid,'private','proof'),{epoch:m.epoch,secret:token,revision:m.revision});}
    });
  }
  async startEmpty() {
    const loaded=await this.load();if(loaded.meta.stage!=='unstarted') throw Error('Konto bereits gestartet');
    return this.#commit(clone(EMPTY),{action:'empty',expected:loaded.meta,initialize:true});
  }
  async resolveOperation(operation) {
    const uid=this.#user().uid;this.#assert(uid);checkOperation(operation,uid);
    const r=await getDocFromServer(this.#ref(uid,'operations',operation.id));this.#assert(uid);
    if(!r.exists())return null;
    if(r.data().kind!==operation.binding.kind||!sameBinding(r.data().binding,operation.binding)) throw Error('Vorgangskennung bereits anders verwendet');
    return {alreadyCommitted:true,operation:clone(operation),receipt:r.data()};
  }
  async importGuest(guest,backupSink,{operationId=unique(),operation}={}) {
    if(this.live)throw Error('Keine Gastübernahme in vorhandene Spark-Konten');const prepared=await prepareImport(guest,backupSink),uid=this.#user().uid;
    const ticket=operation||{id:operationId,binding:{uid,kind:'import',source:prepared.encoded.digest}};
    checkOperation(ticket,uid);
    if(ticket.binding.kind!=='import'||ticket.binding.source!==prepared.encoded.digest)throw Error('Vorgangskennung bereits anders verwendet');
    this.pendingOperation=clone(ticket);
    const resolved=await this.resolveOperation(ticket);if(resolved)return resolved;
    const loaded=await this.load();
    // Vorschau und Sicherung existieren vor dem Commit. Keine automatische Zusammenführung.
    if(loaded.meta.imported||loaded.meta.hasProgress) throw Error('Einmalige Übernahme nicht mehr möglich');
    return this.#commit(prepared.data,{action:'import',expected:loaded.meta,initialize:loaded.meta.stage==='unstarted',operationId:ticket.id,binding:ticket.binding});
  }
  async save(data,{operationId=unique(),expected=this.cache?.meta,afterCommit}={}) {
    if(!expected) throw Error('Zuerst aktuellen Spielstand laden');
    if(this.live)throw Error('Im Spark-Test nur leerer Start und Testbonus');return this.#commit(data,{action:'save',expected,operationId,afterCommit});
  }
  async resume() {
    await this.auth.authStateReady();
    const user=this.auth.currentUser;if(!user)return null;
    if(this.live&&!LIVE_UIDS.includes(user.uid)){await this.logout();throw Error('Konto nicht für leeren Test freigegeben');}
    await reload(user);await user.getIdToken(true);this.restoreDeviceLease();return this.load();
  }
  restoreDeviceLease(){try{const uid=this.auth.currentUser?.uid,stored=JSON.parse(this.deviceStore?.getItem('mcp_account_lease_v150:'+uid)||'null');if(stored?.uid===uid&&Number.isSafeInteger(stored.epoch)&&/^[a-f0-9]{64}$/.test(stored.secret))this.#lease=stored;}catch{}}
  persistDeviceLease(){if(this.#lease&&this.deviceStore){const key='mcp_account_lease_v150:'+this.#lease.uid,value=JSON.stringify(this.#lease);this.deviceStore.setItem(key,value);if(this.deviceStore.getItem(key)!==value)throw Error('Gerätefreigabe konnte nicht dauerhaft gesichert werden');}}
  async importPrepared(data,backupSink,{operation}={}){
    if(this.live)throw Error('Keine Gastübernahme im leeren Spark-Test');
    const uid=this.#user().uid,encoded=await encode(data);
    if(await backupSink({format:'mcp-original-guest-v150',data:clone(data),digest:encoded.digest,json:encoded.json})!==encoded.digest)throw Error('Originalsicherung nicht bestätigt');
    const ticket=operation||{id:'import-'+unique(),binding:{uid,kind:'import',source:encoded.digest}};checkOperation(ticket,uid);
    if(ticket.binding.source!==encoded.digest)throw Error('Übernahmebeleg passt nicht zum gesicherten Stand');
    const prior=await this.resolveOperation(ticket);if(prior)return prior;const loaded=await this.load();
    if(loaded.meta.imported||loaded.meta.hasProgress)throw Error('Einmalige Übernahme nicht mehr möglich');
    return this.#commit(data,{action:'import',expected:loaded.meta,initialize:loaded.meta.stage==='unstarted',operationId:ticket.id,binding:ticket.binding});
  }
  async claimWelcome({afterCommit}={}) {
    const loaded=await this.load(),claimId='welcome-v150',operationId='reward-'+claimId;
    const prior=await getDocFromServer(this.#ref(loaded.uid,'operations',operationId));
    if(prior.exists())return {alreadyCommitted:true};
    if(loaded.meta.stage!=='active'||!loaded.data)throw Error('Kontostart erforderlich');
    if(loaded.data.wallet.units>Number.MAX_SAFE_INTEGER-100000)throw Error('Token-Grenze');
    const data=clone(loaded.data);data.wallet.units+=100000;
    return this.#commit(data,{action:'reward',claimId,operationId,expected:loaded.meta,afterCommit});
  }
  async welcomeClaimed(){const uid=this.#user().uid;return (await getDocFromServer(this.#ref(uid,'operations','reward-welcome-v150'))).exists();}
  async commitGame(data,{operationId,expected,kind,binding,claimId='',afterCommit}={}){
    if(this.live)throw Error('Spielaktionen im bestehenden Spark-Test noch gesperrt');
    if(!['save','trade','promo'].includes(kind))throw Error('Unbekannte Spielbuchung');
    return this.#commit(data,{action:kind,operationId,expected,binding,claimId,afterCommit});
  }
  async claimDaily({now=new Date()}={}){
    if(this.live)throw Error('Tagesgutschrift im Spark-Test gesperrt');
    const loaded=await this.load(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),id='daily-'+day;
    if((loaded.meta.dailyDay||'')>=day)return {alreadyCommitted:true};
    if((await getDocFromServer(this.#ref(loaded.uid,'operations',id))).exists())return {alreadyCommitted:true};
    if(!loaded.data)throw Error('Kontostart erforderlich');
    const data=clone(loaded.data);data.wallet.units+=50000;data.wallet.lastDay=day;
    return this.#commit(data,{action:'daily',operationId:id,claimId:day,expected:loaded.meta,binding:{uid:loaded.uid,kind:'game-daily',source:loaded.meta.dataDigest,proof:'0'.repeat(64),units:50000}});
  }
  async claimGift(){
    if(this.live)throw Error('Geschenk im Spark-Test gesperrt');const loaded=await this.load(),id='gift-thanks-2026-10';
    if(loaded.meta.giftClaimed||(await getDocFromServer(this.#ref(loaded.uid,'operations',id))).exists())return {alreadyCommitted:true};
    if(!loaded.data)throw Error('Kontostart erforderlich');const data=clone(loaded.data);data.wallet.units+=100000;data.wallet.gifts['thanks-2026-10']=true;
    return this.#commit(data,{action:'gift',operationId:id,claimId:'thanks-2026-10',expected:loaded.meta,binding:{uid:loaded.uid,kind:'game-gift',source:loaded.meta.dataDigest,proof:'0'.repeat(64),units:100000}});
  }
  async preparePromo(world,id) {
    if(this.live)throw Error('Keine Promobuchung im Spark-Test');
    if(!['pocket','live'].includes(world)) throw Error('Ungültige Kartenwelt');
    const loaded=await this.load(),p=loaded.data?.promos[world];
    if(!p?.pending?.ids.includes(id)||p.claimed>=Math.floor(p.packs/20)) throw Error('Keine passende offene Auswahl');
    return {id:'promo-'+world+'-'+(p.claimed+1),binding:{uid:loaded.uid,kind:'promo',world,claim:p.claimed+1,set:p.pending.set,selection:await selectionDigest(p.pending),card:id}};
  }
  async redeemPromo(world,id,{operation}={}) {
    const ticket=operation||await this.preparePromo(world,id),uid=this.#user().uid;
    checkOperation(ticket,uid);
    if(ticket.binding.kind!=='promo'||ticket.binding.world!==world||ticket.binding.card!==id)throw Error('Vorgangskennung bereits anders verwendet');
    this.pendingOperation=clone(ticket);
    const resolved=await this.resolveOperation(ticket);if(resolved)return resolved;
    const loaded=await this.load(),data=clone(loaded.data),p=data.promos[world],binding=ticket.binding;
    if(!p.pending?.ids.includes(id)||binding.claim!==p.claimed+1||binding.set!==p.pending.set||binding.selection!==await selectionDigest(p.pending)||p.claimed>=Math.floor(p.packs/20))throw Error('Keine passende offene Auswahl');
    p.owned[id]=(p.owned[id]||0)+1;p.pending=null;p.claimed++;
    const claimId=world+'-'+p.claimed;
    return this.#commit(data,{action:'promo',claimId,operationId:ticket.id,binding,expected:loaded.meta});
  }
  async #commit(data,{action,expected,initialize=false,operationId=unique(),claimId='',binding,afterCommit}) {
    const uid=this.#user().uid;this.#assert(uid);
    if(expected.deletionRequested)throw Error('Löschung beantragt: Konto gesperrt');
    checkId(operationId);
    const encoded=await encode(data),lease=initialize?{uid,secret:secret(),epoch:expected.epoch+1}:this.#lease;
    if(!lease||lease.uid!==uid) throw Error('Nur Ansicht: Gerät zuerst übernehmen');
    this.status='Änderungen ausstehend';
    try {
      // Transaktions-RPCs sind nicht durch disableNetwork allein gesperrt.
      // Eine ausdrücklich vom Server gelesene Vorprüfung verhindert diesen Offline-Pfad.
      await getDocFromServer(this.#ref(uid));this.#assert(uid);
      const result=await runTransaction(this.db,async tx=>{
        this.#assert(uid);
        const ref=this.#ref(uid),opRef=this.#ref(uid,'operations',operationId);
        const [profile,receipt]=await Promise.all([tx.get(ref),tx.get(opRef)]),old=profile.data();
        if(receipt.exists()) {
          if(receipt.data().kind!==action || receipt.data().claimId!==claimId || (binding&&!sameBinding(receipt.data().binding,binding)) || (['save','import'].includes(action)&&receipt.data().digest!==encoded.digest)) throw Error('Vorgangskennung bereits anders verwendet');
          return {alreadyCommitted:true};
        }
        if(old.revision!==expected.revision) throw Error('Versionskonflikt: erst aktuellen Stand laden');
        if(action==='import'&&(old.imported||old.hasProgress)) throw Error('Einmalige Übernahme nicht mehr möglich');
        if(!initialize&&old.epoch!==lease.epoch) throw Error('Nur Ansicht: anderes Gerät aktiv');
        const m={...old,dailyDay:data.wallet.lastDay,giftClaimed:data.wallet.gifts?.['thanks-2026-10']===true,stage:'active',revision:old.revision+1,dataRevision:old.revision+1,epoch:lease.epoch,hasProgress:action!=='empty',
          imported:old.imported||action==='import',importDigest:action==='import'?encoded.digest:old.importDigest,dataDigest:encoded.digest,walletUnits:data.wallet.units,
          promoPacks:{pocket:data.promos.pocket.packs,live:data.promos.live.packs},promoClaimed:{pocket:data.promos.pocket.claimed,live:data.promos.live.claimed},lastOp:operationId,action,claimId};
        tx.set(ref,m);
        encoded.fragments.forEach((fragment,i)=>tx.set(this.#ref(uid,'snapshots',String(i)),{generation:m.dataRevision,fragment}));
        tx.set(this.#ref(uid,'private','proof'),{secret:lease.secret,epoch:m.epoch,revision:m.revision});
        if(initialize) tx.set(this.#ref(uid,'private','lease'),{secret:lease.secret,epoch:m.epoch});
        tx.set(opRef,{kind:action,revision:m.revision,digest:m.dataDigest,claimId,...(binding?{binding}: {})});
        return {alreadyCommitted:false};
      });
      this.#lease=lease;this.persistDeviceLease();
      // Ausschließlich lokaler Fehler-Injektionspunkt, kein Live-Adapter.
      if(afterCommit)await afterCommit();
      await this.load();return {...result,...(binding?{operation:{id:operationId,binding:clone(binding)}}:{})};
    } catch(err) {this.status=!this.online||err.code==='unavailable'?'Offline · nur Ansicht':'Speicherstatus unklar · neu laden';throw err;}
  }
  deletionConsequences() {return 'Du beantragst die vollständige Löschung von Online-Sammlung, Token, Promos und Konto. Ab bestätigtem Antrag ist das Kontospiel gesperrt. Der Betreiber bearbeitet den Antrag innerhalb von sieben Tagen und bestätigt den tatsächlichen Abschluss über euren bestehenden privaten Kontakt, etwa WhatsApp. Das getrennte Gastspiel bleibt erhalten; es wird nichts aus dem Konto kopiert.';}
  async deletionRequestStatus() {
    const uid=this.#user().uid;this.#assert(uid);
    try {
      const r=await getDocFromServer((this.production?doc(this.db,'deletionRequests',uid):doc(this.db,'integrationTests','v150','deletionRequests',uid)));this.#assert(uid);
      if(!r.exists())return {state:'unknown',message:'Kein bestätigter Antrag abrufbar. Das ist keine Löschbestätigung; bitte Betreiber kontaktieren.'};
      return {...r.data(),message:r.data().state==='requested'?'Antrag bestätigt · wartet auf Betreiber':'In Bearbeitung · noch nicht vollständig gelöscht'};
    }catch(err){this.status='Löschstatus nicht abrufbar · Betreiber kontaktieren';throw err;}
  }
  async submitDeletionRequest(password,confirmation,{requestId=unique(),afterCommit}={}) {
    if(this.live)throw Error('Keine Löschanträge gegen vorhandene Spielerkonten im Integrationstest');const user=this.#user(),uid=user.uid;this.#assert(uid);checkId(requestId);
    if(confirmation!=='KONTOLÖSCHUNG BEANTRAGEN')throw Error('Ausdrückliche Bestätigung des Löschantrags erforderlich');
    await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password));await user.getIdToken(true);this.#assert(uid);
    this.pendingDeletion={uid,requestId};this.status='Löschantrag wird gesendet';
    try {
      const prior=await this.deletionRequestStatus();
      if(prior.state!=='unknown'){this.#clear();this.status=prior.message;return prior;}
      await getDocFromServer(this.#ref(uid));this.#assert(uid);
      await runTransaction(this.db,async tx=>{
        this.#assert(uid);const ref=this.#ref(uid),req=(this.production?doc(this.db,'deletionRequests',uid):doc(this.db,'integrationTests','v150','deletionRequests',uid));
        const [profile,existing]=await Promise.all([tx.get(ref),tx.get(req)]);
        if(existing.exists())return;
        const old=profile.data();if(!old||old.deletionRequested)throw Error('Löschstatus widersprüchlich · Betreiber kontaktieren');
        const m={...old,deletionRequested:true,revision:old.revision+1,lastOp:requestId,action:'deletion-request',claimId:''};
        tx.set(ref,m);tx.set(this.#ref(uid,'operations',requestId),{kind:m.action,revision:m.revision,digest:m.dataDigest,claimId:''});
        tx.set(req,{uid,requestId,state:'requested',requestedAt:serverTimestamp(),policy:'manual-v1'});
      });
      this.#clear();this.status='Löschung angefragt · Bearbeitung innerhalb von sieben Tagen';if(afterCommit)await afterCommit();
      return await this.deletionRequestStatus();
    }catch(err){this.status='Löschantrag unklar · Status prüfen, noch keine Löschbestätigung';throw err;}
  }
  // Historischer Emulator-Prototyp: kein freigegebener Produktweg, ausschließlich Regressionstests.
  async requestDeletion(password,confirmation,coordinator) {
    throw Error('Historischer Löschprototyp nicht Teil der Integration');
    const user=this.#user();this.#assert(user.uid);
    if(confirmation!=='ONLINE-KONTO UNWIDERRUFLICH LÖSCHEN')throw Error('Ausdrückliche Löschbestätigung erforderlich');
    await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password));
    const token=await user.getIdToken(true);this.#assert(user.uid);
    this.#clear();this.pendingOperation=null;this.status='Löschung ausstehend';
    try {const r=await coordinator.request(token,confirmation);await signOut(this.auth);return r;}
    catch(err){this.status='Löschstatus unklar · Wiederaufnahme prüfen';throw err;}
  }
  async offline(value=true) {this.online=!value;if(value){await disableNetwork(this.db);this.status='Offline · nur Ansicht';}else await enableNetwork(this.db);}
  async close() {this.#clear();await deleteApp(this.app);}
}
