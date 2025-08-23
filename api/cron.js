// =================================================================
// |   ملف المهمة المجدولة (CRON JOB) لإلغاء تثبيت التنبيهات تلقائياً    |
// =================================================================

// --- 1. استدعاء المكتبات ---
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

// --- 2. تهيئة الاتصال بقاعدة البيانات والبوت ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
const bot = new Telegraf(process.env.BOT_TOKEN);

/**
 * دالة تقوم بإلغاء تثبيت الرسائل على دفعات لتجنب المشاكل مع الأعداد الكبيرة من المستخدمين.
 * @param {string} adminId - ID المشرف الذي سيتم إبلاغه عند اكتمال العملية.
 * @param {number} page - رقم الدفعة الحالية (يبدأ من 0).
 */
async function unpinInBatches(adminId, page = 0) {
    const BATCH_SIZE = 100; // عدد المستخدمين في كل دفعة
    const client = await pool.connect();
    try {
        // جلب دفعة من المستخدمين الذين لديهم رسالة تنبيه مثبتة
        const usersResult = await client.query(
            `SELECT id, pinned_alert_id FROM public.users WHERE pinned_alert_id IS NOT NULL LIMIT $1 OFFSET $2`,
            [BATCH_SIZE, page * BATCH_SIZE]
        );

        // إذا لم يتم العثور على المزيد من المستخدمين، تكون العملية قد انتهت
        if (usersResult.rows.length === 0) {
            if (adminId) {
                await bot.telegram.sendMessage(adminId, '✅ اكتملت عملية إلغاء تثبيت التنبيه تلقائياً من جميع المستخدمين.');
            }
            console.log("Unpinning process completed successfully.");
            return;
        }

        // المرور على مستخدمي الدفعة الحالية وإلغاء تثبيت الرسالة لكل منهم
        for (const user of usersResult.rows) {
            try {
                await bot.telegram.unpinChatMessage(user.id, { message_id: user.pinned_alert_id });
                // بعد إلغاء التثبيت بنجاح، قم بحذف الـ ID من قاعدة البيانات لتنظيفها
                await client.query('UPDATE public.users SET pinned_alert_id = NULL WHERE id = $1', [user.id]);
            } catch (e) {
                // إذا فشل (مثلاً المستخدم حظر البوت)، فقط تجاهل الخطأ وامسح الـ ID
                await client.query('UPDATE public.users SET pinned_alert_id = NULL WHERE id = $1', [user.id]);
                console.error(`(Cron) Failed to unpin for user ${user.id}: ${e.message}`);
            }
            // تأخير بسيط بين كل طلب وآخر لتجنب إغراق واجهة تيليجرام
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // استدعاء الدالة نفسها لمعالجة الدفعة التالية
        unpinInBatches(adminId, page + 1);

    } finally {
        client.release();
    }
}

/**
 * الدالة الرئيسية التي سيتم استدعاؤها بواسطة خدمة Cron الخارجية (مثل UptimeRobot).
 */
module.exports = async (req, res) => {
    // الخطوة 1: التحقق من وجود كلمة السر في الرابط
    const { secret } = req.query;
    if (secret !== process.env.CRON_SECRET) {
        // إذا كانت كلمة السر غير صحيحة، يتم رفض الطلب
        return res.status(401).send('Unauthorized');
    }

    const client = await pool.connect();
    try {
        // الخطوة 2: البحث عن تنبيه نشط انتهت مدته
        const settingsQuery = `
            SELECT id FROM public.settings
            WHERE alert_message IS NOT NULL AND alert_duration_hours IS NOT NULL
            AND (alert_message_set_at + (alert_duration_hours * INTERVAL '1 hour')) < NOW()
        `;
        const settingsResult = await client.query(settingsQuery);

        // الخطوة 3: إذا تم العثور على تنبيه منتهي الصلاحية
        if (settingsResult.rows.length > 0) {
            console.log('Found an expired alert. Starting the unpinning process...');
            
            // تحديث قاعدة البيانات فوراً لمنع تشغيل المهمة مرة أخرى على نفس التنبيه
            await client.query(`
                UPDATE public.settings 
                SET alert_message = NULL, alert_message_set_at = NULL, alert_duration_hours = NULL 
                WHERE id = 1
            `);

            // إبلاغ المشرف الرئيسي بأن العملية ستبدأ
            const superAdminId = process.env.SUPER_ADMIN_ID;
            if (superAdminId) {
                await bot.telegram.sendMessage(superAdminId, '⏳ انتهت مدة صلاحية التنبيه. سأبدأ الآن بإلغاء تثبيته من المستخدمين تلقائياً.');
            }
            
            // بدء عملية إلغاء التثبيت الفعلية على دفعات
            unpinInBatches(superAdminId, 0);

            res.status(200).send('Expired alert found. Unpinning process initiated.');
        } else {
            // إذا لم يتم العثور على تنبيهات منتهية، لا تفعل شيئًا
            res.status(200).send('No expired alerts found.');
        }
    } catch (error) {
        console.error('Error in Cron Job:', error);
        res.status(500).send('Error executing cron job.');
    } finally {
        client.release();
    }
};
