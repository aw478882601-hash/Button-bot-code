// =================================================================
// |   TELEGRAM FIREBASE BOT - SCRIPT DE MIGRATION DE DONNÉES        |
// |   Ce script est à usage unique pour restructurer la base de données.   |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
// Assurez-vous que vos variables d'environnement sont correctement configurées
try {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
} catch (error) {
    console.error('Erreur d\'initialisation de Firebase Admin :', error.message);
    // Empêche le bot de démarrer si Firebase n'est pas configuré
    process.exit(1);
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
// Assurez-vous que BOT_TOKEN est défini dans vos variables d'environnement
if (!process.env.BOT_TOKEN) {
    console.error('BOT_TOKEN n\'est pas défini !');
    process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 4. تعريف الأمر السري والآمن لعملية الترحيل ---
const MIGRATION_COMMAND = 'migrate_my_database_final_version';

bot.command(MIGRATION_COMMAND, async (ctx) => {
    const userId = String(ctx.from.id);

    // -- التحقق من أن منفذ الأمر هو الأدمن الرئيسي فقط --
    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمطور فقط.');
    }

    await ctx.reply('🚀 حسنًا! تم استلام الأمر. سأبدأ عملية ترحيل البيانات الآن. كن صبوراً...');

    try {
        const allButtonsSnapshot = await db.collection('buttons').get();
        if (allButtonsSnapshot.empty) {
            return ctx.reply('ℹ️ قاعدة بيانات الأزرار فارغة، لا يوجد ما يتم ترحيله.');
        }

        const batch = db.batch();
        let processedCount = 0;

        // المرور على كل زر في قاعدة البيانات
        for (const buttonDoc of allButtonsSnapshot.docs) {
            const buttonId = buttonDoc.id;
            const buttonData = buttonDoc.data();
            
            // --- 1. تجميع الرسائل المضمنة ---
            const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
            const embeddedMessages = messagesSnapshot.docs.map(doc => {
                const { buttonId, ...messageData } = doc.data();
                return messageData; // `order` field is already included
            });

            // --- 2. تجميع الأزرار الفرعية المضمنة ---
            // Le chemin complet est parentPath/buttonId
            const fullButtonPrefix = buttonData.parentId === 'root' ? buttonId : `${buttonData.parentId}/${buttonId}`;
            const subButtonsSnapshot = await db.collection('buttons').where('parentId', '==', fullButtonPrefix).orderBy('order').get();
            const embeddedSubButtons = subButtonsSnapshot.docs.map(doc => {
                const subBtnData = doc.data();
                return {
                    buttonId: doc.id,
                    text: subBtnData.text,
                    isFullWidth: subBtnData.isFullWidth,
                    order: subBtnData.order
                };
            });
            
            // --- 3. تجهيز الحقول الجديدة للتحديث ---
            const updatePayload = {
                hasMessages: embeddedMessages.length > 0,
                hasSubButtons: embeddedSubButtons.length > 0,
                messages: embeddedMessages,
                subButtons: embeddedSubButtons
            };
            
            // --- 4. إضافة عملية التحديث إلى الـ batch ---
            batch.update(buttonDoc.ref, updatePayload);
            processedCount++;
        }

        // --- 5. تنفيذ جميع التحديثات مرة واحدة (عملية ذرية) ---
        await batch.commit();

        await ctx.reply(`✅🎉 اكتملت عملية الترحيل بنجاح لـ ${processedCount} زر!`);
        await ctx.reply('‼️ مهم جداً: أعد الآن كود البوت الأصلي وقم بإعادة النشر فوراً.');

    } catch (error) {
        console.error("Erreur de migration :", error);
        await ctx.reply(`❌ حدث خطأ فادح أثناء الترحيل: ${error.message}\n\nلم يتم إجراء أي تغييرات. قاعدة البيانات لا تزال كما كانت.`);
    }
});

// رسالة افتراضية لأي أمر أو رسالة أخرى
bot.on('message', (ctx) => {
    if (String(ctx.from.id) === process.env.SUPER_ADMIN_ID) {
        ctx.reply(`أنا في وضع الترحيل. لتشغيل العملية، أرسل الأمر:\n\n/${MIGRATION_COMMAND}`);
    } else {
        ctx.reply('البوت حالياً تحت الصيانة المؤقتة.');
    }
});


// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Bot de migration en attente de commande.');
        }
    } catch (err) {
        console.error('Erreur dans le gestionnaire de webhook :', err.message);
        if (!res.headersSent) {
            res.status(500).send('Erreur interne du serveur.');
        }
    }
};
