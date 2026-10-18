// Wiederaufnahmebeschreibung: im Labor nur im RAM, niemals echte App-Speicher lesen.
export const operationId = id => {
  if(typeof id!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error('Ungültige Vorgangskennung');
  return id;
};
const canonical = x => JSON.stringify(x, Object.keys(x).sort());
export const sameBinding = (a,b) => !!a&&!!b&&canonical(a)===canonical(b);
export async function selectionDigest(pending) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({set:pending.set,ids:pending.ids})))),x=>x.toString(16).padStart(2,'0')).join('');
}
export function checkOperation(ticket,uid) {
  if(!ticket||Object.keys(ticket).sort().join(',')!=='binding,id'||!ticket.binding||ticket.binding.uid!==uid) throw Error('Vorgang gehört zu anderem Konto oder ist ungültig');
  operationId(ticket.id);
  const b=ticket.binding;
  if(b.kind==='import' && Object.keys(b).sort().join(',')==='kind,source,uid' && /^[a-f0-9]{64}$/.test(b.source)) return ticket;
  if(b.kind==='promo' && Object.keys(b).sort().join(',')==='card,claim,kind,selection,set,uid,world'
    && ['pocket','live'].includes(b.world)&&Number.isSafeInteger(b.claim)&&b.claim>0
    && typeof b.card==='string'&&b.card.length>0&&typeof b.set==='string'&&b.set.length>0
    && /^[a-f0-9]{64}$/.test(b.selection)&&ticket.id==='promo-'+b.world+'-'+b.claim) return ticket;
  throw Error('Ungültige Vorgangsbeschreibung');
}
