// Schickt jeden Abend kurz nach 17 Uhr (Bestellschluss) die Schnittliste für morgen aufs Handy.
// Läuft über GitHub Actions (.github/workflows/kohl.yml). Ohne Bestellungen kommt keine Nachricht.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

let sa = JSON.parse((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim());
if (typeof sa === "string") sa = JSON.parse(sa);
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const APP_URL = process.env.APP_URL || "/";

const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));

// Datenschutz: Bestellungen 30 Tage nach dem Abholtag automatisch löschen
{
  const g = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const grenze = `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, "0")}-${String(g.getDate()).padStart(2, "0")}`;
  const alt = await db.collection("kohlBestellungen").where("abholung", "<", grenze).get();
  for (let i = 0; i < alt.docs.length; i += 400) {
    const b = db.batch(); alt.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
  }
  if (alt.size) console.log(`${alt.size} alte Bestellungen gelöscht (Abholung vor ${grenze}).`);
}
// Zwei Zeitpläne (Sommer/Winter), es sendet nur der, der gerade 17 Uhr in Deutschland ist.
const SCHED = process.env.SCHED || "";
const off = Math.round((now - new Date(new Date().toLocaleString("en-US", { timeZone: "UTC" }))) / 36e5);
if (SCHED && !((off === 2 && SCHED.startsWith("2 15 ")) || (off === 1 && SCHED.startsWith("2 16 ")))) { console.log("Anderer Zeitplan für Sommer-/Winterzeit."); process.exit(0); }

const m = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const morgen = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
const SORTEN = [["weisskohl", "Weißkohl"], ["rotkohl", "Rotkohl"], ["wirsing", "Wirsing"], ["rosenkohl", "Rosenkohl"]];

const snap = await db.collection("kohlBestellungen").where("abholung", "==", morgen).get();
const best = snap.docs.map(d => d.data()).filter(b => b.status !== "abgeholt");
if (!best.length) { console.log("Keine Kohl-Bestellungen für morgen."); process.exit(0); }

const summe = SORTEN.map(([id, n]) => [n, best.reduce((a, b) => a + (+(b.posten || {})[id] || 0), 0)]).filter(x => x[1]);
const title = `Kohl für morgen: ${best.length} Bestellung${best.length > 1 ? "en" : ""}`;
const body = summe.map(([n, z]) => `${z} × ${n}`).join("\n") + "\n" +
  best.sort((a, b) => (a.uhrzeit || "").localeCompare(b.uhrzeit || "")).map(b => `${b.uhrzeit || "?"} ${b.name}`).join(", ");

const geraete = await db.collection("geraete").get();
if (geraete.empty) { console.log("Keine Geräte mit Benachrichtigungen."); process.exit(0); }
const tokens = geraete.docs.map(d => d.id);
const res = await getMessaging().sendEachForMulticast({
  tokens, notification: { title, body },
  webpush: { fcmOptions: { link: APP_URL }, notification: { icon: APP_URL + "icon-192.png", tag: "kohl" } },
});
console.log(`Gesendet: ${res.successCount} ok, ${res.failureCount} fehlgeschlagen.\n${title}\n${body}`);
