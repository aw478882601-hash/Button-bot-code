// =================================================================
// |      TELEGRAM FIREBASE BOT - V5 - SUPER ADMIN & FULL STATS    |
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

    // قائمة الإشراف لها أزرار ثابتة
    if (currentPath === 'supervision') {
        keyboardRows = [
            ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
            ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
            ['🔙 رجوع']
        ];
        // زر القائمة الرئيسية يظهر دائمًا في الإشراف للعودة السريعة
        keyboardRows.push(['🔝 القائمة الرئيسية']);
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
    
    // **FIXED**: Admin control buttons now show correctly
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
        return ctx.reply('لا يوجد محتوى مرتبط بهذا الزر بعد.');
    }

    for (const doc of messagesSnapshot.docs) {
        const message = doc.data();
        const messageId = doc.id;
        
        let inlineKeyboard = [];
        if (inEditMode) {
            inlineKeyboard.push([
                Markup.button.callback('🗑️ حذف', `msg:delete:${messageId}`),
                Markup.button.callback('✏️ تعديل', `msg:edit:${messageId}`),
            ]);
            inlineKeyboard.push([
                Markup.button.callback('🔼 للأعلى', `msg:up:${messageId}`),
                Markup.button.callback('🔽 للأسفل', `msg:down:${messageId}`),
            ]);
            inlineKeyboard.push([Markup.button.callback('➕ إضافة تالية', `msg:addnext:${messageId}`)]);
        }

        const options = { 
            caption: message.caption || '',
            reply_markup: inEditMode && inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
        };

        try {
            switch (message.type) {
                case 'text': await ctx.reply(message.content, options.reply_markup ? {reply_markup: options.reply_markup} : {}); break;
                case 'photo': await ctx.replyWithPhoto(message.content, options); break;
                case 'video': await ctx.replyWithVideo(message.content, options); break;
                case 'document': await ctx.replyWithDocument(message.content, options); break;
            }
        } catch (e) { console.error(`Failed to send message with file_id: ${message.content}`, e.message); }
    }
}

// **NEW**: Enhanced stats update function
async function updateButtonStats(buttonId, userId) {
    const today = new Date().toISOString().split('T')[0];
    const buttonRef = db.collection('buttons').doc(buttonId);
    
    await db.runTransaction(async (transaction) => {
        const buttonDoc = await transaction.get(buttonRef);
        if (!buttonDoc.exists) return;

        let stats = buttonDoc.data().stats || {};
        
        // Clicks stats
        stats.totalClicks = (stats.totalClicks || 0) + 1;
        stats.dailyClicks = stats.dailyClicks || {};
        stats.dailyClicks[today] = (stats.dailyClicks[today] || 0) + 1;

        // Users stats
        stats.totalUsers = stats.totalUsers || [];
        if (!stats.totalUsers.includes(userId)) {
            stats.totalUsers.push(userId);
        }
        
        stats.dailyUsers = stats.dailyUsers || {};
        stats.dailyUsers[today] = stats.dailyUsers[today] || [];
        if (!stats.dailyUsers[today].includes(userId)) {
            stats.dailyUsers[today].push(userId);
        }

        transaction.update(buttonRef, { stats });
    });
}

async function recursiveDeleteButton(buttonId) {
    // This function needs to be improved to handle large-scale deletions,
    // but for now, it works for simple cases.
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
    const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
    const isAdmin = adminIds.includes(userId);

    if (!userDoc.exists) {
        await userRef.set({
            chatId: ctx.chat.id, isAdmin, currentPath: 'root',
            state: 'NORMAL', stateData: {}, lastActive: today
        });
        
        // **NEW**: New user notification
        if (adminIds.length > 0) {
            const superAdminId = adminIds[0]; // The first admin is the super admin
            const userName = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
            const userLink = `tg://user?id=${userId}`;
            try {
                await bot.telegram.sendMessage(superAdminId, `👤 مستخدم جديد انضم!\n\nالاسم: <a href="${userLink}">${userName}</a>\nID: <code>${userId}</code>`, { parse_mode: 'HTML' });
            } catch (e) { console.error("Failed to send new user notification", e); }
        }

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
    let { currentPath, state, isAdmin, stateData } = userData;

    await userRef.update({ lastActive: new Date().toISOString().split('T')[0] });

    // --- State-based input handling ---
    if (isAdmin) {
        switch (state) {
            case 'AWAITING_NEW_BUTTON_NAME':
                const existing = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).get();
                if (!existing.empty) return ctx.reply('الاسم موجود مسبقاً.');
                const count = (await db.collection('buttons').where('parentId', '==', currentPath).get()).size;
                await db.collection('buttons').add({ text, parentId: currentPath, order: count, adminOnly: false, stats: {} });
                await userRef.update({ state: 'EDITING_BUTTONS' });
                return ctx.reply('✅ تم إضافة الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());
            // ... other states
        }
    }
    
    // --- Fixed buttons and controls ---
    switch (text) {
        case '🔝 القائمة الرئيسية':
            await userRef.update({ currentPath: 'root', state: 'NORMAL' });
            return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
        case '🔙 رجوع':
            const parentPath = currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root');
            await userRef.update({ currentPath: parentPath });
            return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
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
                await userRef.update({ state: newState });
                return ctx.reply(`تم تحديث الوضع.`, Markup.keyboard(await generateKeyboard(userId)).resize());
            }
            break;
        case '📄 تعديل المحتوى':
        case '🚫 إلغاء تعديل المحتوى':
            if (isAdmin) {
                const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                await userRef.update({ state: newContentState });
                await ctx.reply(`تم تحديث الوضع.`, Markup.keyboard(await generateKeyboard(userId)).resize());
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
        // ... other fixed buttons
    }

    // --- Supervision menu buttons ---
    if (currentPath === 'supervision' && isAdmin) {
        switch (text) {
            case '⚙️ تعديل المشرفين':
                const adminsDoc = await db.collection('config').doc('admins').get();
                const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
                const superAdminId = adminIds.length > 0 ? adminIds[0] : null;

                if (userId !== superAdminId) {
                    return ctx.reply('🚫 هذه الميزة مخصصة للمشرف الرئيسي فقط.');
                }
                
                const adminList = adminIds.join('\n') || 'لا يوجد';
                return ctx.reply(`المشرفون:\n${adminList}`, Markup.inlineKeyboard([
                    [Markup.button.callback('➕ إضافة', 'admin:add'), Markup.button.callback('➖ حذف', 'admin:remove')]
                ]));
            // ... other supervision buttons
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

        // **NEW**: Pass userId to stats function
        await updateButtonStats(buttonId, userId);

        const newPath = `${currentPath}/${buttonId}`;
        await userRef.update({ currentPath: newPath });
        await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
        await sendButtonMessages(ctx, newPath, state === 'EDITING_CONTENT');
    }
});

// --- Callback Query Handler ---
bot.on('callback_query', async (ctx) => {
    const userId = String(ctx.from.id);
    const data = ctx.callbackQuery.data;
    const [action, subAction, targetId] = data.split(':');

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists || !userDoc.data().isAdmin) return ctx.answerCbQuery('غير مصرح لك.');
    
    // **NEW**: Enhanced stats display
    if (action === 'btn' && subAction === 'stats') {
        const buttonDoc = await db.collection('buttons').doc(targetId).get();
        if (!buttonDoc.exists) return ctx.answerCbQuery('الزر غير موجود.');

        const stats = buttonDoc.data().stats || {};
        const today = new Date().toISOString().split('T')[0];

        const totalClicks = stats.totalClicks || 0;
        const dailyClicks = stats.dailyClicks ? (stats.dailyClicks[today] || 0) : 0;
        const totalUsers = stats.totalUsers ? stats.totalUsers.length : 0;
        const dailyUsers = stats.dailyUsers && stats.dailyUsers[today] ? stats.dailyUsers[today].length : 0;

        const statsMessage = `📊 إحصائيات الزر:\n\n` +
                             `👆 الضغطات:\n` +
                             `  - اليوم: ${dailyClicks}\n` +
                             `  - الكلي: ${totalClicks}\n\n` +
                             `👤 المستخدمون:\n` +
                             `  - اليوم: ${dailyUsers}\n` +
                             `  - الكلي: ${totalUsers}`;

        return ctx.answerCbQuery(statsMessage, { show_alert: true });
    }

    // ... other callback handlers ...
});


// --- Media and Message Handlers ---
bot.on(['photo', 'video', 'document'], async (ctx) => {
    // ... same as before ...
});

bot.on('message', async (ctx) => {
    // ... same as before ...
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
