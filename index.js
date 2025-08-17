// =================================================================
// |   TELEGRAM FIREBASE BOT - V37 - FINAL COMPLETE BUILD        |
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

// -- دالة لتسجيل الرسائل المعروضة في وضع التعديل --
async function trackSentMessages(userId, messageIds) {
    const userRef = db.collection('users').doc(String(userId));
    await userRef.update({ 'stateData.messageViewIds': messageIds });
}

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
        if (button.isFullWidth) {
            if (currentRow.length > 0) {
                keyboardRows.push(currentRow);
            }
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
    if (currentRow.length > 0) {
        keyboardRows.push(currentRow);
    }

    if (isAdmin) {
      const adminActionRow = [];
      if (state === 'EDITING_BUTTONS') adminActionRow.push('➕ إضافة زر');
      if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
        adminActionRow.push('➕ إضافة رسالة');
      }
      if (adminActionRow.length > 0) keyboardRows.push(adminActionRow);
    }
    
    const fixedButtons = [];
    if (currentPath !== 'root') {
      fixedButtons.push('🔙 رجوع');
      fixedButtons.push('🔝 القائمة الرئيسية');
    }
    
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
    const sentMessageIds = [];

    if (messagesSnapshot.empty && inEditMode) {
        if(ctx.from) await trackSentMessages(String(ctx.from.id), []);
        return 0;
    }

    for (const doc of messagesSnapshot.docs) {
        const message = doc.data();
        const messageId = doc.id;
        let sentMessage;
        let inlineKeyboard = [];
        if (inEditMode) {
            inlineKeyboard = [[
                Markup.button.callback('🔼', `msg:up:${messageId}`), Markup.button.callback('🔽', `msg:down:${messageId}`),
                Markup.button.callback('✏️', `msg:edit:${messageId}`), Markup.button.callback('➕', `msg:addnext:${messageId}`),
                Markup.button.callback('🗑️', `msg:delete:${messageId}`),
            ]];
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
            }
            if (sentMessage) sentMessageIds.push(sentMessage.message_id);
        } catch (e) {
            console.error(`Failed to send message ID ${messageId} (type: ${message.type}) due to error:`, e.message);
        }
    }
    
    if(inEditMode && ctx.from) {
        await trackSentMessages(String(ctx.from.id), sentMessageIds);
    }

    return messagesSnapshot.size;
}

async function clearAndResendMessages(ctx, userId, buttonId) {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];

    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
    }
    
    await sendButtonMessages(ctx, buttonId, true);
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
            if (!totalUsers.includes(userId)) totalUsers.push(userId);
            let dailyUsers = stats.dailyUsers || {};
            dailyUsers[today] = dailyUsers[today] || [];
            if (!dailyUsers[today].includes(userId)) dailyUsers[today].push(userId);
            transaction.update(buttonRef, {
                'stats.totalClicks': admin.firestore.FieldValue.increment(1),
                [`stats.dailyClicks.${today}`]: admin.firestore.FieldValue.increment(1),
                'stats.totalUsers': totalUsers, 'stats.dailyUsers': dailyUsers
            });
        });
    } catch (e) { console.error(`Button stats transaction failed for button ${buttonId}:`, e); }
}

async function recursiveDeleteButton(buttonPath) {
    const subButtons = await db.collection('buttons').where('parentId', '==', buttonPath).get();
    for (const sub of subButtons.docs) {
        const subPath = `${buttonPath}/${sub.id}`;
        await recursiveDeleteButton(subPath);
    }
    const buttonId = buttonPath.split('/').pop();
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
    try {
        const userId = String(ctx.from.id);
        const today = new Date().toISOString().split('T')[0];
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        const adminsDoc = await db.collection('config').doc('admins').get();
        const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];
        const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
        const isAdmin = adminIds.includes(userId) || isSuperAdmin;
        if (!userDoc.exists) {
            await userRef.set({ chatId: ctx.chat.id, isAdmin, currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, banned: false });
            const totalUsers = (await db.collection('users').get()).size;
            if (adminIds.length > 0) {
                const user = ctx.from;
                const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                const userLink = `tg://user?id=${user.id}`;
                let notificationMessage = `👤 <b>مستخدم جديد انضم!</b>\n\n` + `<b>الاسم:</b> <a href="${userLink}">${userName}</a>\n` + `<b>المعرف:</b> ${user.username ? `@${user.username}` : 'لا يوجد'}\n` + `<b>ID:</b> <code>${user.id}</code>\n\n` + `👥 أصبح العدد الكلي للمستخدمين: <b>${totalUsers}</b>`;
                for (const adminId of adminIds) {
                    try { await bot.telegram.sendMessage(adminId, notificationMessage, { parse_mode: 'HTML' }); }
                    catch (e) { console.error(`Failed to send new user notification to admin ${adminId}:`, e.message); }
                }
            }
        } else {
            await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, isAdmin });
        }
        const settingsDoc = await db.collection('config').doc('settings').get();
        const welcomeMessage = (settingsDoc.exists && settingsDoc.data().welcomeMessage) ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';
        await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
    } catch (error) { console.error("FATAL ERROR in bot.start:", error, "Update:", ctx.update); }
});

const mainMessageHandler = async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return bot.start(ctx);
        let { currentPath, state, isAdmin, stateData, banned } = userDoc.data();
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        await userRef.update({ lastActive: new Date().toISOString().split('T')[0] });

        if (state.startsWith('AWAITING_')) {
            if (isAdmin) {
                if (ctx.message && ctx.message.text) {
                    const text = ctx.message.text;
                    switch (state) {
                        case 'AWAITING_NEW_BUTTON_NAME':
                            const existing = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).get();
                            if (!existing.empty) return ctx.reply('الاسم موجود مسبقاً.');
                            const count = (await db.collection('buttons').where('parentId', '==', currentPath).get()).size;
                            await db.collection('buttons').add({ text, parentId: currentPath, order: count, adminOnly: false, isFullWidth: false, stats: {} });
                            await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                            return ctx.reply('✅ تم إضافة الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());
                        case 'AWAITING_RENAME':
                            await db.collection('buttons').doc(stateData.buttonId).update({ text });
                            await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
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
                            await db.collection('messages').doc(stateData.messageId).update({ caption: text, entities: ctx.message.caption_entities || [] });
                            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                            await ctx.reply('✅ تم تعديل الشرح بنجاح.');
                            await clearAndResendMessages(ctx, userId, stateData.buttonId);
                            return;
                        case 'AWAITING_TEXT_MESSAGE_EDIT':
                            await db.collection('messages').doc(stateData.messageId).update({ content: text, entities: ctx.message.entities || [] });
                            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                            await ctx.reply('✅ تم تعديل الرسالة بنجاح.');
                             await clearAndResendMessages(ctx, userId, stateData.buttonId);
                            return;
                        case 'AWAITING_BROADCAST':
                            const users = await db.collection('users').get();
                            let successCount = 0, errorCount = 0;
                            for (const user of users.docs) {
                                if (!user.data().banned) {
                                    try { await ctx.copyMessage(user.data().chatId); successCount++; }
                                    catch (e) { errorCount++; console.error(`Broadcast failed for user ${user.id}:`, e.message); }
                                }
                            }
                            await userRef.update({ state: 'NORMAL' });
                            return ctx.reply(`تم الإرسال إلى ${successCount} مستخدم.\nفشل: ${errorCount}.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                        case 'AWAITING_ADMIN_REPLY':
                            try {
                                const targetUserDoc = await db.collection('users').doc(stateData.targetUserId).get();
                                if (!targetUserDoc.exists) return ctx.reply('❌ المستخدم غير موجود.');
                                await bot.telegram.sendMessage(targetUserDoc.data().chatId, `✉️ <b>رد من الإدارة:</b>\n\n${text}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ Markup.button.callback('✍️ الرد على المشرف', `user:reply`) ]] }});
                                await ctx.reply('✅ تم إرسال ردك بنجاح.');
                            } catch (e) { await ctx.reply('❌ فشل إرسال الرد. قد يكون المستخدم قد حظر البوت.'); }
                            await userRef.update({ state: 'NORMAL', stateData: {} });
                            return;
                    }
                }
                if ((state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_NEW_MESSAGE_NEXT') && ctx.message) {
                    const buttonId = stateData.buttonId;
                    if (!buttonId) {
                        await userRef.update({ state: 'NORMAL', stateData: {} });
                        return ctx.reply("حدث خطأ حرج (buttonId غير موجود). يرجى المحاولة مرة أخرى.");
                    }
                    const messages = (await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get()).docs.map(d => ({id: d.id, ...d.data()}));
                    let newMsgOrder = messages.length;
                    if (state === 'AWAITING_NEW_MESSAGE_NEXT') {
                        const targetOrder = stateData.targetOrder;
                        const batch = db.batch();
                        messages.filter(m => m.order >= targetOrder).forEach(m => batch.update(db.collection('messages').doc(m.id), { order: m.order + 1 }));
                        await batch.commit(); newMsgOrder = targetOrder;
                    }
                    if (ctx.message.text) {
                        await db.collection('messages').add({ buttonId, type: 'text', content: ctx.message.text, entities: ctx.message.entities || [], caption: '', order: newMsgOrder });
                    } else {
                        let type, fileId, caption = ctx.message.caption || '', caption_entities = ctx.message.caption_entities || [];
                        if (ctx.message.photo) { type = 'photo'; fileId = ctx.message.photo.pop().file_id; } 
                        else if (ctx.message.video) { type = 'video'; fileId = ctx.message.video.file_id; } 
                        else if (ctx.message.document) { type = 'document'; fileId = ctx.message.document.file_id; }
                        else return;
                        await db.collection('messages').add({ buttonId, type, content: fileId, caption, entities: caption_entities, order: newMsgOrder });
                    }
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await clearAndResendMessages(ctx, userId, buttonId);
                    return;
                }
                if (state === 'AWAITING_MSG_CAPTION' && ctx.message && !ctx.message.text) {
                    let type, fileId, caption = ctx.message.caption || '', caption_entities = ctx.message.caption_entities || [];
                    if (ctx.message.photo) { type = 'photo'; fileId = ctx.message.photo.pop().file_id; } 
                    else if (ctx.message.video) { type = 'video'; fileId = ctx.message.video.file_id; } 
                    else if (ctx.message.document) { type = 'document'; fileId = ctx.message.document.file_id; }
                    else return;
                    await db.collection('messages').doc(stateData.messageId).update({ type, content: fileId, caption, entities: caption_entities });
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await clearAndResendMessages(ctx, userId, stateData.buttonId);
                    return;
                }
            }
            if(state === 'CONTACTING_ADMIN' || state === 'REPLYING_TO_ADMIN') {
                 const adminsDoc = await db.collection('config').doc('admins').get();
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
                         await bot.telegram.sendMessage(adminId, userDetails, { parse_mode: 'HTML', reply_markup: replyMarkup });
                         await ctx.copyMessage(adminId);
                     } catch(e) { console.error(`Failed to send message to admin ${adminId}:`, e); }
                 }
                 await userRef.update({ state: 'NORMAL' });
                 return ctx.reply('✅ تم إرسال رسالتك إلى الإدارة بنجاح.');
            }
            return;
        }
        
        if (!ctx.message || !ctx.message.text) return; 
        const text = ctx.message.text;

        switch (text) {
            case '🔝 القائمة الرئيسية':
                await userRef.update({ currentPath: 'root' });
                return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '🔙 رجوع':
                const newPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
                await userRef.update({ currentPath: newPath });
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
                    // START: MODIFICATION
                    await userRef.update({ state: newState, stateData: {} }); // Clear stateData on toggle
                    // END: MODIFICATION
                    return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '📄 تعديل المحتوى':
            case '🚫 إلغاء تعديل المحتوى':
                if (isAdmin) {
                    const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                    await userRef.update({ state: newContentState });
                    await ctx.reply(`تم ${newContentState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل المحتوى.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    if (newContentState === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                        const buttonId = currentPath.split('/').pop();
                        await clearAndResendMessages(ctx, userId, buttonId);
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
                if (isAdmin && state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                    await userRef.update({ state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId: currentPath.split('/').pop() } });
                    return ctx.reply('أرسل الرسالة الجديدة.');
                }
                break;
        }

        if (currentPath === 'supervision' && isAdmin) {
            // ... (supervision logic remains unchanged)
        }

        const buttonSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).limit(1).get();
        if (buttonSnapshot.empty) return;

        const buttonDoc = buttonSnapshot.docs[0];
        const buttonId = buttonDoc.id;

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            if (stateData && stateData.lastClickedButtonId === buttonId) {
                await userRef.update({ currentPath: `${currentPath}/${buttonId}`, stateData: {} });
                return ctx.reply(`تم الدخول إلى "${text}"`, Markup.keyboard(await generateKeyboard(userId)).resize());
            } else {
                await userRef.update({ stateData: { lastClickedButtonId: buttonId } });
                const inlineKb = [[
                    Markup.button.callback('✏️', `btn:rename:${buttonId}`),
                    Markup.button.callback('🗑️', `btn:delete:${buttonId}`),
                    Markup.button.callback('📊', `btn:stats:${buttonId}`),
                    Markup.button.callback('🔒', `btn:adminonly:${buttonId}`),
                    Markup.button.callback('◀️', `btn:left:${buttonId}`),
                    Markup.button.callback('🔼', `btn:up:${buttonId}`),
                    Markup.button.callback('🔽', `btn:down:${buttonId}`),
                    Markup.button.callback('▶️', `btn:right:${buttonId}`),
                ]];
                return ctx.reply( `خيارات للزر "${text}" (اضغط مرة أخرى للدخول):`, Markup.inlineKeyboard(inlineKb));
            }
        }
        
        await updateButtonStats(buttonId, userId);
        const potentialChildParentId = `${currentPath}/${buttonId}`;
        const subButtonsSnapshot = await db.collection('buttons').where('parentId', '==', potentialChildParentId).limit(1).get();
        
        if (!subButtonsSnapshot.empty) {
            await userRef.update({ currentPath: potentialChildParentId });
            if (state === 'EDITING_CONTENT') {
                await clearAndResendMessages(ctx, userId, buttonId);
            } else {
                await sendButtonMessages(ctx, buttonId, false);
            }
            await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
        } else {
            const messageCount = await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
            if (state === 'EDITING_CONTENT' && messageCount === 0) {
                await userRef.update({ currentPath: potentialChildParentId });
                await ctx.reply('تم الدخول للزر الفارغ. لوحة المفاتيح تم تحديثها.', Markup.keyboard(await generateKeyboard(userId)).resize());
            }
        }

    } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        console.error("Caused by update:", JSON.stringify(ctx.update, null, 2));
        await ctx.reply("حدث خطأ فادح. تم إبلاغ المطور.");
    }
};

bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const data = ctx.callbackQuery.data;
        const [action, subAction, targetId] = data.split(':');
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return ctx.answerCbQuery('المستخدم غير موجود.');
        
        if (action === 'user' && subAction === 'reply') {
            await userRef.update({ state: 'REPLYING_TO_ADMIN' });
            await ctx.answerCbQuery();
            return ctx.reply('أرسل الآن ردك على رسالة المشرف:');
        }

        if (!userDoc.data().isAdmin) return ctx.answerCbQuery('غير مصرح لك.', { show_alert: true });
        
        const { currentPath } = userDoc.data();

        if (action === 'admin') {
            // ... (admin logic remains unchanged)
        }

        if (action === 'btn') {
            await userRef.update({ stateData: {} }); // Reset double-click state on any btn action

            if (subAction === 'rename') {
                await userRef.update({ state: 'AWAITING_RENAME', stateData: { buttonId: targetId } });
                await ctx.answerCbQuery();
                await ctx.editMessageText('أدخل الاسم الجديد:');
                return;
            }
            if (subAction === 'delete') {
                const buttonToDeletePath = `${currentPath}/${targetId}`;
                await recursiveDeleteButton(buttonToDeletePath);
                await ctx.answerCbQuery('✅ تم الحذف بنجاح');
                await ctx.deleteMessage().catch(()=>{});
                await ctx.reply('تم تحديث لوحة المفاتيح.', Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }
            if (['up', 'down', 'left', 'right'].includes(subAction)) {
                const buttonsSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order').get();
                let buttonList = buttonsSnapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
                
                if (buttonList.length < 1) return ctx.answerCbQuery('لا يوجد ما يكفي من الأزرار للتحريك');

                const currentIndex = buttonList.findIndex(b => b.id === targetId);
                if (currentIndex === -1) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                
                const batch = db.batch();
                let actionTaken = false;

                if (subAction === 'up' || subAction === 'down') {
                    // Reconstruct rows to understand layout
                    let rows = [];
                    let currentRow = [];
                    buttonList.forEach(btn => {
                        if (btn.isFullWidth) {
                            if (currentRow.length > 0) rows.push(currentRow);
                            rows.push([btn]);
                            currentRow = [];
                        } else {
                            currentRow.push(btn);
                            if (currentRow.length === 2) {
                                rows.push(currentRow);
                                currentRow = [];
                            }
                        }
                    });
                    if (currentRow.length > 0) rows.push(currentRow);

                    let { rowIndex, colIndex } = (-1,-1);
                    for(let r=0; r < rows.length; r++){
                        let c = rows[r].findIndex(b => b.id === targetId);
                        if(c !== -1) { rowIndex = r; colIndex = c; break; }
                    }

                    if (subAction === 'down') {
                        if (rows[rowIndex]?.length === 2 && colIndex === 0) {
                            batch.update(rows[rowIndex][0].ref, { isFullWidth: true });
                            batch.update(rows[rowIndex][1].ref, { isFullWidth: true });
                            actionTaken = true;
                        }
                    } else if (subAction === 'up') {
                        if (rows[rowIndex]?.length === 2 && colIndex === 0) {
                            batch.update(rows[rowIndex][0].ref, { isFullWidth: true });
                            batch.update(rows[rowIndex][1].ref, { isFullWidth: true });
                            actionTaken = true;
                        } else if (rows[rowIndex]?.length === 1 && rowIndex > 0 && rows[rowIndex-1]?.length === 1) {
                            batch.update(rows[rowIndex][0].ref, { isFullWidth: false });
                            batch.update(rows[rowIndex-1][0].ref, { isFullWidth: false });
                            actionTaken = true;
                        }
                    }

                    if (!actionTaken) {
                        if (subAction === 'up' && currentIndex > 0) {
                            [buttonList[currentIndex], buttonList[currentIndex - 1]] = [buttonList[currentIndex - 1], buttonList[currentIndex]];
                            actionTaken = true;
                        } else if (subAction === 'down' && currentIndex < buttonList.length - 1) {
                            [buttonList[currentIndex], buttonList[currentIndex + 1]] = [buttonList[currentIndex + 1], buttonList[currentIndex]];
                            actionTaken = true;
                        }
                    }
                } else if (subAction === 'left' || subAction === 'right') {
                    let swapIndex = -1;
                    if (subAction === 'right' && currentIndex % 2 === 0 && currentIndex + 1 < buttonList.length && !buttonList[currentIndex].isFullWidth && !buttonList[currentIndex + 1]?.isFullWidth) {
                        swapIndex = currentIndex + 1;
                    } else if (subAction === 'left' && currentIndex % 2 === 1 && !buttonList[currentIndex].isFullWidth && !buttonList[currentIndex - 1]?.isFullWidth) {
                        swapIndex = currentIndex - 1;
                    }

                    if(swapIndex !== -1) {
                        [buttonList[currentIndex], buttonList[swapIndex]] = [buttonList[swapIndex], buttonList[currentIndex]];
                        actionTaken = true;
                    }
                }

                if (actionTaken) {
                    buttonList.forEach((button, i) => batch.update(button.ref, { order: i }));
                    await batch.commit();
                    await ctx.answerCbQuery('✅ تم');
                    await ctx.deleteMessage().catch(()=>{});
                    await ctx.reply('تم تحديث لوحة المفاتيح.', Markup.keyboard(await generateKeyboard(userId)).resize());
                } else {
                    await ctx.answerCbQuery('لا يمكن التحريك');
                }
                return;
            }
            if (subAction === 'adminonly') {
                const buttonRef = db.collection('buttons').doc(targetId);
                const buttonDoc = await buttonRef.get();
                const adminOnly = !buttonDoc.data().adminOnly;
                await buttonRef.update({ adminOnly });
                await ctx.answerCbQuery(`الزر الآن ${adminOnly ? 'للمشرفين فقط' : 'للجميع'}`);
                return;
            }
            if (subAction === 'stats') {
                const buttonDoc = await db.collection('buttons').doc(targetId).get();
                if (!buttonDoc.exists) return ctx.answerCbQuery('الزر غير موجود.');
                const stats = buttonDoc.data().stats || {};
                const today = new Date().toISOString().split('T')[0];
                const totalClicks = stats.totalClicks || 0;
                const dailyClicks = stats.dailyClicks ? (stats.dailyClicks[today] || 0) : 0;
                const totalUsers = stats.totalUsers ? stats.totalUsers.length : 0;
                const dailyUsers = stats.dailyUsers && stats.dailyUsers[today] ? stats.dailyUsers[today].length : 0;
                const statsMessage = `📊 <b>إحصائيات الزر:</b>\n\n` + `👆 <b>الضغطات:</b>\n` + `  - اليوم: <code>${dailyClicks}</code>\n` + `  - الكلي: <code>${totalClicks}</code>\n\n` + `👤 <b>المستخدمون:</b>\n` + `  - اليوم: <code>${dailyUsers}</code>\n` + `  - الكلي: <code>${totalUsers}</code>`;
                await ctx.answerCbQuery();
                await ctx.replyWithHTML(statsMessage);
                return;
            }
        }

        if (action === 'msg') {
            // This logic remains unchanged
        }
    } catch (error) {
        console.error("FATAL ERROR in callback_query handler:", error);
        console.error("Caused by callback_query data:", JSON.stringify(ctx.update.callback_query, null, 2));
        await ctx.answerCbQuery("حدث خطأ فادح.", { show_alert: true });
    }
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
