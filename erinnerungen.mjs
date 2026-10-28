// Wochenüberblick: prüft TÜV, Wartung, Lagerbestand und fehlende Angaben und schickt eine Push-Nachricht an alle Geräte.
// Läuft über GitHub Actions (.github/workflows/erinnerungen.yml).
//
// Regeln:
//  - Nur montags um 7 Uhr: TÜV und Wartung (überfällig oder in 30 Tagen fällig), Teile unter Mindestbestand, fehlende Angaben.
//  - TEST=1: schickt sofort eine Testnachricht mit dem aktuellen Stand.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

// Schlüssel aus dem GitHub-Secret lesen (verzeiht doppelt verpacktes JSON und Leerzeichen)
const roh = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
if (!roh) { console.error("Secret FIREBASE_SERVICE_ACCOUNT ist leer oder fehlt."); process.exit(1); }
let sa;
try { sa = JSON.parse(roh); if (typeof sa === "string") sa = JSON.parse(sa); }
catch (e) { console.error("Secret FIREBASE_SERVICE_ACCOUNT ist kein gültiges JSON. Bitte den kompletten Inhalt der Datei von { bis } einfügen."); process.exit(1); }
if (!sa || !sa.project_id || !sa.private_key || !sa.client_email) {
  console.error("Secret FIREBASE_SERVICE_ACCOUNT enthält nicht den Dienstkonto-Schlüssel. Gefundene Felder: " + Object.keys(sa || {}).join(", ") +
    "\nErwartet: type, project_id, private_key, client_email … (Firebase › Projekteinstellungen › Dienstkonten › Neuen privaten Schlüssel generieren)");
  process.exit(1);
}
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

// ── Datenscan: TÜV, Wartung, Lager, fehlende Angaben ──
const tuev = [], wartung = [], luecken = [];
const maschinen = await db.collection("maschinen").get();
for (const doc of maschinen.docs) {
  const m = doc.data();
  if (m.abgemeldet || m.beispiel) continue;
  const tuevPflicht = m.tuevPflicht !== false;
  if (m.tuevBis && tuevPflicht) tuev.push({ name: m.name, wann: mmyy(m.tuevBis), d: daysUntil(monthEnd(m.tuevBis)) });
  // Wartungspunkte mit Intervall (Abschmieren / „zuletzt“ haben keinen Termin)
  const pk = Array.isArray(m.wartung) ? m.wartung : [];
  for (const p of pk) {
    if (/abschmier/i.test(p.name || "") || p.modus === "zuletzt" || !p.naechste) continue;
    const d = daysUntil(monthEnd(p.naechste));
    if (d <= 30) wartung.push({ name: m.name, was: p.name, wann: mmyy(p.naechste), d });
  }
  // Fehlende Angaben
  const fehlt = [];
  if (tuevPflicht && !m.tuevBis) fehlt.push("TÜV-Termin");
  if (tuevPflicht && !m.fin) fehlt.push("Fahrgestell-Nr.");
  if (pk.some(p => !/abschmier/i.test(p.name || "") && p.modus !== "zuletzt" && p.intervall && !p.naechste)) fehlt.push("Wartungstermin");
  if (fehlt.length) luecken.push({ name: m.name, fehlt });
}
tuev.sort((a, b) => a.d - b.d); wartung.sort((a, b) => a.d - b.d);
const lager = await db.collection("lager").get();
const knapp = lager.docs.map(d => d.data()).filter(a => +a.min > 0 && (+a.menge || 0) <= +a.min);

const wann = i => i.d < 0 ? `überfällig (${i.wann})` : i.d === 0 ? "heute" : `bis ${i.wann}`;
const tuevOffen = tuev.filter(i => i.d <= 30);
const tuevUeber = tuevOffen.filter(i => i.d < 0).length;
const kurz = (arr, f, n = 2) => arr.slice(0, n).map(f).join(", ") + (arr.length > n ? ` … (+${arr.length - n})` : "");

// Montags 7 Uhr deutscher Zeit. GitHub rechnet in UTC, darum laufen zwei Zeitpläne (5 und 6 Uhr UTC);
// es sendet nur der, der gerade 7 Uhr in Deutschland entspricht (Sommer- bzw. Winterzeit).
const SCHED = process.env.SCHED || "";
const berlinOffset = Math.round((now - new Date(new Date().toLocaleString("en-US", { timeZone: "UTC" }))) / 36e5);
const passt = !SCHED || (berlinOffset === 2 && SCHED.startsWith("0 5 ")) || (berlinOffset === 1 && SCHED.startsWith("0 6 "));
if (!TEST && !passt) { console.log("Anderer Zeitplan für Sommer-/Winterzeit, nichts zu tun."); process.exit(0); }

const zeilen = [];
zeilen.push(tuevOffen.length ? `TÜV: ${kurz(tuevOffen, i => `${i.name} ${wann(i)}`)}` : "TÜV: nichts fällig in den nächsten 30 Tagen");
if (wartung.length) zeilen.push(`Wartung: ${kurz(wartung, i => `${i.name} ${i.was} ${wann(i)}`)}`);
if (knapp.length) zeilen.push(`Nachbestellen: ${kurz(knapp, a => a.teil || a.name, 3)}`);
if (luecken.length) zeilen.push(`Daten fehlen bei ${luecken.length} Maschine${luecken.length > 1 ? "n" : ""} (z. B. ${luecken[0].name}: ${luecken[0].fehlt.join(", ")})`);

const probleme = tuevOffen.length + wartung.length + knapp.length;
let title = (TEST ? "Test · " : "") + "Wochenüberblick" +
  (probleme ? `: ${[tuevOffen.length && `${tuevOffen.length}× TÜV`, wartung.length && `${wartung.length}× Wartung`, knapp.length && `${knapp.length}× Lager`].filter(Boolean).join(", ")}` : ": alles in Ordnung") +
  (tuevUeber ? ` (${tuevUeber} überfällig)` : "");
let body = zeilen.join("\n");
console.log("Fehlende Daten:\n" + luecken.map(l => `- ${l.name}: ${l.fehlt.join(", ")}`).join("\n"));
if (!title) { console.log("Heute nichts zu melden."); process.exit(0); }

const geraete = await db.collection("geraete").get();
if (geraete.empty) { console.log("Keine Geräte mit eingeschalteten Benachrichtigungen."); process.exit(0); }
const tokens = geraete.docs.map(d => d.id);

const res = await getMessaging().sendEachForMulticast({
  tokens,
  notification: { title, body },
  webpush: { fcmOptions: { link: APP_URL }, notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png", tag: "maschinenpark" } },
});
console.log(`Gesendet: ${res.successCount} ok, ${res.failureCount} fehlgeschlagen.\n${title}\n${body}`);

// Alte Geräte (App gelöscht, Rechte entzogen) aufräumen
const tot = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"];
await Promise.all(res.responses.map((r, i) => !r.success && tot.includes(r.error?.code) ? db.collection("geraete").doc(tokens[i]).delete() : null));
