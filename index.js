// =================================================================
// |      TELEGRAM FIREBASE BOT - CLEANED & CORRECTED CODE         |
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

    // Logic for supervision menu
    if (currentPath === 'supervision') {
        keyboardRows = [
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
            ['🔙 رجوع']
        ];
        return keyboardRows;
    }

    const buttonsSnapshot = await db.collection('buttons')
      .where('parentId', '==', currentPath)
      .orderBy('order')
      .get();

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
      if (state === 'EDITING_BUTTONS' && currentPath !== 'supervision') {
        keyboardRows.push(['➕ إضافة زر']);
      }
      if (state === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
        keyboardRows.push(['➕ إضافة رسالة']);
      }
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
    
    if (isAdmin && currentPath !== 'supervision') {
      const adminControlRow = [];
      const editButtonsText = state === 'EDITING_BUTTONS' ? '🚫 إلغاء تعديل الأزرار' : '✏️ تعديل الأزرار';
      const editContentText = state === 'EDITING_CONTENT' ? '🚫 إلغاء تعديل المحتوى' : '📄 تعديل المحتوى';
      adminControlRow.push(editButtonsText, editContentText);
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
    const messagesSnapshot = await db.collection('messages')
        .where('buttonId', '==', buttonId)
        .orderBy('order')
        .get();

    if (messagesSnapshot.empty && !inEditMode) {
        await ctx.reply('لا يوجد محتوى مرتبط بهذا الزر بعد.');
        return;
    }

    for (const doc of messagesSnapshot.docs) {
        const message = doc.data();
        const messageId = doc.id;
        
        let inlineKeyboard = [];
        if (inEditMode) {
            inlineKeyboard = [
                [
                    Markup.button.callback('🗑️ حذف', `msg:delete:${messageId}`),
                    Markup.button.callback('✏️ تعديل', `msg:edit:${messageId}`),
                ],
                [
                    Markup.button.callback('🔼 للأعلى', `msg:up:${messageId}`),
                    Markup.button.callback('🔽 للأسفل', `msg:down:${messageId}`),
                ],
                [
                    Markup.button.callback('➕ إضافة تالية', `msg:addnext:${messageId}`),
                ]
            ];
        }

        const options = { 
            caption: message.caption || '',
            reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
        };

        try {
            switch (message.type) {
                case 'text':
                    await ctx.reply(message.content, options.reply_markup ? {reply_markup: options.reply_markup} : {});
                    break;
                case 'photo':
                    await ctx.replyWithPhoto(message.content, options);
                    break;
                case 'video':
                    await ctx.replyWithVideo(message.content, options);
                    break;
                case 'document':
                    await ctx.replyWithDocument(message.content, options);
                    break;
            }
        } catch (e) {
            console.error(`Failed to send message with file_id: ${message.content}`, e.message);
        }
    }
}

async function updateButtonStats(buttonId) {
    const today = new Date().toISOString().split('T')[0];
    const buttonRef = db.collection('buttons').doc(buttonId);
    
    await db.runTransaction(async (transaction) => {
        const buttonDoc = await transaction.get(buttonRef);
        if (!buttonDoc.exists) return;

        let stats = buttonDoc.data().stats || { totalClicks: 0, dailyClicks: 0, lastDay: '' };
        stats.totalClicks = (stats.totalClicks || 0) + 1;

        if (stats.lastDay === today) {
            stats.dailyClicks = (stats.dailyClicks || 0) + 1;
        } else {
            stats.dailyClicks = 1;
            stats.lastDay = today;
        }
        transaction.update(buttonRef, { stats });
    });
}


async function recursiveDeleteButton(buttonId) {
    const batch = db.batch();
    
    // Delete messages for the button
    const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
    messages.forEach(doc => batch.delete(doc.ref));

    // Find and recursively delete sub-buttons
    const subButtons = await db.collection('buttons').where('parentId', '==', buttonId).get();
    for (const sub of subButtons.docs) {
        await recursiveDeleteButton(sub.id); // This will handle nested deletions
    }

    // Delete the button itself
    const buttonRef = db.collection('buttons').doc(buttonId);
    batch.delete(buttonRef);

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

    let isAdmin = false;
    const adminsDoc = await db.collection('config').doc('admins').get();
    const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
    isAdmin = adminIds.includes(userId);

    if (!userDoc.exists) {
        await userRef.set({
            chatId: ctx.chat.id,
            isAdmin,
            currentPath: 'root',
            state: 'NORMAL',
            stateData: {},
            lastActive: today
        });
    } else {
        await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, isAdmin });
    }

    const settingsDoc = await db.collection('config').doc('settings').get();
    const welcomeMessage = settingsDoc.exists && settingsDoc.data().welcomeMessage ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';

    await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
});

bot.on('text', async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text;
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return bot.start(ctx);

    const userData = userDoc.data();
    const { currentPath, state, isAdmin, stateData } = userData;

    const today = new Date().toISOString().split('T')[0];
    await userRef.update({ lastActive: today });

    // --- State-based input handling ---
    if (isAdmin) {
        switch (state) {
            case 'AWAITING_NEW_BUTTON_NAME':
                const existing = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).get();
                if (!existing.empty) return ctx.reply('الاسم موجود مسبقاً، جرب اسماً آخر.');
                const buttons = await db.collection('buttons').where('parentId', '==', currentPath).get();
                const newOrder = buttons.size;
                await db.collection('buttons').add({
                    text, parentId: currentPath, adminOnly: false, order: newOrder,
                    stats: { totalClicks: 0, dailyClicks: 0, lastDay: '' }
                });
                await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                return ctx.reply('تم إضافة الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());

            case 'AWAITING_BUTTON_RENAME':
                await db.collection('buttons').doc(stateData.buttonId).update({ text });
                await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                return ctx.reply('تم تعديل الاسم.', Markup.keyboard(await generateKeyboard(userId)).resize());

            case 'AWAITING_WELCOME_MESSAGE':
                await db.collection('config').doc('settings').set({ welcomeMessage: text }, { merge: true });
                await userRef.update({ state: 'NORMAL', stateData: {} });
                return ctx.reply('تم تعديل رسالة الترحيب.', Markup.keyboard(await generateKeyboard(userId)).resize());

            case 'AWAITING_ADMIN_ADD':
                await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayUnion(text) });
                await userRef.update({ state: 'NORMAL', stateData: {} });
                return ctx.reply('تم إضافة المشرف.', Markup.keyboard(await generateKeyboard(userId)).resize());

            case 'AWAITING_ADMIN_REMOVE':
                await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayRemove(text) });
                await userRef.update({ state: 'NORMAL', stateData: {} });
                return ctx.reply('تم حذف المشرف.', Markup.keyboard(await generateKeyboard(userId)).resize());
            
            case 'AWAITING_MESSAGE_EDIT':
                await db.collection('messages').doc(stateData.messageId).update({ caption: text });
                await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                await ctx.reply('تم تعديل الشرح.');
                return sendButtonMessages(ctx, stateData.buttonId, true);

            case 'AWAITING_NEW_MESSAGE':
            case 'AWAITING_NEW_MESSAGE_NEXT':
                const buttonId = stateData.buttonId;
                const messages = (await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get()).docs.map(d => ({id: d.id, ...d.data()}));
                let newMsgOrder = messages.length;
                if (state === 'AWAITING_NEW_MESSAGE_NEXT') {
                    const targetOrder = stateData.targetOrder;
                    for (const m of messages.filter(m => m.order > targetOrder)) {
                        await db.collection('messages').doc(m.id).update({ order: m.order + 1 });
                    }
                    newMsgOrder = targetOrder + 1;
                }
                await db.collection('messages').add({
                    buttonId, type: 'text', content: text, caption: '', order: newMsgOrder
                });
                await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                await ctx.reply('تم إضافة النص.');
                return sendButtonMessages(ctx, buttonId, true);
        }
    }
    
    if (state === 'CONTACT_ADMIN') {
        const adminsDoc = await db.collection('config').doc('admins').get();
        const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
        for (const adminId of adminIds) {
            try { await ctx.forwardMessage(adminId); } catch (e) { console.error(e); }
        }
        await userRef.update({ state: 'NORMAL', stateData: {} });
        return ctx.reply('تم إرسال الرسالة إلى الإدارة.', Markup.keyboard(await generateKeyboard(userId)).resize());
    }

    // --- Fixed buttons and controls ---
    switch (text) {
        case '🔝 القائمة الرئيسية':
            await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
            return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
        case '🔙 رجوع':
            const parentPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
            await userRef.update({ currentPath: parentPath, stateData: {} });
            return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
        case '💬 التواصل مع الإدارة':
            await userRef.update({ state: 'CONTACT_ADMIN' });
            return ctx.reply('أرسل رسالتك إلى الإدارة:');
        case '👑 الإشراف':
            if (isAdmin) {
                await userRef.update({ currentPath: 'supervision' });
                return ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId)).resize());
            }
            break;
        case '✏️ تعديل الأزرار':
        case '🚫 إلغاء تعديل الأزرار':
            if (isAdmin) {
                const newButtonState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
                await userRef.update({ state: newButtonState });
                return ctx.reply(`وضع تعديل الأزرار: ${newButtonState === 'EDITING_BUTTONS' ? 'مفعل' : 'معطل'}`, Markup.keyboard(await generateKeyboard(userId)).resize());
            }
            break;
        case '📄 تعديل المحتوى':
        case '🚫 إلغاء تعديل المحتوى':
            if (isAdmin) {
                const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                await userRef.update({ state: newContentState });
                await ctx.reply(`وضع تعديل المحتوى: ${newContentState === 'EDITING_CONTENT' ? 'مفعل' : 'معطل'}`, Markup.keyboard(await generateKeyboard(userId)).resize());
                if (newContentState === 'EDITING_CONTENT') {
                    await sendButtonMessages(ctx, currentPath, true);
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
                await userRef.update({ state: 'AWAITING_NEW_MESSAGE', stateData: { buttonId: currentPath } });
                return ctx.reply('أرسل الرسالة الجديدة (نص، صورة، فيديو، ملف):');
            }
            break;
    }

    // --- Supervision menu buttons ---
    if (currentPath === 'supervision' && isAdmin) {
        switch (text) {
            case '📊 الإحصائيات':
                const totalUsers = (await db.collection('users').get()).size;
                const today = new Date().toISOString().split('T')[0];
                const dailyUsers = (await db.collection('users').where('lastActive', '==', today).get()).size;
                const totalButtons = (await db.collection('buttons').get()).size;
                const totalMessages = (await db.collection('messages').get()).size;
                return ctx.reply(`عدد المستخدمين الكلي: ${totalUsers}\nعدد المستخدمين اليومي: ${dailyUsers}\nعدد الأزرار: ${totalButtons}\nعدد الرسائل: ${totalMessages}`);
            case '🗣️ رسالة جماعية':
                await userRef.update({ state: 'AWAITING_BROADCAST' });
                return ctx.reply('أرسل الرسالة الجماعية الآن (نص، صورة، إلخ):');
            case '⚙️ تعديل المشرفين':
                const adminsDoc = await db.collection('config').doc('admins').get();
                const adminList = adminsDoc.exists ? adminsDoc.data().ids.join('\n') : 'لا يوجد';
                return ctx.reply(`المشرفون:\n${adminList}`, Markup.inlineKeyboard([
                    [Markup.button.callback('➕ إضافة', 'admin:add'), Markup.button.callback('➖ حذف', 'admin:remove')]
                ]));
            case '📝 تعديل رسالة الترحيب':
                await userRef.update({ state: 'AWAITING_WELCOME_MESSAGE' });
                return ctx.reply('أدخل رسالة الترحيب الجديدة:');
        }
    }

    // --- Dynamic button handling ---
    const buttonSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).limit(1).get();

    if (!buttonSnapshot.empty) {
        const buttonDoc = buttonSnapshot.docs[0];
        const buttonId = buttonDoc.id;

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            const inlineKb = [
                [Markup.button.callback('✏️ تعديل اسم', `btn:rename:${buttonId}`)],
                [Markup.button.callback('🗑️ حذف', `btn:delete:${buttonId}`)],
                [
                    Markup.button.callback('🔼', `btn:up:${buttonId}`), 
                    Markup.button.callback('🔽', `btn:down:${buttonId}`),
                    Markup.button.callback('◀️', `btn:left:${buttonId}`),
                    Markup.button.callback('▶️', `btn:right:${buttonId}`),
                ],
                [
                    Markup.button.callback('🔒 للمشرفين فقط', `btn:adminonly:${buttonId}`),
                    Markup.button.callback('📊 إحصائيات', `btn:stats:${buttonId}`),
                ]
            ];
            return ctx.reply(`خيارات للزر "${text}":`, Markup.inlineKeyboard(inlineKb));
        }

        await updateButtonStats(buttonId);

        const newPath = `${currentPath}/${buttonId}`;
        await userRef.update({ currentPath: newPath });
        await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
        await sendButtonMessages(ctx, newPath, state === 'EDITING_CONTENT');
    }
});

bot.on(['photo', 'video', 'document'], async (ctx) => {
    const userId = String(ctx.from.id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;
    const { state, isAdmin, stateData } = userDoc.data();

    if (isAdmin && (state === 'AWAITING_NEW_MESSAGE' || state === 'AWAITING_NEW_MESSAGE_NEXT' || state === 'AWAITING_MESSAGE_EDIT')) {
        let type, fileId, caption = ctx.message.caption || '';
        if (ctx.message.photo) { type = 'photo'; fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id; } 
        else if (ctx.message.video) { type = 'video'; fileId = ctx.message.video.file_id; } 
        else if (ctx.message.document) { type = 'document'; fileId = ctx.message.document.file_id; }

        const buttonId = stateData.buttonId;
        if (state === 'AWAITING_MESSAGE_EDIT') {
            await db.collection('messages').doc(stateData.messageId).update({ type, content: fileId, caption });
            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
            await ctx.reply('تم تعديل الرسالة.');
            return sendButtonMessages(ctx, buttonId, true);
        } else {
            const messages = (await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get()).docs.map(d => ({id: d.id, ...d.data()}));
            let newOrder = messages.length;
            if (state === 'AWAITING_NEW_MESSAGE_NEXT') {
                const targetOrder = stateData.targetOrder;
                for (const m of messages.filter(m => m.order > targetOrder)) {
                    await db.collection('messages').doc(m.id).update({ order: m.order + 1 });
                }
                newOrder = targetOrder + 1;
            }
            await db.collection('messages').add({ buttonId, type, content: fileId, caption, order: newOrder });
            await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
            await ctx.reply('تم إضافة المحتوى.');
            return sendButtonMessages(ctx, buttonId, true);
        }
    }
});

bot.on('message', async (ctx) => {
    const userId = String(ctx.from.id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;
    const { state, isAdmin } = userDoc.data();

    if (state === 'AWAITING_BROADCAST' && isAdmin) {
        const users = await db.collection('users').get();
        let successCount = 0;
        for (const user of users.docs) {
            try {
                await ctx.copyMessage(user.data().chatId);
                successCount++;
            } catch (e) { console.error(`Broadcast failed for user ${user.id}`); }
        }
        await userRef.update({ state: 'NORMAL' });
        await ctx.reply(`تم الإرسال الجماعي إلى ${successCount} مستخدم.`, Markup.keyboard(await generateKeyboard(userId)).resize());
    }
});

bot.on('callback_query', async (ctx) => {
    const userId = String(ctx.from.id);
    const data = ctx.callbackQuery.data;
    const [action, subAction, targetId] = data.split(':');

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists || !userDoc.data().isAdmin) return ctx.answerCbQuery('غير مصرح لك.');
    const { currentPath } = userDoc.data();

    if (action === 'admin') {
        if (subAction === 'add') {
            await userRef.update({ state: 'AWAITING_ADMIN_ADD' });
            return ctx.editMessageText('أدخل ID المشرف الجديد:');
        }
        if (subAction === 'remove') {
            await userRef.update({ state: 'AWAITING_ADMIN_REMOVE' });
            return ctx.editMessageText('أدخل ID المشرف لحذفه:');
        }
    }

    if (action === 'btn') {
        if (subAction === 'rename') {
            await userRef.update({ state: 'AWAITING_BUTTON_RENAME', stateData: { buttonId: targetId } });
            await ctx.answerCbQuery();
            return ctx.reply('أدخل الاسم الجديد:');
        }
        if (subAction === 'delete') {
            await recursiveDeleteButton(targetId);
            await ctx.answerCbQuery('تم الحذف');
            await ctx.editMessageText('تم حذف الزر وكل محتوياته.');
            return ctx.reply('تم تحديث القائمة.', Markup.keyboard(await generateKeyboard(userId)).resize());
        }
        if (['up', 'down', 'left', 'right'].includes(subAction)) {
            const buttonsSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order').get();
            const buttonList = buttonsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const index = buttonList.findIndex(b => b.id === targetId);
            if (index === -1) return ctx.answerCbQuery('خطأ');

            let swapIndex = -1;
            if (subAction === 'up' && index > 0) swapIndex = index - 1;
            if (subAction === 'down' && index < buttonList.length - 1) swapIndex = index + 1;
            if (subAction === 'left' && index > 0) swapIndex = index - 1;
            if (subAction === 'right' && index < buttonList.length - 1) swapIndex = index + 1;

            if (swapIndex !== -1) {
                const tempOrder = buttonList[index].order;
                await db.collection('buttons').doc(targetId).update({ order: buttonList[swapIndex].order });
                await db.collection('buttons').doc(buttonList[swapIndex].id).update({ order: tempOrder });
                await ctx.answerCbQuery('تم التحريك');
                await ctx.editMessageText('تم تحديث الترتيب.');
                return ctx.reply('تم تحديث القائمة.', Markup.keyboard(await generateKeyboard(userId)).resize());
            } else {
                return ctx.answerCbQuery('لا يمكن التحريك');
            }
        }
        if (subAction === 'adminonly') {
            const buttonDoc = await db.collection('buttons').doc(targetId).get();
            const adminOnly = !buttonDoc.data().adminOnly;
            await db.collection('buttons').doc(targetId).update({ adminOnly });
            return ctx.answerCbQuery(`الزر الآن ${adminOnly ? 'للمشرفين فقط' : 'للجميع'}`);
        }
        if (subAction === 'stats') {
            const buttonDoc = await db.collection('buttons').doc(targetId).get();
            const stats = buttonDoc.data().stats || { totalClicks: 0, dailyClicks: 0, lastDay: '' };
            const today = new Date().toISOString().split('T')[0];
            const daily = stats.lastDay === today ? stats.dailyClicks : 0;
            return ctx.answerCbQuery(`ضغطات اليوم: ${daily}\nضغطات كلية: ${stats.totalClicks}`, { show_alert: true });
        }
    }

    if (action === 'msg') {
        const messageDoc = await db.collection('messages').doc(targetId).get();
        if(!messageDoc.exists) return ctx.answerCbQuery('الرسالة غير موجودة');
        const buttonId = messageDoc.data().buttonId;

        if (subAction === 'delete') {
            await db.collection('messages').doc(targetId).delete();
            await ctx.answerCbQuery('تم الحذف');
            return sendButtonMessages(ctx, buttonId, true);
        }
        if (subAction === 'edit') {
            await userRef.update({ state: 'AWAITING_MESSAGE_EDIT', stateData: { messageId: targetId, buttonId: buttonId } });
            await ctx.answerCbQuery();
            return ctx.reply('أرسل المحتوى الجديد (أو الشرح الجديد للملف):');
        }
        if (subAction === 'up' || subAction === 'down') {
            const messagesSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).orderBy('order').get();
            const messageList = messagesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const index = messageList.findIndex(m => m.id === targetId);
            if (index === -1) return ctx.answerCbQuery('خطأ');

            let swapIndex = -1;
            if (subAction === 'up' && index > 0) swapIndex = index - 1;
            if (subAction === 'down' && index < messageList.length - 1) swapIndex = index + 1;

            if (swapIndex !== -1) {
                const tempOrder = messageList[index].order;
                await db.collection('messages').doc(targetId).update({ order: messageList[swapIndex].order });
                await db.collection('messages').doc(messageList[swapIndex].id).update({ order: tempOrder });
                await ctx.answerCbQuery('تم التحريك');
                return sendButtonMessages(ctx, buttonId, true);
            }
        }
        if (subAction === 'addnext') {
            const msg = messageDoc.data();
            await userRef.update({ state: 'AWAITING_NEW_MESSAGE_NEXT', stateData: { targetOrder: msg.order, buttonId: buttonId } });
            await ctx.answerCbQuery();
            return ctx.reply('أرسل الرسالة التالية:');
        }
    }
});

// --- 9. إعداد Vercel Webhook ---
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
