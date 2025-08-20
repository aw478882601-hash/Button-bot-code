// =================================================================
// |   TELEGRAM FIREBASE BOT - V54 - EFFICIENT v2 STRUCTURE        |
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
const FieldValue = admin.firestore.FieldValue;

// --- 3. تهيئة البوت ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                         Helper Functions (دوال مساعدة)                      |
// =================================================================

function simpleHash(text) {
    let hash = 0;
    if (!text || text.length === 0) return 0;
    for (let i = 0; i < text.length; i++) {
        hash += text.charCodeAt(i);
    }
    return hash;
}

function getShardDocRef(buttonId) {
    const shardIndex = simpleHash(String(buttonId)) % 7;
    return db.collection('statistics').doc(`button_stats_shard_${shardIndex}`);
}

async function trackSentMessages(userId, messageIds) {
    const userRef = db.collection('users').doc(String(userId));
    await userRef.update({ 'stateData.messageViewIds': messageIds });
}

function processAndFormatTopButtons(allStats, period) {
    let buttonStats = [];
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

    for (const buttonId in allStats) {
        const stats = allStats[buttonId];
        let clicks = 0;
        let users = 0;

        if (period === 'today') {
            clicks = stats.dailyClicks?.[todayStr] || 0;
            users = stats.dailyUsers?.[todayStr]?.length || 0;
        } else if (period === 'all_time') {
            clicks = stats.totalClicks || 0;
            users = stats.totalUsers?.length || 0;
        } else if (period === 'weekly') {
            let weeklyClicks = 0;
            let weeklyUsersSet = new Set();
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
                weeklyClicks += stats.dailyClicks?.[dateStr] || 0;
                if (stats.dailyUsers?.[dateStr]) {
                    stats.dailyUsers[dateStr].forEach(userId => weeklyUsersSet.add(userId));
                }
            }
            clicks = weeklyClicks;
            users = weeklyUsersSet.size;
        }

        if (clicks > 0) {
            buttonStats.push({
                name: stats.name || 'اسم غير محدد',
                clicks: clicks,
                users: users
            });
        }
    }

    buttonStats.sort((a, b) => b.clicks - a.clicks);
    const top10 = buttonStats.slice(0, 10);

    if (top10.length === 0) {
        return 'لا توجد بيانات لعرضها في هذه الفترة.';
    }

    return top10.map((btn, index) =>
        `${index + 1}. *${btn.name}*\n   - 🖱️ الضغطات: \`${btn.clicks}\`\n   - 👤 المستخدمون: \`${btn.users}\``
    ).join('\n\n');
}

async function sendButtonMessages(ctx, button, inEditMode = false) {
    const messages = button.messages || [];
    messages.sort((a, b) => (a.order || 0) - (b.order || 0));
    const buttonId = button.id;
    const sentMessageIds = [];

    if (messages.length === 0 && inEditMode) {
        if (ctx.from) await trackSentMessages(String(ctx.from.id), []);
        return;
    }

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const stableMessageId = `${buttonId}_${i}`;

        let sentMessage;
        let inlineKeyboard = [];
        if (inEditMode) {
            const baseControls = [
                Markup.button.callback('🔼', `msg:up:${stableMessageId}`), Markup.button.callback('🔽', `msg:down:${stableMessageId}`),
                Markup.button.callback('🗑️', `msg:delete:${stableMessageId}`), Markup.button.callback('➕', `msg:addnext:${stableMessageId}`)
            ];
            if (message.type === 'text') {
                baseControls.push(Markup.button.callback('✏️', `msg:edit:${stableMessageId}`));
                inlineKeyboard = [baseControls];
            } else {
                inlineKeyboard = [baseControls, [
                    Markup.button.callback('📝 تعديل الشرح', `msg:edit_caption:${stableMessageId}`),
                    Markup.button.callback('🔄 استبدال الملف', `msg:replace_file:${stableMessageId}`)
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
            console.error(`Failed to send message (index ${i}) for button ${buttonId} due to error:`, e.message);
        }
    }
    if (inEditMode && ctx.from) await trackSentMessages(String(ctx.from.id), sentMessageIds);
}

async function generateKeyboard(userId) {
  try {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (!userDoc.exists) return [[]];
    const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDoc.data();
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

    let buttonsToShow = [];
    if (currentPath === 'root') {
        const buttonsSnapshot = await db.collection('buttons_v2').where('parentId', '==', 'root').orderBy('order').get();
        buttonsSnapshot.forEach(doc => {
            const data = doc.data();
            buttonsToShow.push({ id: doc.id, text: data.text, isFullWidth: data.isFullWidth, adminOnly: data.adminOnly, order: data.order });
        });
    } else {
        const parentButtonDoc = await db.collection('buttons_v2').doc(currentPath).get();
        if (parentButtonDoc.exists) {
            const parentData = parentButtonDoc.data();
            buttonsToShow = parentData.children || [];
        }
    }
    
    let allButtonsData = {};
    if (currentPath !== 'root' && buttonsToShow.length > 0) {
        const childrenIds = buttonsToShow.map(c => c.id);
        const childrenSnapshot = await db.collection('buttons_v2').where(admin.firestore.FieldPath.documentId(), 'in', childrenIds).get();
        childrenSnapshot.forEach(doc => {
            allButtonsData[doc.id] = doc.data();
        });
    }

    let currentRow = [];
    buttonsToShow.sort((a,b) => (a.order || 0) - (b.order || 0)).forEach(buttonInfo => {
      const fullButtonData = allButtonsData[buttonInfo.id] || buttonInfo;
      if (!fullButtonData.adminOnly || isAdmin) {
        if (fullButtonData.isFullWidth) {
            if (currentRow.length > 0) keyboardRows.push(currentRow);
            keyboardRows.push([fullButtonData.text]);
            currentRow = [];
        } else {
            currentRow.push(fullButtonData.text);
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
      if (state === 'EDITING_BUTTONS' && currentPath !== 'supervision') { adminActionRow.push('➕ إضافة زر');  adminActionRow.push('✂️ نقل زر'); }
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
  }
}

async function updateButtonStats(buttonId, userId) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const statDocRef = getShardDocRef(buttonId);
    const buttonIdStr = String(buttonId);
    const userIdStr = String(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const statDoc = await transaction.get(statDocRef);
            if (!statDoc.exists) transaction.set(statDocRef, { statsMap: {} });

            const statsMap = statDoc.data()?.statsMap || {};
            const buttonStats = statsMap[buttonIdStr] || {};
            
            let buttonNameToSave = buttonStats.name;
            if (!buttonNameToSave) {
                const buttonRef = db.collection('buttons_v2').doc(buttonIdStr);
                const buttonDoc = await transaction.get(buttonRef);
                buttonNameToSave = buttonDoc.exists ? buttonDoc.data().text : 'زر محذوف';
            }

            const newTotalClicks = (buttonStats.totalClicks || 0) + 1;
            const newDailyClicks = { ...buttonStats.dailyClicks, [today]: (buttonStats.dailyClicks?.[today] || 0) + 1 };
            const totalUsers = Array.from(new Set([...(buttonStats.totalUsers || []), userIdStr]));
            const dailyUsers = buttonStats.dailyUsers || {};
            const todayUsers = Array.from(new Set([...(dailyUsers[today] || []), userIdStr]));
            
            transaction.update(statDocRef, {
                [`statsMap.${buttonIdStr}.name`]: buttonNameToSave,
                [`statsMap.${buttonIdStr}.totalClicks`]: newTotalClicks,
                [`statsMap.${buttonIdStr}.dailyClicks`]: newDailyClicks,
                [`statsMap.${buttonIdStr}.totalUsers`]: totalUsers,
                [`statsMap.${buttonIdStr}.dailyUsers`]: { ...dailyUsers, [today]: todayUsers },
            });
        });
    } catch (e) {
        console.error(`Button stats transaction failed for button ${buttonId}:`, e);
    }
}

async function recursiveDeleteButton(buttonId) {
    const buttonRef = db.collection('buttons_v2').doc(buttonId);
    const buttonDoc = await buttonRef.get();
    if (!buttonDoc.exists) return;
    const buttonData = buttonDoc.data();

    if (buttonData.hasChildren) {
        for (const child of buttonData.children) {
            await recursiveDeleteButton(child.id);
        }
    }

    const statDocRef = getShardDocRef(buttonId);
    const batch = db.batch();
    batch.delete(buttonRef);
    batch.update(statDocRef, { [`statsMap.${buttonId}`]: FieldValue.delete() });
    await batch.commit();
    await db.collection('config').doc('stats').update({ 
        totalButtons: FieldValue.increment(-1),
        totalMessages: FieldValue.increment(-(buttonData.messages?.length || 0))
    });

    if (buttonData.parentId && buttonData.parentId !== 'root') {
        const parentRef = db.collection('buttons_v2').doc(buttonData.parentId);
        const parentDoc = await parentRef.get();
        if(parentDoc.exists) {
            const parentData = parentDoc.data();
            const childToRemove = parentData.children.find(c => c.id === buttonId);
            if (childToRemove) {
                const newChildren = parentData.children.filter(child => child.id !== buttonId);
                await parentRef.update({ 
                    children: newChildren,
                    hasChildren: newChildren.length > 0
                });
            }
        }
    }
}

async function clearAdminView(ctx, userId) {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    const messageIdsToDelete = userDoc.data()?.stateData?.messageViewIds || [];
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(()=>{});
    }
    await trackSentMessages(userId, []);
}

// =================================================================
// |                       Bot Commands & Logic                      |
// =================================================================

bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
        await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
    } else {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
        const isAdmin = userId === process.env.SUPER_ADMIN_ID;
        await userRef.set({ 
            chatId: ctx.chat.id, isAdmin, currentPath: 'root', 
            state: 'NORMAL', stateData: {}, lastActive: today, banned: false 
        });
        await db.collection('config').doc('stats').set({ totalUsers: FieldValue.increment(1) }, { merge: true });
    }
    
    const settingsDoc = await db.collection('config').doc('settings').get();
    const welcomeMessage = settingsDoc.exists ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';
    await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
});

const mainMessageHandler = async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) return bot.start(ctx);

        let { currentPath, state, isAdmin, stateData } = userDoc.data();
        await userRef.update({ lastActive: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }) });

        if (isAdmin && state !== 'NORMAL' && state !== 'EDITING_BUTTONS' && state !== 'EDITING_CONTENT') {
            
            if (state === 'AWAITING_NEW_MESSAGE') {
                const { buttonId } = stateData;
                if (!buttonId) return ctx.reply("⚠️ حدث خطأ.");

                let newMessage = {};
                const order = Date.now();
                if (ctx.message.text) { newMessage = { type: "text", content: ctx.message.text, order, entities: ctx.message.entities || [] }; }
                else if (ctx.message.photo) { newMessage = { type: "photo", content: ctx.message.photo.pop().file_id, caption: ctx.message.caption || '', order, entities: ctx.message.caption_entities || [] }; }
                else if (ctx.message.video) { newMessage = { type: "video", content: ctx.message.video.file_id, caption: ctx.message.caption || '', order, entities: ctx.message.caption_entities || [] }; }
                else { return ctx.reply("⚠️ نوع الرسالة غير مدعوم."); }

                const buttonRef = db.collection('buttons_v2').doc(buttonId);
                await buttonRef.update({ messages: FieldValue.arrayUnion(newMessage), hasMessages: true });
                await db.collection('config').doc('stats').update({ totalMessages: FieldValue.increment(1) });
                await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                
                await clearAdminView(ctx, userId);
                const buttonDoc = await buttonRef.get();
                const updatedButton = { id: buttonDoc.id, ...buttonDoc.data() };
                await sendButtonMessages(ctx, updatedButton, true);
                return ctx.reply('✅ تم إضافة الرسالة.');
            }

            if (state === 'AWAITING_NEW_BUTTON_NAME') {
                const newButtonName = ctx.message.text;
                if (!newButtonName) return ctx.reply('⚠️ يرجى إرسال اسم نصي.');
                
                let parentChildren = [];
                if (currentPath !== 'root') {
                    const parentDoc = await db.collection('buttons_v2').doc(currentPath).get();
                    parentChildren = parentDoc.exists ? parentDoc.data().children || [] : [];
                } else {
                    const rootSnapshot = await db.collection('buttons_v2').where('parentId', '==', 'root').get();
                    rootSnapshot.forEach(doc => parentChildren.push({text: doc.data().text}));
                }

                if (parentChildren.some(c => c.text === newButtonName)) return ctx.reply(`⚠️ يوجد زر بهذا الاسم بالفعل.`);

                const newOrder = parentChildren.length;
                const newButtonData = {
                    text: newButtonName, parentId: currentPath, order: newOrder,
                    isFullWidth: false, adminOnly: false, messages: [], children: [],
                    hasMessages: false, hasChildren: false
                };
                const newButtonRef = await db.collection('buttons_v2').add(newButtonData);

                if (currentPath !== 'root') {
                    await db.collection('buttons_v2').doc(currentPath).update({
                        children: FieldValue.arrayUnion({ id: newButtonRef.id, text: newButtonName, order: newOrder }),
                        hasChildren: true
                    });
                }
                
                await getShardDocRef(newButtonRef.id).set({ statsMap: { [newButtonRef.id]: { name: newButtonName, totalClicks: 0 }}}, { merge: true });
                await db.collection('config').doc('stats').update({ totalButtons: FieldValue.increment(1) });
                await userRef.update({ state: 'EDITING_BUTTONS' });
                return ctx.reply(`✅ تم إضافة الزر بنجاح.`, Markup.keyboard(await generateKeyboard(userId)).resize());
            }
        }
        
        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;
        
        // --- Logic for command-like text buttons ---
        switch (text) {
            case '🔝 القائمة الرئيسية':
                await userRef.update({ currentPath: 'root', stateData: {}, state: 'NORMAL' });
                return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
            case '🔙 رجوع':
                const parentId = currentPath === 'root' ? 'root' : (await db.collection('buttons_v2').doc(currentPath).get()).data().parentId;
                await userRef.update({ currentPath: parentId || 'root', stateData: {} });
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
                    await userRef.update({ state: newState, stateData: {} });
                    return ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل الأزرار.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                }
                break;
            case '📄 تعديل المحتوى':
            case '🚫 إلغاء تعديل المحتوى':
                 if (isAdmin) {
                    const newState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
                    await userRef.update({ state: newState, stateData: {} });
                    await clearAdminView(ctx, userId);
                    await ctx.reply(`تم ${newState === 'NORMAL' ? 'إلغاء' : 'تفعيل'} وضع تعديل المحتوى.`, Markup.keyboard(await generateKeyboard(userId)).resize());
                    if (newState === 'EDITING_CONTENT' && !['root', 'supervision'].includes(currentPath)) {
                        const buttonDoc = await db.collection('buttons_v2').doc(currentPath).get();
                        if (buttonDoc.exists) {
                           await sendButtonMessages(ctx, {id: buttonDoc.id, ...buttonDoc.data()}, true);
                        }
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
                        stateData: { buttonId: currentPath }
                    });
                    return ctx.reply('📝 أرسل أو وجّه الرسالة الجديدة:');
                }
                break;
        }
        
        // --- Main v2 Button Click Logic ---
        const buttonSnapshot = await db.collection('buttons_v2').where('parentId', '==', currentPath).where('text', '==', text).limit(1).get();
        if (buttonSnapshot.empty) return;
        
        const buttonDoc = buttonSnapshot.docs[0];
        const buttonId = buttonDoc.id;
        const buttonData = buttonDoc.data();
        const buttonObject = { id: buttonId, ...buttonData };

        if (buttonData.adminOnly && !isAdmin) {
             return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        await updateButtonStats(buttonId, userId);

        if (state === 'EDITING_BUTTONS' && isAdmin) {
            await userRef.update({ stateData: { lastClickedButtonId: buttonId } });
            const inlineKb = [[ Markup.button.callback('✏️', `btn:rename:${buttonId}`), Markup.button.callback('🗑️', `btn:delete:${buttonId}`), Markup.button.callback('📊', `btn:stats:${buttonId}`) ]];
            return ctx.reply(`خيارات للزر "${text}" (اضغط مرة أخرى للدخول):`, Markup.inlineKeyboard(inlineKb));
        }

        await clearAdminView(ctx, userId);

        if (buttonData.hasMessages) {
            await sendButtonMessages(ctx, buttonObject, state === 'EDITING_CONTENT');
        }

        if (buttonData.hasChildren || (isAdmin && ['EDITING_CONTENT', 'EDITING_BUTTONS'].includes(state))) {
            await userRef.update({ currentPath: buttonId });
            let replyText = `أنت الآن في قسم: ${text}`;
            if (!buttonData.hasMessages && !buttonData.hasChildren) {
                replyText = 'هذا الزر فارغ تمامًا.';
            }
            return ctx.reply(replyText, Markup.keyboard(await generateKeyboard(userId)).resize());
        }

        if (!buttonData.hasMessages && !buttonData.hasChildren) {
            return ctx.reply('لم يتم إضافة محتوى إلى هذا القسم بعد.');
        }

    } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        await ctx.reply("حدث خطأ فادح. تم إبلاغ المطور.");
    }
};

bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const data = ctx.callbackQuery.data;
        const [action, subAction, targetId] = data.split(':');
        
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || !userDoc.data().isAdmin) {
            return ctx.answerCbQuery('غير مصرح لك.', { show_alert: true });
        }

        if (action === 'msg') {
            const [buttonId, msgIndexStr] = targetId.split('_');
            const msgIndex = parseInt(msgIndexStr, 10);
            const buttonRef = db.collection('buttons_v2').doc(buttonId);

            const doc = await buttonRef.get();
            if (!doc.exists) return ctx.answerCbQuery('الزر الأصلي غير موجود.');
            
            let buttonData = doc.data();
            let messages = buttonData.messages || [];
            messages.sort((a,b)=>(a.order || 0) - (b.order || 0));

            if (subAction === 'delete') {
                const deletedMessage = messages.splice(msgIndex, 1);
                if (deletedMessage.length > 0) {
                    await buttonRef.update({ messages: messages, hasMessages: messages.length > 0 });
                    await db.collection('config').doc('stats').update({ totalMessages: FieldValue.increment(-1) });
                    await ctx.answerCbQuery('✅ تم الحذف');
                } else {
                     await ctx.answerCbQuery('⚠️ لم يتم العثور على الرسالة');
                }
            } else if (subAction === 'up' && msgIndex > 0) {
                [messages[msgIndex], messages[msgIndex - 1]] = [messages[msgIndex - 1], messages[msgIndex]];
                await buttonRef.update({ messages });
                await ctx.answerCbQuery('✅ تم الرفع');
            } else if (subAction === 'down' && msgIndex < messages.length - 1) {
                [messages[msgIndex], messages[msgIndex + 1]] = [messages[msgIndex + 1], messages[msgIndex]];
                await buttonRef.update({ messages });
                await ctx.answerCbQuery('✅ تم الخفض');
            } else {
                 await ctx.answerCbQuery('⚠️ لا يمكن تنفيذ الحركة');
                 return;
            }
            
            await clearAdminView(ctx, userId);
            const updatedButton = { id: doc.id, ...doc.data(), messages };
            await sendButtonMessages(ctx, updatedButton, true);
            return ctx.reply('تم تحديث العرض.');
        }

        if (action === 'btn' && subAction === 'delete') {
             const buttonDoc = await db.collection('buttons_v2').doc(targetId).get();
             if (!buttonDoc.exists) return ctx.answerCbQuery('الزر غير موجود بالفعل.');

             const confirmationKeyboard = Markup.inlineKeyboard([
                Markup.button.callback('✅ نعم، قم بالحذف', `confirm_delete_button:yes:${targetId}`),
                Markup.button.callback('❌ إلغاء', `confirm_delete_button:no:${targetId}`)
             ]);
             await ctx.editMessageText(`🗑️ هل أنت متأكد من حذف الزر "${buttonDoc.data().text}" وكل ما بداخله؟`, confirmationKeyboard);
             return;
        }

        if (action === 'confirm_delete_button' && subAction === 'yes') {
             await ctx.editMessageText('⏳ جارٍ الحذف...');
             await recursiveDeleteButton(targetId);
             await ctx.deleteMessage().catch(()=>{});
             await ctx.reply('🗑️ تم الحذف بنجاح.', Markup.keyboard(await generateKeyboard(userId)).resize());
             return ctx.answerCbQuery('✅ تم الحذف');
        }
        
    } catch (error) {
        console.error("FATAL ERROR in callback_query handler:", error);
        await ctx.answerCbQuery("حدث خطأ فادح.", { show_alert: true });
    }
});

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send('Bot is running on v2 Structure.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
    }
};
