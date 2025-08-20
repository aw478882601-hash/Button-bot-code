// =================================================================
// |   ملف INDEX.JS مؤقت ومخصص لترحيل إحصائيات الأزرار القديمة فقط   |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Initialized for Migration.");
  } catch (error) {
    console.error('Firebase Admin Initialization Error:', error.message);
    process.exit(1);
  }
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 4. أمر البدء (للتحقق من أن البوت يعمل) ---
bot.start((ctx) => {
    return ctx.reply('✅ بوت ترحيل الإحصائيات جاهز.\n\nأرسل الأمر /migratestats لبدء عملية نقل البيانات القديمة.');
});


// --- 5. الأمر الأساسي لتنفيذ عملية الترحيل ---
bot.command('migratestats', async (ctx) => {
    // التأكد من أن منفذ الأمر هو المطور فقط
    if (String(ctx.from.id) !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 الأمر مخصص للمطور فقط.');
    }

    await ctx.reply('⏳ جارٍ بدء عملية ترحيل الإحصائيات القديمة... قد تستغرق العملية بعض الوقت.');

    try {
        const buttonsSnapshot = await db.collection('buttons').get();
        if (buttonsSnapshot.empty) {
            return ctx.reply("لم يتم العثور على أي أزرار لترحيلها.");
        }

        const batch = db.batch();
        let migratedCount = 0;
        const statsCollectionRef = db.collection('button_stats');

        for (const doc of buttonsSnapshot.docs) {
            const buttonId = doc.id;
            const buttonData = doc.data();
            const oldStats = buttonData.stats;

            if (oldStats && (oldStats.totalClicks || oldStats.dailyClicks)) {
                const newStats = {
                    buttonId: buttonId,
                    buttonText: buttonData.text || "اسم غير متوفر",
                    totalClicks: oldStats.totalClicks || 0,
                    totalUniqueUsers: oldStats.totalUsers?.length || 0,
                    daily: {},
                    lastUpdated: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' })
                };

                if (oldStats.dailyClicks) {
                    for (const date in oldStats.dailyClicks) {
                        if (Object.hasOwnProperty.call(oldStats.dailyClicks, date)) {
                            newStats.daily[date] = {
                                clicks: oldStats.dailyClicks[date] || 0,
                                uniqueUsers: oldStats.dailyUsers?.[date]?.length || 0
                            };
                        }
                    }
                }

                const newStatRef = statsCollectionRef.doc(buttonId);
                batch.set(newStatRef, newStats, { merge: true });
                migratedCount++;
            }
        }

        if (migratedCount === 0) {
            return ctx.reply("✅ لا توجد إحصائيات قديمة في الأزرار تحتاج إلى ترحيل.");
        }

        await batch.commit();
        await ctx.reply(`🎉 تمت عملية الترحيل بنجاح!\nتم تحديث إحصائيات ${migratedCount} زر.`);

    } catch (error) {
        console.error("Migration Error:", error);
        await ctx.reply(`❌ حدث خطأ أثناء عملية الترحيل: ${error.message}`);
    }
});

// --- 6. إعداد Vercel Webhook لتشغيل البوت ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Migration Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
