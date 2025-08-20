// =================================================================
// |   TELEGRAM FIREBASE BOT - SCRIPT DE MIGRATION DÉFINITIF (V4)   |
// |   Ce script corrige la logique de recherche pour les enfants de la racine. |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
try {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
} catch (error) {
    console.error('Erreur d\'initialisation de Firebase Admin:', error.message);
    process.exit(1);
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
if (!process.env.BOT_TOKEN) {
    console.error('BOT_TOKEN n\'est pas défini !');
    process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 4. تعريف الأمر السري والآمن لعملية الترحيل ---
const MIGRATION_COMMAND = 'run_definitive_migration_v4';

bot.command(MIGRATION_COMMAND, async (ctx) => {
    const userId = String(ctx.from.id);

    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمطور فقط.');
    }

    await ctx.reply('🚀 حسنًا! سأبدأ عملية الترحيل النهائية بالمنطق المؤكد (V4).');
    console.log('--- Starting Definitive Migration (V4) ---');

    try {
        const allButtonsSnapshot = await db.collection('buttons').get();
        if (allButtonsSnapshot.empty) {
            return ctx.reply('ℹ️ قاعدة بيانات الأزرار فارغة.');
        }

        const batch = db.batch();
        let processedCount = 0;

        for (const buttonDoc of allButtonsSnapshot.docs) {
            const buttonId = buttonDoc.id;
            const buttonData = buttonDoc.data();
            
            // ========================= LOGIC FIX V4 =========================
            //  This is the corrected logic. It correctly determines the
            //  `parentId` to search for in the children documents.
            let pathForChildren;
            if (buttonData.parentId === 'root') {
                // For a root button, its children have a parentId of 'root/buttonId'
                pathForChildren = `root/${buttonId}`;
            } else {
                // For any other button, its children have a parentId of 'parentPath/buttonId'
                pathForChildren = `${buttonData.parentId}/${buttonId}`;
            }
            console.log(`Processing button '${buttonData.text}'. Searching for children with parentId: '${pathForChildren}'`);
            // ================================================================

            const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
            const embeddedMessages = messages.docs.map(doc => {
                const { buttonId, ...messageData } = doc.data();
                return messageData;
            });

            const subButtonsSnapshot = await db.collection('buttons').where('parentId', '==', pathForChildren).orderBy('order').get();
            const embeddedSubButtons = subButtonsSnapshot.docs.map(doc => {
                const subBtnData = doc.data();
                return {
                    buttonId: doc.id, text: subBtnData.text,
                    isFullWidth: subBtnData.isFullWidth, order: subBtnData.order
                };
            });
            
            const updatePayload = {
                hasMessages: embeddedMessages.length > 0,
                hasSubButtons: embeddedSubButtons.length > 0,
                messages: embeddedMessages,
                subButtons: embeddedSubButtons
            };
            
            batch.update(buttonDoc.ref, updatePayload);
            processedCount++;
        }

        await batch.commit();

        console.log('--- Definitive Migration (V4) Completed Successfully ---');
        await ctx.reply(`✅🎉 اكتملت عملية الترحيل المؤكدة بنجاح لـ ${processedCount} زر!`);
        await ctx.reply('‼️ مهم جداً: لقد تم تحديث قاعدة بياناتك. أعد الآن كود البوت الأصلي والوظيفي وقم بإعادة النشر فوراً.');

    } catch (error) {
        console.error("Erreur de migration (V4):", error);
        await ctx.reply(`❌ حدث خطأ فادح أثناء الترحيل: ${error.message}\n\nلم يتم إجراء أي تغييرات.`);
    }
});

// رسالة افتراضية لأي أمر أو رسالة أخرى
bot.on('message', (ctx) => {
    if (String(ctx.from.id) === process.env.SUPER_ADMIN_ID) {
        ctx.reply(`أنا في وضع الترحيل النهائي (V4). لتشغيل العملية، أرسل الأمر:\n\n/${MIGRATION_COMMAND}`);
    } else {
        ctx.reply('البوت حالياً تحت الصيانة المؤقتة.');
    }
});

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (err) {
        console.error('Erreur dans le gestionnaire de webhook :', err.message);
    } finally {
        if (!res.headersSent) {
            res.status(200).send('OK');
        }
    }
};
