import express from 'express';
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from 'firebase-admin';
// On définit les types manuellement pour ne plus dépendre des imports capricieux
const Type = {
OBJECT: "OBJECT",
STRING: "STRING"
};
// ==========================================
// 1. INITIALISATION FIREBASE
// ==========================================
if (!admin.apps.length) {
try {
const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountStr) {
// Parse JSON configuration
const serviceAccount = JSON.parse(serviceAccountStr);
admin.initializeApp({
credential: admin.credential.cert(serviceAccount)
});
console.log("🔥 [WhatsApp Bot] Firebase admin initialized with service account");
} else {
admin.initializeApp();
console.log("🔥 [WhatsApp Bot] Firebase admin initialized with default credentials");
}
} catch (error) {
console.error("🔥 [WhatsApp Bot] Firebase admin initialization error:", error);
}
}
const db = admin.firestore();
// ==========================================
// 2. INITIALISATION GEMINI
// ==========================================
const ai = new GoogleGenerativeAI({
apiKey: process.env.GEMINI_API_KEY || "dummy-key-to-prevent-crash"
});
// ==========================================
// 3. EXPRESS APP & MICROSERVICE CONFIG
// ==========================================
const app = express();
app.use(express.json());
// Port indépendant (3001) tel que demandé pour le microservice
const PORT = process.env.BOT_PORT || 3001;
// ==========================================
// 4. OUTILS FIREBASE (Function Calling)
// ==========================================
async function check_availability(doctorId, date) {
try {
// Horaires par défaut pour la démo
let availableSlots = [
"08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
"11:00", "11:30", "13:00", "13:30", "14:00", "14:30",
"15:00", "15:30", "16:00", "16:30", "17:00"
];
code
Code
// Vérifie les RDVs existants
const apptsSnap = await db.collection("appointments")
  .where("doctorId", "==", doctorId)
  .where("date", "==", date)
  .get();
  
const bookedHours = apptsSnap.docs.map(d => d.data().time);

// Vérifie les absences
const absSnap = await db.collection("absences")
  .where("doctorId", "==", doctorId)
  .where("date", "==", date)
  .get();

// Si absence journalière, tout nettoyer
if (!absSnap.empty) {
    const fullAbsence = absSnap.docs.some(d => d.data().type === "Journée entière");
    if (fullAbsence) return [];
}
  
// Retourner les créneaux restants
return availableSlots.filter(t => !bookedHours.includes(t));
} catch (error) {
console.error("check_availability error:", error);
return [];
}
}
async function book_appointment(patientName, patientPhone, doctorId, date, time, reason) {
try {
// Création RDV
await db.collection("appointments").add({
doctorId,
patientName,
patientPhone,
date,
time,
reason,
status: 'À venir',
bookedBy: patientPhone,
createdAt: admin.firestore.FieldValue.serverTimestamp()
});
code
Code
// Ajout du numéro dans l'annuaire patient
const userRef = db.collection("users").doc(patientPhone);
await userRef.set({
  phone: patientPhone,
  name: patientName,
  role: "patient",
  updatedAt: admin.firestore.FieldValue.serverTimestamp()
}, { merge: true });

return `Succès: Réservation confirmée pour ${patientName} le ${date} à ${time} pour: ${reason}.`;
} catch (err) {
console.error("book_appointment error:", err);
return "Erreur technique lors de la réservation dans la base.";
}
}
// ==========================================
// 5. PONT WHATSAPP
// ==========================================
async function sendWhatsAppMessage(to, text) {
const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!token || !phoneNumberId) {
console.warn("⚠️ Meta WhatsApp credentials not configured. Skipping message to:", to);
console.log([WHATSAPP MOCK] To ${to}: ${text});
return;
}
const url = https://graph.facebook.com/v17.0/${phoneNumberId}/messages;
try {
const response = await fetch(url, {
method: "POST",
headers: {
"Authorization": Bearer ${token},
"Content-Type": "application/json"
},
body: JSON.stringify({
messaging_product: "whatsapp",
to: to,
type: "text",
text: { body: text }
})
});
code
Code
if (!response.ok) {
    const errText = await response.text();
    console.error(`🚨 WhatsApp API error (Status ${response.status}):`, errText);
} else {
    console.log(`✓ WhatsApp message sent to ${to}`);
}
} catch (error) {
console.error("🚨 Failed to send WhatsApp message:", error);
}
}
// ==========================================
// 6. CERVEAU IA (Gemini 1.5 Flash)
// ==========================================
const memory = {};
const systemPrompt = `Tu es Amina, la secrétaire médicale virtuelle de Tabibo gérant l'agenda du Médecin. Tu es polie, concise et rassurante.
RÈGLE D'OR : Fais du 'Mirroring' linguistique. Si le patient parle en Français, réponds en Français. S'il parle en Arabe littéraire, réponds en Arabe. S'il parle en Derja (dialecte algérien en lettres latines ou arabes, ex: 'wach rak', 'khoya'), tu DOIS répondre en Derja chaleureusement tout en restant très professionnelle.
Ton but est de :
Demander le motif de la consultation.
Proposer des créneaux en utilisant TOUJOURS tes outils. Ne sois JAMAIS créative avec les horaires. Propose toujours des alternatives proches si c'est plein.
Demander le Nom et Prénom complet du patient.
Valider le RDV dans la base via l'outil.
RAPPEL IMPORTANT (NO-SHOW) : À la toute fin du processus de réservation, rappelle toujours cette phrase : "Attention : Toute absence non annulée 24h à l'avance entraînera le blocage de votre numéro sur la plateforme Tabibo."
Ne donne AUCUN conseil médical. En cas de symptômes graves, oriente vers les urgences (14) ou un hôpital.`;
const tools = [{
functionDeclarations: [
{
name: "check_availability",
description: "Vérifie les horaires libres du médecin pour une date donnée (YYYY-MM-DD).",
parameters: {
type: Type.OBJECT,
properties: {
doctorId: { type: Type.STRING, description: "ID du médecin. Défaut: 'dr_amina_001'." },
date: { type: Type.STRING, description: "Date au format YYYY-MM-DD." }
},
required: ["doctorId", "date"]
}
},
{
name: "book_appointment",
description: "Valide le RDV dans la base de données. N'utiliser que lorsque l'heure est choisie et que le nom/prénom est fourni.",
parameters: {
type: Type.OBJECT,
properties: {
patientName: { type: Type.STRING, description: "Nom complet du patient." },
patientPhone: { type: Type.STRING, description: "Téléphone du patient." },
doctorId: { type: Type.STRING, description: "ID du médecin (ex: dr_amina_001)." },
date: { type: Type.STRING, description: "Date choisie: YYYY-MM-DD." },
time: { type: Type.STRING, description: "Heure choisie: '14:30'." },
reason: { type: Type.STRING, description: "Motif qualifié de la consultation." }
},
required: ["patientName", "patientPhone", "doctorId", "date", "time", "reason"]
}
}
]
}];
async function processMessageAI(phone, text) {
if (!memory[phone]) {
memory[phone] = [];
}
code
Code
// Garder le contexte courant
memory[phone].push({
    role: "user",
    parts: [{ text: text }]
});

if (memory[phone].length > 10) {
    memory[phone] = memory[phone].slice(-10);
}

try {
    let currentContents = [...memory[phone]];
    
    let response = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: currentContents,
        config: {
            systemInstruction: systemPrompt,
            tools: tools,
            temperature: 0.2
        }
    });

    while (response.functionCalls && response.functionCalls.length > 0) {
        currentContents.push(response.candidates[0].content);
        const toolResponses = [];

        for (const call of response.functionCalls) {
            let callResult = null;
            try {
                if (call.name === "check_availability") {
                    const slots = await check_availability(call.args.doctorId, call.args.date);
                    callResult = { slots };
                } else if (call.name === "book_appointment") {
                    const phoneArg = call.args.patientPhone || phone;
                    const resultMsg = await book_appointment(
                        call.args.patientName, 
                        phoneArg, 
                        call.args.doctorId, 
                        call.args.date, 
                        call.args.time, 
                        call.args.reason
                    );
                    callResult = { status: resultMsg };
                } else {
                    callResult = { error: "Fonction inconnue" };
                }
            } catch (e) {
                callResult = { error: e.message };
            }

            toolResponses.push({
                functionResponse: {
                    name: call.name,
                    response: { result: callResult }
                }
            });
        }

        currentContents.push({
            role: "user",
            parts: toolResponses
        });

        response = await ai.models.generateContent({
            model: "gemini-1.5-flash",
            contents: currentContents,
            config: {
                systemInstruction: systemPrompt,
                tools: tools,
                temperature: 0.2
            }
        });
    }

    const assistantMessage = response.text || "";
    memory[phone].push({
        role: "model",
        parts: [{ text: assistantMessage }]
    });

    return assistantMessage;

} catch (err) {
    console.error("[Cerveau IA] Erreur traitement:", err);
    return "Désolé, je rencontre un problème de connexion temporaire. Pouvez-vous répéter ?";
}
}
// ==========================================
// 7. ROUTES META WHATSAPP
// ==========================================
// Route de validation (GET) stricte exigée par Meta
app.get('/webhook', (req, res) => {
const mode = req.query['hub.mode'];
const token = req.query['hub.verify_token'];
const challenge = req.query['hub.challenge'];
if (mode && token) {
if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
console.log('✅ [Microservice WhatsApp] WEBHOOK_VERIFIED');
return res.status(200).send(challenge); // Meta exige qu'on renvoie juste le challenge en texte brut
} else {
console.log('❌ [Microservice WhatsApp] Échec vérification Webhook (Token invalide)');
return res.sendStatus(403);
}
}
return res.status(400).send('Bad Request');
});
// Route de réception des messages (POST)
app.post('/webhook', async (req, res) => {
const body = req.body;
if (body.object === "whatsapp_business_account") {
// Toujours renvoyer un statut 200 IMMÉDIATEMENT pour ne pas se faire bloquer par Meta
res.sendStatus(200);
code
Code
try {
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (message && message.type === "text") {
    const fromPhone = message.from; 
    const textBody = message.text.body;

    console.log(`💬 [WhatsApp Bot] Reçu de ${fromPhone}: ${textBody}`);
    
    // Traitement asynchrone sans bloquer la requête HTTP
    processMessageAI(fromPhone, textBody).then((aiReply) => {
       if (aiReply) {
           sendWhatsAppMessage(fromPhone, aiReply);
       }
    });
  }
} catch (err) {
  console.error("❌ [WhatsApp Bot] Erreur parsing webhook:", err);
}
} else {
// Si la requête ne provient pas de WhatsApp Business
res.sendStatus(404);
}
});
// Lancement du microservice
app.listen(PORT, "0.0.0.0", () => {
console.log(🚀 [Microservice Amina] Serveur WhatsApp autonome démarré sur http://localhost:${PORT});
console.log(🌍 Endpoint de validation Meta : /webhook);
});
