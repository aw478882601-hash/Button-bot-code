// =================================================================
// |   ملف مخصص لمسح وإعادة بناء قاعدة بيانات الإحصائيات بالكامل     |
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

// الدالة الرئيسية التي تقوم بعملية المسح وإعادة البناء
async function runResetAndRebuildScript(ctx) {
    let reportLines = ['🚀 *بدء عملية مسح وإعادة بناء الإحصائيات...*'];
    
    try {
        // --- الخطوة 1: مسح جميع سجلات الإحصائيات الحالية ---
        reportLines.push('\n*الخطوة 1: جاري مسح البيانات القديمة...*');
        const batchDelete = db.batch();
        for (let i = 0; i < 7; i++) {
            const shardRef = db.collection('statistics').doc(`button_stats_shard_${i}`);
            batchDelete.delete(shardRef);
        }
        await batchDelete.commit();
        reportLines.push('- ✅ تم مسح جميع المستندات السبعة بنجاح.');

        // --- الخطوة 2: جلب كل الأزرار لإعادة بناء الإحصائيات ---
        reportLines.push('\n*الخطوة 2: جاري جلب قائمة الأزرار...*');
        const buttonsSnapshot = await db.collection('buttons').get();
        const allButtons = {};
        buttonsSnapshot.forEach(doc => {
            allButtons[doc.id] = doc.data();
        });
        reportLines.push(`- تم العثور على *${Object.keys(allButtons).length}* زر لإعادة بناء إحصائياته.`);

        // --- الخطوة 3: تجميع سجلات الإحصائيات الجديدة ---
        reportLines.push('\n*الخطوة 3: جاري تجميع الإحصائيات الجديدة...*');
        const updatesByShard = {};
        let totalRebuilt = 0;

        for (const buttonId in allButtons) {
            const buttonData = allButtons[buttonId];
            const correctShardIndex = simpleHash(buttonId) % 7;

            if (!updatesByShard[correctShardIndex]) {
                updatesByShard[correctShardIndex] = {};
            }

            const oldStat = buttonData.stats; // البيانات القديمة جدًا
            let newStatRecord;

            // إذا وجدنا بيانات تاريخية، نستخدمها
            if (oldStat) {
                newStatRecord = {
                    name: buttonData.text,
                    totalClicks: oldStat.totalClicks || 0,
                    totalUsers: oldStat.totalUsers || [],
                    dailyClicks: oldStat.dailyClicks || {},
                    dailyUsers: oldStat.dailyUsers || {}
                };
            } 
            // إذا لم توجد، ننشئ سجلاً نظيفًا
            else {
                newStatRecord = {
                    name: buttonData.text,
                    totalClicks: 0,
                    totalUsers: [],
                    dailyClicks: {},
                    dailyUsers: {}
                };
            }
            updatesByShard[correctShardIndex][`statsMap.${buttonId}`] = newStatRecord;
            totalRebuilt++;
        }

        // --- الخطوة 4: كتابة البيانات الجديدة في المستندات ---
        reportLines.push('\n*الخطوة 4: جاري كتابة البيانات الجديدة...*');
        const batchWrite = db.batch();
        for (const shardIndex in updatesByShard) {
            const updates = updatesByShard[shardIndex];
            if (Object.keys(updates).length > 0) {
                const shardRef = db.collection('statistics').doc(`button_stats_shard_${shardIndex}`);
                // نستخدم set هنا لأننا نعيد كتابة المستند بالكامل
                batchWrite.set(shardRef, { statsMap: updates });
            }
        }
        await batchWrite.commit();
        reportLines.push('- ✅ تم كتابة جميع السجلات الجديدة بنجاح.');


        reportLines.push(`\n\n🎉 *اكتملت عملية إعادة البناء بنجاح!*`);
        reportLines.push(`- إجمالي السجلات التي تم إنشاؤها: *${totalRebuilt}*`);

    } catch (error) {
        console.error("Error during reset and rebuild script:", error);
        reportLines.push(`\n\n❌ *حدث خطأ فادح أثناء العملية.*`);
        reportLines.push(`- ${error.message}`);
    }
    
    await ctx.telegram.sendMessage(ctx.chat.id, reportLines.join('\n'), { parse_mode: 'Markdown' });
}

// =================================================================
// |                     أوامر البوت المخصصة                         |
// =================================================================

bot.start((ctx) => {
    ctx.reply('أهلاً بك. هذا البوت مخصص لمسح وإعادة بناء قاعدة بيانات الإحصائيات.\n\n⚠️ تحذير: هذا الأمر سيحذف كل الإحصائيات الحالية ويعيد بناءها.\n\nللتأكيد، أرسل الأمر: `/resetstats I_AM_SURE`');
});

// الأمر الرئيسي لتشغيل الاسكربت
bot.command('resetstats', async (ctx) => {
    const userId = String(ctx.from.id);
    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    // التحقق من وجود كلمة التأكيد
    if (!ctx.message.text.includes('I_AM_SURE')) {
        return ctx.reply('❌ لم يتم تأكيد الأمر. لتأكيد الحذف وإعادة البناء، يرجى إرسال الأمر كاملاً:\n`/resetstats I_AM_SURE`');
    }

    try {
        await ctx.reply('✅ تم استلام التأكيد. سأبدأ الآن عملية المسح وإعادة البناء الشاملة. هذه العملية لا يمكن التراجع عنها... سأرسل لك تقريرًا عند الانتهاء.');
        await runResetAndRebuildScript(ctx);
    } catch (error) {
        console.error('Error triggering reset script:', error);
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
            res.status(200).send('Reset & Rebuild Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
