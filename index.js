// =================================================================
// |   TELEGRAM FIREBASE BOT - V56 - SINGLE-TRIP (NO CACHE)        |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (error) { console.error('Firebase Admin Initialization Error:', error.message); }
}
const db = admin.firestore();

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                 ⭐️ Modified Helper Functions ⭐️                 |
// =================================================================

async function getKeyboard(ctx, userDocData) {
    const keyboardRows = await generateKeyboardFromDB(userDocData);
    return Markup.keyboard(keyboardRows).resize();
}

async function getNavigationContext(currentPath, buttonText) {
    console.log(`[DB-FETCH] Fetching context from Firestore for ${currentPath}:${buttonText}`);
    
    const buttonQuery = db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', buttonText).limit(1);
    const buttonSnapshot = await buttonQuery.get();

    if (buttonSnapshot.empty) return null;

    const buttonDoc = buttonSnapshot.docs[0];
    const buttonData = buttonDoc.data();
    const buttonId = buttonDoc.id;
    const newPath = `${currentPath}/${buttonId}`;

    const newKeyboardButtonsQuery = db.collection('buttons').where('parentId', '==', newPath).orderBy('order').get();
    const messagesQuery = db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();

    const [newKeyboardSnapshot, messagesSnapshot] = await Promise.all([newKeyboardButtonsQuery, messagesQuery]);

    const messages = messagesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const context = {
        clickedButton: { id: buttonId, ...buttonData },
        newPath: newPath,
        messages: messages,
        hasSubButtons: !newKeyboardSnapshot.empty,
        hasMessages: messages.length > 0
    };

    return context;
}

// =================================================================
// |                 Original Helper Functions                     |
// =================================================================

async function trackSentMessages(userId, messageIds) {
    const userRef = db.collection('users').doc(String(userId));
    await userRef.update({ 'stateData.messageViewIds': messageIds });
}

async function getTopButtons(period) {
    const allButtonsSnapshot = await db.collection('buttons').get();
    let buttonStats = [];
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

    for (const doc of allButtonsSnapshot.docs) {
        const button = doc.data();
        const stats = button.stats || {};
        let clicks = 0; let users = 0;
        if (period === 'today') {
            clicks = stats.dailyClicks?.[todayStr] || 0;
            users = stats.dailyUsers?.[todayStr]?.length || 0;
        } else if (period === 'all_time') {
            clicks = stats.totalClicks || 0;
            users = stats.totalUsers?.length || 0;
        } else if (period === 'weekly') {
            let weeklyClicks = 0; let weeklyUsersSet = new Set();
            for (let i = 0; i < 7; i++) {
                const d = new Date(); d.setDate(d.getDate() - i);
                const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
                weeklyClicks += stats.dailyClicks?.[dateStr] || 0;
                if (stats.dailyUsers?.[dateStr]) {
                    stats.dailyUsers[dateStr].forEach(userId => weeklyUsersSet.add(userId));
                }
            }
            clicks = weeklyClicks; users = weeklyUsersSet.size;
        }
        if (clicks > 0) { buttonStats.push({ name: button.text, clicks: clicks, users: users }); }
    }
    buttonStats.sort((a, b) => b.clicks - a.clicks);
    const top10 = buttonStats.slice(0, 10);
    if (top10.length === 0) { return 'لا توجد بيانات لعرضها في هذه الفترة.'; }
    return top10.map((btn, index) => `${index + 1}. *${btn.name}*\n   - 🖱️ الضغطات: \`${btn.clicks}\`\n   - 👤 المستخدمون: \`${btn.users}\``).join('\n\n');
}

async function sendButtonMessages(ctx, buttonId, inEditMode = false) {
    const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
    const messages = messagesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    await sendMessages(ctx, messages, inEditMode);
}

async function refreshAdminView(ctx, userId, buttonId, confirmationMessage = '✅ تم تحديث العرض.') {
    const userRef = db.collection('users').doc(String(userId));
    const userDoc = await userRef.get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
    }
    await sendButtonMessages(ctx, buttonId, true);
    await ctx.reply(confirmationMessage, await getKeyboard(ctx, userDoc.data()));
}

async function generateKeyboardFromDB(userData) {
    try {
        const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userData;
        let keyboardRows = [];
        if (isAdmin && state === 'AWAITING_DESTINATION_PATH') {
            keyboardRows.unshift(['✅ النقل إلى هنا', '❌ إلغاء النقل']);
        }
        if (currentPath === 'supervision') {
            return [
                ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
                ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
                ['🚫 قائمة المحظورين'],
                ['🔙 رجوع', '🔝 القائمة الرئيسية']
            ];
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
        console.error('Error generating keyboard from DB:', error);
        return [['حدث خطأ في عرض الأزرار']];
    }
}

async function sendMessages(ctx, messages, inEditMode) {
    const sentMessageIds = [];
    if (messages.length === 0 && inEditMode) {
        if (ctx.from) await trackSentMessages(String(ctx.from.id), []);
        return 0;
    }
    for (const message of messages) {
        const messageId = message.id;
        let sentMessage;
        let inlineKeyboard = [];
        if (inEditMode) {
            const baseControls = [Markup.button.callback('🔼', `msg:up:${messageId}`), Markup.button.callback('🔽', `msg:down:${messageId}`), Markup.button.callback('🗑️', `msg:delete:${messageId}`), Markup.button.callback('➕', `msg:addnext:${messageId}`)];
            if (message.type === 'text') {
                baseControls.push(Markup.button.callback('✏️', `msg:edit:${messageId}`));
                inlineKeyboard = [baseControls];
            } else {
                inlineKeyboard = [baseControls, [Markup.button.callback('📝 تعديل الشرح', `msg:edit_caption:${messageId}`), Markup.button.callback('🔄 استبدال الملف', `msg:replace_file:${messageId}`)]];
            }
        }
        const options = { caption: message.caption || '', entities: message.entities, parse_mode: (message.entities && message.entities.length > 0) ? undefined : 'HTML', reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined };
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
        } catch (e) { console.error(`Failed to send message ID ${messageId} (type: ${message.type}) due to error:`, e.message); }
    }
    if (inEditMode && ctx.from) await trackSentMessages(String(ctx.from.id), sentMessageIds);
    return messages.length;
}

async function clearAndResendMessages(ctx, userId, buttonId) {
    const userRef = db.collection('users').doc(String(userId));
    const userDoc = await userRef.get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => console.error(`Could not delete message ${msgId}: ${err.message}`));
    }
    await sendButtonMessages(ctx, buttonId, true);
}

async function updateButtonStats(buttonId, userId) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
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

async function recursiveDeleteButton(buttonPath, statsUpdate = { buttons: 0, messages: 0 }) {
    const buttonId = buttonPath.split('/').pop();
    const subButtons = await db.collection('buttons').where('parentId', '==', buttonPath).get();
    for (const sub of subButtons.docs) {
        const subPath = `${buttonPath}/${sub.id}`;
        await recursiveDeleteButton(subPath, statsUpdate);
    }
    const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
    const batch = db.batch();
    messages.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('buttons').doc(buttonId));
    await batch.commit();
    statsUpdate.buttons++;
    statsUpdate.messages += messages.size;
    return statsUpdate;
}

async function moveBranch(sourceButtonId, newParentPath) {
    try {
        const sourceButtonRef = db.collection('buttons').doc(sourceButtonId);
        const sourceButtonDoc = await sourceButtonRef.get();
        if (!sourceButtonDoc.exists) throw new Error("Source button not found.");
        const sourceData = sourceButtonDoc.data();
        const oldParentPath = sourceData.parentId;
        const oldPath = `${oldParentPath}/${sourceButtonId}`;
        const newPath = `${newParentPath}/${sourceButtonId}`;
        const siblingsSnapshot = await db.collection('buttons').where('parentId', '==', newParentPath).orderBy('order', 'desc').limit(1).get();
        const newOrder = siblingsSnapshot.empty ? 0 : siblingsSnapshot.docs[0].data().order + 1;
        const batch = db.batch();
        batch.update(sourceButtonRef, { parentId: newParentPath, order: newOrder });
        async function findAndMoveDescendants(currentOldPath, currentNewPath) {
            const snapshot = await db.collection('buttons').where('parentId', '==', currentOldPath).get();
            if (snapshot.empty) return;
            for (const doc of snapshot.docs) {
                batch.update(doc.ref, { parentId: currentNewPath });
                await findAndMoveDescendants(`${currentOldPath}/${doc.id}`, `${currentNewPath}/${doc.id}`);
            }
        }
        await findAndMoveDescendants(oldPath, newPath);
        await batch.commit();
    } catch (error) { console.error(`[moveBranch Error]`, error); throw error; }
}

// =================================================================
// |                       Bot Commands & Logic                      |
// =================================================================

bot.start(async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
        const userRef = db.collection('users').doc(userId);
        let userDoc = await userRef.get();
        const adminsDoc = await db.collection('config').doc('admins').get();
        const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];
        const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
        const isAdmin = adminIds.includes(userId) || isSuperAdmin;
        if (!userDoc.exists) {
            await userRef.set({ chatId: ctx.chat.id, isAdmin, currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, banned: false });
            userDoc = await userRef.get(); // Re-fetch
            await db.collection('config').doc('stats').set({ totalUsers: admin.firestore.FieldValue.increment(1) }, { merge: true });
            if (adminIds.length > 0) {
                const statsDoc = await db.collection('config').doc('stats').get();
                const totalUsers = statsDoc.data()?.totalUsers || 1;
                const user = ctx.from;
                const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
                const userLink = `tg://user?id=${user.id}`;
                const language = user.language_code || 'غير محدد';
                const isPremium = user.is_premium ? 'نعم ✅' : 'لا ❌';
                let notificationMessage = `👤 <b>مستخدم جديد انضم!</b>\n\n` + `<b>الاسم:</b> <a href="${userLink}">${userName}</a>\n` + `<b>المعرف:</b> ${user.username ? `@${user.username}` : 'لا يوجد'}\n` + `<b>ID:</b> <code>${user.id}</code>\n` + `<b>لغة التلجرام:</b> ${language}\n` + `<b>حساب بريميوم:</b> ${isPremium}\n\n` + `👥 أصبح العدد الكلي للمستخدمين: <b>${totalUsers}</b>`;
                for (const adminId of adminIds) {
                    try { await bot.telegram.sendMessage(adminId, notificationMessage, { parse_mode: 'HTML' }); } catch (e) { console.error(`Failed to send new user notification to admin ${adminId}:`, e.message); }
                }
            }
        } else {
             if(userDoc.data().isAdmin !== isAdmin){
                 await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, isAdmin });
            } else {
                 await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
            }
            userDoc = await userRef.get(); // Re-fetch
        }
        const settingsDoc = await db.collection('config').doc('settings').get();
        const welcomeMessage = (settingsDoc.exists && settingsDoc.data().welcomeMessage) ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';
        await ctx.reply(welcomeMessage, await getKeyboard(ctx, userDoc.data()));
    } catch (error) { console.error("FATAL ERROR in bot.start:", error, "Update:", ctx.update); }
});

const mainMessageHandler = async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const text = ctx.message?.text;
        if (!text) return;

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return bot.start(ctx);

        let userData = userDoc.data();
        let { currentPath, state, isAdmin, stateData, banned } = userData;
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        
        // This large block handles all special cases, admin commands, and user input states
        if (isAdmin || state !== 'NORMAL') {
            const navigationCommands = { '🔝 القائمة الرئيسية': 'root', '🔙 رجوع': currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root') };
            if (navigationCommands[text] && state !== 'AWAITING_DESTINATION_PATH') {
                const newPath = navigationCommands[text];
                await userRef.update({ currentPath: newPath, state: 'NORMAL', stateData: {} });
                const updatedUserDoc = await userRef.get();
                return ctx.reply('...', await getKeyboard(ctx, updatedUserDoc.data()));
            } else if (navigationCommands[text] && state === 'AWAITING_DESTINATION_PATH') {
                 const newPath = navigationCommands[text];
                 await userRef.update({ currentPath: newPath });
                 const updatedUserDoc = await userRef.get();
                 return ctx.reply('...', await getKeyboard(ctx, updatedUserDoc.data()));
            }

            if (isAdmin) {
                switch (text) {
                    case '✏️ تعديل الأزرار': case '🚫 إلغاء تعديل الأزرار': {
                        const newState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
                        await userRef.update({ state: newState, stateData: {} });
                        const updatedUserDoc = await userRef.get();
                        return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, await getKeyboard(ctx, updatedUserDoc.data()));
                    }
                    case '📄 تعديل المحتوى': case '🚫 إلغاء تعديل المحتوى': {
                        const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                        await userRef.update({ state: newContentState, stateData: {} });
                        const updatedUserDoc = await userRef.get();
                        await ctx.reply(`تم ${newContentState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل المحتوى.`, await getKeyboard(ctx, updatedUserDoc.data()));
                        if (newContentState === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                            const buttonId = currentPath.split('/').pop();
                            await clearAndResendMessages(ctx, userId, buttonId);
                        }
                        return;
                    }
                    case '➕ إضافة زر':
                        if (state === 'EDITING_BUTTONS') {
                            await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME' });
                            return ctx.reply('أدخل اسم الزر الجديد:');
                        }
                        break;
                    case '➕ إضافة رسالة':
                        if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                            await userRef.update({ state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId: currentPath.split('/').pop() } });
                            return ctx.reply('📝 أرسل أو وجّه الرسالة الجديدة:', { reply_markup: { force_reply: true } });
                        }
                        break;
                    // Other admin commands can be placed here...
                }
            }

            if (state !== 'NORMAL' && state !== 'EDITING_BUTTONS' && state !== 'EDITING_CONTENT') {
                if (state === 'AWAITING_ADMIN_REPLY') {
                    const { targetUserId } = stateData;
                    if (!targetUserId) {
                        await userRef.update({ state: 'NORMAL', stateData: {} });
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
                        await userRef.update({ state: 'NORMAL', stateData: {} });
                    }
                    return;
                }
    
                if (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_REPLACEMENT_FILE' || state === 'AWAITING_EDITED_TEXT' || state === 'AWAITING_NEW_CAPTION') {
                    const { buttonId, messageId, targetOrder } = stateData;
                    if (!buttonId) {
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        return ctx.reply("⚠️ حدث خطأ: لم يتم العثور على الزر. تم إلغاء العملية.");
                    }
                    
                    if (state === 'AWAITING_EDITED_TEXT') {
                         if (!messageId) { await userRef.update({ state: 'EDITING_CONTENT', stateData: {} }); return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل."); }
                        if (!ctx.message.text) { return ctx.reply('⚠️ الإجراء يتطلب نصًا فقط.'); }
                        await db.collection("messages").doc(messageId).update({ content: ctx.message.text, entities: ctx.message.entities || [], caption: '' });
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await refreshAdminView(ctx, userId, buttonId, '✅ تم تحديث النص بنجاح.');
                        return;
                    }
                    
                    if (state === 'AWAITING_NEW_CAPTION') {
                         if (!messageId) { await userRef.update({ state: 'EDITING_CONTENT', stateData: {} }); return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل."); }
                        const newCaption = ctx.message.text || ctx.message.caption;
                        if (typeof newCaption !== 'string') { return ctx.reply('⚠️ يرجى إرسال نص أو رسالة تحتوي على شرح.');}
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
                    else { await userRef.update({ state: 'EDITING_CONTENT', stateData: {} }); return ctx.reply("⚠️ نوع الرسالة غير مدعوم. تم إلغاء العملية.");}
                    
                    if (state === 'AWAITING_REPLACEMENT_FILE') {
                        if (!messageId) { await userRef.update({ state: 'EDITING_CONTENT', stateData: {} }); return ctx.reply("⚠️ حدث خطأ. تم إلغاء التعديل."); }
                        await db.collection("messages").doc(messageId).update({ type, content, caption, entities });
                        await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                        await refreshAdminView(ctx, userId, buttonId, '✅ تم استبدال الملف بنجاح.');
                    } else { // AWAITING_NEW_MESSAGE
                        let order = 0;
                        if (typeof targetOrder === "number") { order = targetOrder; } else {
                            const lastMsg = await db.collection("messages").where("buttonId", "==", buttonId).orderBy("order", "desc").limit(1).get();
                            if (!lastMsg.empty) order = lastMsg.docs[0].data().order + 1;
                        }
                        await db.collection("messages").add({ buttonId, type, content, caption, entities, order });
                        await db.collection('config').doc('stats').set({ totalMessages: admin.firestore.FieldValue.increment(1) }, { merge: true });
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
                    if (!existingButton.empty) { await userRef.update({ state: 'EDITING_BUTTONS' }); return ctx.reply(`⚠️ يوجد زر بهذا الاسم بالفعل "${newButtonName}". تم إلغاء الإضافة.`); }
                    const lastButton = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order', 'desc').limit(1).get();
                    const newOrder = lastButton.empty ? 0 : lastButton.docs[0].data().order + 1;
                    await db.collection('buttons').add({ text: newButtonName, parentId: currentPath, order: newOrder, adminOnly: false, isFullWidth: true });
                    await db.collection('config').doc('stats').set({ totalButtons: admin.firestore.FieldValue.increment(1) }, { merge: true });
                    await userRef.update({ state: 'EDITING_BUTTONS' });
                    const updatedUserDoc = await userRef.get();
                    await ctx.reply(`✅ تم إضافة الزر "${newButtonName}" بنجاح.`, await getKeyboard(ctx, updatedUserDoc.data()));
                    return;
                }
                if (state === 'AWAITING_RENAME') {
                    if (!ctx.message.text) return ctx.reply('⚠️ يرجى إرسال اسم نصي فقط.');
                    const newButtonName = ctx.message.text;
                    const buttonIdToRename = stateData.buttonId;
                    if (!buttonIdToRename) { await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} }); return ctx.reply('حدث خطأ، لم يتم العثور على الزر المراد تعديله.'); }
                    const buttonDoc = await db.collection('buttons').doc(buttonIdToRename).get();
                    const parentId = buttonDoc.data().parentId;
                    const existingButton = await db.collection('buttons').where('parentId', '==', parentId).where('text', '==', newButtonName).limit(1).get();
                    if (!existingButton.empty && existingButton.docs[0].id !== buttonIdToRename) { await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} }); return ctx.reply(`⚠️ يوجد زر آخر بهذا الاسم "${newButtonName}". تم إلغاء التعديل.`); }
                    await db.collection('buttons').doc(buttonIdToRename).update({ text: newButtonName });
                    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                    const updatedUserDoc = await userRef.get();
                    await ctx.reply(`✅ تم تعديل اسم الزر إلى "${newButtonName}".`, await getKeyboard(ctx, updatedUserDoc.data()));
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
                            await adminsRef.set({ ids: admin.firestore.FieldValue.arrayUnion(targetAdminId) }, { merge: true });
                            await db.collection('users').doc(targetAdminId).set({ isAdmin: true }, { merge: true });
                            await ctx.reply(`✅ تم إضافة ${targetAdminName} كمشرف بنجاح.`);
                        } else { 
                            if (targetAdminId === process.env.SUPER_ADMIN_ID) { await ctx.reply('🚫 لا يمكن حذف الأدمن الرئيسي.');} else {
                               await adminsRef.update({ ids: admin.firestore.FieldValue.arrayRemove(targetAdminId) });
                               await db.collection('users').doc(targetAdminId).update({ isAdmin: false });
                               await ctx.reply(`🗑️ تم حذف ${targetAdminName} من قائمة المشرفين.`);
                            }
                        }
                    } else { await ctx.reply("تم إلغاء العملية."); }
                    await userRef.update({ state: 'NORMAL', stateData: {} });
                    return;
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
                    await ctx.reply('✅ تم إرسال رسالتك إلى الأدمن بنجاح.');
                    return;
                }
            }
        }
        
        // --- 2. Main navigation logic using the smart function ---
        const context = await getNavigationContext(currentPath, text);
        
        if (!context) return; 

        const { clickedButton, newPath, hasSubButtons, hasMessages, messages } = context;

        if (clickedButton.adminOnly && !isAdmin) {
            return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        await updateButtonStats(clickedButton.id, userId);
        await userRef.update({ lastActive: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }) });
        
        const canEnter = hasSubButtons || (isAdmin && ['EDITING_CONTENT', 'EDITING_BUTTONS', 'AWAITING_DESTINATION_PATH'].includes(state));
        
        if (canEnter) {
            await userRef.update({ currentPath: newPath });
            const updatedUserDoc = await userRef.get();
            
            if (messages.length > 0) {
                 await sendMessages(ctx, messages, state === 'EDITING_CONTENT');
            }
           
            let replyText = `أنت الآن في قسم: ${clickedButton.text}`;
            if (!hasMessages && !hasSubButtons && isAdmin) {
                replyText = 'هذا الزر فارغ تمامًا.';
            }
            await ctx.reply(replyText, await getKeyboard(ctx, updatedUserDoc.data()));

        } else if (hasMessages) {
             await sendMessages(ctx, messages, false);
        } else {
            await ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
        }

    } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        console.error("Caused by update:", JSON.stringify(ctx.update, null, 2));
        await ctx.reply("حدث خطأ فادح. تم إبلاغ المطور.");
    }
};

bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    // The full callback_query handler from your original file goes here.
    // Make sure to remove any `invalidateCaches` calls if you added them previously.
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

        if (action === 'confirm_delete_button') {
            if (subAction === 'no') { await ctx.editMessageText('👍 تم إلغاء عملية الحذف.'); return ctx.answerCbQuery(); }
            if (subAction === 'yes') {
                await ctx.editMessageText('⏳ جارٍ الحذف...');
                const deletedCounts = await recursiveDeleteButton(`${currentPath}/${targetId}`);
                if (deletedCounts.buttons > 0 || deletedCounts.messages > 0) {
                    const statsRef = db.collection('config').doc('stats');
                    await statsRef.set({ totalButtons: admin.firestore.FieldValue.increment(-deletedCounts.buttons), totalMessages: admin.firestore.FieldValue.increment(-deletedCounts.messages) }, { merge: true });
                }
                await ctx.deleteMessage().catch(()=>{});
                const updatedUserDoc = await userRef.get();
                await ctx.reply('🗑️ تم الحذف بنجاح.', await getKeyboard(ctx, updatedUserDoc.data()));
                return ctx.answerCbQuery('✅ تم الحذف');
            }
        }
        if (action === 'admin') {
           if (subAction === 'reply') {
                await userRef.update({ state: 'AWAITING_ADMIN_REPLY', stateData: { targetUserId: targetId } });
                await ctx.answerCbQuery();
                return ctx.reply(`أرسل الآن ردك للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
            }
            if (subAction === 'ban') {
                if (targetId === process.env.SUPER_ADMIN_ID) { return ctx.answerCbQuery('🚫 لا يمكن حظر الأدمن الرئيسي.', { show_alert: true }); }
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
                const buttonList = buttonsSnapshot.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
                let rows = []; let currentRow = [];
                buttonList.forEach(btn => {
                    currentRow.push(btn);
                    if (btn.isFullWidth || currentRow.length === 2) { rows.push(currentRow); currentRow = []; }
                });
                if (currentRow.length > 0) rows.push(currentRow);
                let targetRowIndex = -1; let targetColIndex = -1;
                rows.find((row, rIndex) => {
                    const cIndex = row.findIndex(b => b.id === targetId);
                    if (cIndex !== -1) { targetRowIndex = rIndex; targetColIndex = cIndex; return true; }
                    return false;
                });
                if (targetRowIndex === -1) return ctx.answerCbQuery('!خطأ في إيجاد الزر');
                let actionTaken = false;
                if (subAction === 'up') {
                    const isHalfWidth = rows[targetRowIndex].length > 1;
                    if (isHalfWidth) { const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0]; const self = rows[targetRowIndex][targetColIndex]; rows.splice(targetRowIndex, 1, [self], [partner]); actionTaken = true; }
                    else if (targetRowIndex > 0) { const rowAbove = rows[targetRowIndex - 1]; if (rowAbove.length === 1) { const buttonAbove = rowAbove[0]; const self = rows[targetRowIndex][0]; rows[targetRowIndex - 1] = [buttonAbove, self]; rows.splice(targetRowIndex, 1); actionTaken = true; } }
                } else if (subAction === 'down') {
                    const isHalfWidth = rows[targetRowIndex].length > 1;
                    if (isHalfWidth) { const partner = rows[targetRowIndex][targetColIndex === 0 ? 1 : 0]; const self = rows[targetRowIndex][targetColIndex]; rows.splice(targetRowIndex, 1, [partner], [self]); actionTaken = true; }
                    else if (targetRowIndex < rows.length - 1) { const rowBelow = rows[targetRowIndex + 1]; if (rowBelow.length === 1) { const buttonBelow = rowBelow[0]; const self = rows[targetRowIndex][0]; rows.splice(targetRowIndex, 1); rows[targetRowIndex] = [self, buttonBelow]; actionTaken = true; } }
                } else if (subAction === 'left' || subAction === 'right') {
                    if (rows[targetRowIndex].length > 1) { [rows[targetRowIndex][0], rows[targetRowIndex][1]] = [rows[targetRowIndex][1], rows[targetRowIndex][0]]; actionTaken = true; }
                }
                if (actionTaken) {
                    const newButtonList = rows.flat();
                    const batch = db.batch();
                    newButtonList.forEach((button, index) => {
                        const newIsFullWidth = rows.find(r => r.some(b => b.id === button.id)).length === 1;
                        batch.update(button.ref, { order: index, isFullWidth: newIsFullWidth });
                    });
                    await batch.commit();
                    await db.collection('users').doc(userId).update({ stateData: {} });
                    await ctx.answerCbQuery('✅ تم');
                    await ctx.deleteMessage().catch(()=>{});
                    const updatedUserDoc = await userRef.get();
                    await ctx.reply('تم تحديث لوحة المفاتيح.', await getKeyboard(ctx, updatedUserDoc.data()));
                } else { await ctx.answerCbQuery('لا يمكن التحريك'); }
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
            const buttonDoc = await db.collection('buttons').doc(targetId).get();
            if (!buttonDoc.exists) return ctx.answerCbQuery('الزر غير موجود بالفعل.');
            const confirmationKeyboard = Markup.inlineKeyboard([ Markup.button.callback('✅ نعم، قم بالحذف', `confirm_delete_button:yes:${targetId}`), Markup.button.callback('❌ إلغاء', `confirm_delete_button:no:${targetId}`) ]);
            await ctx.editMessageText(`🗑️ هل أنت متأكد من حذف الزر "${buttonDoc.data().text}" وكل ما بداخله؟ هذا الإجراء لا يمكن التراجع عنه.`, confirmationKeyboard);
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
                const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
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
                await userRef.update({ state: 'AWAITING_CONFIRMATION', stateData: { action: 'confirm_reorder', messageId: targetId, buttonId: buttonId, direction: subAction } });
                await ctx.answerCbQuery();
                const directionText = subAction === 'up' ? 'للأعلى' : 'للاسفل';
                return ctx.reply(`↕️ هل أنت متأكد من تحريك الرسالة ${directionText}؟\nأرسل "نعم" للتأكيد.`, { reply_markup: { force_reply: true } });
            }
            if (subAction === 'edit') {
                await userRef.update({ state: 'AWAITING_REPLACEMENT_FILE', stateData: { messageId: targetId, buttonId: buttonId } });
                await ctx.answerCbQuery();
                return ctx.reply("📝 أرسل أو وجّه المحتوى الجديد (نص أو ملف):", { reply_markup: { force_reply: true } });
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
