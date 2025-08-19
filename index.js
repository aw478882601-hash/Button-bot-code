// =================================================================
// |   TELEGRAM FIREBASE BOT - V61 - SINGLE-TRIP (NO CACHE)        |
// =================================================================

const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

// --- Firebase Initialization ---
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (error) { console.error('Firebase Admin Initialization Error:', error.message); }
}
const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);

// =================================================================
// |                 ⭐️ Core Helper Functions ⭐️                 |
// =================================================================

async function getNavigationContext(currentPath, buttonText) {
    console.log(`[DB-FETCH] Fetching context: ${currentPath} -> "${buttonText}"`);
    const buttonQuery = db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', buttonText).limit(1);
    const buttonSnapshot = await buttonQuery.get();

    if (buttonSnapshot.empty) return null;
    const buttonDoc = buttonSnapshot.docs[0];
    const buttonData = buttonDoc.data();
    
    return {
        clickedButton: { id: buttonDoc.id, ...buttonData },
        newPath: `${currentPath}/${buttonDoc.id}`,
        messages: buttonData.messages || [],
        subButtons: buttonData.subButtons || []
    };
}

async function generateKeyboard(userDocData, subButtonsFromContext = null) {
    try {
        const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDocData;
        let keyboardRows = [];
        let buttonsToGenerate = subButtonsFromContext;

        if (!buttonsToGenerate) {
            if (currentPath === 'root') {
                const buttonsSnapshot = await db.collection('buttons').where('parentId', '==', 'root').orderBy('order').get();
                buttonsToGenerate = buttonsSnapshot.docs.map(doc => ({id: doc.id, ...doc.data()}));
            } else if (currentPath !== 'supervision') {
                 const buttonId = currentPath.split('/').pop();
                 const parentDoc = await db.collection('buttons').doc(buttonId).get();
                 if(parentDoc.exists){
                    buttonsToGenerate = parentDoc.data().subButtons || [];
                 }
            }
        }
        
        if (currentPath === 'supervision') {
            return Markup.keyboard([
                ['📊 الإحصائيات', '🗣️ رسالة جماعية'],
                ['⚙️ تعديل المشرفين', '📝 تعديل رسالة الترحيب'],
                ['🚫 قائمة المحظورين'],
                ['🔙 رجوع', '🔝 القائمة الرئيسية']
            ]).resize();
        }

        let currentRow = [];
        (buttonsToGenerate || []).sort((a,b) => a.order - b.order).forEach(button => {
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
          if (state === 'EDITING_BUTTONS') { adminActionRow.push('➕ إضافة زر');  adminActionRow.push('✂️ نقل زر'); }
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

        const finalRow = ['💬 التواصل مع الأدمن'];
        if (isAdmin && currentPath === 'root') { finalRow.push('👑 الإشراف'); }
        keyboardRows.push(finalRow);

        return Markup.keyboard(keyboardRows).resize();
    } catch (error) {
        console.error('Error generating keyboard:', error);
        return Markup.keyboard([['حدث خطأ']]).resize();
    }
}

async function sendMessages(ctx, messages, inEditMode = false, parentButtonId = null) {
    const sentMessageIds = [];
    if (messages.length === 0 && inEditMode) {
        if (ctx.from) await trackSentMessages(String(ctx.from.id), []);
        return;
    }
    for (const message of messages) {
        let sentMessage;
        let inlineKeyboard = [];
        if (inEditMode) {
             const baseControls = [
                Markup.button.callback('🔼', `msg:up:${parentButtonId}:${message.id}`), 
                Markup.button.callback('🔽', `msg:down:${parentButtonId}:${message.id}`), 
                Markup.button.callback('🗑️', `msg:delete:${parentButtonId}:${message.id}`)
            ];
            if (message.type === 'text') {
                baseControls.push(Markup.button.callback('✏️', `msg:edit:${parentButtonId}:${message.id}`));
                inlineKeyboard = [baseControls];
            } else {
                inlineKeyboard = [baseControls, [
                    Markup.button.callback('📝 تعديل الشرح', `msg:edit_caption:${parentButtonId}:${message.id}`), 
                    Markup.button.callback('🔄 استبدال الملف', `msg:replace_file:${parentButtonId}:${message.id}`)
                ]];
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
            if(sentMessage) sentMessageIds.push(sentMessage.message_id);
        } catch (e) { console.error(`Failed to send message (type: ${message.type}) due to error:`, e.message); }
    }
     if (inEditMode && ctx.from) await trackSentMessages(String(ctx.from.id), sentMessageIds);
}

async function refreshAdminView(ctx, parentButtonId) {
    const userId = String(ctx.from.id);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const messageIdsToDelete = userDoc.data().stateData?.messageViewIds || [];
    for (const msgId of messageIdsToDelete) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch(()=>{});
    }
    
    const parentButtonDoc = await db.collection('buttons').doc(parentButtonId).get();
    if(parentButtonDoc.exists){
        const messages = parentButtonDoc.data().messages || [];
        await sendMessages(ctx, messages, true, parentButtonId);
    }
}

async function trackSentMessages(userId, messageIds) {
    const userRef = db.collection('users').doc(String(userId));
    await userRef.update({ 'stateData.messageViewIds': messageIds });
}

// ... (Other original helper functions like getTopButtons, updateButtonStats, etc. can be kept here)

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
            userDoc = await userRef.get();
            await db.collection('config').doc('stats').set({ totalUsers: admin.firestore.FieldValue.increment(1) }, { merge: true });
            // ... (New user notification logic from original file)
        } else {
             if(userDoc.data().isAdmin !== isAdmin){
                 await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today, isAdmin });
            } else {
                 await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
            }
            userDoc = await userRef.get();
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
        let { currentPath, state, isAdmin, banned, stateData } = userData;
        if (banned) return ctx.reply('🚫 أنت محظور من استخدام هذا البوت.');
        
        // --- 1. Handle navigation, state-based, and admin commands first ---
        const navigationCommands = { '🔝 القائمة الرئيسية': 'root', '🔙 رجوع': currentPath === 'supervision' ? 'root' : (currentPath.split('/').slice(0, -1).join('/') || 'root') };
        if (navigationCommands[text]) {
            const newPath = navigationCommands[text];
            await userRef.update({ currentPath: newPath, state: 'NORMAL', stateData: {} });
            const updatedUserDoc = await userRef.get();
            return ctx.reply('...', await getKeyboard(ctx, updatedUserDoc.data()));
        }
        
        if (isAdmin || state !== 'NORMAL') {
            // This is where the full admin logic from your original file goes,
            // but refactored to work with the new array-based data structure.
            // Example: Adding a new message
            if (state === 'AWAITING_NEW_MESSAGE') {
                const { buttonId } = stateData;
                const parentButtonRef = db.collection('buttons').doc(buttonId);
                const parentButtonDoc = await parentButtonRef.get();
                if(!parentButtonDoc.exists) { return ctx.reply('Button not found.'); }

                let type, content, caption = '', entities = [];
                 if (ctx.message.text) { type = "text"; content = ctx.message.text; entities = ctx.message.entities || []; }
                 else if (ctx.message.photo) { type = "photo"; content = ctx.message.photo.pop().file_id; caption = ctx.message.caption || ''; entities = ctx.message.caption_entities || []; }
                 // ... handle all other message types ...
                
                const newMessage = { id: uuidv4(), order: (parentButtonDoc.data().messages || []).length, type, content, caption, entities };
                await parentButtonRef.update({ messages: admin.firestore.FieldValue.arrayUnion(newMessage) });
                
                await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
                await refreshAdminView(ctx, buttonId);
                return;
            }
             // ... The rest of the original admin state logic (AWAITING_NEW_BUTTON, AWAITING_RENAME, etc.)
             // needs to be fully refactored here to work with the array structure.
        }
        
        // --- 2. Main navigation logic using the smart function ---
        const context = await getNavigationContext(currentPath, text);
        if (!context) {
             // ... Handle admin text commands like 'الإحصائيات' here as they are not buttons ...
            return;
        }

        const { clickedButton, newPath, messages, subButtons } = context;

        if (clickedButton.adminOnly && !isAdmin) {
            return ctx.reply('🚫 عذراً، هذا القسم مخصص للمشرفين فقط.');
        }

        await userRef.update({ lastActive: new Date().toLocaleDateString('en-CA'), currentPath: newPath });
        const updatedUserDoc = await userRef.get();
            
        if (messages.length > 0) {
            await sendMessages(ctx, messages, state === 'EDITING_CONTENT', clickedButton.id);
        }
        
        await ctx.reply(`أنت الآن في: ${clickedButton.text}`, await getKeyboard(ctx, updatedUserDoc.data(), subButtons));

    } catch (error) {
        console.error("FATAL ERROR in mainMessageHandler:", error);
        await ctx.reply("حدث خطأ فادح.");
    }
};
bot.on('message', mainMessageHandler);

bot.on('callback_query', async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const data = ctx.callbackQuery.data;
        // The format is now msg:action:parentButtonId:messageId
        const [action, subAction, parentButtonId, targetId] = data.split(':');
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists || !userDoc.data().isAdmin) return ctx.answerCbQuery('غير مصرح لك.');
        
        const parentButtonRef = db.collection('buttons').doc(parentButtonId);
        const parentButtonDoc = await parentButtonRef.get();
        if (!parentButtonDoc.exists) return ctx.answerCbQuery('الزر الأب غير موجود.');

        let buttonData = parentButtonDoc.data();

        if (action === 'msg') {
            let messages = buttonData.messages || [];
            const messageIndex = messages.findIndex(m => m.id === targetId);

            if (subAction === 'delete') {
                if (messageIndex > -1) {
                    const messageToDelete = messages[messageIndex];
                    await parentButtonRef.update({ messages: admin.firestore.FieldValue.arrayRemove(messageToDelete) });
                    await ctx.answerCbQuery('🗑️ تم الحذف');
                    await refreshAdminView(ctx, parentButtonId);
                }
            } else if (subAction === 'up' || subAction === 'down') {
                 if (subAction === 'up' && messageIndex > 0) {
                    [messages[messageIndex], messages[messageIndex - 1]] = [messages[messageIndex - 1], messages[messageIndex]];
                } else if (subAction === 'down' && messageIndex < messages.length - 1) {
                    [messages[messageIndex], messages[messageIndex + 1]] = [messages[messageIndex + 1], messages[messageIndex]];
                }
                messages.forEach((msg, i) => msg.order = i);
                await parentButtonRef.update({ messages: messages });
                await ctx.answerCbQuery('↕️ تم تغيير الترتيب');
                await refreshAdminView(ctx, parentButtonId);
            }
             // ... other callback actions for editing text, replacing files, etc.
             // would follow a similar pattern: read the array, modify it, write it back.
        }
        // ... The rest of the callback_query handler from the original file
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
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
