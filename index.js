// =================================================================
// |   ملف مخصص لإنشاء collection جديد (buttons_v2) بالهيكل الشامل   |
// |      (يدمج الرسائل، الأبناء، الإحصائيات القديمة، والحقول الجديدة)     |
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
// |                   اسكربت الترقية ودواله المساعدة                 |
// =================================================================

async function runSafeUpgradeScript(ctx) {
    let reportLines = ['🚀 *بدء عملية إنشاء `buttons_v2` بالهيكل الشامل...*'];
    
    try {
        const batch = db.batch();

        // --- الخطوة 1: جلب كل البيانات من المصادر القديمة ---
        reportLines.push('\n*الخطوة 1: جلب كل الأزرار والرسائل الأصلية...*');
        const buttonsSnapshot = await db.collection('buttons').get();
        const messagesSnapshot = await db.collection('messages').get();

        const allButtons = {};
        buttonsSnapshot.forEach(doc => {
            allButtons[doc.id] = doc.data();
        });
        reportLines.push(`- تم العثور على *${buttonsSnapshot.size}* زر.`);

        const messagesByButton = {};
        messagesSnapshot.forEach(doc => {
            const message = doc.data();
            if (!messagesByButton[message.buttonId]) {
                messagesByButton[message.buttonId] = [];
            }
            const { buttonId, ...messageData } = message;
            messagesByButton[message.buttonId].push(messageData);
        });
        reportLines.push(`- تم العثور على *${messagesSnapshot.size}* رسالة سيتم دمجها.`);

        // --- الخطوة 2: بناء الهيكل الجديد وتجهيز عمليات الكتابة ---
        reportLines.push('\n*الخطوة 2: بناء الهيكل الجديد...*');
        
        for (const buttonId in allButtons) {
            const buttonData = allButtons[buttonId];
            
            const embeddedMessages = messagesByButton[buttonId] || [];
            embeddedMessages.sort((a, b) => (a.order || 0) - (b.order || 0));

            const children = [];
            for (const childId in allButtons) {
                if (allButtons[childId].parentId === buttonId) {
                    children.push({
                        id: childId,
                        text: allButtons[childId].text,
                        order: allButtons[childId].order || 0
                    });
                }
            }
            children.sort((a, b) => a.order - b.order);

            // تجهيز المستند الجديد بالكامل
            const newButtonDocument = {
                ...buttonData, // *** هذا السطر ينسخ كل بيانات الزر القديمة بما فيها كائن "stats" إن وجد ***
                messages: embeddedMessages,
                children: children,
                hasMessages: embeddedMessages.length > 0,
                hasChildren: children.length > 0
            };

            const newDocRef = db.collection('buttons_v2').doc(buttonId);
            batch.set(newDocRef, newButtonDocument);
        }

        // --- الخطوة 3: تنفيذ إنشاء collection جديد دفعة واحدة ---
        reportLines.push('\n*الخطوة 3: كتابة البيانات في `buttons_v2`...*');
        await batch.commit();
        reportLines.push('- ✅ تم إنشاء جميع المستندات في `buttons_v2` بنجاح.');

        reportLines.push(`\n\n🎉 *اكتملت عملية إنشاء collection جديد بنجاح!*`);
        reportLines.push(`- تم نقل جميع البيانات القديمة بما فيها الإحصائيات التاريخية.`);
        reportLines.push(`- اطلب الآن الخطوة الثانية (الكود الجديد للبوت).`);

    } catch (error) {
        console.error("Error during safe upgrade script:", error);
        reportLines.push(`\n\n❌ *حدث خطأ فادح أثناء العملية.*`);
        reportLines.push(`- ${error.message}`);
    }
    
    await ctx.telegram.sendMessage(ctx.chat.id, reportLines.join('\n'), { parse_mode: 'Markdown' });
}

// =================================================================
// |                     أوامر البوت المخصصة                         |
// =================================================================

bot.start((ctx) => {
    ctx.reply('أهلاً بك. هذا البوت مخصص لإنشاء collection جديد `buttons_v2` بالهيكل الشامل.\n\nأرسل /createv2 لبدء العملية (للأدمن الرئيسي فقط).');
});

bot.command('createv2', async (ctx) => {
    const userId = String(ctx.from.id);
    if (userId !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    try {
        await ctx.reply('⏳ حسنًا، سأبدأ الآن عملية إنشاء `buttons_v2`. سيتم نسخ وهيكلة جميع البيانات... سأرسل لك تقريرًا عند الانتهاء.');
        await runSafeUpgradeScript(ctx);
    } catch (error) {
        console.error('Error triggering v2 creation script:', error);
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
            res.status(200).send('DB v2 Creation Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
