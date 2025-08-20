// =================================================================
// |   ملف مخصص لتشغيل اسكربت صيانة الإحصائيات عبر أمر من البوت      |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
if (!admin.apps.length) {
  try {
    // تأكد من أن هذه الطريقة تطابق طريقة اتصالك في البوت
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('فشل في الاتصال بـ Firebase:', error.message);
    process.exit(1);
  }
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                   اسكربت الصيانة ودواله المساعدة                 |
// =================================================================

// دالة لتحويل نص ID الزر إلى رقم ثابت لاستخدامه في التوزيع
function simpleHash(text) {
    let hash = 0;
    if (!text || text.length === 0) return 0;
    for (let i = 0; i < text.length; i++) {
        hash += text.charCodeAt(i);
    }
    return hash;
}

// دالة لتحديد مرجع مستند الإحصائيات (الشارد) الصحيح لأي زر
function getShardDocRef(buttonId) {
    const shardIndex = simpleHash(String(buttonId)) % 7; // نقسم على 7 مستندات
    return db.collection('statistics').doc(`button_stats_shard_${shardIndex}`);
}

// الدالة الرئيسية التي تقوم بعملية الإصلاح
async function runFixStatsScript(ctx) {
    let reportLines = ['🚀 *بدء عملية فحص وتصحيح أسماء الأزرار...*'];
    let totalFixed = 0;

    try {
        // المرور على كل مستندات الإحصائيات السبعة
        for (let i = 0; i < 7; i++) {
            const shardName = `button_stats_shard_${i}`;
            const shardRef = db.collection('statistics').doc(shardName);
            
            reportLines.push(`\n🔍 *جاري فحص المستند:* \`${shardName}\``);
            
            const shardDoc = await shardRef.get();
            if (!shardDoc.exists) {
                reportLines.push(`- المستند غير موجود، تم تخطيه.`);
                continue;
            }

            const statsMap = shardDoc.data().statsMap || {};
            const updates = {}; // كائن لتجميع كل التحديثات المطلوبة لهذا المستند
            
            // المرور على كل سجلات الأزرار داخل المستند
            for (const buttonId in statsMap) {
                const buttonStats = statsMap[buttonId];

                // التحقق مما إذا كان الاسم مفقودًا
                if (!buttonStats.name) {
                    const buttonRef = db.collection('buttons').doc(buttonId);
                    const buttonDoc = await buttonRef.get();

                    if (buttonDoc.exists) {
                        const correctName = buttonDoc.data().text;
                        updates[`statsMap.${buttonId}.name`] = correctName;
                        totalFixed++;
                    } else {
                        updates[`statsMap.${buttonId}.name`] = 'زر محذوف';
                    }
                }
            }

            // إذا وجدنا تحديثات، قم بتنفيذها دفعة واحدة على المستند
            if (Object.keys(updates).length > 0) {
                await shardRef.update(updates);
                reportLines.push(`- ✅ تم إصلاح *${Object.keys(updates).length}* سجل.`);
            } else {
                reportLines.push(`- لا توجد أسماء مفقودة هنا.`);
            }
        }

        reportLines.push(`\n\n🎉 *اكتملت عملية الصيانة!*`);
        reportLines.push(`- إجمالي السجلات التي تم إصلاحها: *${totalFixed}*`);

    } catch (error) {
        console.error("Error during fix stats script:", error);
        reportLines.push(`\n\n❌ *حدث خطأ فادح أثناء العملية.*`);
        reportLines.push(`- تم إبلاغ المطور.`);
    }
    
    // إرسال التقرير النهائي للمشرف الذي طلب العملية
    await ctx.telegram.sendMessage(ctx.chat.id, reportLines.join('\n'), { parse_mode: 'Markdown' });
}

// =================================================================
// |                     أوامر البوت المخصصة                         |
// =================================================================

// أمر /start لتعريف البوت
bot.start((ctx) => {
    ctx.reply('أهلاً بك. هذا البوت مخصص لتنفيذ اسكربت صيانة قاعدة البيانات.\n\nأرسل /fixstats لبدء العملية (للأدمن الرئيسي فقط).');
});

// الأمر الرئيسي لتشغيل الاسكربت
bot.command('fixstats', async (ctx) => {
    const userId = String(ctx.from.id);
    // تأكد من أن المستخدم هو الأدمن الرئيسي
    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    try {
        await ctx.reply('⏳ حسنًا، سأبدأ الآن عملية الإصلاح. قد تستغرق هذه العملية بعض الوقت... سأرسل لك تقريرًا عند الانتهاء.');
        // تشغيل الاسكربت
        await runFixStatsScript(ctx);
    } catch (error) {
        console.error('Error triggering fix stats script:', error);
        await ctx.reply('❌ حدث خطأ أثناء محاولة بدء عملية الصيانة.');
    }
});

// =================================================================
// |                      Vercel Webhook Setup                      |
// =================================================================

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Maintenance Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
