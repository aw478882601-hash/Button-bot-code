// =================================================================
// |   TELEGRAM BOT - FIREBASE MIGRATION ONLY                      |
// =================================================================

const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 1. تهيئة Firebase ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('Firebase Admin Initialization Error:', error.message);
    process.exit(1);
  }
}
const db = admin.firestore();

// --- 2. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                   Migration Function                          |
// =================================================================

async function migrateDatabase(ctx) {
  try {
    const buttonsSnapshot = await db.collection('buttons').get();
    if (buttonsSnapshot.empty) {
      return ctx.reply("⚠️ لا يوجد أزرار للهجرة.");
    }

    let migratedCount = 0;

    for (const buttonDoc of buttonsSnapshot.docs) {
      const fullPathId = buttonDoc.id; // 👈 ID = مسار كامل
      const buttonData = buttonDoc.data();

      // --- 1. اجمع الرسائل ---
      const messagesSnapshot = await db.collection('messages')
        .where('buttonId', '==', fullPathId)
        .orderBy('order')
        .get();
      const messages = messagesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // --- 2. اجمع الأزرار الفرعية ---
      const subButtonsSnapshot = await db.collection('buttons')
        .where('parentId', '==', fullPathId)
        .get();
      const subButtons = subButtonsSnapshot.docs.map(doc => ({
        id: doc.id, // برضه مسار كامل
        text: doc.data().text,
        order: doc.data().order,
        adminOnly: doc.data().adminOnly || false,
        isFullWidth: doc.data().isFullWidth || false
      }));

      // --- 3. احسب الفلاجز ---
      const hasMessages = messages.length > 0;
      const hasSubButtons = subButtons.length > 0;

      // --- 4. احفظ في buttons_v2 ---
      await db.collection('buttons_v2').doc(fullPathId).set({
        ...buttonData,
        messages,
        subButtons,
        hasMessages,
        hasSubButtons
      }, { merge: true });

      migratedCount++;
    }

    await ctx.reply(`🎉 تمت الهجرة بنجاح!\n\n✔ عدد الأزرار المنقولة: ${migratedCount}`);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    await ctx.reply("❌ فشل في عملية الهجرة. شوف اللوجات.");
  }
}

// =================================================================
// |                    Bot Commands                               |
// =================================================================

bot.command('migrate', async (ctx) => {
  const userId = String(ctx.from.id);

  // مسموح بس للأدمن الرئيسي
  if (userId !== process.env.SUPER_ADMIN_ID) {
    return ctx.reply("🚫 الأمر مسموح للأدمن الرئيسي فقط.");
  }

  await ctx.reply("⏳ جاري تنفيذ عملية الهجرة...");
  await migrateDatabase(ctx);
});

// =================================================================
// |                    Webhook / Launch                           |
// =================================================================

if (process.env.VERCEL === "true") {
  // لو شغال على Vercel
  module.exports = async (req, res) => {
    try {
      if (req.method === 'POST' && req.body) {
        await bot.handleUpdate(req.body, res);
      } else {
        res.status(200).send('Migration bot is running.');
      }
    } catch (err) {
      console.error('Error in webhook handler:', err.message);
      if (!res.headersSent) {
        res.status(500).send('Internal server error.');
      }
    }
  };
} else {
  // لو بتجرب محلي
  bot.launch();
  console.log("🚀 Migration bot started. Use /migrate to run migration.");
}
