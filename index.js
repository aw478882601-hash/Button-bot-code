// =================================================================
// |   ملف مخصص لترحيل البيانات القديمة وإصلاح الأسماء في الإحصائيات   |
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

function simpleHash(text) {
    let hash = 0;
    if (!text || text.length === 0) return 0;
    for (let i = 0; i < text.length; i++) {
        hash += text.charCodeAt(i);
    }
    return hash;
}

// الدالة الرئيسية التي تقوم بعملية الترحيل والإصلاح
async function runMigrationAndFixScript(ctx) {
    let reportLines = ['🚀 *بدء عملية ترحيل وإصلاح بيانات الإحصائيات...*'];
    let totalFixed = 0;
    let totalMigrated = 0;

    try {
        // --- الخطوة 1: جلب كل البيانات اللازمة ---
        reportLines.push('\n*الخطوة 1: جلب البيانات...*');
        
        // جلب كل الأزرار وبيانات الإحصائيات القديمة (إن وجدت)
        const buttonsSnapshot = await db.collection('buttons').get();
        const allButtons = {};
        buttonsSnapshot.forEach(doc => {
            allButtons[doc.id] = doc.data();
        });
        reportLines.push(`- تم العثور على *${Object.keys(allButtons).length}* زر في قاعدة البيانات.`);

        // جلب كل سجلات الإحصائيات الحالية من المستندات المقسمة
        const shardRefs = Array.from({ length: 7 }, (_, i) => db.collection('statistics').doc(`button_stats_shard_${i}`));
        const shardDocs = await db.getAll(...shardRefs);
        const allCurrentStats = {};
        shardDocs.forEach(doc => {
            if (doc.exists) {
                Object.assign(allCurrentStats, doc.data().statsMap || {});
            }
        });
        reportLines.push(`- تم العثور على *${Object.keys(allCurrentStats).length}* سجل إحصائيات حالي.`);

        // --- الخطوة 2: تحليل البيانات وتحديد التغييرات ---
        reportLines.push('\n*الخطوة 2: تحليل وتحديد التغييرات...*');
        const updatesByShard = {}; // { "0": {...}, "1": {...}, ... }

        for (const buttonId in allButtons) {
            const buttonData = allButtons[buttonId];
            const correctShardIndex = simpleHash(buttonId) % 7;

            if (!updatesByShard[correctShardIndex]) {
                updatesByShard[correctShardIndex] = {};
            }

            const currentStat = allCurrentStats[buttonId];
            const oldStat = buttonData.stats; // الإحصائيات القديمة المخزنة في الزر نفسه

            // الحالة 1: السجل غير موجود في نظام الإحصائيات الجديد
            if (!currentStat) {
                // إذا وجدنا بيانات قديمة، نقوم بترحيلها
                if (oldStat && oldStat.totalClicks > 0) {
                    updatesByShard[correctShardIndex][`statsMap.${buttonId}`] = {
                        name: buttonData.text,
                        totalClicks: oldStat.totalClicks || 0,
                        totalUsers: oldStat.totalUsers || [],
                        dailyClicks: oldStat.dailyClicks || {},
                        dailyUsers: oldStat.dailyUsers || {}
                    };
                    totalMigrated++;
                }
            } 
            // الحالة 2: السجل موجود ولكن بدون اسم (يحتاج إصلاح)
            else if (!currentStat.name) {
                updatesByShard[correctShardIndex][`statsMap.${buttonId}.name`] = buttonData.text;
                totalFixed++;
            }
        }
        
        // --- الخطوة 3: تنفيذ التحديثات على قاعدة البيانات ---
        reportLines.push('\n*الخطوة 3: كتابة التحديثات...*');
        let shardsUpdatedCount = 0;
        for (const shardIndex in updatesByShard) {
            const updates = updatesByShard[shardIndex];
            if (Object.keys(updates).length > 0) {
                const shardRef = db.collection('statistics').doc(`button_stats_shard_${shardIndex}`);
                // استخدام set مع merge لإنشاء المستند أو دمجه بأمان
                await shardRef.set({ statsMap: updates }, { merge: true });
                reportLines.push(`- ✅ تم تحديث المستند \`button_stats_shard_${shardIndex}\``);
                shardsUpdatedCount++;
            }
        }

        if (shardsUpdatedCount === 0) {
            reportLines.push('- لا توجد تغييرات مطلوبة. البيانات سليمة.');
        }

        reportLines.push(`\n\n🎉 *اكتملت العملية بنجاح!*`);
        reportLines.push(`- إجمالي السجلات التي تم ترحيلها: *${totalMigrated}*`);
        reportLines.push(`- إجمالي السجلات التي تم إصلاح أسمائها: *${totalFixed}*`);

    } catch (error) {
        console.error("Error during migration script:", error);
        reportLines.push(`\n\n❌ *حدث خطأ فادح أثناء العملية.*`);
        reportLines.push(`- ${error.message}`);
    }
    
    // إرسال التقرير النهائي للمشرف
    await ctx.telegram.sendMessage(ctx.chat.id, reportLines.join('\n'), { parse_mode: 'Markdown' });
}

// =================================================================
// |                     أوامر البوت المخصصة                         |
// =================================================================

bot.start((ctx) => {
    ctx.reply('أهلاً بك. هذا البوت مخصص لعملية ترحيل وإصلاح بيانات الإحصائيات.\n\nأرسل /startmigration لبدء العملية (للأدمن الرئيسي فقط).');
});

bot.command('startmigration', async (ctx) => {
    const userId = String(ctx.from.id);
    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    try {
        await ctx.reply('⏳ حسنًا، سأبدأ الآن عملية الترحيل والإصلاح الشاملة. هذه العملية قد تستغرق بعض الوقت... سأرسل لك تقريرًا عند الانتهاء.');
        await runMigrationAndFixScript(ctx);
    } catch (error) {
        console.error('Error triggering migration script:', error);
        await ctx.reply('❌ حدث خطأ أثناء محاولة بدء العملية.');
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
            res.status(200).send('Migration & Fix Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
