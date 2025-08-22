// =================================================================
// |   TELEGRAM SUPABASE BOT - V56 - FINAL VERSION                 |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

// --- 2. تهيئة Pooler الاتصال بـ Supabase ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                         Helper Functions (دوال مساعدة)                      |
// =================================================================

// دالة لجلب اتصال من الـ Pooler
async function getClient() {
    try {
        return await pool.connect();
    } catch (error) {
        console.error('Failed to get a client from the pool:', error);
        throw error;
    }
}
// دالة مساعدة للحصول على ID المصدر سواء كان مستخدم، بوت، قناة، أو جروب
function getSourceId(ctx) {
    if (ctx.message.forward_from) { // Forwarded from a user or bot
        return String(ctx.message.forward_from.id);
    }
    if (ctx.message.forward_from_chat) { // Forwarded from a channel or group
        return String(ctx.message.forward_from_chat.id);
    }
    return null;
}

// دالة لتحديث حالة المستخدم وبياناته
// دالة لتحديث حالة المستخدم وبياناته (النسخة النهائية والمحسّنة)
async function updateUserState(userId, updates) {
    const client = await getClient();
    try {
        const fieldsToUpdate = [];
        const values = [];
        let paramIndex = 1;

        // خريطة لربط أسماء الحقول في الكود بأسمائها في قاعدة البيانات
        const keyMapping = {
            state: 'state',
            stateData: 'state_data',
            currentPath: 'current_path'
        };

        for (const key in updates) {
            if (Object.prototype.hasOwnProperty.call(updates, key) && keyMapping[key]) {
                const dbKey = keyMapping[key];
                fieldsToUpdate.push(`${dbKey} = $${paramIndex++}`);
                
                if (key === 'stateData') {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        }

        if (fieldsToUpdate.length === 0) {
            return; // لا يوجد شيء لتحديثه
        }

        values.push(userId); // لإضافته في جملة WHERE
        const query = `UPDATE public.users SET ${fieldsToUpdate.join(', ')} WHERE id = $${paramIndex}`;
        
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// دالة لتتبع الرسائل المرسلة للمستخدم في وضع التعديل
async function trackSentMessages(userId, messageIds) {
    const client = await getClient();
    try {
        await client.query('UPDATE public.users SET state_data = state_data || $1 WHERE id = $2', [JSON.stringify({ messageViewIds: messageIds }), userId]);
    } finally {
        client.release();
    }
}

// دالة لتجميع ومعالجة إحصائيات الأزرار (تم التحديث)
// دالة لتجميع ومعالجة إحصائيات الأزرار (تم التحديث لتدعم الفترات الزمنية)
// دالة لتجميع ومعالجة إحصائيات الأزرار (تم التحديث لتدعم الفترات الزمنية وتوقيت مصر)
// دالة لتجميع ومعالجة إحصائيات الأزرار (تم إصلاح توقيت اليوم)
async function processAndFormatTopButtons(interval) {
    const client = await getClient();
    try {
        let title = '';
        let query;

        // جزء ثابت لجلب إحصائيات اليوم المباشرة (من السجل الخام)
        const dailyLiveQueryPart = `
            SELECT b.id, b.text, COUNT(l.id) as clicks, COUNT(DISTINCT l.user_id) as users
            FROM public.buttons b
            JOIN public.button_clicks_log l ON b.id = l.button_id
            -- الشرط الأساسي: فلترة بيانات اليوم فقط
            WHERE (l.clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
            GROUP BY b.id, b.text
        `;
        
        // جزء ثابت لجلب إحصائيات اليوم المؤرشفة (في حالة الأرشفة اليدوية الخاطئة)
        const dailyArchivedQueryPart = `
            SELECT b.id, b.text, s.total_clicks as clicks, s.unique_users_count as users
            FROM public.buttons b
            JOIN public.daily_button_stats s ON b.id = s.button_id
            WHERE s.click_date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
        `;

        if (interval === 'daily') {
            title = '*🏆 الأكثر استخداماً (اليوم):*';
            // نجمع بين السجل المباشر والأرشيف لبيانات اليوم فقط
            query = `
                WITH combined_today AS (
                    ${dailyLiveQueryPart}
                    UNION ALL
                    ${dailyArchivedQueryPart}
                )
                SELECT text, SUM(clicks)::integer as clicks_count, SUM(users)::integer as unique_users
                FROM combined_today
                GROUP BY text ORDER BY clicks_count DESC LIMIT 10;
            `;
        } else { // الأسبوعي والكلي
            let dateFilter = '';
            if (interval === 'weekly') {
                title = '*🏆 الأكثر استخداماً (أسبوعياً):*';
                // الفلترة هنا تستبعد اليوم الحالي لأنه سيُضاف من السجل المباشر
                dateFilter = `WHERE s.click_date >= date_trunc('week', now() AT TIME ZONE 'Africa/Cairo') AND s.click_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date`;
            } else {
                title = '*🏆 الأكثر استخداماً (الكلي):*';
                 dateFilter = `WHERE s.click_date < (NOW() AT TIME ZONE 'Africa/Cairo')::date`;
            }

            query = `
                WITH combined_stats AS (
                    -- الأرشيف التاريخي (بدون اليوم)
                    SELECT b.id, b.text, SUM(s.total_clicks) as clicks, SUM(s.unique_users_count) as users
                    FROM public.buttons b JOIN public.daily_button_stats s ON b.id = s.button_id
                    ${dateFilter}
                    GROUP BY b.id, b.text
                    UNION ALL
                    -- بيانات اليوم الكاملة (مباشر + مؤرشف)
                    ${dailyLiveQueryPart}
                    UNION ALL
                    ${dailyArchivedQueryPart}
                )
                SELECT text, SUM(clicks)::integer as clicks_count, SUM(users)::integer as unique_users
                FROM combined_stats
                GROUP BY text ORDER BY clicks_count DESC LIMIT 10;
            `;
        }

        const { rows } = await client.query(query);

        if (rows.length === 0) return `${title}\nلا توجد بيانات لعرضها.`;
        
        const formattedRows = rows.map((row, index) =>
            `${index + 1}. *${row.text}*\n   - 🖱️ الضغطات: \`${row.clicks_count}\`\n   - 👤 المستخدمون: \`${row.unique_users || 0}\``
        ).join('\n\n');

        return `${title}\n${formattedRows}`;
    } finally {
        client.release();
    }
}

// دالة لتحديث عرض المشرف (حذف الرسائل وإعادة إرسالها)
async function refreshAdminView(ctx, userId, buttonId, confirmationMessage = '✅ تم تحديث العرض.') {
    const client = await getClient();
    try {
        const userResult = await client.query('SELECT state_data FROM public.users WHERE id = $1', [userId]);
        const messageIdsToDelete = userResult.rows[0]?.state_data?.messageViewIds || [];
        for (const msgId of messageIdsToDelete) {
            await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
        }
        await sendButtonMessages(ctx, buttonId, true);
        await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } finally {
        client.release();
    }
}
// دالة جديدة مخصصة فقط لتحديث لوحة المفاتيح
async function refreshKeyboardView(ctx, userId, confirmationMessage) {
    try {
        await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } catch (error) {
        console.error('Error refreshing keyboard view:', error);
    }
}
async function generateKeyboard(userId) {
  const client = await getClient();
  try {
    const userResult = await client.query('SELECT is_admin, current_path, state, state_data FROM public.users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return [[]];
    const { is_admin: isAdmin, current_path: currentPath, state } = userResult.rows[0];
    let keyboardRows = [];

    // --- لوحات المفاتيح الخاصة بالحالات ---
    if (state === 'DYNAMIC_TRANSFER') {
        return [['✅ إنهاء وإضافة الكل', '❌ إلغاء العملية']];
    }
    if (state === 'AWAITING_BULK_MESSAGES') {
        return [['✅ إنهاء الإضافة']];
    }
    if (isAdmin && state === 'AWAITING_DESTINATION_PATH') {
        keyboardRows.unshift(['✅ النقل إلى هنا', '❌ إلغاء النقل']);
    }
    
    // --- لوحة مفاتيح قسم الإشراف ---
    if (currentPath === 'supervision') {
        keyboardRows = [
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
            ['🚫 قائمة المحظورين'],
            ['🔙 رجوع', '🔝 القائمة الرئيسية']
        ];
        return keyboardRows;
    }

    // --- بناء لوحة المفاتيح الرئيسية ---
    let buttonsToRender;
    let query, values;
    if (currentPath === 'root') {
        query = 'SELECT id, text, "order", is_full_width, admin_only FROM public.buttons WHERE parent_id IS NULL ORDER BY "order"';
        values = [];
    } else {
        const parentId = currentPath.split('/').pop();
        query = 'SELECT id, text, "order", is_full_width, admin_only FROM public.buttons WHERE parent_id = $1 ORDER BY "order"';
        values = [parentId];
    }
    const buttonsResult = await client.query(query, values);
    buttonsToRender = buttonsResult.rows;
    
    let currentRow = [];
    buttonsToRender.forEach(button => {
        if (!button.admin_only || isAdmin) {
            if (button.is_full_width) {
                if (currentRow.length > 0) keyboardRows.push(currentRow);
                keyboardRows.push([button.text]);
                currentRow = [];
            } else {
                currentRow.push(button.text);
                if (currentRow.length === 2) {
                    keyboardRows.push(currentRow);
                    currentRow = [];
                }
            }
        }
    });

    if (currentRow.length > 0) keyboardRows.push(currentRow);

    // --- إضافة أزرار الإدارة ---
    if (isAdmin) {
        const adminActionRow = [];
        if (state === 'EDITING_BUTTONS') { 
            adminActionRow.push('➕ إضافة زر'); 
            adminActionRow.push('✂️ نقل زر');
            adminActionRow.push('📥 نقل البيانات'); // الزر الجديد
        }
        if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
            adminActionRow.push('➕ إضافة رسالة');
        }
        if (adminActionRow.length > 0) keyboardRows.push(adminActionRow);
    }
    
    if (currentPath !== 'root') {
        keyboardRows.push(['🔙 رجوع', '🔝 القائمة الرئيسية']);
    }

    if (isAdmin) {
        const editContentText = state === 'EDITING_CONTENT' ? '🚫 إلغاء تعديل المحتوى' : '📄 تعديل المحتوى';
        const editButtonsText = state === 'EDITING_BUTTONS' ? '🚫 إلغاء تعديل الأزرار' : '✏️ تعديل الأزرار';
        keyboardRows.push([editButtonsText, editContentText]);
    }

    const finalRow = [];
    finalRow.push('💬 التواصل مع الأدمن');
    if (isAdmin && currentPath === 'root') {
        finalRow.push('👑 الإشراف');
    }
    keyboardRows.push(finalRow);

    return keyboardRows;
  } catch (error) {
    console.error('Error generating keyboard:', error);
    return [['حدث خطأ في عرض الأزرار']];
  } finally {
    client.release();
  }
}

// دالة لإرسال رسائل الزر (نسخة معدّلة)
async function sendButtonMessages(ctx, buttonId, inEditMode = false) {
    const client = await getClient();
    try {
        const messagesResult = await client.query('SELECT id, type, content, caption, entities, "order" FROM public.messages WHERE button_id = $1 ORDER BY "order"', [buttonId]);
        const messages = messagesResult.rows;

        if (messages.length === 0 && inEditMode) {
            if (ctx.from) await trackSentMessages(String(ctx.from.id), []);
            return 0;
        }
        
        const sentMessageIds = [];

        for (const message of messages) {
            let sentMessage;
            let inlineKeyboard = [];
            
            const messageId = message.id;

            if (inEditMode) {
                // تم تقصير بيانات الزر لتجنب الخطأ
                const baseControls = [
                    Markup.button.callback('🔼', `msg:up:${messageId}`),
                    Markup.button.callback('🔽', `msg:down:${messageId}`),
                    Markup.button.callback('🗑️', `msg:delete:${messageId}`),
                    Markup.button.callback('➕', `msg:addnext:${messageId}`)
                ];
                if (message.type === 'text') {
                    baseControls.push(Markup.button.callback('✏️', `msg:edit:${messageId}`));
                    inlineKeyboard = [ baseControls ];
                } else {
                     inlineKeyboard = [ baseControls, [
                        Markup.button.callback('📝 تعديل الشرح', `msg:edit_caption:${messageId}`),
                        Markup.button.callback('🔄 استبدال الملف', `msg:replace_file:${messageId}`)
                    ]];
                }
            }
            const options = { 
                caption: message.caption || '',
                entities: message.entities,
                parse_mode: (message.entities && message.entities.length > 0) ? undefined : 'HTML',
                reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
            };
            try {
                switch (message.type) {
                    case 'text': sentMessage = await ctx.reply(message.content, { ...options }); break;
                    case 'photo': sentMessage = await ctx.replyWithPhoto(message.content, options); break;
                    case 'video': sentMessage = await ctx.replyWithVideo(message.content, options); break;
                    case 'document': sentMessage = await ctx.replyWithDocument(message.content, options); break;
                    case 'audio': sentMessage = await ctx.replyWithAudio(message.content, options); break;
                    case 'voice': sentMessage = await ctx.replyWithVoice(message.content, options); break;
                }
                if (sentMessage) sentMessageIds.push(sentMessage.message_id);
            } catch (e) {
                console.error(`Failed to send message ID ${messageId} (type: ${message.type}) due to error:`, e.message);
            }
        }
        if(inEditMode && ctx.from) await trackSentMessages(String(ctx.from.id), sentMessageIds);
        return messages.length;
    } finally {
        client.release();
    }
}

// دالة لتسجيل إحصائيات ضغط الزر
// دالة لتسجيل إحصائيات ضغط الزر
async function updateButtonStats(buttonId, userId) {
    const client = await getClient();
    try {
        // تم إضافة حقل clicked_at لتسجيل وقت الضغطة
        const query = 'INSERT INTO public.button_clicks_log (button_id, user_id, clicked_at) VALUES ($1, $2, NOW())';
        const values = [buttonId, userId];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// =================================================================
// |                       Bot Commands & Logic                      |
// =================================================================

bot.start(async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        const userExists = userResult.rows.length > 0;
        
        const adminsResult = await client.query('SELECT array_agg(id) FROM public.users WHERE is_admin = true');
        const adminIds = adminsResult.rows[0]?.array_agg || [];
        const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
        const isAdmin = adminIds.includes(userId) || isSuperAdmin;
        
        if (!userExists) {
            const query = 'INSERT INTO public.users (id, chat_id, is_admin, current_path, state, state_data, last_active, banned) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
            const values = [userId, ctx.chat.id, isAdmin, 'root', 'NORMAL', {}, new Date(), false];
            await client.query(query, values);
            
            // Notification logic (requires a settings table or similar)
            if (adminIds.length > 0) {
                const totalUsersResult = await client.query('SELECT COUNT(*) FROM public.users');
                const totalUsers = totalUsersResult.rows[0].count;

                const user = ctx.from;
                const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                const userLink = `tg://user?id=${user.id}`;
                const language = user.language_code || 'غير محدد';
                const isPremium = user.is_premium ? 'نعم ✅' : 'لا ❌';

                let notificationMessage = `👤 <b>مستخدم جديد انضم!</b>\n\n` +
                                          `<b>الاسم:</b> <a href="${userLink}">${userName}</a>\n` +
                                          `<b>المعرف:</b> ${user.username ? `@${user.username}` : 'لا يوجد'}\n` +
                                          `<b>ID:</b> <code>${user.id}</code>\n` +
                                          `<b>لغة التلجرام:</b> ${language}\n` +
                                          `<b>حساب بريميوم:</b> ${isPremium}\n\n` +
                                          `👥 أصبح العدد الكلي للمستخدمين: <b>${totalUsers}</b>`;

                for (const adminId of adminIds) {
                    try { await bot.telegram.sendMessage(adminId, notificationMessage, { parse_mode: 'HTML' }); }
                    catch (e) { console.error(`Failed to send new user notification to admin ${adminId}:`, e.message); }
                }
            }
        } else {
            const query = 'UPDATE public.users SET current_path = $1, state = $2, state_data = $3, last_active = $4, is_admin = $5 WHERE id = $6';
            const values = ['root', 'NORMAL', {}, new Date(), isAdmin, userId];
            await client.query(query, values);
        }

        const settingsResult = await client.query('SELECT welcome_message FROM public.settings WHERE id = 1');
        const welcomeMessage = settingsResult.rows[0]?.welcome_message || 'أهلاً بك في البوت!';
        await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } catch (error) { console.error("FATAL ERROR in bot.start:", error, "Update:", ctx.update); }
    finally { client.release(); }
});

// --- أوامر الإدارة الجديدة (حظر، فك حظر، معلومات) ---

// دالة مساعدة للتعامل مع الحظر وفك الحظر
// --- دالة مساعدة للتعامل مع الحظر وفك الحظر (تدعم الطريقتين) ---
const banUnbanHandler = async (ctx, banAction) => {
    const client = await getClient();
    try {
        const adminId = String(ctx.from.id);
        const adminResult = await client.query('SELECT is_admin FROM public.users WHERE id = $1', [adminId]);
        if (!adminResult.rows[0]?.is_admin) return; // الأمر للمشرفين فقط

        let targetId = null;
        let targetName = null;

        // ✨ الخطوة 1: التحقق من طريقة الرد على رسالة موجهة
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.forward_from) {
            const targetUser = ctx.message.reply_to_message.forward_from;
            targetId = String(targetUser.id);
            targetName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim();
        } 
        // ✨ الخطوة 2: إذا لم تكن الطريقة الأولى، تحقق من وجود ID في الأمر
        else {
            const parts = ctx.message.text.split(' ');
            if (parts.length > 1 && /^\d+$/.test(parts[1])) {
                targetId = parts[1];
                try {
                    const userChat = await bot.telegram.getChat(targetId);
                    targetName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                } catch (e) {
                    targetName = `<code>${targetId}</code>`; // في حالة عدم العثور على المستخدم، استخدم الـ ID
                }
            }
        }

        // ✨ الخطوة 3: إذا لم يتم تحديد هدف، أرسل رسالة تعليمات
        if (!targetId) {
            const command = banAction ? '/ban' : '/unban';
            return ctx.replyWithHTML(`⚠️ <b>استخدام غير صحيح.</b>\n\nيمكنك استخدام الأمر بطريقتين:\n1️⃣ قم بالرد على رسالة مُعادة توجيهها من المستخدم بالأمر <code>${command}</code>.\n2️⃣ اكتب الأمر مع ID المستخدم، مثال: <code>${command} 123456789</code>.`);
        }

        if (targetId === process.env.SUPER_ADMIN_ID) {
            return ctx.reply('🚫 لا يمكن تعديل حالة الأدمن الرئيسي.');
        }

        await client.query('UPDATE public.users SET banned = $1 WHERE id = $2', [banAction, targetId]);
        
        if (banAction) {
            await ctx.replyWithHTML(`🚫 تم حظر المستخدم <b>${targetName}</b> بنجاح.`);
            await bot.telegram.sendMessage(targetId, '🚫 لقد تم حظرك من استخدام هذا البوت.').catch(e => console.error(e.message));
        } else {
            await ctx.replyWithHTML(`✅ تم فك حظر المستخدم <b>${targetName}</b> بنجاح.`);
            await bot.telegram.sendMessage(targetId, '✅ تم فك الحظر عنك. يمكنك الآن استخدام البوت مجددًا.').catch(e => console.error(e.message));
        }

    } catch (error) {
        console.error('Error in ban/unban command:', error);
        await ctx.reply('حدث خطأ أثناء تنفيذ الأمر.');
    } finally {
        client.release();
    }
};

bot.command('ban', (ctx) => banUnbanHandler(ctx, true));
bot.command('unban', (ctx) => banUnbanHandler(ctx, false));

// أمر عرض معلومات المستخدم
// أمر عرض معلومات المستخدم (بالتنسيق النهائي والمفصل)
// أمر عرض معلومات المستخدم (مع تنسيق محسن)
bot.command('info', async (ctx) => {
    const client = await getClient();
    try {
        const adminId = String(ctx.from.id);
        const userResult = await client.query('SELECT is_admin FROM public.users WHERE id = $1', [adminId]);
        if (!userResult.rows[0]?.is_admin) {
            return; // ليس مشرفًا
        }

        if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.forward_from) {
            return ctx.reply('⚠️ للاستخدام الصحيح، قم بالرد على رسالة مُعادة توجيهها من المستخدم بالأمر /info.');
        }

        const targetUser = ctx.message.reply_to_message.forward_from;
        const targetId = String(targetUser.id);
        const targetName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim();
        const targetUsername = targetUser.username ? `@${targetUser.username}` : 'لا يوجد';

        const [
            botUserResult,
            clicksTodayResult,
            buttonsVisitedResult
        ] = await Promise.all([
            client.query('SELECT last_active FROM public.users WHERE id = $1', [targetId]),
            client.query(`
                SELECT COUNT(*) FROM public.button_clicks_log 
                WHERE user_id = $1 AND (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
            `, [targetId]),
            client.query(`
                SELECT b.text, COUNT(l.id) as click_count
                FROM public.buttons b 
                JOIN public.button_clicks_log l ON b.id = l.button_id 
                WHERE l.user_id = $1 AND (l.clicked_at AT TIME ZONE 'Africa/Cairo')::date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
                GROUP BY b.text
                ORDER BY click_count DESC
            `, [targetId])
        ]);

        const lastActive = botUserResult.rows[0]?.last_active;
        const clicksToday = clicksTodayResult.rows[0].count;
        
        // ✨ تعديل هنا: تمت إضافة سطرين للفصل بين الأزرار ✨
        const buttonsVisited = buttonsVisitedResult.rows.length > 0 
            ? buttonsVisitedResult.rows.map(r => `- ${r.text} (${r.click_count} ضغطة)`).join('\n\n') 
            : 'لم يزر أي أزرار اليوم';
        
        const lastActiveFormatted = lastActive 
            ? new Date(lastActive).toLocaleString('ar-EG', {
                timeZone: 'Africa/Cairo',
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            })
            : 'غير معروف';

        // بناء التقرير النهائي بالتنسيق الجديد
        const userInfoReport = `📋 <b>تقرير المستخدم: ${targetName}</b>\n\n` +
                             `<b>المعرف:</b> ${targetUsername} (<code>${targetId}</code>)\n\n` +
                             `🕒 <b>آخر نشاط:</b> ${lastActiveFormatted}\n\n` +
                             `🖱️ <b>إجمالي الضغطات (اليوم):</b> ${clicksToday}\n\n` +
                             // ✨ تعديل هنا: تمت إضافة سطرين للفصل عن العنوان ✨
                             `🔘 <b>تفاصيل نشاط الأزرار (اليوم):</b>\n\n` +
                             `${buttonsVisited}`;

        await ctx.replyWithHTML(userInfoReport);

    } catch (error) {
        console.error("Error in /info command:", error);
        await ctx.reply('حدث خطأ أثناء جلب بيانات المستخدم.');
    } finally {
        client.release();
    }
});

const mainMessageHandler = async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return bot.start(ctx);
        const { current_path: currentPath, state, is_admin: isAdmin, state_data: stateData, banned } = userResult.rows[0];
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        await client.query('UPDATE public.users SET last_active = NOW() WHERE id = $1', [userId]);

       if (isAdmin && state === 'DYNAMIC_TRANSFER') {
            const step = stateData.step;

            // --- المرحلة 1: تحديد مصدر الأزرار ---
            if (step === 'AWAITING_BUTTON_SOURCE') {
                const buttonSourceId = getSourceId(ctx);
                if (!buttonSourceId) return ctx.reply('⚠️ خطأ: يرجى إعادة توجيه رسالة صالحة.');
                
                await updateUserState(userId, { stateData: { ...stateData, step: 'AWAITING_CONTENT_SOURCE', buttonSourceId } });
                return ctx.reply('✅ تم تحديد مصدر الأزرار.\n\n**الخطوة 2:** الآن قم بتوجيه رسالة من **مصدر المحتوى**.', Markup.keyboard(await generateKeyboard(userId)).resize());
            }

            // --- المرحلة 2: تحديد مصدر المحتوى ---
            if (step === 'AWAITING_CONTENT_SOURCE') {
                const contentSourceId = getSourceId(ctx);
                if (!contentSourceId) return ctx.reply('⚠️ خطأ: يرجى إعادة توجيه رسالة صالحة.');

                await updateUserState(userId, { 
                    stateData: { ...stateData, step: 'AWAITING_NEXT_BUTTON', contentSourceId } 
                });
                return ctx.reply('✅ تم تحديد مصدر المحتوى.\n\n**🚀 أنت الآن جاهز!**\nابدأ الآن بتوجيه أول رسالة من **مصدر الزر** لبدء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
            }

            // --- المرحلة 3: تجميع البيانات بشكل ديناميكي ---
            if (step === 'AWAITING_NEXT_BUTTON' || step === 'AWAITING_CONTENT') {
                const sourceId = getSourceId(ctx);
                if (!sourceId) return; // تجاهل الرسائل غير الموجهة
                
                // **الحالة أ: استقبال رسالة زر جديد**
                if (sourceId === stateData.buttonSourceId) {
                    // أولاً، تحقق إذا كان هناك زر سابق لم يكتمل ليتم حفظه
                    if (stateData.currentButton && stateData.currentButton.content.length > 0) {
                        const prevButton = stateData.currentButton;
                        const updatedUnits = [...stateData.completedUnits, prevButton];
                         await ctx.reply(`🔔 **اكتمل بناء الزر السابق!**\n- الزر: \`${prevButton.name}\`\n- المحتوى: \`${prevButton.content.length}\` رسالة.\n\n✅ تم حفظه مؤقتاً.`);
                        await updateUserState(userId, { stateData: { ...stateData, completedUnits: updatedUnits, currentButton: null } });
                    }

                    const buttonName = ctx.message.text || ctx.message.caption;
                    if (!buttonName) return ctx.reply('⚠️ تم تجاهل رسالة الزر، لا تحتوي على نص أو تعليق.');

                    const newButton = { name: buttonName, content: [] };
                    await updateUserState(userId, { 
                        stateData: { ...stateData, step: 'AWAITING_CONTENT', currentButton: newButton } 
                    });
                    return ctx.reply(`👍 تم استلام الزر **"${buttonName}"**. الآن قم بتوجيه رسائل المحتوى الخاصة به.`);
                }

                // **الحالة ب: استقبال رسالة محتوى**
                if (sourceId === stateData.contentSourceId) {
                    if (step !== 'AWAITING_CONTENT' || !stateData.currentButton) {
                        return ctx.reply('⚠️ خطأ: يجب أن تبدأ بزر أولاً. قم بتوجيه رسالة من مصدر الأزرار.');
                    }
                    
                    // تحليل الرسالة
                    let type, content, caption = '', entities = [];
                    if (ctx.message.text) { type = "text"; content = ctx.message.text; entities = ctx.message.entities || []; }
                    else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
                    else if (ctx.message.video) { type = "video"; content = ctx.message.video.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
                    else if (ctx.message.document) { type = "document"; content = ctx.message.document.file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
                    else { return ctx.reply('⚠️ نوع رسالة المحتوى غير مدعوم حاليًا.'); }
                    
                    const messageObject = { type, content, caption, entities: entities || [] };
                    const updatedContent = [...stateData.currentButton.content, messageObject];
                    const updatedButton = { ...stateData.currentButton, content: updatedContent };

                    await updateUserState(userId, { stateData: { ...stateData, currentButton: updatedButton } });
                    await ctx.reply(`📥 تمت إضافة المحتوى (${updatedContent.length}) للزر النشط.`);
                    return; // أضف return هنا لتجنب تنفيذ الكود التالي
                }
            }

            // --- المرحلة 4: عند الضغط على زر الإنهاء ---
            if (ctx.message && ctx.message.text === '✅ إنهاء وإضافة الكل') {
                let finalUnits = [...stateData.completedUnits];
                if (stateData.currentButton && stateData.currentButton.content.length > 0) {
                    finalUnits.push(stateData.currentButton);
                     await ctx.reply(`🔔 **اكتمل بناء الزر الأخير!**\n- الزر: \`${stateData.currentButton.name}\`\n- المحتوى: \`${stateData.currentButton.content.length}\` رسالة.`);
                }

                if (finalUnits.length === 0) {
                     await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply('لم يتم بناء أي أزرار مكتملة. تم الخروج من وضع النقل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }

                const statusMessage = await ctx.reply(`⏳ جاري إضافة ${finalUnits.length} زر مع محتوياتها إلى قاعدة البيانات...`);

                const parentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                const lastOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL'), parentId ? [parentId] : []);
                let btnOrder = lastOrderResult.rows[0].max_order;

                for (const unit of finalUnits) {
                    btnOrder++;
                    const insertResult = await client.query('INSERT INTO public.buttons (text, parent_id, "order", is_full_width) VALUES ($1, $2, $3, $4) RETURNING id', [unit.name, parentId, btnOrder, true]);
                    const newButtonId = insertResult.rows[0].id;
                    
                    let msgOrder = -1;
                    for (const msg of unit.content) {
                        msgOrder++;
                        await client.query('INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)', [newButtonId, msgOrder, msg.type, msg.content, msg.caption, JSON.stringify(msg.entities)]);
                    }
                }
                
                await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `🎉 اكتملت العملية! تم إضافة ${finalUnits.length} زر بنجاح.`);
                await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');
                return;
            }
            return; // لمنع تنفيذ أي كود آخر
        }
        if (state === 'AWAITING_BULK_MESSAGES') {
            const { buttonId, collectedMessages = [] } = stateData;

            if (ctx.message && ctx.message.text === '✅ إنهاء الإضافة') {
                if (collectedMessages.length === 0) {
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply('تم إلغاء العملية حيث لم يتم إضافة أي رسائل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }

                // Insert collected messages into the database
                for (const msg of collectedMessages) {
                    const orderResult = await client.query('SELECT COALESCE(MAX("order"), -1) FROM public.messages WHERE button_id = $1', [buttonId]);
                    const newOrder = orderResult.rows[0].coalesce + 1;
                    const query = 'INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)';
                    const values = [buttonId, newOrder, msg.type, msg.content, msg.caption, JSON.stringify(msg.entities)];
                    await client.query(query, values);
                }
                
                await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                await refreshAdminView(ctx, userId, buttonId, `✅ تم إضافة ${collectedMessages.length} رسالة بنجاح.`);
                return;
            }

            let type, content, caption, entities;

            if (ctx.message.text) {
                type = "text";
                content = ctx.message.text;
                caption = "";
                entities = ctx.message.entities || [];
            } else if (ctx.message.photo) {
                type = "photo";
                content = ctx.message.photo.pop().file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.video) {
                type = "video";
                content = ctx.message.video.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.document) {
                type = "document";
                content = ctx.message.document.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.caption_entities || [];
            } else if (ctx.message.audio) {
                type = "audio";
                content = ctx.message.audio.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.audio.caption_entities || [];
            } else if (ctx.message.voice) {
                type = "voice";
                content = ctx.message.voice.file_id;
                caption = ctx.message.caption || '';
                entities = ctx.message.voice.caption_entities || [];
            } else { 
                return ctx.reply("⚠️ نوع الرسالة غير مدعوم.");
            }

            const newMessageObject = { type, content, caption, entities };
            const updatedCollectedMessages = [...collectedMessages, newMessageObject];
            
            await updateUserState(userId, { state: 'AWAITING_BULK_MESSAGES', stateData: { buttonId, collectedMessages: updatedCollectedMessages } });
            await ctx.reply(`👍 تمت إضافة الرسالة (${updatedCollectedMessages.length}). أرسل المزيد أو اضغط "إنهاء الإضافة".`);
            return;
        }

        if (isAdmin && state !== 'NORMAL' && state !== 'EDITING_BUTTONS' && state !== 'EDITING_CONTENT') {
            if (state === 'AWAITING_ADMIN_REPLY') {
                const { targetUserId } = stateData;
                if (!targetUserId) {
                    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                    return ctx.reply('⚠️ حدث خطأ: لم يتم العثور على المستخدم المراد الرد عليه.');
                }
                try {
                    // 1. جلب كل المشرفين بترتيب ثابت لتحديد رقم المشرف
                    const adminsResult = await client.query("SELECT id FROM public.users WHERE is_admin = true ORDER BY id");
                    const adminIds = adminsResult.rows.map(row => String(row.id));
                    
                    // 2. تحديد رقم المشرف الحالي (index + 1)
                    const adminIndex = adminIds.indexOf(String(ctx.from.id));
                    const adminNumber = adminIndex !== -1 ? adminIndex + 1 : 'غير محدد';

                    // 3. إرسال الرد الفعلي للمستخدم
                    await ctx.copyMessage(targetUserId);

                    // 4. إنشاء زر رد ورسالة للمستخدم تحمل رقم المشرف
                    const replyMarkup = { 
                        inline_keyboard: [[ Markup.button.callback(`✍️ الرد على الأدمن رقم ${adminNumber}`, `user:reply:${ctx.from.id}`) ]] 
                    };
                    await bot.telegram.sendMessage(targetUserId, `✉️ رسالة جديدة من الأدمن رقم *${adminNumber}*`, { parse_mode: 'Markdown', reply_markup: replyMarkup });

                    await ctx.reply('✅ تم إرسال ردك بنجاح.');
                } catch (e) {
                    console.error(`Failed to send admin reply to user ${targetUserId}:`, e.message);
                    await ctx.reply(`❌ فشل إرسال الرسالة للمستخدم ${targetUserId}. قد يكون المستخدم قد حظر البوت.`);
                } finally {
                    await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                }
                return;
            }

            if (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_REPLACEMENT_FILE' || state === 'AWAITING_EDITED_TEXT' || state === 'AWAITING_NEW_CAPTION') {
                const { buttonId, messageId, targetOrder } = stateData;
                if (!buttonId) {
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ حدث خطأ: لم يتم العثور على الزر. تم إلغاء العملية.");
                }

              if (state === 'AWAITING_EDITED_TEXT') {
                     if (!messageId) {
                        await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    
                    // --- ✨ الكود الجديد يبدأ هنا ---
                    let type, content, caption = '', entities = [];
                    if (ctx.message.text) { 
                        type = "text"; 
                        content = ctx.message.text; 
                        entities = ctx.message.entities || []; 
                    } else if (ctx.message.photo) { 
                        type = "photo"; 
                        content = ctx.message.photo.pop().file_id;
                        caption = ctx.message.caption || '';
                        entities = ctx.message.caption_entities || [];
                    } else if (ctx.message.video) { 
                        type = "video"; 
                        content = ctx.message.video.file_id;
                        caption = ctx.message.caption || '';
                        entities = ctx.message.caption_entities || [];
                    } else if (ctx.message.document) { 
                        type = "document"; 
                        content = ctx.message.document.file_id;
                        caption = ctx.message.caption || '';
                        entities = ctx.message.caption_entities || [];
                    } else if (ctx.message.audio) { 
                        type = "audio"; 
                        content = ctx.message.audio.file_id;
                        caption = ctx.message.caption || '';
                        entities = ctx.message.caption_entities || [];
                    } else if (ctx.message.voice) { 
                        type = "voice"; 
                        content = ctx.message.voice.file_id;
                        caption = ctx.message.caption || '';
                        entities = ctx.message.voice.caption_entities || [];
                    } else { 
                        return ctx.reply('⚠️ نوع الرسالة غير مدعوم.');
                    }

                    const query = 'UPDATE public.messages SET type = $1, content = $2, caption = $3, entities = $4 WHERE id = $5';
                    const values = [type, content, caption, JSON.stringify(entities), messageId];
                    await client.query(query, values);
                    // --- نهاية الكود الجديد ---

                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث الرسالة بنجاح.');
                    return;
                }
                
                if (state === 'AWAITING_NEW_CAPTION') {
                     if (!messageId) {
                          await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    const newCaption = ctx.message.text || ctx.message.caption;
                    if (typeof newCaption !== 'string') {
                        return ctx.reply('⚠️ يرجى إرسال نص أو رسالة تحتوي على شرح.');
                    }
                    const newEntities = ctx.message.entities || ctx.message.caption_entities || [];
                    const query = 'UPDATE public.messages SET caption = $1, entities = $2 WHERE id = $3';
                    const values = [newCaption, JSON.stringify(newEntities), messageId];
                    await client.query(query, values);
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث الشرح بنجاح.');
                    return;
                }

                let type, content, caption = ctx.message.caption || '', entities = ctx.message.caption_entities || [];
                if (ctx.message.text) { type = "text"; content = ctx.message.text; caption = ""; entities = ctx.message.entities || []; }
                else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; }
                else if (ctx.message.video) { type = "video"; content = ctx.message.video.file_id; }
                else if (ctx.message.document) { type = "document"; content = ctx.message.document.file_id; }
                else if (ctx.message.audio) { type = "audio"; content = ctx.message.audio.file_id; }
                else if (ctx.message.voice) { type = "voice"; content = ctx.message.voice.file_id; }
                else { 
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ نوع الرسالة غير مدعوم. تم إلغاء العملية.");
                }
                
                if (state === 'AWAITING_REPLACEMENT_FILE') {
                    if (!messageId) {
                        await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    const query = 'UPDATE public.messages SET type = $1, content = $2, caption = $3, entities = $4 WHERE id = $5';
                    const values = [type, content, caption, JSON.stringify(entities), messageId];
                    await client.query(query, values);
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم استبدال الملف بنجاح.');
                } else { // AWAITING_NEW_MESSAGE
                    const maxOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.messages WHERE button_id = $1', [buttonId]);
                    const newOrder = maxOrderResult.rows[0].max_order + 1;
                    const query = 'INSERT INTO public.messages (button_id, "order", type, content, caption, entities) VALUES ($1, $2, $3, $4, $5, $6)';
                    const values = [buttonId, targetOrder !== undefined ? targetOrder : newOrder, type, content, caption, JSON.stringify(entities)];
                    await client.query(query, values);
                    if (targetOrder !== undefined) {
                        await client.query('UPDATE public.messages SET "order" = "order" + 1 WHERE button_id = $1 AND "order" >= $2 AND id <> (SELECT id FROM public.messages WHERE button_id = $1 AND "order" = $2)', [buttonId, targetOrder]);
                    }

                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم إضافة الرسالة بنجاح.');
                }
                return;
            }

            if (state === 'AWAITING_BROADCAST') {
                const allUsersResult = await client.query('SELECT id FROM public.users WHERE banned = false');
                const allUsers = allUsersResult.rows;
                let successCount = 0; let failureCount = 0;
                const statusMessage = await ctx.reply(`⏳ جاري إرسال الرسالة إلى ${allUsers.length} مستخدم...`);
                for (const user of allUsers) {
                    try { await ctx.copyMessage(user.id); successCount++; } 
                    catch (e) { failureCount++; console.error(`Failed to broadcast to user ${user.id}:`, e.message); }
                }
                await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ تم الإرسال بنجاح إلى ${successCount} مستخدم.\n❌ فشل الإرسال إلى ${failureCount} مستخدم.`);
                await updateUserState(userId, { state: 'NORMAL' });
                return;
            }

            if (state === 'AWAITING_WELCOME_MESSAGE') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال رسالة نصية فقط.');
                await client.query('INSERT INTO public.settings (id, welcome_message) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET welcome_message = EXCLUDED.welcome_message', [ctx.message.text]);
                await ctx.reply('✅ تم تحديث رسالة الترحيب بنجاح.');
                await updateUserState(userId, { state: 'NORMAL' });
                return;
            }
            
           if (state === 'AWAITING_NEW_BUTTON_NAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال نص يحتوي على أسماء الأزرار.');

                const reservedNames = [
                    '🔝 القائمة الرئيسية', '🔙 رجوع', '📄 تعديل المحتوى', '🚫 إلغاء تعديل المحتوى',
                    '✏️ تعديل الأزرار', '🚫 إلغاء تعديل الأزرار', '👑 الإشراف', '🗣️ رسالة جماعية',
                    '📊 الإحصائيات', '📝 تعديل رسالة الترحيب', '⚙️ تعديل المشرفين', '🚫 قائمة المحظورين',
                    '💬 التواصل مع الأدمن', '✅ النقل إلى هنا', '❌ إلغاء النقل', '➕ إضافة زر',
                    '✂️ نقل زر', '➕ إضافة رسالة'
                ];

                const buttonNames = ctx.message.text.split('\n').map(name => name.trim()).filter(name => name.length > 0);
                if (buttonNames.length === 0) {
                    return ctx.reply('⚠️ لم يتم العثور على أسماء أزرار صالحة.');
                }
                
                const parentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                const lastOrderResult = await client.query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL'), parentId ? [parentId] : []);
                let lastOrder = lastOrderResult.rows[0].max_order;
                
                let addedCount = 0;
                let skippedMessages = [];

                for (const newButtonName of buttonNames) {
                    if (reservedNames.includes(newButtonName)) {
                        skippedMessages.push(`- "${newButtonName}" (اسم محجوز)`);
                        continue;
                    }
                    
                    let queryText, queryValues;
                    if (parentId) {
                        queryText = 'SELECT id FROM public.buttons WHERE parent_id = $1 AND text = $2';
                        queryValues = [parentId, newButtonName];
                    } else {
                        queryText = 'SELECT id FROM public.buttons WHERE parent_id IS NULL AND text = $1';
                        queryValues = [newButtonName];
                    }
                    const existingButtonResult = await client.query(queryText, queryValues);

                    if (existingButtonResult.rows.length > 0) {
                        skippedMessages.push(`- "${newButtonName}" (موجود بالفعل)`);
                        continue;
                    }

                    lastOrder++;
                    addedCount++;
                    
                    const query = 'INSERT INTO public.buttons (text, parent_id, "order", is_full_width, admin_only) VALUES ($1, $2, $3, $4, $5)';
                    const values = [newButtonName, parentId, lastOrder, true, false];
                    await client.query(query, values);
                }

                let summaryMessage = `✅ تمت إضافة ${addedCount} زر بنجاح.`;
                if (skippedMessages.length > 0) {
                    summaryMessage += `\n\n⚠️ تم تخطي الأزرار التالية:\n${skippedMessages.join('\n')}`;
                }

                await updateUserState(userId, { state: 'EDITING_BUTTONS' });
                await ctx.reply(summaryMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }

            if (state === 'AWAITING_RENAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال اسم نصي فقط.');
                const newButtonName = ctx.message.text;
                const buttonIdToRename = stateData.buttonId;
                if (!buttonIdToRename) {
                     await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                     return ctx.reply('حدث خطأ، لم يتم العثور على الزر المراد تعديله.');
                }
                const buttonResult = await client.query('SELECT parent_id FROM public.buttons WHERE id = $1', [buttonIdToRename]);
                const parentId = buttonResult.rows[0]?.parent_id;
                
                let queryText, queryValues;
                if (parentId) {
                    queryText = 'SELECT id FROM public.buttons WHERE parent_id = $1 AND text = $2 AND id <> $3';
                    queryValues = [parentId, newButtonName, buttonIdToRename];
                } else {
                    queryText = 'SELECT id FROM public.buttons WHERE parent_id IS NULL AND text = $1 AND id <> $2';
                    queryValues = [newButtonName, buttonIdToRename];
                }
                const existingButtonResult = await client.query(queryText, queryValues);

                if (existingButtonResult.rows.length > 0) {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply(`⚠️ يوجد زر آخر بهذا الاسم "${newButtonName}". تم إلغاء التعديل.`);
                }
                await client.query('UPDATE public.buttons SET text = $1 WHERE id = $2', [newButtonName, buttonIdToRename]);

                await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                await ctx.reply(`✅ تم تعديل اسم الزر إلى "${newButtonName}".`, Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }
            if (state === 'AWAITING_ADMIN_ID_TO_ADD' || state === 'AWAITING_ADMIN_ID_TO_REMOVE') {
                if (!ctx.message.text || !/^\d+$/.test(ctx.message.text)) return ctx.reply("⚠️ يرجى إرسال ID رقمي صحيح.");
                const targetAdminId = ctx.message.text;
                try {
                    const userChat = await bot.telegram.getChat(targetAdminId);
                    const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                    const confirmationState = state === 'AWAITING_ADMIN_ID_TO_ADD' ? 'AWAITING_ADD_ADMIN_CONFIRMATION' : 'AWAITING_REMOVE_ADMIN_CONFIRMATION';
                    const actionText = state === 'AWAITING_ADMIN_ID_TO_ADD' ? 'إضافة' : 'حذف';
                    await updateUserState(userId, { state: confirmationState, stateData: { targetAdminId, targetAdminName: userName } });
                    return ctx.reply(`👤 المستخدم: ${userName} (<code>${targetAdminId}</code>)\nهل أنت متأكد من ${actionText} هذا المستخدم كمشرف؟\nأرسل "نعم" للتأكيد.`, { parse_mode: 'HTML'});
                } catch (e) {
                    await updateUserState(userId, { state: 'NORMAL' });
                    return ctx.reply("⚠️ لم يتم العثور على مستخدم بهذا الـ ID.");
                }
            }
            if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION' || state === 'AWAITING_REMOVE_ADMIN_CONFIRMATION') {
                if (ctx.message.text === 'نعم') {
                    const { targetAdminId, targetAdminName } = stateData;
                    if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION') {
                        await client.query('UPDATE public.users SET is_admin = true WHERE id = $1', [targetAdminId]);
                        await ctx.reply(`✅ تم إضافة ${targetAdminName} كمشرف بنجاح.`);
                    } else { // AWAITING_REMOVE_ADMIN_CONFIRMATION
                        if (targetAdminId === process.env.SUPER_ADMIN_ID) {
                           await ctx.reply('🚫 لا يمكن حذف الأدمن الرئيسي.');
                        } else {
                           await client.query('UPDATE public.users SET is_admin = false WHERE id = $1', [targetAdminId]);
                           await ctx.reply(`🗑️ تم حذف ${targetAdminName} من قائمة المشرفين.`);
                        }
                    }
                } else {
                    await ctx.reply("تم إلغاء العملية.");
                }
                await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                return;
            }
        }
        
        // هذا المقطع للرسالة الأولى فقط (يرسلها للجميع)
        if (state === 'CONTACTING_ADMIN') {
            const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
            const adminIds = adminsResult.rows.map(row => String(row.id));
            if (adminIds.length === 0) {
                await updateUserState(userId, { state: 'NORMAL' });
                return ctx.reply('⚠️ عذراً، لا يوجد مشرفون متاحون حالياً لتلقي رسالتك.');
            }
            const from = ctx.from;
            const userDetails = `👤 <b>رسالة جديدة من مستخدم!</b>\n\n<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}` + `\n<b>المعرف:</b> @${from.username || 'لا يوجد'}` + `\n<b>ID:</b> <code>${from.id}</code>`;
            for (const adminId of adminIds) {
                try {
                    const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ رد', `admin:reply:${from.id}`), Markup.button.callback('🚫 حظر', `admin:ban:${from.id}`) ]] };
                    await bot.telegram.sendMessage(adminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                    await ctx.copyMessage(adminId);
                } catch (e) { console.error(`Failed to send message to admin ${adminId}:`, e); }
            }
            await updateUserState(userId, { state: 'NORMAL' });
            await ctx.reply('✅ تم إرسال رسالتك إلى الأدمن بنجاح.');
            return;
        }

        // هذا المقطع الجديد لرد المستخدم على أدمن محدد
        if (state === 'REPLYING_TO_ADMIN') {
            const { targetAdminId } = stateData;
            if (!targetAdminId) {
                await updateUserState(userId, { state: 'NORMAL', stateData: {} });
                return ctx.reply('⚠️ حدث خطأ، لم يتم تحديد المشرف للرد عليه.');
            }
            const from = ctx.from;
            const userDetails = `📝 <b>رد من مستخدم!</b>\n\n<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}` + `\n<b>المعرف:</b> @${from.username || 'لا يوجد'}` + `\n<b>ID:</b> <code>${from.id}</code>`;
            
            try {
                // إرسال الرد للأدمن المحدد فقط
                const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ رد', `admin:reply:${from.id}`), Markup.button.callback('🚫 حظر', `admin:ban:${from.id}`) ]] };
                await bot.telegram.sendMessage(targetAdminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                await ctx.copyMessage(targetAdminId);
            } catch (e) {
                 console.error(`Failed to send reply to admin ${targetAdminId}:`, e);
            }

            await updateUserState(userId, { state: 'NORMAL', stateData: {} });
            await ctx.reply('✅ تم إرسال ردك للمشرف بنجاح.');
            return;
        }

        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;

        switch (text) {
           case '🔝 القائمة الرئيسية':
    // هذا التعديل يقوم فقط بتغيير المسار دون مسح بيانات النقل
    await updateUserState(userId, { currentPath: 'root' }); 
    return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
           case '🔙 رجوع':
    const newPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
    // هذا التعديل يقوم فقط بالرجوع للخلف دون مسح بيانات النقل
    await updateUserState(userId, { currentPath: newPath });
    return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '💬 التواصل مع الأدمن':
                await updateUserState(userId, { state: 'CONTACTING_ADMIN' });
                return ctx.reply('أرسل رسالتك الآن (نص، صورة، ملف...)... او يمكنك التواصل بشكل مباشر هنا @aw478260');
            case '👑 الإشراف':
                if (isAdmin && currentPath === 'root') {
                    await updateUserState(userId, { currentPath: 'supervision', stateData: {} });
                    return ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '✏️ تعديل الأزرار':
            case '🚫 إلغاء تعديل الأزرار':
                if (isAdmin) {
                    const newState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
                    await updateUserState(userId, { state: newState, stateData: {} });
                    return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '📄 تعديل المحتوى':
            case '🚫 إلغاء تعديل المحتوى':
                if (isAdmin) {
                    const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                    await updateUserState(userId, { state: newContentState, stateData: {} });
                    await ctx.reply(`تم ${newContentState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل المحتوى.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    if (newContentState === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                        const buttonId = currentPath.split('/').pop();
                        await sendButtonMessages(ctx, buttonId, true);
                    }
                    return;
                }
                break;
            case '➕ إضافة زر':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, { state: 'AWAITING_NEW_BUTTON_NAME' });
                    return ctx.reply('أدخل اسم الزر الجديد:');
                }
                break;
            case '➕ إضافة رسالة':
                if (isAdmin && state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                    await updateUserState(userId, {
                        state: 'AWAITING_BULK_MESSAGES',
                        stateData: { buttonId: currentPath.split('/').pop(), collectedMessages: [] }
                    });
                    await ctx.reply('📝 وضع إضافة الرسائل المتعددة 📝\n\nأرسل أو وجّه الآن كل الرسائل التي تريد إضافتها. عند الانتهاء، اضغط على زر "✅ إنهاء الإضافة".',
                        Markup.keyboard(await generateKeyboard(userId)).resize()
                    );
                }
                break;
            case '✂️ نقل زر':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, { state: 'AWAITING_SOURCE_BUTTON_TO_MOVE' });
                    return ctx.reply('✂️ الخطوة 1: اختر الزر الذي تريد نقله (المصدر).');
                }
                break;
            case '📥 نقل البيانات':
                if (isAdmin && state === 'EDITING_BUTTONS') {
                    await updateUserState(userId, { 
                        state: 'DYNAMIC_TRANSFER', 
                        stateData: { 
                            step: 'AWAITING_BUTTON_SOURCE',
                            completedUnits: [] // لتخزين الوحدات المكتملة (زر + محتواه)
                        }
                    });
                    return ctx.reply('📥 **وضع النقل الديناميكي**\n\n**الخطوة 1:** قم بإعادة توجيه أي رسالة من (القناة أو الجروب أو البوت) الذي يمثل **مصدر الأزرار**.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '❌ إلغاء العملية':
                if (isAdmin && state === 'DYNAMIC_TRANSFER') {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply('👍 تم إلغاء العملية.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '✅ النقل إلى هنا':
                if (isAdmin && state === 'AWAITING_DESTINATION_PATH') {
                    const { sourceButtonId, sourceButtonText } = stateData;
                    const newParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
                    try {
                        const sourceButtonResult = await client.query('SELECT parent_id FROM public.buttons WHERE id = $1', [sourceButtonId]);
                        if (sourceButtonResult.rows.length === 0) {
                           await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                           return ctx.reply(`❌ خطأ: الزر المصدر غير موجود. تم إلغاء العملية.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                        }
                        const oldParentId = sourceButtonResult.rows[0]?.parent_id;
                        
                        if (newParentId === oldParentId) {
                             await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                             return ctx.reply(`❌ خطأ: لا يمكن نقل زر إلى نفس مكانه الحالي.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                        }
                        await ctx.reply(`⏳ جاري نقل الزر [${sourceButtonText}] إلى القسم الحالي...`);
                        await client.query('UPDATE public.buttons SET parent_id = $1 WHERE id = $2', [newParentId, sourceButtonId]);
                        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                        return ctx.reply(`✅ تم نقل الزر بنجاح.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    } catch (error) {
                        console.error("Move button error in handler:", error.message, { sourceButtonId, newParentId });
                        await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                        return ctx.reply(`❌ حدث خطأ أثناء نقل الزر. تم إبلاغ المطور.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                }
                break;
            case '❌ إلغاء النقل':
                if (isAdmin && state === 'AWAITING_DESTINATION_PATH') {
                    await updateUserState(userId, { state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply('👍 تم إلغاء عملية النقل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
        }

      // --- معالجة أزرار قائمة الإشراف ---
        if (currentPath === 'supervision' && isAdmin) {
            let supervisionCommandHandled = true;
            switch (text) {
                case '📊 الإحصائيات': {
                    const [ generalStatsData, topDaily, topWeekly, topAllTime ] = await Promise.all([
                        (async () => {
                            const client = await getClient();
                            try {
                                const activeUsersResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active > NOW() - INTERVAL '1 DAY'");
                                const totalButtonsResult = await client.query('SELECT COUNT(*) FROM public.buttons');
                                const totalMessagesResult = await client.query('SELECT COUNT(*) FROM public.messages');
                                const totalUsersResult = await client.query('SELECT COUNT(*) FROM public.users');
                                const inactiveResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active < NOW() - INTERVAL '10 DAY'");
                                return {
                                    dailyActiveUsers: activeUsersResult.rows[0].count,
                                    totalButtons: totalButtonsResult.rows[0].count,
                                    totalMessages: totalMessagesResult.rows[0].count,
                                    totalUsers: totalUsersResult.rows[0].count,
                                    inactiveCount: inactiveResult.rows[0].count,
                                };
                            } finally { client.release(); }
                        })(),
                        processAndFormatTopButtons('daily'),
                        processAndFormatTopButtons('weekly'),
                        processAndFormatTopButtons('all_time')
                    ]);
                    const { dailyActiveUsers, totalButtons, totalMessages, totalUsers, inactiveCount } = generalStatsData;
                    const generalStats = `*📊 الإحصائيات العامة:*\n\n` + `👤 المستخدمون: \`${totalUsers}\` (نشط اليوم: \`${dailyActiveUsers}\`)\n` + `🔘 الأزرار: \`${totalButtons}\`\n` + `✉️ الرسائل: \`${totalMessages}\``;
                    const inactiveUsersReport = `*👥 عدد المستخدمين غير النشطين (آخر 10 أيام):* \`${inactiveCount}\``;
                    const finalReport = `${generalStats}\n\n---\n\n${topDaily}\n\n---\n\n${topWeekly}\n\n---\n\n${topAllTime}\n\n---\n\n${inactiveUsersReport}`;
                    await ctx.reply(finalReport, { parse_mode: 'Markdown' });
                    break;
                }
                case '🗣️ رسالة جماعية':
                    await updateUserState(userId, { state: 'AWAITING_BROADCAST' });
                    await ctx.reply('أرسل الآن الرسالة التي تريد بثها لجميع المستخدمين:');
                    break;
                case '⚙️ تعديل المشرفين':
                     if (userId !== process.env.SUPER_ADMIN_ID) { 
                         await ctx.reply('🚫 هذه الميزة للمشرف الرئيسي فقط.'); 
                         break;
                     }
                    const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
                    let adminListText = '<b>المشرفون الحاليون:</b>\n';
                    for (const row of adminsResult.rows) {
                        const adminId = String(row.id);
                        try {
                            const userChat = await bot.telegram.getChat(adminId);
                            const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                            adminListText += `- ${userName} (<code>${adminId}</code>)\n`;
                        } catch (e) { adminListText += `- <code>${adminId}</code> (لم يتم العثور على المستخدم)\n`; }
                    }
                    await ctx.replyWithHTML(adminListText, Markup.inlineKeyboard([
                        [Markup.button.callback('➕ إضافة مشرف', 'admin:add'), Markup.button.callback('➖ حذف مشرف', 'admin:remove')]
                    ]));
                    break;
                case '📝 تعديل رسالة الترحيب':
                    await updateUserState(userId, { state: 'AWAITING_WELCOME_MESSAGE' });
                    await ctx.reply('أرسل رسالة الترحيب الجديدة:');
                    break;
                case '🚫 قائمة المحظورين': {
                    const bannedUsersResult = await client.query('SELECT id FROM public.users WHERE banned = true');
                    if (bannedUsersResult.rows.length === 0) {
                        await ctx.reply('✅ لا يوجد مستخدمون محظورون حاليًا.');
                        break;
                    }
                    let bannedListMessage = '<b>🚫 قائمة المستخدمين المحظورين:</b>\n\n';
                    for (const row of bannedUsersResult.rows) {
                        const bannedUserId = String(row.id);
                        let userName = 'مستخدم غير معروف', userUsername = 'لا يوجد';
                        try {
                            const userChat = await bot.telegram.getChat(bannedUserId);
                            userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                            if (userChat.username) userUsername = `@${userChat.username}`;
                        } catch (e) { console.error(`Could not fetch info for banned user ${bannedUserId}`); }
                        
                        bannedListMessage += `👤 <b>الاسم:</b> ${userName}\n` +
                                             `<b>المعرف:</b> ${userUsername}\n` +
                                             `🆔 <b>ID:</b> <code>${bannedUserId}</code>\n` +
                                             `CMD: <code>/unban ${bannedUserId}</code>\n---\n`;
                    }
                    await ctx.replyWithHTML(bannedListMessage);
                    break;
                }
                default:
                    supervisionCommandHandled = false;
            }
            return;
        }
        
        // --- إذا لم يكن أي مما سبق، ابحث عن زر عادي في قاعدة البيانات ---
        const currentParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
        
        let buttonResult;
        if (currentParentId === null) {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id IS NULL AND text = $1', [text]);
        } else {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id = $1 AND text = $2', [currentParentId, text]);
        }
        
        const buttonInfo = buttonResult.rows[0];
        if (!buttonInfo) return; // لم يتم العثور على زر مطابق
        const buttonId = buttonInfo.id;

        if (isAdmin && state === 'AWAITING_SOURCE_BUTTON_TO_MOVE') {
            await updateUserState(userId, { state: 'AWAITING_DESTINATION_PATH', stateData: { sourceButtonId: buttonId, sourceButtonText: text } });
            return ctx.reply(`✅ تم اختيار [${text}].\n\n🚙 الآن، تنقّل بحرية داخل البوت وعندما تصل للمكان المطلوب اضغط على زر "✅ النقل إلى هنا".`, Markup.keyboard(await generateKeyboard(userId)).resize());
        }

        if (buttonInfo.admin_only && !isAdmin) {
            return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            if (stateData && stateData.lastClickedButtonId === buttonId) {
                await updateUserState(userId, { currentPath: `${currentPath}/${buttonId}`, stateData: {} });
                await ctx.reply(`تم الدخول إلى "${text}"`, Markup.keyboard(await generateKeyboard(userId)).resize());
            } else {
                await updateUserState(userId, { stateData: { lastClickedButtonId: buttonId } });
                const inlineKb = [[ Markup.button.callback('✏️', `btn:rename:${buttonId}`), Markup.button.callback('🗑️', `btn:delete:${buttonId}`), Markup.button.callback('📊', `btn:stats:${buttonId}`), Markup.button.callback('🔒', `btn:adminonly:${buttonId}`), Markup.button.callback('◀️', `btn:left:${buttonId}`), Markup.button.callback('🔼', `btn:up:${buttonId}`), Markup.button.callback('🔽', `btn:down:${buttonId}`), Markup.button.callback('▶️', `btn:right:${buttonId}`) ]];
                await ctx.reply(`خيارات للزر "${text}" (اضغط مرة أخرى للدخول):`, Markup.inlineKeyboard(inlineKb));
            }
            return;
        }
        
        const hasSubButtonsResult = await client.query('SELECT EXISTS(SELECT 1 FROM public.buttons WHERE parent_id = $1)', [buttonId]);
        const hasMessagesResult = await client.query('SELECT EXISTS(SELECT 1 FROM public.messages WHERE button_id = $1)', [buttonId]);
        const hasSubButtons = hasSubButtonsResult.rows[0].exists;
        const hasMessages = hasMessagesResult.rows[0].exists;

        await updateButtonStats(buttonId, userId);

        const canEnter = hasSubButtons || (isAdmin && ['EDITING_CONTENT', 'EDITING_BUTTONS', 'AWAITING_DESTINATION_PATH'].includes(state));
        
        if (canEnter) {
            await updateUserState(userId, { currentPath: `${currentPath}/${buttonId}` });
            await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
            let replyText = `أنت الآن في قسم: ${text}`;
            if (state === 'AWAITING_DESTINATION_PATH' && !hasSubButtons && !hasMessages) {
                replyText = `🧭 تم الدخول إلى القسم الفارغ [${text}].\nاضغط "✅ النقل إلى هنا" لاختياره كوجهة.`;
            } else if ((state === 'EDITING_CONTENT' || state === 'EDITING_BUTTONS') && !hasMessages && !hasSubButtons) {
                replyText = 'هذا الزر فارغ. يمكنك الآن إضافة رسائل أو أزرار فرعية.';
            }
            await ctx.reply(replyText, Markup.keyboard(await generateKeyboard(userId)).resize());
        } else if (hasMessages) {
            await sendButtonMessages(ctx, buttonId, false);
        } else {
            await ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
        }
        
    } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        console.error("Caused by update:", JSON.stringify(ctx.update, null, 2));
        await ctx.reply("حدث خطأ فادح. تم إبلاغ المطور.");
    } finally { client.release(); }
};

bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const data = ctx.callbackQuery.data;
        
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return ctx.answerCbQuery('المستخدم غير موجود.');
        const userDoc = userResult.rows[0];

        const parts = data.split(':');
        const action = parts[0];

        if (action === 'user' && parts[1] === 'reply') {
            const targetAdminId = parts[2]; // الحصول على ID الأدمن من الزر
            
            // تخزين ID الأدمن للرد عليه تحديداً
            await updateUserState(userId, { state: 'REPLYING_TO_ADMIN', stateData: { targetAdminId: targetAdminId } });
            await ctx.answerCbQuery();
            return ctx.reply(`أرسل الآن ردك للمشرف المحدد:`);
        }

        if (!userDoc.is_admin) return ctx.answerCbQuery('غير مصرح لك.', { show_alert: true });
        
        if (action === 'confirm_delete_button') {
            const subAction = parts[1];
            const buttonId = parts[2];
            if (subAction === 'no') {
                await ctx.editMessageText('👍 تم إلغاء عملية الحذف.');
                return ctx.answerCbQuery();
            }

            if (subAction === 'yes') {
                await client.query('DELETE FROM public.buttons WHERE id = $1', [buttonId]);
                await ctx.editMessageText('🗑️ تم الحذف بنجاح.');
                await refreshKeyboardView(ctx, userId, 'تم تحديث لوحة المفاتيح.');
                return ctx.answerCbQuery();
            }
        }

        if (action === 'admin') {
            const subAction = parts[1];
            const targetId = parts[2];
           if (subAction === 'reply') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_REPLY', stateData: { targetUserId: targetId } });
                await ctx.answerCbQuery();
                return ctx.reply(`أرسل الآن ردك للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
            }
            if (subAction === 'ban') {
                if (targetId === process.env.SUPER_ADMIN_ID) {
                    return ctx.answerCbQuery('🚫 لا يمكن حظر الأدمن الرئيسي.', { show_alert: true });
                }
                await client.query('UPDATE public.users SET banned = true WHERE id = $1', [targetId]);
                await ctx.answerCbQuery();
                await ctx.editMessageText(`🚫 تم حظر المستخدم <code>${targetId}</code> بنجاح.`, { parse_mode: 'HTML' });
                await bot.telegram.sendMessage(targetId, '🚫 لقد تم حظرك من استخدام هذا البوت.').catch(e => console.error(e.message));
                return;
            }
            if (subAction === 'unban') {
    const targetId = parts[2]; // تأكد من أن targetId يتم تعريفه هنا

    await client.query('UPDATE public.users SET banned = false WHERE id = $1', [targetId]);
    await ctx.answerCbQuery();
    await ctx.editMessageText(`✅ تم فك حظر المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });

    // ✨ تأكد من وجود هذا السطر، فهو المسؤول عن إرسال الإعلام للمستخدم ✨
    await bot.telegram.sendMessage(targetId, '✅ تم فك الحظر عنك. يمكنك الآن استخدام البوت مجددًا.').catch(e => console.error(`Failed to send unban notification to user ${targetId}:`, e.message));

    return;
}
            if (userId !== process.env.SUPER_ADMIN_ID) return ctx.answerCbQuery('🚫 للمشرف الرئيسي فقط.', { show_alert: true });
            if (subAction === 'add') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_ID_TO_ADD' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف الجديد:');
            }
            if (subAction === 'remove') {
                await updateUserState(userId, { state: 'AWAITING_ADMIN_ID_TO_REMOVE' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف للحذف:');
            }
        }

      if (action === 'btn') {
            await updateUserState(userId, { stateData: {} }); // << قم بإضافة هذا السطر
            const subAction = parts[1];
            const buttonId = parts[2];
            
            // لا تقم بمسح stateData هنا، فقط عند الإجراءات التي تنهي الوضع
            // await updateUserState(userId, { stateData: {} });

            if (subAction === 'rename') {
                await updateUserState(userId, { state: 'AWAITING_RENAME', stateData: { buttonId: buttonId } });
                await ctx.answerCbQuery();
                await ctx.editMessageText('أدخل الاسم الجديد:');
                return;
            }
           if (subAction === 'delete') {
            const buttonResult = await client.query('SELECT text FROM public.buttons WHERE id = $1', [buttonId]);
            if (buttonResult.rows.length === 0) return ctx.answerCbQuery('الزر غير موجود بالفعل.');

            const confirmationKeyboard = Markup.inlineKeyboard([
                Markup.button.callback('✅ نعم، قم بالحذف', `confirm_delete_button:yes:${buttonId}`),
                Markup.button.callback('❌ إلغاء', `confirm_delete_button:no:${buttonId}`)
            ]);
            await ctx.editMessageText(`🗑️ هل أنت متأكد من حذف الزر "${buttonResult.rows[0].text}" وكل ما بداخله؟ هذا الإجراء لا يمكن التراجع عنه.`, confirmationKeyboard);
            return;
        }
            if (subAction === 'adminonly') {
                const buttonResult = await client.query('SELECT admin_only FROM public.buttons WHERE id = $1', [buttonId]);
                const adminOnly = !buttonResult.rows[0].admin_only;
                await client.query('UPDATE public.buttons SET admin_only = $1 WHERE id = $2', [adminOnly, buttonId]);
                await ctx.answerCbQuery(`الزر الآن ${adminOnly ? 'للمشرفين فقط' : 'للجميع'}`);
                return;
            }
          if (subAction === 'stats') {
    const todayDate = new Date().toISOString().split('T')[0];

    // 1. جلب إحصائيات اليوم (من السجل المباشر)
    const todayResultLive = await client.query(`
        SELECT COUNT(*) as clicks, COUNT(DISTINCT user_id) as users FROM public.button_clicks_log 
        WHERE button_id = $1 AND (clicked_at AT TIME ZONE 'Africa/Cairo')::date = (now() AT TIME ZONE 'Africa/Cairo')::date`, 
    [buttonId]);
    
    // 2. جلب إحصائيات اليوم التي قد تكون أُرشفت بالخطأ
    const todayResultArchive = await client.query(`SELECT total_clicks as clicks, unique_users_count as users FROM public.daily_button_stats WHERE button_id = $1 AND click_date = $2`, [buttonId, todayDate]);

    // 3. جلب الإحصائيات التاريخية
    const historicalResult = await client.query(`SELECT SUM(total_clicks) as clicks, SUM(unique_users_count) as users FROM public.daily_button_stats WHERE button_id = $1 AND click_date <> $2`, [buttonId, todayDate]);

    // تجميع النتائج
    const dailyClicks = parseInt(todayResultLive.rows[0].clicks || 0) + parseInt(todayResultArchive.rows[0]?.clicks || 0);
    const dailyUsers = parseInt(todayResultLive.rows[0].users || 0) + parseInt(todayResultArchive.rows[0]?.users || 0);
    const historicalClicks = parseInt(historicalResult.rows[0].clicks || 0);
    const totalClicks = dailyClicks + historicalClicks;
    const totalUsers = dailyUsers + parseInt(historicalResult.rows[0].users || 0);

    const buttonTextResult = await client.query('SELECT text FROM public.buttons WHERE id = $1', [buttonId]);
    const buttonName = buttonTextResult.rows[0]?.text || 'غير معروف';

    const statsMessage = `📊 <b>إحصائيات الزر: ${buttonName}</b>\n\n` +
        `👆 <b>الضغطات:</b>\n` +
        `  - اليوم: <code>${dailyClicks}</code>\n` +
        `  - الكلي: <code>${totalClicks}</code>\n\n` +
        `👤 <b>المستخدمون:</b>\n` +
        `  - اليوم: <code>${dailyUsers}</code>\n` +
        `  - الكلي: <code>${totalUsers}</code>`;
    
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(statsMessage);
    return;
}
            
            // ---  ✨ الجزء الجديد الذي تمت إضافته ---
         // --- ✨✨✨ الجزء الجديد الخاص بتحريك الأزرار ✨✨✨ ---
            if (['up', 'down', 'left', 'right'].includes(subAction)) {
                // 1. جلب كل الأزرار في نفس المستوى لتحديد الترتيب الحالي
                const btnToMoveResult = await client.query('SELECT parent_id FROM public.buttons WHERE id = $1', [buttonId]);
                if (btnToMoveResult.rows.length === 0) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                const parentId = btnToMoveResult.rows[0].parent_id;

                const buttonsResult = await client.query(
                    'SELECT id, "order", is_full_width FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL') + ' ORDER BY "order"',
                    parentId ? [parentId] : []
                );
                const buttonList = buttonsResult.rows;
                
                // 2. إعادة بناء شكل الأزرار كما يظهر للمستخدم في مصفوفة صفوف
                let rows = [];
                let currentRow = [];
                buttonList.forEach(btn => {
                    currentRow.push(btn);
                    if (btn.is_full_width || currentRow.length === 2) {
                        rows.push(currentRow);
                        currentRow = [];
                    }
                });
                if (currentRow.length > 0) rows.push(currentRow);

                // 3. إيجاد مكان الزر المراد تحريكه (رقم الصف والعمود)
                let targetRowIndex = -1;
                let targetColIndex = -1;
                rows.find((row, rIndex) => {
                    const cIndex = row.findIndex(b => b.id === buttonId);
                    if (cIndex !== -1) {
                        targetRowIndex = rIndex;
                        targetColIndex = cIndex;
                        return true;
                    }
                    return false;
                });

                if (targetRowIndex === -1) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                
                let actionTaken = false;

                // 4. تطبيق منطق التحريك حسب الإجراء المطلوب
                if (subAction === 'up') {
                    // زر بنصف عرض يصبح زر بعرض كامل فوق شريكه
                    if (rows[targetRowIndex].length > 1) { 
                        const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0];
                        const self = rows[targetRowIndex][targetColIndex];
                        rows.splice(targetRowIndex, 1, [self], [partner]);
                        actionTaken = true;
                    // زر بعرض كامل يندمج مع زر آخر بعرض كامل فوقه ليصبحا صفا واحدا
                    } else if (targetRowIndex > 0) {
                        const rowAbove = rows[targetRowIndex - 1];
                        if (rowAbove.length === 1) { 
                            const buttonAbove = rowAbove[0];
                            const self = rows[targetRowIndex][0];
                            rows[targetRowIndex - 1] = [buttonAbove, self];
                            rows.splice(targetRowIndex, 1);
                            actionTaken = true;
                        }
                    }
                } else if (subAction === 'down') {
                    // زر بنصف عرض يصبح زر بعرض كامل تحت شريكه
                    if (rows[targetRowIndex].length > 1) { 
                        const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0];
                        const self = rows[targetRowIndex][targetColIndex];
                        rows.splice(targetRowIndex, 1, [partner], [self]);
                        actionTaken = true;
                    // زر بعرض كامل يندمج مع زر آخر بعرض كامل تحته
                    } else if (targetRowIndex < rows.length - 1) {
                        const rowBelow = rows[targetRowIndex + 1];
                        if (rowBelow.length === 1) { 
                            const buttonBelow = rowBelow[0];
                            const self = rows[targetRowIndex][0];
                            rows.splice(targetRowIndex, 1);
                            rows[targetRowIndex] = [self, buttonBelow];
                            actionTaken = true;
                        }
                    }
                } else if (subAction === 'left' || subAction === 'right') {
                    // تبديل الأماكن في نفس الصف
                    if (rows[targetRowIndex].length > 1) {
                        [rows[targetRowIndex][0], rows[targetRowIndex][1]] = [rows[targetRowIndex][1], rows[targetRowIndex][0]];
                        actionTaken = true;
                    }
                }

                // 5. إذا تم التحريك بنجاح، قم بتحديث قاعدة البيانات
               if (actionTaken) {
                    const newButtonList = rows.flat();
                    try {
                        await client.query('BEGIN');
                        for (let i = 0; i < newButtonList.length; i++) {
                            const button = newButtonList[i];
                            const finalRow = rows.find(r => r.some(b => b.id === button.id));
                            const newIsFullWidth = finalRow.length === 1;
                            await client.query('UPDATE public.buttons SET "order" = $1, is_full_width = $2 WHERE id = $3', [i, newIsFullWidth, button.id]);
                        }
                        await client.query('COMMIT');
                        await refreshKeyboardView(ctx, userId, '✅ تم تحديث ترتيب الأزرار.');
                        await ctx.answerCbQuery();
                    } catch (e) {
                        await client.query('ROLLBACK');
                        console.error("Error updating button order:", e);
                        await ctx.reply('❌ حدث خطأ أثناء تحديث الترتيب.');
                    }
                } else {
                    await ctx.answerCbQuery('لا يمكن تحريك الزر أكثر.', { show_alert: true });
                }
                return; // <<<<<<< السطر المضاف
            }
        }


        if (action === 'msg') {
            const msgAction = parts[1];
            const messageId = parts[2];

            const msgResult = await client.query('SELECT *, button_id FROM public.messages WHERE id = $1', [messageId]);
            if (msgResult.rows.length === 0) return ctx.answerCbQuery('الرسالة غير موجودة');
            
            const messageToHandle = msgResult.rows[0];
            const buttonId = messageToHandle.button_id;

            const messagesResult = await client.query('SELECT * FROM public.messages WHERE button_id = $1 ORDER BY "order"', [buttonId]);
            const messages = messagesResult.rows;
            const messageIndex = messages.findIndex(msg => msg.id === messageId);
            if (messageIndex === -1) return ctx.answerCbQuery('الرسالة غير موجودة');

            if (msgAction === 'delete') {
                await client.query('DELETE FROM public.messages WHERE id = $1', [messageId]);
                await client.query('UPDATE public.messages SET "order" = "order" - 1 WHERE button_id = $1 AND "order" > $2', [buttonId, messages[messageIndex].order]);
                await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                await refreshAdminView(ctx, userId, buttonId, '🗑️ تم الحذف بنجاح.');
                return ctx.answerCbQuery();
            }
            if (msgAction === 'up' || msgAction === 'down') {
                const currentMessage = messages[messageIndex];
                const newOrder = msgAction === 'up' ? currentMessage.order - 1 : currentMessage.order + 1;
                const targetMessageResult = await client.query('SELECT id, "order" FROM public.messages WHERE button_id = $1 AND "order" = $2', [buttonId, newOrder]);
                const targetMessage = targetMessageResult.rows[0];
                if (targetMessage) {
                    await client.query('BEGIN'); // Start transaction
                    await client.query('UPDATE public.messages SET "order" = $1 WHERE id = $2', [targetMessage.order, currentMessage.id]);
                    await client.query('UPDATE public.messages SET "order" = $1 WHERE id = $2', [currentMessage.order, targetMessage.id]);
                    await client.query('COMMIT'); // Commit transaction
                    await updateUserState(userId, { state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '↕️ تم تحديث الترتيب.');
                    return ctx.answerCbQuery();
                } else {
                    return ctx.answerCbQuery('لا يمكن تحريك الرسالة أكثر.');
                }
            }
            if (msgAction === 'edit') {
                 await updateUserState(userId, { state: 'AWAITING_EDITED_TEXT', stateData: { messageId: messageId, buttonId: buttonId } });
                 await ctx.answerCbQuery();
                 return ctx.reply("📝 أرسل أو وجّه المحتوى الجديد :", { reply_markup: { force_reply: true } });
            }
             if (msgAction === 'edit_caption') {
                await updateUserState(userId, { state: 'AWAITING_NEW_CAPTION', stateData: { messageId: messageId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه رسالة تحتوي على الشرح الجديد:", { reply_markup: { force_reply: true } });
            }
            if (msgAction === 'replace_file') {
                await updateUserState(userId, { state: 'AWAITING_REPLACEMENT_FILE', stateData: { messageId: messageId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("🔄 أرسل أو وجّه الملف الجديد:", { reply_markup: { force_reply: true } });
            }
            if (msgAction === 'addnext') {
                const msg = messages[messageIndex];
                await updateUserState(userId, { state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId, targetOrder: msg.order + 1 } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه الرسالة التالية:", { reply_markup: { force_reply: true } });
            }
        }
    } catch (error) {
        console.error("FATAL ERROR in callback_query handler:", error);
        console.error("Caused by callback_query data:", JSON.stringify(ctx.update.callback_query, null, 2));
        await ctx.answerCbQuery("حدث خطأ فادح.", { show_alert: true });
    } finally { client.release(); }
});

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
