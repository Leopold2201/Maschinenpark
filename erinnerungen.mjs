// Prüft jeden Morgen TÜV- und Wartungstermine und schickt Push-Nachrichten an alle Geräte.
// Läuft über GitHub Actions (.github/workflows/erinnerungen.yml).
//
// Regeln:
//  - Montags: Wochenüberblick über alles, was überfällig ist oder in den nächsten 30 Tagen fällig wird.
//  - Jeden Tag: Nachricht, wenn ein Termin genau 30 Tage, 7 Tage oder 1 Tag vor Ablauf steht
//    oder gestern abgelaufen ist.
//  - TEST=1: schickt sofort eine Testnachricht mit dem aktuellen Stand.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!sa.project_id) { console.error("Secret FIREBASE_SERVICE_ACCOUNT fehlt."); process.exit(1); }
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const APP_URL = process.env.APP_URL || "/";
const TEST = process.env.TEST === "1";

// Heute in deutscher Zeit
const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const monthEnd = ym => { const [y, m] = String(ym).slice(0, 7).split("-").map(Number); return new Date(y, m, 0); };
const daysUntil = d => Math.round((d - today) / 864e5);
const mmyy = ym => { const [y, m] = String(ym).slice(0, 7).split("-"); return `${m}/${y.slice(2)}`; };

const items = [];
const maschinen = await db.collection("maschinen").get();
for (const doc of maschinen.docs) {
  const m = doc.data();
  if (m.tuevBis && !m.abgemeldet) items.push({ name: m.name, was: "TÜV", wann: mmyy(m.tuevBis), d: daysUntil(monthEnd(m.tuevBis)) });
  const punkte = Array.isArray(m.wartung) ? m.wartung : [];
  for (const p of punkte) if (p.naechste) items.push({ name: m.name, was: p.name, wann: mmyy(p.naechste), d: daysUntil(monthEnd(p.naechste)) });
}
items.sort((a, b) => a.d - b.d);

const line = i => `${i.name}: ${i.was} ${i.d < 0 ? `überfällig (${i.wann})` : i.d === 0 ? "läuft heute ab" : `bis ${i.wann}`}`;
const offen = items.filter(i => i.d <= 30);
const ueberfaellig = items.filter(i => i.d < 0).length;
const montag = today.getDay() === 1;
const neu = items.filter(i => [30, 7, 1, 0, -1].includes(i.d));

let title = "", body = "";
if (TEST) {
  title = "Maschinenpark: Test";
  body = offen.length ? offen.slice(0, 6).map(line).join("\n") : "Benachrichtigungen funktionieren. Gerade ist nichts fällig.";
} else if (montag && offen.length) {
  title = `Wochenüberblick: ${offen.length} Termin${offen.length > 1 ? "e" : ""}` + (ueberfaellig ? `, ${ueberfaellig} überfällig` : "");
  body = offen.slice(0, 6).map(line).join("\n") + (offen.length > 6 ? `\n… und ${offen.length - 6} weitere` : "");
} else if (neu.length) {
  title = neu.length === 1 ? `${neu[0].was} fällig: ${neu[0].name}` : `${neu.length} Termine werden fällig`;
  body = neu.slice(0, 6).map(line).join("\n");
}
if (!title) { console.log("Heute nichts zu melden."); process.exit(0); }

const geraete = await db.collection("geraete").get();
if (geraete.empty) { console.log("Keine Geräte mit eingeschalteten Benachrichtigungen."); process.exit(0); }
const tokens = geraete.docs.map(d => d.id);

const res = await getMessaging().sendEachForMulticast({
  tokens,
  notification: { title, body },
  webpush: { fcmOptions: { link: APP_URL }, notification: { icon: APP_URL + "icons/icon-192.png", badge: APP_URL + "icons/icon-192.png", tag: "maschinenpark" } },
});
console.log(`Gesendet: ${res.successCount} ok, ${res.failureCount} fehlgeschlagen.\n${title}\n${body}`);

// Alte Geräte (App gelöscht, Rechte entzogen) aufräumen
const tot = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"];
await Promise.all(res.responses.map((r, i) => !r.success && tot.includes(r.error?.code) ? db.collection("geraete").doc(tokens[i]).delete() : null));
