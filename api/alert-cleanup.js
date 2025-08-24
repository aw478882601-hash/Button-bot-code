// =================================================================
// |   TELEGRAM BOT - SELF-TRIGGERING BATCH JOB FOR UNPINNING      |
// =================================================================

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- الدالة الرئيسية التي سيتم تشغيلها ---
module.exports = async (request, response) => {
    const client = await pool.connect();
    try {
        console.log("Task Runner: Checking for expired alerts.");

        // 1. جلب إعدادات التنبيه
        const settingsResult = await client.query(
            `SELECT alert_message_set_at, alert_duration_hours FROM public.settings 
             WHERE id = 1 AND alert_message_set_at IS NOT NULL AND alert_duration_hours IS NOT NULL`
        );

        if (settingsResult.rows.length === 0) {
            return response.status(200).json({ status: 'complete', message: 'No active alert to process.' });
        }

        const alert = settingsResult.rows[0];
        const alertSetAt = new Date(alert.alert_message_set_at);
        const expiresAt = new Date(alertSetAt.getTime() + alert.alert_duration_hours * 60 * 60 * 1000);

        if (new Date() < expiresAt) {
            return response.status(200).json({ status: 'skipped', message: 'Alert has not expired yet.' });
        }
        
        // 2. جلب دفعة من 100 مستخدم
        const usersToProcess = await client.query(
            'SELECT id, chat_id FROM public.users WHERE pinned_alert_message_id IS NOT NULL LIMIT 100'
        );

        // 3. إذا لم يعد هناك مستخدمون، نظّف الإعدادات وأنهِ السلسلة
        if (usersToProcess.rows.length === 0) {
            console.log("All pinned messages processed. Cleaning up settings.");
            await client.query('UPDATE public.settings SET alert_message = NULL, alert_message_set_at = NULL, alert_duration_hours = NULL WHERE id = 1');
            // إرسال رد نهائي ناجح
            return response.status(200).json({ status: 'complete', message: 'All users processed. Alert settings cleared.' });
        }

        console.log(`Processing a batch of ${usersToProcess.rows.length} users.`);
        let unpinnedCount = 0;

        // 4. معالجة الدفعة الحالية
        for (const user of usersToProcess.rows) {
            try {
                await bot.telegram.unpinChatMessage(user.chat_id);
                unpinnedCount++;
            } catch (error) {
                console.error(`Failed to unpin for user ${user.id}: ${error.message}`);
            } finally {
                await client.query('UPDATE public.users SET pinned_alert_message_id = NULL WHERE id = $1', [user.id]);
            }
        }
        
        // 5. ✨ المنطق الجديد: التحقق إذا كان هناك المزيد من المستخدمين
        // إذا قمنا بمعالجة 100، فهذا يعني أنه من المحتمل وجود دفعة أخرى
        if (usersToProcess.rows.length === 100) {
            console.log("More users likely exist, triggering next batch...");
            
            // قم باستدعاء نفس الرابط مرة أخرى لبدء معالجة الدفعة التالية فورًا
            // لا نستخدم await هنا لننهي الطلب الحالي بسرعة ونحرر الموارد
            fetch(`${process.env.BASE_URL}/api/alert-cleanup`);

            // إرسال رد "تم القبول" للإشارة إلى أن العملية مستمرة في الخلفية
            return response.status(202).json({ status: 'in-progress', message: 'Batch processed, next batch triggered.' });
        } else {
            // هذه كانت آخر دفعة، قم بتنظيف الإعدادات الآن
            console.log("Final batch processed. Cleaning up settings.");
            await client.query('UPDATE public.settings SET alert_message = NULL, alert_message_set_at = NULL, alert_duration_hours = NULL WHERE id = 1');
            return response.status(200).json({ status: 'complete', message: `Final batch of ${unpinnedCount} processed.` });
        }

    } catch (error) {
        console.error('Error in task runner:', error);
        return response.status(500).json({ status: 'error', message: 'Internal Server Error' });
    } finally {
        client.release();
    }
};
