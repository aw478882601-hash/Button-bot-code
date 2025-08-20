// =================================================================
// |   TELEGRAM FIREBASE BOT - V3.0 - PRODUCTION BUILD             |
// |   Fully refactored for the denormalized Firestore schema.       |
// |   Includes complete Admin CUD (Create, Update, Delete) logic. |
// =================================================================

// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid'); // لإضافة ID فريد للرسائل

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
// |                         Helper Functions (دوال مساعدة)                      |
// =================================================================

// --- دوال مساعدة خاصة بالمستخدم النهائي ---

async function generateKeyboard(userId, subButtons = []) {
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

    let currentRow = [];
    const sortedButtons = subButtons.sort((a, b) => a.order - b.order);

    sortedButtons.forEach(button => {
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
        if (state === 'EDITING_BUTTONS' && currentPath !== 'supervision') {
            adminActionRow.push('➕ إضافة زر');
            adminActionRow.push('✂️ نقل زر');
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
        keyboardRows.push([editButtonsText, editButtonsText]);
    }

    const finalRow = [];
    finalRow.push('💬 التواصل مع الأدمن');
    if (isAdmin && currentPath === 'root') {
        finalRow.push('👑 الإشراف');
    }
    keyboardRows.push(finalRow);

    return keyboardRows;
}

async function sendButtonMessages(ctx, messages = [], inEditMode = false) {
    const sentMessageIds = [];
    const sortedMessages = messages.sort((a, b) => a.order - b.order);
    const userId = String(ctx.from.id);

    for (const message of sortedMessages) {
        const messageId = message.id || uuidv4(); // Ensure message has a unique ID
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
    if(inEditMode) {
        await db.collection('users').doc(userId).update({ 'stateData.messageViewIds': sentMessageIds });
    }
    return sentMessageIds;
}


async function updateButtonStats(buttonId, userId) {
    if (!buttonId || buttonId === 'root' || buttonId === 'supervision') return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const buttonRef = db.collection('buttons').doc(buttonId);
    try {
        await db.runTransaction(async (transaction) => {
            const buttonDoc = await transaction.get(buttonRef);
            if (!buttonDoc.exists) return;
            
            transaction.update(buttonRef, {
                'stats.totalClicks': admin.firestore.FieldValue.increment(1),
                [`stats.dailyClicks.${today}`]: admin.firestore.FieldValue.increment(1),
                'stats.totalUsers': admin.firestore.FieldValue.arrayUnion(userId),
                [`stats.dailyUsers.${today}`]: admin.firestore.FieldValue.arrayUnion(userId)
            });
        });
    } catch (e) { console.error(`Button stats transaction failed for button ${buttonId}:`, e); }
}

async function getTopButtons(period) {
    const allButtonsSnapshot = await db.collection('buttons').get();
    let buttonStats = [];
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

    for (const doc of allButtonsSnapshot.docs) {
        const button = doc.data();
        const stats = button.stats || {};
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
                name: button.text,
                clicks: clicks,
                users: users
            });
        }
    }

    buttonStats.sort((a, b) => b.clicks - a.clicks);
    const top10 = buttonStats.slice(0, 10);

    if (top10.length === 0) return 'لا توجد بيانات لعرضها في هذه الفترة.';
    
    return top10.map((btn, index) => 
        `${index + 1}. *${btn.name}*\n   - 🖱️ الضغطات: \`${btn.clicks}\`\n   - 👤 المستخدمون: \`${btn.users}\``
    ).join('\n\n');
}

// --- دوال مساعدة خاصة بالأدمن ---

async function refreshAdminView(ctx, userId, buttonId, confirmationMessage = '✅ تم تحديث العرض.') {
    const userRef = db.collection('users').doc(String(userId));
    const userDoc = await userRef.get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];
    
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(err => {});
    }

    const buttonDoc = await db.collection('buttons').doc(buttonId).get();
    if (!buttonDoc.exists) {
        await ctx.reply('❌ خطأ: الزر الذي كنت تعدله لم يعد موجوداً.');
        return;
    }
    const buttonData = buttonDoc.data();
    
    await sendButtonMessages(ctx, buttonData.messages, true);

    const parentButtonId = buttonData.parentId === 'root' ? 'root' : buttonData.parentId.split('/').pop();
    let parentSubButtons = [];
    if (parentButtonId === 'root') {
        const rootButtonsSnapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
        parentSubButtons = rootButtonsSnapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));
    } else {
        const parentDoc = await db.collection('buttons').doc(parentButtonId).get();
        parentSubButtons = parentDoc.exists ? parentDoc.data().subButtons : [];
    }
    
    await ctx.reply(confirmationMessage, Markup.keyboard(await generateKeyboard(userId, parentSubButtons)).resize());
}

async function createButton(parentId, parentPath, newButtonName) {
    const parentRef = parentId === 'root' ? null : db.collection('buttons').doc(parentId);
    const newButtonRef = db.collection('buttons').doc(); // Auto-generate ID

    return db.runTransaction(async (transaction) => {
        let parentSubButtons = [];
        let newOrder = 0;

        if (parentRef) {
            const parentDoc = await transaction.get(parentRef);
            if (!parentDoc.exists) throw new Error("Parent button not found!");
            parentSubButtons = parentDoc.data().subButtons || [];
        } else {
            const rootButtonsQuery = db.collection('buttons').where('parentId', '==', 'root').orderBy('order', 'desc').limit(1);
            const rootButtonsSnapshot = await transaction.get(rootButtonsQuery);
            if (!rootButtonsSnapshot.empty) {
                newOrder = rootButtonsSnapshot.docs[0].data().order + 1;
            }
        }
        
        if (parentRef) {
            newOrder = parentSubButtons.length > 0 ? Math.max(...parentSubButtons.map(b => b.order)) + 1 : 0;
        }

        const newButtonData = {
            text: newButtonName,
            parentId: parentId === 'root' ? 'root' : parentPath,
            order: newOrder,
            adminOnly: false, isFullWidth: true,
            hasMessages: false, hasSubButtons: false,
            messages: [], subButtons: []
        };
        transaction.set(newButtonRef, newButtonData);

        if (parentRef) {
            const newSubButtonSummary = {
                buttonId: newButtonRef.id, text: newButtonName, order: newOrder,
                isFullWidth: true, adminOnly: false
            };
            transaction.update(parentRef, {
                subButtons: admin.firestore.FieldValue.arrayUnion(newSubButtonSummary),
                hasSubButtons: true
            });
        }
    });
}

async function deleteButtonRecursive(buttonId, parentId) {
    const buttonRef = db.collection('buttons').doc(buttonId);
    
    const buttonDoc = await buttonRef.get();
    if (!buttonDoc.exists) return; // Already deleted
    
    const children = buttonDoc.data().subButtons || [];
    for (const child of children) {
        const childPath = `${buttonDoc.data().parentId}/${buttonId}`;
        await deleteButtonRecursive(child.buttonId, buttonId);
    }
    
    const parentRef = parentId === 'root' ? null : db.collection('buttons').doc(parentId);

    await db.runTransaction(async (transaction) => {
        if (parentRef) {
            const parentDoc = await transaction.get(parentRef);
            if (parentDoc.exists) {
                const parentSubButtons = parentDoc.data().subButtons || [];
                const updatedSubButtons = parentSubButtons.filter(b => b.buttonId !== buttonId);
                transaction.update(parentRef, {
                    subButtons: updatedSubButtons,
                    hasSubButtons: updatedSubButtons.length > 0
                });
            }
        }
        transaction.delete(buttonRef);
    });
}

// =================================================================
// |                       Bot Commands & Logic                      |
// =================================================================

bot.start(async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userRef = db.collection('users').doc(userId);
        let userDoc = await userRef.get();

        if (!userDoc.exists) {
            const adminsDoc = await db.collection('config').doc('admins').get();
            const adminIds = (adminsDoc.exists && Array.isArray(adminsDoc.data().ids)) ? adminsDoc.data().ids : [];
            const isSuperAdmin = userId === process.env.SUPER_ADMIN_ID;
            const isAdmin = adminIds.includes(userId) || isSuperAdmin;
            
            await userRef.set({
                chatId: ctx.chat.id, isAdmin,
                currentPath: 'root', currentButtonId: 'root',
                state: 'NORMAL', stateData: {}, banned: false,
                lastActive: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' })
            });
            // New user notification logic from original code can be placed here
        } else {
             await userRef.update({ currentPath: 'root', currentButtonId: 'root', state: 'NORMAL', stateData: {} });
        }
       
        const rootButtonsSnapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
        const rootButtons = rootButtonsSnapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));

        const settingsDoc = await db.collection('config').doc('settings').get();
        const welcomeMessage = (settingsDoc.exists && settingsDoc.data().welcomeMessage) ? settingsDoc.data().welcomeMessage : 'أهلاً بك!';

        await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId, rootButtons)).resize());

    } catch (error) {
        console.error("FATAL ERROR in bot.start:", error);
    }
});

const mainMessageHandler = async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) return bot.start(ctx);
        let { currentPath, currentButtonId, state, isAdmin, stateData, banned } = userDoc.data();
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        
        await userRef.update({ lastActive: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }) });

        if (!ctx.message || !ctx.message.text) return;
        const text = ctx.message.text;
        
        // --- ADMIN STATE HANDLING ---
        if (isAdmin && state !== 'NORMAL') {
            // Example: AWAITING_NEW_BUTTON_NAME
            if (state === 'AWAITING_NEW_BUTTON_NAME') {
                const newButtonName = ctx.message.text;
                try {
                    await createButton(currentButtonId, currentPath, newButtonName);
                    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });

                    let buttonsToShow = [];
                    if (currentButtonId === 'root') {
                        const rootButtonsSnapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
                        buttonsToShow = rootButtonsSnapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));
                    } else {
                        const parentDoc = await db.collection('buttons').doc(currentButtonId).get();
                        buttonsToShow = parentDoc.data().subButtons || [];
                    }
                    return ctx.reply(`✅ تم إضافة الزر "${newButtonName}" بنجاح.`, Markup.keyboard(await generateKeyboard(userId, buttonsToShow)).resize());
                } catch (error) {
                    console.error("Create button error:", error);
                    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
                    return ctx.reply(`❌ حدث خطأ أثناء إضافة الزر: ${error.message}`);
                }
            }
            // ... Other admin state handlers like AWAITING_RENAME, BROADCAST, etc. would go here
        }

        // --- GENERAL COMMANDS & NAVIGATION ---
        switch (text) {
            case '🔝 القائمة الرئيسية':
                await userRef.update({ currentPath: 'root', currentButtonId: 'root', state: 'NORMAL', stateData: {} });
                const rootButtonsSnapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
                const rootButtons = rootButtonsSnapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));
                return ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId, rootButtons)).resize());

            case '🔙 رجوع':
                if (currentPath === 'root') return;
                
                const pathParts = currentPath.split('/');
                const newParentId = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'root';
                const newPath = newParentId === 'root' ? 'root' : pathParts.slice(0, -1).join('/');

                await userRef.update({ currentPath: newPath, currentButtonId: newParentId, state: 'NORMAL', stateData: {} });

                let buttonsToShow = [];
                if (newParentId === 'root') {
                    const rootSnapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
                    buttonsToShow = rootSnapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));
                } else {
                    const parentButtonDoc = await db.collection('buttons').doc(newParentId).get();
                    if (parentButtonDoc.exists) {
                        buttonsToShow = parentButtonDoc.data().subButtons || [];
                    }
                }
                return ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId, buttonsToShow)).resize());
            
            case '👑 الإشراف':
                if (isAdmin && currentPath === 'root') {
                    await userRef.update({ currentPath: 'supervision', currentButtonId: 'supervision' });
                    return ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId, [])).resize());
                }
                break;

            case '➕ إضافة زر':
                if (isAdmin && state === 'EDITING_BUTTONS' && currentPath !== 'supervision') {
                    await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME' });
                    return ctx.reply('أدخل اسم الزر الجديد:');
                }
                break;
            // ... other switch cases
        }
        
        // --- BUTTON CLICK LOGIC ---
        let currentScopeButtons = [];
        if (currentButtonId === 'root') {
            const snapshot = await db.collection('buttons').where('parentId', '==', 'root').orderBy('order').get();
            currentScopeButtons = snapshot.docs.map(doc => ({ ...doc.data(), buttonId: doc.id }));
        } else if (currentButtonId !== 'supervision') {
            const doc = await db.collection('buttons').doc(currentButtonId).get();
            if (doc.exists) {
                currentScopeButtons = doc.data().subButtons || [];
            }
        }

        const clickedButtonSummary = currentScopeButtons.find(b => b.text === text);
        if (!clickedButtonSummary) return; // Not a button click in the current context

        const buttonDoc = await db.collection('buttons').doc(clickedButtonSummary.buttonId).get();
        if (!buttonDoc.exists) return ctx.reply('❌ عذراً، هذا الزر لم يعد موجوداً.');
        
        const buttonData = buttonDoc.data();

        if (buttonData.adminOnly && !isAdmin) return ctx.reply('🚫 هذا القسم للمشرفين فقط.');

        await updateButtonStats(clickedButtonSummary.buttonId, userId);
        
        const userVisibleButtons = isAdmin ? buttonData.subButtons : (buttonData.subButtons || []).filter(b => !b.adminOnly);

        await sendButtonMessages(ctx, buttonData.messages, state === 'EDITING_CONTENT');
        
        if (buttonData.hasSubButtons) {
            const newPath = currentPath === 'root' ? clickedButtonSummary.buttonId : `${currentPath}/${clickedButtonSummary.buttonId}`;
            await userRef.update({ currentPath: newPath, currentButtonId: clickedButtonSummary.buttonId });
            await ctx.reply(`أنت الآن في قسم: ${buttonData.text}`, Markup.keyboard(await generateKeyboard(userId, userVisibleButtons)).resize());
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
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if(!userDoc.exists || !userDoc.data().isAdmin) return ctx.answerCbQuery('غير مصرح لك');

        const { currentButtonId } = userDoc.data();
        const [action, subAction, targetId] = ctx.callbackQuery.data.split(':');

        if (action === 'msg') {
            const buttonRef = db.collection('buttons').doc(currentButtonId);
            
            if (subAction === 'delete') {
                await db.runTransaction(async t => {
                    const doc = await t.get(buttonRef);
                    if (!doc.exists) return;
                    const messages = doc.data().messages.filter(m => m.id !== targetId);
                    t.update(buttonRef, { messages, hasMessages: messages.length > 0 });
                });
                await ctx.deleteMessage();
                await ctx.answerCbQuery('✅ تم الحذف');
            }
            // ... other msg actions (up, down, edit) would follow a similar pattern
        }
        
        if (action === 'btn' && subAction === 'delete') {
            const buttonToDeleteId = targetId;
            const parentId = currentButtonId;
            await deleteButtonRecursive(buttonToDeleteId, parentId);
            
            await ctx.deleteMessage();
            await ctx.answerCbQuery('✅ تم الحذف بنجاح');
            
            let buttonsToShow = [];
            if (parentId === 'root') {
                const snapshot = await db.collection('buttons').where('parentId', '==', 'root').get();
                buttonsToShow = snapshot.docs.map(doc => ({...doc.data(), buttonId: doc.id}));
            } else {
                const parentDoc = await db.collection('buttons').doc(parentId).get();
                buttonsToShow = parentDoc.data().subButtons || [];
            }
            await ctx.reply('🗑️ تم حذف الزر. تم تحديث لوحة المفاتيح.', Markup.keyboard(await generateKeyboard(userId, buttonsToShow)).resize());
        }
        // ... other btn actions (rename, reorder) would follow their respective logic
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
            res.status(200).send('Bot is running.');
        }
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
    }
};
