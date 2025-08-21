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
async function processAndFormatTopButtons() {
    const client = await getClient();
    try {
        // يتم استخدام هذا الاستعلام لجمع الإحصائيات من جدول واحد (button_clicks_log)
        // إذا كان هذا الجدول غير موجود، يجب إنشاؤه أولاً
        const query = `
            SELECT b.text, COUNT(l.button_id) as clicks_count, COUNT(DISTINCT l.user_id) as unique_users
            FROM public.buttons b
            JOIN public.button_clicks_log l ON b.id = l.button_id
            GROUP BY b.text
            ORDER BY clicks_count DESC
            LIMIT 10;
        `;
        const { rows } = await client.query(query);

        if (rows.length === 0) {
            return 'لا توجد بيانات لعرضها في هذه الفترة.';
        }

        return rows.map((row, index) =>
            `${index + 1}. *${row.text}*\n   - 🖱️ الضغطات: \`${row.clicks_count}\`\n   - 👤 المستخدمون: \`${row.unique_users}\``
        ).join('\n\n');
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

// دالة لإنشاء لوحة المفاتيح
async function generateKeyboard(userId) {
  const client = await getClient();
  try {
    const userResult = await client.query('SELECT is_admin, current_path, state FROM public.users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return [[]];
    const { is_admin: isAdmin, current_path: currentPath, state } = userResult.rows[0];
    let keyboardRows = [];

    if (state === 'AWAITING_BULK_MESSAGES') {
        return [['✅ إنهاء الإضافة']];
    }

    if (isAdmin && state === 'AWAITING_DESTINATION_PATH') {
        keyboardRows.unshift(['✅ النقل إلى هنا', '❌ إلغاء النقل']);
    }
    
    if (currentPath === 'supervision') {
        keyboardRows = [
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
            ['🚫 قائمة المحظورين'],
            ['🔙 رجوع', '🔝 القائمة الرئيسية']
        ];
        return keyboardRows;
    }

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

    if (isAdmin) {
        const adminActionRow = [];
        if (state === 'EDITING_BUTTONS') { adminActionRow.push('➕ إضافة زر'); adminActionRow.push('✂️ نقل زر'); }
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
async function updateButtonStats(buttonId, userId) {
    const client = await getClient();
    try {
        // تأكد من وجود جدول button_clicks_log أولاً
        const query = 'INSERT INTO public.button_clicks_log (button_id, user_id) VALUES ($1, $2)';
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

const mainMessageHandler = async (ctx) => {
    const client = await getClient();
    try {
        const userId = String(ctx.from.id);
        const userResult = await client.query('SELECT * FROM public.users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return bot.start(ctx);
        const { current_path: currentPath, state, is_admin: isAdmin, state_data: stateData, banned } = userResult.rows[0];
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        await client.query('UPDATE public.users SET last_active = NOW() WHERE id = $1', [userId]);

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
                    await ctx.copyMessage(targetUserId);
                    const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ الرد على المشرف', `user:reply`) ]] };
                    await bot.telegram.sendMessage(targetUserId, '✉️ رسالة جديدة من الأدمن.', { reply_markup: replyMarkup });
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
        
        if (state === 'CONTACTING_ADMIN' || state === 'REPLYING_TO_ADMIN') {
            const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
            const adminIds = adminsResult.rows.map(row => String(row.id));
            if (adminIds.length === 0) {
                await updateUserState(userId, { state: 'NORMAL' });
                return ctx.reply('⚠️ عذراً، لا يوجد مشرفون متاحون حالياً لتلقي رسالتك.');
            }
            const from = ctx.from;
            const messagePrefix = state === 'REPLYING_TO_ADMIN' ? '📝 <b>رد من مستخدم!</b>' : '👤 <b>رسالة جديدة من مستخدم!</b>';
            const userDetails = `${messagePrefix}\n\n<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}` + `\n<b>المعرف:</b> @${from.username || 'لا يوجد'}` + `\n<b>ID:</b> <code>${from.id}</code>`;
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

        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;

        switch (text) {
            case '🔝 القائمة الرئيسية':
                await updateUserState(userId, { currentPath: 'root', state: 'NORMAL', stateData: {} });
                return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '🔙 رجوع':
                const newPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
                await updateUserState(userId, { currentPath: newPath, state: 'NORMAL', stateData: {} });
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

        if (currentPath === 'supervision' && isAdmin) {
             switch (text) {
                case '📊 الإحصائيات': {
                    const waitingMessage = await ctx.reply('⏳ جارٍ تجميع كافة الإحصائيات والتقارير المتقدمة، يرجى الانتظار...');

                    const activeUsersResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active > NOW() - INTERVAL '1 DAY'");
                    const dailyActiveUsers = activeUsersResult.rows[0].count;
                    const totalButtonsResult = await client.query('SELECT COUNT(*) FROM public.buttons');
                    const totalMessagesResult = await client.query('SELECT COUNT(*) FROM public.messages');
                    const totalUsersResult = await client.query('SELECT COUNT(*) FROM public.users');
                    
                    const totalButtons = totalButtonsResult.rows[0].count;
                    const totalMessages = totalMessagesResult.rows[0].count;
                    const totalUsers = totalUsersResult.rows[0].count;
                    const generalStats = `*📊 الإحصائيات العامة:*\n\n` + `👤 المستخدمون: \`${totalUsers}\` (نشط اليوم: \`${dailyActiveUsers}\`)\n` + `🔘 الأزرار: \`${totalButtons}\`\n` + `✉️ الرسائل: \`${totalMessages}\``;

                    const topAllTime = await processAndFormatTopButtons();

                    const topButtonsReport = `*🏆 الأكثر استخداماً:*\n${topAllTime}`;
                    
                    const inactiveResult = await client.query("SELECT COUNT(*) FROM public.users WHERE last_active < NOW() - INTERVAL '10 DAY'");
                    const inactiveCount = inactiveResult.rows[0].count;
                    const inactiveUsersReport = `*👥 عدد المستخدمين غير النشطين (آخر 10 أيام):* \`${inactiveCount}\``;

                    const finalReport = `${generalStats}\n\n---\n\n${topButtonsReport}\n\n---\n\n${inactiveUsersReport}`;
                    await ctx.telegram.editMessageText(ctx.chat.id, waitingMessage.message_id, undefined, finalReport, { parse_mode: 'Markdown' });
                    
                    return;
                }
                case '🗣️ رسالة جماعية':
                    await updateUserState(userId, { state: 'AWAITING_BROADCAST' });
                    return ctx.reply('أرسل الآن الرسالة التي تريد بثها لجميع المستخدمين:');
                case '⚙️ تعديل المشرفين':
                     if (userId !== process.env.SUPER_ADMIN_ID) return ctx.reply('🚫 هذه الميزة للمشرف الرئيسي فقط.');
                    const adminsResult = await client.query('SELECT id FROM public.users WHERE is_admin = true');
                    let adminListText = '<b>المشرفون الحاليون:</b>\n';
                    if (adminsResult.rows.length > 0) {
                        for (const row of adminsResult.rows) {
                            const adminId = String(row.id);
                            try {
                                const userChat = await bot.telegram.getChat(adminId);
                                const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                                adminListText += `- ${userName} (<code>${adminId}</code>)\n`;
                            } catch (e) {
                                adminListText += `- <code>${adminId}</code> (لم يتم العثور على المستخدم)\n`;
                            }
                        }
                    } else {
                        adminListText = 'لا يوجد مشرفون حالياً.';
                    }
                    return ctx.replyWithHTML(adminListText, Markup.inlineKeyboard([
                        [Markup.button.callback('➕ إضافة مشرف', 'admin:add'), Markup.button.callback('➖ حذف مشرف', 'admin:remove')]
                    ]));
                case '📝 تعديل رسالة الترحيب':
                    await updateUserState(userId, { state: 'AWAITING_WELCOME_MESSAGE' });
                    return ctx.reply('أرسل رسالة الترحيب الجديدة:');
                case '🚫 قائمة المحظورين':
                    const bannedUsersResult = await client.query('SELECT id FROM public.users WHERE banned = true');
                    if (bannedUsersResult.rows.length === 0) { return ctx.reply('لا يوجد مستخدمون محظورون حاليًا.'); }
                    await ctx.reply('قائمة المستخدمين المحظورين:');
                    for (const row of bannedUsersResult.rows) {
                        const bannedUserId = String(row.id);
                        try {
                            const userChat = await bot.telegram.getChat(bannedUserId);
                            const userName = `${userChat.first_name || ''} ${userChat.last_name || ''}`.trim();
                            const userLink = `tg://user?id=${bannedUserId}`;
                            const userInfo = `<b>الاسم:</b> <a href="${userLink}">${userName}</a>\n<b>ID:</b> <code>${bannedUserId}</code>`;
                            await ctx.reply(userInfo, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ Markup.button.callback('✅ فك الحظر', `admin:unban:${bannedUserId}`) ]] } });
                        } catch (e) {
                            await ctx.reply(`- <code>${bannedUserId}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ Markup.button.callback('✅ فك الحظر', `admin:unban:${bannedUserId}`) ]] } });
                        }
                    }
                    return;
            }
        }

        const currentParentId = currentPath === 'root' ? null : currentPath.split('/').pop();
        
        let buttonResult;
        if (currentParentId === null) {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id IS NULL AND text = $1', [text]);
        } else {
            buttonResult = await client.query('SELECT id, is_full_width, admin_only FROM public.buttons WHERE parent_id = $1 AND text = $2', [currentParentId, text]);
        }
        
        const buttonInfo = buttonResult.rows[0];
        if (!buttonInfo) return; // إذا لم يتم العثور على زر، لا تفعل شيئًا
        const buttonId = buttonInfo.id;

        if (isAdmin && state === 'AWAITING_SOURCE_BUTTON_TO_MOVE') {
            await updateUserState(userId, {
                state: 'AWAITING_DESTINATION_PATH',
                stateData: { sourceButtonId: buttonId, sourceButtonText: text }
            });
            return ctx.reply(`✅ تم اختيار [${text}].\n\n🚙 الآن، تنقّل بحرية داخل البوت وعندما تصل للمكان المطلوب اضغط على زر "✅ النقل إلى هنا".`, Markup.keyboard(await generateKeyboard(userId)).resize());
        }

        if (buttonInfo.admin_only && !isAdmin) {
            return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            if (stateData && stateData.lastClickedButtonId === buttonId) {
                await updateUserState(userId, { currentPath: `${currentPath}/${buttonId}`, stateData: {} });
                return ctx.reply(`تم الدخول إلى "${text}"`, Markup.keyboard(await generateKeyboard(userId)).resize());
            } else {
                await updateUserState(userId, { stateData: { lastClickedButtonId: buttonId } });
                const inlineKb = [[ Markup.button.callback('✏️', `btn:rename:${buttonId}`), Markup.button.callback('🗑️', `btn:delete:${buttonId}`), Markup.button.callback('📊', `btn:stats:${buttonId}`), Markup.button.callback('🔒', `btn:adminonly:${buttonId}`), Markup.button.callback('◀️', `btn:left:${buttonId}`), Markup.button.callback('🔼', `btn:up:${buttonId}`), Markup.button.callback('🔽', `btn:down:${buttonId}`), Markup.button.callback('▶️', `btn:right:${buttonId}`) ]];
                return ctx.reply(`خيارات للزر "${text}" (اضغط مرة أخرى للدخول):`, Markup.inlineKeyboard(inlineKb));
            }
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
            return ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
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
            await updateUserState(userId, { state: 'REPLYING_TO_ADMIN' });
            await ctx.answerCbQuery();
            return ctx.reply('أرسل الآن ردك على رسالة المشرف:');
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
                await ctx.editMessageText('⏳ جارٍ الحذف...');
                await client.query('DELETE FROM public.buttons WHERE id = $1', [buttonId]);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.reply('🗑️ تم الحذف بنجاح. تم تحديث لوحة المفاتيح.', Markup.keyboard(await generateKeyboard(userId)).resize());
                return ctx.answerCbQuery('✅ تم الحذف');
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
                await client.query('UPDATE public.users SET banned = false WHERE id = $1', [targetId]);
                await ctx.answerCbQuery();
                await ctx.editMessageText(`✅ تم فك حظر المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
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
                const totalClicksResult = await client.query('SELECT COUNT(*) FROM public.button_clicks_log WHERE button_id = $1', [buttonId]);
                const totalClicks = totalClicksResult.rows[0].count;
                const dailyClicksResult = await client.query('SELECT COUNT(*) FROM public.button_clicks_log WHERE button_id = $1 AND clicked_at >= NOW()::date', [buttonId]);
                const dailyClicks = dailyClicksResult.rows[0].count;
                const totalUsersResult = await client.query('SELECT COUNT(DISTINCT user_id) FROM public.button_clicks_log WHERE button_id = $1', [buttonId]);
                const totalUsers = totalUsersResult.rows[0].count;
                const dailyUsersResult = await client.query('SELECT COUNT(DISTINCT user_id) FROM public.button_clicks_log WHERE button_id = $1 AND clicked_at >= NOW()::date', [buttonId]);
                const dailyUsers = dailyUsersResult.rows[0].count;
                const buttonTextResult = await client.query('SELECT text FROM public.buttons WHERE id = $1', [buttonId]);
                const buttonName = buttonTextResult.rows[0]?.text || 'غير معروف';

                const statsMessage = `📊 <b>إحصائيات الزر: ${buttonName}</b>\n\n` + `👆 <b>الضغطات:</b>\n` + `  - اليوم: <code>${dailyClicks}</code>\n` + `  - الكلي: <code>${totalClicks}</code>\n\n` + `👤 <b>المستخدمون:</b>\n` + `  - اليوم: <code>${dailyUsers}</code>\n` + `  - الكلي: <code>${totalUsers}</code>`;
                await ctx.answerCbQuery();
                await ctx.replyWithHTML(statsMessage);
                return;
            }
            
            // ---  ✨ الجزء الجديد الذي تمت إضافته ---
            if (['up', 'down', 'left', 'right'].includes(subAction)) {
                 await ctx.answerCbQuery('⏳ جارٍ تحديث الترتيب...');
                 const btnToMoveResult = await client.query('SELECT "order", parent_id, is_full_width FROM public.buttons WHERE id = $1', [buttonId]);
                 if (btnToMoveResult.rows.length === 0) return await ctx.reply('حدث خطأ: الزر غير موجود.');
                 
                 const { "order": currentOrder, parent_id: parentId, is_full_width: isFullWidth } = btnToMoveResult.rows[0];

                 let targetOrder;
                 let swapQuery, values;

                 if (subAction === 'up' || subAction === 'down') {
                    targetOrder = subAction === 'up' ? currentOrder - 1 : currentOrder + 1;
                    swapQuery = 'SELECT id FROM public.buttons WHERE parent_id ' + (parentId ? '= $1' : 'IS NULL') + ' AND "order" = $2';
                    values = parentId ? [parentId, targetOrder] : [targetOrder];
                 } else { // left or right
                    if (isFullWidth) return ctx.answerCbQuery('لا يمكن تحريك زر بعرض كامل يمينًا أو يسارًا.', { show_alert: true });
                     // هذه الخاصية تحتاج منطق أكثر تعقيدًا للتعامل مع الصفوف، سيتم إضافتها لاحقًا
                     return ctx.answerCbQuery('ميزة التحريك يمين/يسار قيد التطوير.', { show_alert: true });
                 }

                 const targetButtonResult = await client.query(swapQuery, values);
                 if (targetButtonResult.rows.length > 0) {
                     const targetButtonId = targetButtonResult.rows[0].id;
                     await client.query('BEGIN');
                     await client.query('UPDATE public.buttons SET "order" = $1 WHERE id = $2', [targetOrder, buttonId]);
                     await client.query('UPDATE public.buttons SET "order" = $1 WHERE id = $2', [currentOrder, targetButtonId]);
                     await client.query('COMMIT');
                     
                     await ctx.deleteMessage().catch(()=>{});
                     await ctx.reply('✅ تم تحديث ترتيب الأزرار.', Markup.keyboard(await generateKeyboard(userId)).resize());
                 } else {
                     return ctx.answerCbQuery('لا يمكن تحريك الزر أكثر.', { show_alert: true });
                 }
                 return;
            }
            // --- نهاية الجزء المضاف ---
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
                 return ctx.reply("📝 أرسل أو وجّه المحتوى الجديد (نص فقط):", { reply_markup: { force_reply: true } });
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
