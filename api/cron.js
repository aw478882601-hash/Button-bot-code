// =================================================================
// |   ملف المهمة المجدولة (CRON JOB) لإلغاء تثبيت التنبيهات تلقائياً    |
// =================================================================

const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
const bot = new Telegraf(process.env.BOT_TOKEN);

async function unpinInBatches(adminId, page = 0) {
    const BATCH_SIZE = 100;
    const client = await pool.connect();
    try {
        const usersResult = await client.query(
            `SELECT id, pinned_alert_id FROM public.users WHERE pinned_alert_id IS NOT NULL LIMIT $1 OFFSET $2`,
            [BATCH_SIZE, page * BATCH_SIZE]
        );

        if (usersResult.rows.length === 0) {
            if (adminId) {
                await bot.telegram.sendMessage(adminId, '✅ اكتملت عملية إلغاء تثبيت التنبيه تلقائياً من جميع المستخدمين.');
            }
            return;
        }

        for (const user of usersResult.rows) {
            try {
                await bot.telegram.unpinChatMessage(user.id, { message_id: user.pinned_alert_id });
                await client.query('UPDATE public.users SET pinned_alert_id = NULL WHERE id = $1', [user.id]);
            } catch (e) {
                await client.query('UPDATE public.users SET pinned_alert_id = NULL WHERE id = $1', [user.id]);
                console.error(`(Cron) Failed to unpin for user ${user.id}: ${e.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        unpinInBatches(adminId, page + 1);

    } finally {
        client.release();
    }
}

module.exports = async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }

    const client = await pool.connect();
    try {
        const settingsQuery = `
            SELECT id FROM public.settings
            WHERE alert_message IS NOT NULL AND alert_duration_hours IS NOT NULL
            AND (alert_message_set_at + (alert_duration_hours * INTERVAL '1 hour')) < NOW()
        `;
        const settingsResult = await client.query(settingsQuery);

        if (settingsResult.rows.length > 0) {
            console.log('Found an expired alert. Starting the unpinning process...');

            await client.query(`
                UPDATE public.settings 
                SET alert_message = NULL, alert_message_set_at = NULL, alert_duration_hours = NULL 
                WHERE id = 1
            `);

            const superAdminId = process.env.SUPER_ADMIN_ID;
            if (superAdminId) {
                await bot.telegram.sendMessage(superAdminId, '⏳ انتهت مدة صلاحية التنبيه. سأبدأ الآن بإلغاء تثبيته من المستخدمين تلقائياً.');
            }

            unpinInBatches(superAdminId, 0);

            res.status(200).send('Expired alert found. Unpinning process initiated.');
        } else {
            res.status(200).send('No expired alerts found.');
        }
    } catch (error) {
        console.error('Error in Cron Job:', error);
        res.status(500).send('Error executing cron job.');
    } finally {
        client.release();
    }
};
