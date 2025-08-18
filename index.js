// =================================================================
// |   TELEGRAM FIREBASE BOT - V52 - FINAL COMPLETE BUILD          |
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
// |                       Helper Functions (دوال مساعدة)             |
// =================================================================

async function trackSentMessages(userId, messageIds) {
    const userRef = db.collection('users').doc(String(userId));
    await userRef.update({ 'stateData.messageViewIds': messageIds });
}

async function refreshAdminView(ctx, userId, buttonId, confirmationMessage = '✅ تم تحديث العرض.') {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
    }
    await sendButtonMessages(ctx, buttonId, true);
    await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
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
    if (isAdmin && currentPath === 'root') fixedButtons.push('👑 الإشراف');
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
            const baseControls = [
                Markup.button.callback('🔼', `msg:up:${messageId}`), Markup.button.callback('🔽', `msg:down:${messageId}`),
                Markup.button.callback('🗑️', `msg:delete:${messageId}`), Markup.button.callback('➕', `msg:addnext:${messageId}`)
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
            caption: message.caption || '', entities: message.entities,
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
// |                       Bot Commands & Logic                      |
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

        // --- Handle specific user states for receiving text/media input ---
        if (isAdmin && state !== 'NORMAL' && state !== 'EDITING_BUTTONS' && state !== 'EDITING_CONTENT') {
            
            if (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_REPLACEMENT_FILE' || state === 'AWAITING_EDITED_TEXT' || state === 'AWAITING_NEW_CAPTION') {
                const { buttonId, messageId, targetOrder } = stateData;
                if (!buttonId) {
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ حدث خطأ: لم يتم العثور على الزر. تم إلغاء العملية.");
                }

                if (state === 'AWAITING_EDITED_TEXT') {
                     if (!messageId) {
                         await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    if (!ctx.message.text) {
                        return ctx.reply('⚠️ الإجراء يتطلب نصًا فقط.');
                    }
                    await db.collection("messages").doc(messageId).update({ content: ctx.message.text, entities: ctx.message.entities || [], caption: '' });
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث النص بنجاح.');
                    return;
                }
                
                if (state === 'AWAITING_NEW_CAPTION') {
                     if (!messageId) {
                         await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    const newCaption = ctx.message.text || ctx.message.caption;
                    if (typeof newCaption !== 'string') {
                        return ctx.reply('⚠️ يرجى إرسال نص أو رسالة تحتوي على شرح.');
                    }
                    const newEntities = ctx.message.entities || ctx.message.caption_entities || [];
                    await db.collection("messages").doc(messageId).update({ caption: newCaption, entities: newEntities });
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
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
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    return ctx.reply("⚠️ نوع الرسالة غير مدعوم. تم إلغاء العملية.");
                }
                
                if (state === 'AWAITING_REPLACEMENT_FILE') {
                    if (!messageId) {
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل.");
                    }
                    await db.collection("messages").doc(messageId).update({ type, content, caption, entities });
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم استبدال الملف بنجاح.');
                } else { // AWAITING_NEW_MESSAGE
                    let order = 0;
                    if (typeof targetOrder === "number") {
                        order = targetOrder;
                    } else {
                        const lastMsg = await db.collection("messages").where("buttonId", "==", buttonId).orderBy("order", "desc").limit(1).get();
                        if (!lastMsg.empty) order = lastMsg.docs[0].data().order + 1;
                    }
                    await db.collection("messages").add({ buttonId, type, content, caption, entities, order });
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, buttonId, '✅ تم إضافة الرسالة بنجاح.');
                }
                return;
            }

            if (state === 'AWAITING_BROADCAST') {
                const allUsers = await db.collection('users').where('banned', '==', false).get();
                let successCount = 0; let failureCount = 0;
                const statusMessage = await ctx.reply(`⏳ جاري إرسال الرسالة إلى ${allUsers.size} مستخدم...`);
                for (const doc of allUsers.docs) {
                    try { await ctx.copyMessage(doc.id); successCount++; } 
                    catch (e) { failureCount++; console.error(`Failed to broadcast to user ${doc.id}:`, e.message); }
                }
                await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ تم الإرسال بنجاح إلى ${successCount} مستخدم.\n❌ فشل الإرسال إلى ${failureCount} مستخدم.`);
                await userRef.update({ state: 'NORMAL' });
                return;
            }

            if (state === 'AWAITING_WELCOME_MESSAGE') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال رسالة نصية فقط.');
                await db.collection('config').doc('settings').set({ welcomeMessage: ctx.message.text }, { merge: true });
                await ctx.reply('✅ تم تحديث رسالة الترحيب بنجاح.');
                await userRef.update({ state: 'NORMAL' });
                return;
            }

            if (state === 'AWAITING_NEW_BUTTON_NAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال اسم نصي فقط.');
                const newButtonName = ctx.message.text;
                const existingButton = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', newButtonName).limit(1).get();
                if (!existingButton.empty) {
                    await userRef.update({ state: 'EDITING_BUTTONS' });
                    return ctx.reply(`⚠️ يوجد زر بهذا الاسم بالفعل "${newButtonName}". تم إلغاء الإضافة.`);
                }
                const lastButton = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order', 'desc').limit(1).get();
                const newOrder = lastButton.empty ? 0 : lastButton.docs[0].data().order + 1;
                await db.collection('buttons').add({ text: newButtonName, parentId: currentPath, order: newOrder, adminOnly: false, isFullWidth: true });
                await userRef.update({ state: 'EDITING_BUTTONS' });
                await ctx.reply(`✅ تم إضافة الزر "${newButtonName}" بنجاح.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                return;
            }

            if (state === 'AWAITING_RENAME') {
                if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال اسم نصي فقط.');
                const newButtonName = ctx.message.text;
                const buttonIdToRename = stateData.buttonId;
                if (!buttonIdToRename) {
                     await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                     return ctx.reply('حدث خطأ، لم يتم العثور على الزر المراد تعديله.');
                }
                const buttonDoc = await db.collection('buttons').doc(buttonIdToRename).get();
                const parentId = buttonDoc.data().parentId;
                const existingButton = await db.collection('buttons').where('parentId', '==', parentId).where('text', '==', newButtonName).limit(1).get();
                if (!existingButton.empty && existingButton.docs[0].id !== buttonIdToRename) {
                    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply(`⚠️ يوجد زر آخر بهذا الاسم "${newButtonName}". تم إلغاء التعديل.`);
                }
                await db.collection('buttons').doc(buttonIdToRename).update({ text: newButtonName });
                await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
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
                    await userRef.update({ state: confirmationState, stateData: { targetAdminId, targetAdminName: userName } });
                    return ctx.reply(`👤 المستخدم: ${userName} (<code>${targetAdminId}</code>)\nهل أنت متأكد من ${actionText} هذا المستخدم كمشرف؟\nأرسل "نعم" للتأكيد.`, { parse_mode: 'HTML'});
                } catch (e) {
                    await userRef.update({ state: 'NORMAL' });
                    return ctx.reply("⚠️ لم يتم العثور على مستخدم بهذا الـ ID.");
                }
            }
            if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION' || state === 'AWAITING_REMOVE_ADMIN_CONFIRMATION') {
                if (ctx.message.text === 'نعم') {
                    const { targetAdminId, targetAdminName } = stateData;
                    const adminsRef = db.collection('config').doc('admins');
                    if (state === 'AWAITING_ADD_ADMIN_CONFIRMATION') {
                        await adminsRef.update({ ids: admin.firestore.FieldValue.arrayUnion(targetAdminId) });
                        await db.collection('users').doc(targetAdminId).update({ isAdmin: true });
                        await ctx.reply(`✅ تم إضافة ${targetAdminName} كمشرف بنجاح.`);
                    } else { // AWAITING_REMOVE_ADMIN_CONFIRMATION
                        await adminsRef.update({ ids: admin.firestore.FieldValue.arrayRemove(targetAdminId) });
                        await db.collection('users').doc(targetAdminId).update({ isAdmin: false });
                        await ctx.reply(`🗑️ تم حذف ${targetAdminName} من قائمة المشرفين.`);
                    }
                } else {
                    await ctx.reply("تم إلغاء العملية.");
                }
                await userRef.update({ state: 'NORMAL', stateData: {} });
                return;
            }
        }
        
        if (state === 'CONTACTING_ADMIN' || state === 'REPLYING_TO_ADMIN') {
            const adminsDoc = await db.collection('config').doc('admins').get();
            const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];
            if (adminIds.length === 0) {
                await userRef.update({ state: 'NORMAL' });
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
            await userRef.update({ state: 'NORMAL' });
            await ctx.reply('✅ تم إرسال رسالتك إلى الإدارة بنجاح.');
            return;
        }

        if (ctx.message && ctx.message.reply_to_message) {
            if (stateData.action === 'confirm_delete') {
                if (ctx.message.text === 'نعم') {
                    await db.collection('messages').doc(stateData.messageId).delete();
                    const remainingMsgs = await db.collection('messages').where('buttonId', '==', stateData.buttonId).orderBy('order').get();
                    const batch = db.batch();
                    remainingMsgs.docs.forEach((doc, i) => batch.update(doc.ref, { order: i }));
                    await batch.commit();
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, stateData.buttonId, '🗑️ تم الحذف بنجاح.');
                } else {
                    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                    await refreshAdminView(ctx, userId, stateData.buttonId, 'تم إلغاء عملية الحذف.');
                }
                return;
            }

            if (stateData.action === 'confirm_reorder') {
                if (ctx.message.text === 'نعم') {
                    const { buttonId, messageId, direction } = stateData;
                    const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
                    let messageList = messagesSnapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
                    const currentIndex = messageList.findIndex(m => m.id === messageId);
                    
                    let targetIndex = -1;
                    if (direction === 'up' && currentIndex > 0) targetIndex = currentIndex - 1;
                    else if (direction === 'down' && currentIndex < messageList.length - 1) targetIndex = currentIndex + 1;

                    if (targetIndex !== -1) {
                        [messageList[currentIndex], messageList[targetIndex]] = [messageList[targetIndex], messageList[currentIndex]];
                        const batch = db.batch();
                        messageList.forEach((msg, i) => batch.update(msg.ref, { order: i }));
                        await batch.commit();
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await refreshAdminView(ctx, userId, buttonId, '↕️ تم تحديث الترتيب.');
                    } else {
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await refreshAdminView(ctx, userId, buttonId, 'لم يتم تغيير الترتيب.');
                    }
                } else {
                     await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                     await refreshAdminView(ctx, userId, stateData.buttonId, 'تم إلغاء تغيير الترتيب.');
                }
                return;
            }
        }
        
        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;

        switch (text) {
            case '🔝 القائمة الرئيسية':
                await userRef.update({ currentPath: 'root', stateData: {} });
                return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '🔙 رجوع':
                const newPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
                await userRef.update({ currentPath: newPath, stateData: {} });
                return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '💬 التواصل مع الإدارة':
                await userRef.update({ state: 'CONTACTING_ADMIN' });
                return ctx.reply('أرسل رسالتك الآن (نص، صورة، ملف...)...');
            case '👑 الإشراف':
                if (isAdmin && currentPath === 'root') {
                    await userRef.update({ currentPath: 'supervision', stateData: {} });
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
                    await userRef.update({ 
                        state: 'AWAITING_NEW_MESSAGE',
                        stateData: { buttonId: currentPath.split('/').pop() }
                    });
                    return ctx.reply('📝 أرسل أو وجّه الرسالة الجديدة:', { reply_markup: { force_reply: true } });
                }
                break;
        }

        if (currentPath === 'supervision' && isAdmin) {
             switch (text) {
                case '📊 الإحصائيات':
                    const totalUsers = (await db.collection('users').get()).size;
                    const todayStr = new Date().toISOString().split('T')[0];
                    const dailyActiveUsers = (await db.collection('users').where('lastActive', '==', todayStr).get()).size;
                    const totalButtons = (await db.collection('buttons').get()).size;
                    const totalMessages = (await db.collection('messages').get()).size;
                    const statsMessage = `📊 <b>إحصائيات البوت:</b>\n\n` + `👤 المستخدمون: <code>${totalUsers}</code> (نشط اليوم: <code>${dailyActiveUsers}</code>)\n` + `🔘 الأزرار: <code>${totalButtons}</code>\n` + `✉️ الرسائل: <code>${totalMessages}</code>`;
                    return ctx.replyWithHTML(statsMessage);
                case '🗣️ رسالة جماعية':
                    await userRef.update({ state: 'AWAITING_BROADCAST' });
                    return ctx.reply('أرسل الآن الرسالة التي تريد بثها لجميع المستخدمين:');
                case '⚙️ تعديل المشرفين':
                     if (userId !== process.env.SUPER_ADMIN_ID) return ctx.reply('🚫 هذه الميزة للمشرف الرئيسي فقط.');
                    const adminsDoc = await db.collection('config').doc('admins').get();
                    let adminListText = '<b>المشرفون الحاليون:</b>\n';
                    if (adminsDoc.exists && adminsDoc.data().ids.length > 0) {
                        for (const adminId of adminsDoc.data().ids) {
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
                    await userRef.update({ state: 'AWAITING_WELCOME_MESSAGE' });
                    return ctx.reply('أرسل رسالة الترحيب الجديدة:');
                case '🚫 قائمة المحظورين':
                    const bannedUsersSnapshot = await db.collection('users').where('banned', '==', true).get();
                    if (bannedUsersSnapshot.empty) { return ctx.reply('لا يوجد مستخدمون محظورون حاليًا.'); }
                    await ctx.reply('قائمة المستخدمين المحظورين:');
                    for (const doc of bannedUsersSnapshot.docs) {
                        const bannedUserId = doc.id;
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
                const inlineKb = [[ Markup.button.callback('✏️', `btn:rename:${buttonId}`), Markup.button.callback('🗑️', `btn:delete:${buttonId}`), Markup.button.callback('📊', `btn:stats:${buttonId}`), Markup.button.callback('🔒', `btn:adminonly:${buttonId}`), Markup.button.callback('◀️', `btn:left:${buttonId}`), Markup.button.callback('🔼', `btn:up:${buttonId}`), Markup.button.callback('🔽', `btn:down:${buttonId}`), Markup.button.callback('▶️', `btn:right:${buttonId}`) ]];
                return ctx.reply(`خيارات للزر "${text}" (اضغط مرة أخرى للدخول):`, Markup.inlineKeyboard(inlineKb));
            }
        }
        
        const potentialNewPath = `${currentPath}/${buttonId}`;
        const subButtonsQuery = db.collection('buttons').where('parentId', '==', potentialNewPath).limit(1).get();
        const messagesQuery = db.collection('messages').where('buttonId', '==', buttonId).limit(1).get();
        const [subButtonsSnapshot, messagesSnapshot] = await Promise.all([subButtonsQuery, messagesQuery]);
        const hasSubButtons = !subButtonsSnapshot.empty;
        const hasMessages = !messagesSnapshot.empty;

        await updateButtonStats(buttonId, userId);

        if (isAdmin && (state === 'EDITING_CONTENT' || state === 'EDITING_BUTTONS')) {
             await userRef.update({ currentPath: potentialNewPath });
             if (hasSubButtons) {
                await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
                await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
             } else {
                const messageCount = await sendButtonMessages(ctx, buttonId, state === 'EDITING_CONTENT');
                if (messageCount > 0) {
                     await ctx.reply(`تم عرض المحتوى. استخدم الأزرار بالأسفل للرجوع.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                } else {
                    await ctx.reply('هذا الزر فارغ. يمكنك الآن إضافة رسائل.', Markup.keyboard(await generateKeyboard(userId)).resize());
                }
             }
        }
        else if (hasSubButtons) {
            await userRef.update({ currentPath: potentialNewPath });
            await sendButtonMessages(ctx, buttonId, false);
            await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
        } else if (hasMessages) {
            await sendButtonMessages(ctx, buttonId, false);
        } else {
            return ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
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
           if (subAction === 'reply') {
                await userRef.update({ state: 'AWAITING_ADMIN_REPLY', stateData: { targetUserId: targetId } });
                await ctx.answerCbQuery();
                return ctx.reply(`أرسل الآن ردك للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
            }
            if (subAction === 'ban') {
                await db.collection('users').doc(targetId).update({ banned: true });
                await ctx.answerCbQuery();
                await ctx.editMessageText(`🚫 تم حظر المستخدم <code>${targetId}</code> بنجاح.`, { parse_mode: 'HTML' });
                await bot.telegram.sendMessage(targetId, '🚫 لقد تم حظرك من استخدام هذا البوت.').catch(e => console.error(e.message));
                return;
            }
            if (subAction === 'unban') {
                await db.collection('users').doc(targetId).update({ banned: false });
                await ctx.answerCbQuery();
                await ctx.editMessageText(`✅ تم فك حظر المستخدم <code>${targetId}</code>.`, { parse_mode: 'HTML' });
                return;
            }
            if (userId !== process.env.SUPER_ADMIN_ID) return ctx.answerCbQuery('🚫 للمشرف الرئيسي فقط.', { show_alert: true });
            if (subAction === 'add') {
                await userRef.update({ state: 'AWAITING_ADMIN_ID_TO_ADD' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف الجديد:');
            }
            if (subAction === 'remove') {
                await userRef.update({ state: 'AWAITING_ADMIN_ID_TO_REMOVE' });
                await ctx.answerCbQuery();
                return ctx.editMessageText('أرسل ID المشرف للحذف:');
            }
        }
        if (action === 'btn') {
            if (['up', 'down', 'left', 'right'].includes(subAction)) {
                const buttonsSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order').get();
                let buttonList = buttonsSnapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
                const currentIndex = buttonList.findIndex(b => b.id === targetId);
                if (currentIndex === -1) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                let actionTaken = false;
                const batch = db.batch();
                
                if (subAction === 'up' || subAction === 'down') {
                    const buttonClicked = buttonList[currentIndex];
                    if (!buttonClicked.isFullWidth) {
                        const partnerIndex = (currentIndex % 2 === 0) ? currentIndex + 1 : currentIndex - 1;
                        if (partnerIndex >= 0 && partnerIndex < buttonList.length && !buttonList[partnerIndex].isFullWidth) {
                            batch.update(buttonClicked.ref, { isFullWidth: true });
                            batch.update(buttonList[partnerIndex].ref, { isFullWidth: true });
                            if (subAction === 'up' && currentIndex > partnerIndex) {
                               [buttonList[currentIndex], buttonList[partnerIndex]] = [buttonList[partnerIndex], buttonList[currentIndex]];
                            } else if (subAction === 'down' && currentIndex < partnerIndex) {
                               [buttonList[currentIndex], buttonList[partnerIndex]] = [buttonList[partnerIndex], buttonList[currentIndex]];
                            }
                            actionTaken = true;
                        }
                    } 
                    else {
                        if (subAction === 'up' && currentIndex > 0) {
                            const buttonAbove = buttonList[currentIndex - 1];
                            if (buttonAbove.isFullWidth) {
                                batch.update(buttonClicked.ref, { isFullWidth: false });
                                batch.update(buttonAbove.ref, { isFullWidth: false });
                                actionTaken = true;
                            }
                        } else if (subAction === 'down' && currentIndex < buttonList.length - 1) {
                             const buttonBelow = buttonList[currentIndex + 1];
                            if (buttonBelow.isFullWidth) {
                                batch.update(buttonClicked.ref, { isFullWidth: false });
                                batch.update(buttonBelow.ref, { isFullWidth: false });
                                actionTaken = true;
                            }
                        }
                        
                        if (!actionTaken) {
                            let rows = []; let currentRow = [];
                            buttonList.forEach(btn => {
                                currentRow.push(btn);
                                if (btn.isFullWidth || currentRow.length === 2) { rows.push(currentRow); currentRow = []; }
                            });
                            if (currentRow.length > 0) rows.push(currentRow);
                            const rowIndex = rows.findIndex(row => row.some(btn => btn.id === targetId));
                            
                            if (subAction === 'up' && rowIndex > 0) {
                                [rows[rowIndex], rows[rowIndex - 1]] = [rows[rowIndex - 1], rows[rowIndex]];
                                actionTaken = true;
                            } else if (subAction === 'down' && rowIndex < rows.length - 1) {
                                [rows[rowIndex], rows[rowIndex + 1]] = [rows[rowIndex + 1], rows[rowIndex]];
                                actionTaken = true;
                            }
                            if (actionTaken) { buttonList = rows.flat(); }
                        }
                    }
                } else if (subAction === 'left' || subAction === 'right') {
                    let swapIndex = -1;
                    if (subAction === 'right' && currentIndex % 2 === 0 && currentIndex + 1 < buttonList.length && !buttonList[currentIndex].isFullWidth && !buttonList[currentIndex + 1]?.isFullWidth) {
                        swapIndex = currentIndex + 1;
                    } else if (subAction === 'left' && currentIndex % 2 === 1 && !buttonList[currentIndex].isFullWidth && !buttonList[currentIndex - 1]?.isFullWidth) {
                        swapIndex = currentIndex - 1;
                    }
                    if (swapIndex !== -1) {
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
            await userRef.update({ stateData: {} });
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
            const messageDoc = await db.collection('messages').doc(targetId).get();
            if (!messageDoc.exists) return ctx.answerCbQuery('الرسالة غير موجودة');
            const { buttonId } = messageDoc.data();

            if (subAction === 'delete') {
                await userRef.update({ state: 'AWAITING_CONFIRMATION', stateData: { action: 'confirm_delete', messageId: targetId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply('🗑️ هل أنت متأكد من حذف هذه الرسالة؟\nأرسل "نعم" للتأكيد.', { reply_markup: { force_reply: true } });
            }
            if (subAction === 'up' || subAction === 'down') {
                await userRef.update({
                    state: 'AWAITING_CONFIRMATION',
                    stateData: { action: 'confirm_reorder', messageId: targetId, buttonId: buttonId, direction: subAction }
                });
                await ctx.answerCbQuery();
                const directionText = subAction === 'up' ? 'للأعلى' : 'للاسفل';
                return ctx.reply(`↕️ هل أنت متأكد من تحريك الرسالة ${directionText}؟\nأرسل "نعم" للتأكيد.`, {
                    reply_markup: { force_reply: true }
                });
            }
            if (subAction === 'edit') {
                await userRef.update({ state: 'AWAITING_REPLACEMENT_FILE', stateData: { messageId: targetId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه المحتوى الجديد:", { reply_markup: { force_reply: true } });
            }
            if (subAction === 'edit_caption') {
                await userRef.update({ state: 'AWAITING_NEW_CAPTION', stateData: { messageId: targetId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه رسالة تحتوي على الشرح الجديد:", { reply_markup: { force_reply: true } });
            }
            if (subAction === 'replace_file') {
                await userRef.update({ state: 'AWAITING_REPLACEMENT_FILE', stateData: { messageId: targetId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("🔄 أرسل أو وجّه الملف الجديد:", { reply_markup: { force_reply: true } });
            }
            if (subAction === 'addnext') {
                const msg = messageDoc.data();
                await userRef.update({ state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId, targetOrder: msg.order + 1 } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه الرسالة التالية:", { reply_markup: { force_reply: true } });
            }
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
