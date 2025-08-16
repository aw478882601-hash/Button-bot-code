// =================================================================
// |   TELEGRAM FIREBASE BOT - V16 - STABILITY & LOGIC FIXES     |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('Firebase Admin Initialization Error:', error.message);
  }
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                     Helper Functions (دوال مساعدة)              |
// =================================================================

async function generateKeyboard(userId) {
  try {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (!userDoc.exists) return [[]];

    const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDoc.data();
    
    let keyboardRows = [];

    if (currentPath === 'supervision') {
        keyboardRows = [
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
            ['🚫 قائمة المحظورين'],
            ['🔙 رجوع', '🔝 القائمة الرئيسية']
        ];
        return keyboardRows;
    }

    const buttonsSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order').get();

    let currentRow = [];
    buttonsSnapshot.forEach(doc => {
      const button = doc.data();
      if (!button.adminOnly || isAdmin) {
        currentRow.push(button.text);
        if (currentRow.length === 2) { keyboardRows.push(currentRow); currentRow = []; }
      }
    });
    if (currentRow.length > 0) keyboardRows.push(currentRow);

    if (isAdmin) {
      const adminActionRow = [];
      if (state === 'EDITING_BUTTONS') adminActionRow.push('➕ إضافة زر');
      if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) adminActionRow.push('➕ إضافة رسالة');
      if (adminActionRow.length > 0) keyboardRows.push(adminActionRow);
    }
    
    const fixedButtons = [];
    if (currentPath !== 'root') {
      fixedButtons.push('🔙 رجوع');
    }
    fixedButtons.push('🔝 القائمة الرئيسية');
    
    if (isAdmin && currentPath === 'root') {
      fixedButtons.push('👑 الإشراف');
    }
    if (fixedButtons.length > 0) keyboardRows.push(fixedButtons);
    
    if (isAdmin) {
      const adminControlRow = [];
      adminControlRow.push(state === 'EDITING_BUTTONS' ? '🚫 إلغاء تعديل الأزرار' : '✏️ تعديل الأزرار');
      adminControlRow.push(state === 'EDITING_CONTENT' ? '🚫 إلغاء تعديل المحتوى' : '📄 تعديل المحتوى');
      keyboardRows.push(adminControlRow);
    }
    
    keyboardRows.push(['💬 التواصل مع الإدارة']);
    return keyboardRows;
  } catch (error) {
    console.error('Error generating keyboard:', error);
    return [['حدث خطأ في عرض الأزرار']];
  }
}

async function sendButtonMessages(ctx, buttonId, inEditMode = false) {
    const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
    
    if (messagesSnapshot.empty && !inEditMode) {
        return;
    }

    for (const doc of messagesSnapshot.docs) {
        const message = doc.data();
        const messageId = doc.id;
        
        let inlineKeyboard = [];
        if (inEditMode) {
            inlineKeyboard = [[
                Markup.button.callback('🔼', `msg:up:${messageId}`),
                Markup.button.callback('🔽', `msg:down:${messageId}`),
                Markup.button.callback('✏️', `msg:edit:${messageId}`),
                Markup.button.callback('➕', `msg:addnext:${messageId}`),
                Markup.button.callback('🗑️', `msg:delete:${messageId}`),
            ]];
        }

        const options = { 
            caption: message.caption || '',
            parse_mode: 'HTML',
            reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
        };

        try {
            switch (message.type) {
                case 'text':
                    await ctx.reply(message.content, options); 
                    break;
                case 'photo': await ctx.replyWithPhoto(message.content, options); break;
                case 'video': await ctx.replyWithVideo(message.content, options); break;
                case 'document': await ctx.replyWithDocument(message.content, options); break;
            }
        } catch (e) { console.error(`Failed to send message with file_id: ${message.content}`, e.message); }
    }
}

async function updateButtonStats(buttonId, userId) {
    const today = new Date().toISOString().split('T')[0];
    const buttonRef = db.collection('buttons').doc(buttonId);

    try {
        await db.runTransaction(async (transaction) => {
            const buttonDoc = await transaction.get(buttonRef);
            if (!buttonDoc.exists) return;

            let stats = buttonDoc.data().stats || {};
            let totalUsers = stats.totalUsers || [];
            if (!totalUsers.includes(userId)) {
                totalUsers.push(userId);
            }
            
            let dailyUsers = stats.dailyUsers || {};
            dailyUsers[today] = dailyUsers[today] || [];
            if (!dailyUsers[today].includes(userId)) {
                dailyUsers[today].push(userId);
            }

            transaction.update(buttonRef, {
                'stats.totalClicks': admin.firestore.FieldValue.increment(1),
                [`stats.dailyClicks.${today}`]: admin.firestore.FieldValue.increment(1),
                'stats.totalUsers': totalUsers,
                'stats.dailyUsers': dailyUsers
            });
        });
    } catch (e) {
        console.error("Button stats transaction failed: ", e);
    }
}

async function recursiveDeleteButton(buttonId) {
    const subButtons = await db.collection('buttons').where('parentId', '==', buttonId).get();
    for (const sub of subButtons.docs) {
        await recursiveDeleteButton(sub.id);
    }
    const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
    const batch = db.batch();
    messages.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('buttons').doc(buttonId));
    await batch.commit();
}

// =================================================================
// |                      Bot Commands & Logic                     |
// =================================================================

bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    const today = new Date().toISOString().split('T')[0];
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    const adminsDoc = await db.collection('config').doc('admins').get();
    const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];
    
    const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
    const isAdmin = adminIds.includes(userId) || isSuperAdmin;

    if (!userDoc.exists) {
        await userRef.set({
            chatId: ctx.chat.id, isAdmin, currentPath: 'root',
            state: 'NORMAL', stateData: {}, lastActive: today, banned: false
        });
        
        if (adminIds.length > 0) {
            const userName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
            const userLink = `tg://user?id=${userId}`;
            const notificationMessage = `👤 <b>مستخدم جديد انضم!</b>\n\nالاسم: <a href="${userLink}">${userName}</a>\nID: <code>${userId}</code>`;
            for (const adminId of adminIds) {
                try {
                    await bot.telegram.sendMessage(adminId, notificationMessage, { parse_mode: 'HTML' });
                } catch (e) { console.error(`Failed to send new user notification to admin ${adminId}`, e); }
            }
        }
    } else {
        await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, isAdmin });
    }

    const settingsDoc = await db.collection('config').doc('settings').get();
    const welcomeMessage = settingsDoc.exists && settingsDoc.data().welcomeMessage ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';
    
    const extra = Markup.keyboard(await generateKeyboard(userId)).resize();
    await ctx.reply(welcomeMessage, extra);
});

const mainMessageHandler = async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) return bot.start(ctx);

        const userData = userDoc.data();
        let { currentPath, state, isAdmin, stateData, banned } = userData;

        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        
        await userRef.update({ lastActive: new Date().toISOString().split('T')[0] });

        if (state !== 'NORMAL') {
            if (isAdmin) {
                 if (ctx.message.text) {
                    const text = ctx.message.text;
                    switch (state) {
                        case 'AWAITING_NEW_BUTTON_NAME':
                            const existing = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).get();
                            if (!existing.empty) return ctx.reply('الاسم موجود مسبقاً.');
                            const count = (await db.collection('buttons').where('parentId', '==', currentPath).get()).size;
                            await db.collection('buttons').add({ text, parentId: currentPath, order: count, adminOnly: false, stats: {} });
                            await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                            return ctx.reply('✅ تم إضافة الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());
                        
                        case 'AWAITING_RENAME':
                            await db.collection('buttons').doc(stateData.buttonId).update({ text: text });
                            await userRef.update({ state: 'NORMAL', stateData: {} });
                            return ctx.reply('✅ تم تعديل الاسم بنجاح.', Markup.keyboard(await generateKeyboard(userId)).resize());

                        case 'AWAITING_WELCOME_MESSAGE':
                            await db.collection('config').doc('settings').set({ welcomeMessage: text }, { merge: true });
                            await userRef.update({ state: 'NORMAL' });
                            return ctx.reply('✅ تم تحديث رسالة الترحيب.');

                        case 'AWAITING_ADMIN_ID_TO_ADD':
                            await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayUnion(text) });
                            await userRef.update({ state: 'NORMAL' });
                            return ctx.reply(`✅ تم إضافة المشرف ${text}.`);

                        case 'AWAITING_ADMIN_ID_TO_REMOVE':
                            await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayRemove(text) });
                            await userRef.update({ state: 'NORMAL' });
                            return ctx.reply(`✅ تم حذف المشرف ${text}.`);

                        case 'AWAITING_MSG_CAPTION':
                            await db.collection('messages').doc(stateData.messageId).update({ caption: text });
                            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                            await ctx.reply('✅ تم تعديل شرح الملف بنجاح.');
                            return sendButtonMessages(ctx, stateData.buttonId, true);
                        
                        case 'AWAITING_TEXT_MESSAGE_EDIT':
                            await db.collection('messages').doc(stateData.messageId).update({ content: text });
                            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                            await ctx.reply('✅ تم تعديل الرسالة النصية بنجاح.');
                            return sendButtonMessages(ctx, stateData.buttonId, true);

                        case 'AWAITING_NEW_MESSAGE':
                        case 'AWAITING_NEW_MESSAGE_NEXT':
                            const buttonId = stateData.buttonId;
                            const messages = (await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get()).docs.map(d => ({id: d.id, ...d.data()}));
                            let newMsgOrder = messages.length;
                            if (state === 'AWAITING_NEW_MESSAGE_NEXT') {
                                const targetOrder = stateData.targetOrder;
                                const batch = db.batch();
                                messages.filter(m => m.order >= targetOrder).forEach(m => {
                                    batch.update(db.collection('messages').doc(m.id), { order: m.order + 1 });
                                });
                                await batch.commit();
                                newMsgOrder = targetOrder;
                            }
                            await db.collection('messages').add({ buttonId, type: 'text', content: text, caption: '', order: newMsgOrder });
                            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                            await ctx.reply('✅ تم إضافة النص بنجاح.');
                            return sendButtonMessages(ctx, buttonId, true);
                        
                        case 'AWAITING_BROADCAST':
                            const users = await db.collection('users').get();
                            let successCount = 0, errorCount = 0;
                            for (const user of users.docs) {
                                if (!user.data().banned) {
                                    try {
                                        await ctx.copyMessage(user.data().chatId);
                                        successCount++;
                                    } catch (e) { 
                                        errorCount++;
                                        console.error(`Broadcast failed for user ${user.id}`); 
                                    }
                                }
                            }
                            await userRef.update({ state: 'NORMAL' });
                            return ctx.reply(`تم الإرسال الجماعي بنجاح إلى ${successCount} مستخدم.\nفشل الإرسال لـ ${errorCount} مستخدم.`, Markup.keyboard(await generateKeyboard(userId)).resize());

                        case 'AWAITING_ADMIN_REPLY':
                            try {
                                const targetUserDoc = await db.collection('users').doc(stateData.targetUserId).get();
                                if (!targetUserDoc.exists) return ctx.reply('❌ المستخدم غير موجود.');
                                await bot.telegram.sendMessage(targetUserDoc.data().chatId, `✉️ <b>رد من الإدارة:</b>\n\n${text}`, { 
                                    parse_mode: 'HTML',
                                    reply_markup: { inline_keyboard: [[ Markup.button.callback('✍️ الرد على المشرف', `user:reply`) ]] }
                                });
                                await ctx.reply('✅ تم إرسال ردك بنجاح.');
                            } catch (e) {
                                await ctx.reply('❌ فشل إرسال الرد. قد يكون المستخدم قد حظر البوت.');
                            }
                            await userRef.update({ state: 'NORMAL', stateData: {} });
                            return;
                    }
                }

                if (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_NEW_MESSAGE_NEXT' || state === 'AWAITING_MSG_CAPTION') {
                    let type, fileId, caption = ctx.message.caption || '';
                    if (ctx.message.photo) { type = 'photo'; fileId = ctx.message.photo.pop().file_id; } 
                    else if (ctx.message.video) { type = 'video'; fileId = ctx.message.video.file_id; } 
                    else if (ctx.message.document) { type = 'document'; fileId = ctx.message.document.file_id; }
                    else return;

                    const buttonId = stateData.buttonId;
                    if (state === 'AWAITING_MSG_CAPTION') {
                        await db.collection('messages').doc(stateData.messageId).update({ type, content: fileId, caption });
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await ctx.reply('✅ تم تعديل الرسالة بنجاح.');
                        return sendButtonMessages(ctx, buttonId, true);
                    } else {
                        const messages = (await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get()).docs.map(d => ({id: d.id, ...d.data()}));
                        let newOrder = messages.length;
                        if (state === 'AWAITING_NEW_MESSAGE_NEXT') {
                            const targetOrder = stateData.targetOrder;
                            const batch = db.batch();
                            messages.filter(m => m.order >= targetOrder).forEach(m => {
                                batch.update(db.collection('messages').doc(m.id), { order: m.order + 1 });
                            });
                            await batch.commit();
                            newOrder = targetOrder;
                        }
                        await db.collection('messages').add({ buttonId, type, content: fileId, caption, order: newOrder });
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await ctx.reply('✅ تم إضافة المحتوى بنجاح.');
                        return sendButtonMessages(ctx, buttonId, true);
                    }
                }
            }
            
            if(state === 'CONTACTING_ADMIN' || state === 'REPLYING_TO_ADMIN') {
                const adminsDoc = await db.collection('config').doc('admins').get();
                // **FIXED**: More robust check for admin IDs
                const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];

                if (adminIds.length === 0) {
                     await userRef.update({ state: 'NORMAL' });
                     return ctx.reply('⚠️ عذراً، لا يوجد مشرفون متاحون حالياً لتلقي رسالتك.');
                }

                const from = ctx.from;
                const messagePrefix = state === 'REPLYING_TO_ADMIN' ? '📝 <b>رد من مستخدم!</b>' : '👤 <b>رسالة جديدة من مستخدم!</b>';
                const userDetails = `${messagePrefix}\n\n<b>الاسم:</b> ${from.first_name}${from.last_name ? ' ' + from.last_name : ''}\n<b>المعرف:</b> @${from.username || 'لا يوجد'}\n<b>ID:</b> <code>${from.id}</code>`;

                for (const adminId of adminIds) {
                    try {
                        const replyMarkup = { inline_keyboard: [[ Markup.button.callback('✍️ رد', `admin:reply:${from.id}`), Markup.button.callback('🚫 حظر', `admin:ban:${from.id}`) ]] };

                        if (ctx.message.text) {
                            await bot.telegram.sendMessage(adminId, `${userDetails}\n\n💬 <b>نص الرسالة:</b>\n${ctx.message.text}`, { parse_mode: 'HTML', reply_markup: replyMarkup });
                        } else if (ctx.message.photo) {
                            const caption = `${userDetails}${ctx.message.caption ? `\n\n💬 <b>الشرح الأصلي:</b>\n${ctx.message.caption}` : ''}`;
                            await bot.telegram.sendPhoto(adminId, ctx.message.photo.pop().file_id, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
                        } else if (ctx.message.document) {
                            const caption = `${userDetails}${ctx.message.caption ? `\n\n💬 <b>الشرح الأصلي:</b>\n${ctx.message.caption}` : ''}`;
                            await bot.telegram.sendDocument(adminId, ctx.message.document.file_id, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
                        } else if (ctx.message.video) {
                            const caption = `${userDetails}${ctx.message.caption ? `\n\n💬 <b>الشرح الأصلي:</b>\n${ctx.message.caption}` : ''}`;
                            await bot.telegram.sendVideo(adminId, ctx.message.video.file_id, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
                        } else {
                            await bot.telegram.sendMessage(adminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                            await ctx.copyMessage(adminId);
                        }
                    } catch(e) { console.error(`Failed to send message to admin ${adminId}:`, e); }
                }
                await userRef.update({ state: 'NORMAL' });
                return ctx.reply('✅ تم إرسال رسالتك إلى الإدارة بنجاح.');
            }
            return;
        }
        
        if (ctx.message.text) {
            const text = ctx.message.text;
            switch (text) {
                case '🔝 القائمة الرئيسية':
                    await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
                    return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
                case '🔙 رجوع':
                    if (currentPath === 'root') return;
                    currentPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
                    await userRef.update({ currentPath, stateData: {} });
                    return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
                case '💬 التواصل مع الإدارة':
                    await userRef.update({ state: 'CONTACTING_ADMIN' });
                    return ctx.reply('أرسل رسالتك الآن (نص، صورة، ملف...)...');
                case '👑 الإشراف':
                    if (isAdmin && currentPath === 'root') {
                        await userRef.update({ currentPath: 'supervision' });
                        return ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                    break;
                case '✏️ تعديل الأزرار':
                case '🚫 إلغاء تعديل الأزرار':
                    if (isAdmin) {
                        const newState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
                        await userRef.update({ state: newState, stateData: {} });
                        return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    }
                    break;
                case '📄 تعديل المحتوى':
                case '🚫 إلغاء تعديل المحتوى':
                    if (isAdmin) {
                        const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                        await userRef.update({ state: newContentState, stateData: {} });
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
                        await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME' });
                        return ctx.reply('أدخل اسم الزر الجديد:');
                    }
                    break;
                case '➕ إضافة رسالة':
                    if (isAdmin && state === 'EDITING_CONTENT') {
                        const buttonId = currentPath.split('/').pop();
                        await userRef.update({ state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId } });
                        return ctx.reply('أرسل الرسالة الجديدة (نص، صورة، فيديو، ملف). لدعم التنسيقات استخدم وسوم HTML.');
                    }
                    break;
            }

            if (currentPath === 'supervision' && isAdmin) {
                // ... (Supervision logic remains the same)
            }

            // =================================================================
            // |         *** NEW & REWRITTEN BUTTON CLICK LOGIC *** |
            // =================================================================
            const buttonSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).limit(1).get();
            if (!buttonSnapshot.empty) {
                const buttonDoc = buttonSnapshot.docs[0];
                const buttonId = buttonDoc.id;

                // --- LOGIC FOR "EDITING BUTTONS" MODE ---
                if (state === 'EDITING_BUTTONS' && isAdmin) {
                    if (stateData && stateData.lastClickedButtonId === buttonId) {
                        const newPath = `${currentPath}/${buttonId}`;
                        await userRef.update({ currentPath: newPath, stateData: {} });
                        return ctx.reply(`تم الدخول إلى "${text}"`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    } else {
                        await userRef.update({ stateData: { lastClickedButtonId: buttonId } });
                        const inlineKb = [[
                            Markup.button.callback('✏️', `btn:rename:${buttonId}`), Markup.button.callback('🗑️', `btn:delete:${buttonId}`),
                            Markup.button.callback('🔼', `btn:up:${buttonId}`), Markup.button.callback('🔽', `btn:down:${buttonId}`),
                            Markup.button.callback('◀️', `btn:left:${buttonId}`), Markup.button.callback('▶️', `btn:right:${buttonId}`),
                            Markup.button.callback('🔒', `btn:adminonly:${buttonId}`), Markup.button.callback('📊', `btn:stats:${buttonId}`),
                        ]];
                        return ctx.reply(`خيارات للزر "${text}" (اضغط مرة أخرى للدخول أو اختر أحد الخيارات):`, Markup.inlineKeyboard(inlineKb));
                    }
                }

                // --- LOGIC FOR "NORMAL" & "EDITING CONTENT" MODES ---
                await updateButtonStats(buttonId, userId);
                
                const subButtonsSnapshot = await db.collection('buttons').where('parentId', '==', buttonId).limit(1).get();
                
                if (!subButtonsSnapshot.empty) {
                    // If it has sub-buttons ("folder"), navigate into it
                    const newPath = `${currentPath}/${buttonId}`;
                    await userRef.update({ currentPath: newPath });
                    await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
                } else {
                    // If it has no sub-buttons ("leaf"), just show its content
                    await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
                }
            }
        }
    } catch (error) {
        console.error("Error in mainMessageHandler:", error);
        await ctx.reply("حدث خطأ ما، يرجى المحاولة مرة أخرى.");
    }
};

bot.on('message', mainMessageHandler);
bot.on('callback_query', async (ctx) => {
    // ... (Callback query handler remains the same)
});

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body, res);
        } catch (err) {
            console.error('Error in webhook handler:', err);
        }
    } else {
        res.status(200).send('Bot is running.');
    }
};
