```javascript
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

/**
 * دالة لإنشاء لوحة المفاتيح الرئيسية (Reply Keyboard)
 */
async function generateKeyboard(userId) {
  try {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (!userDoc.exists) return [[]];

    const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDoc.data();
    
    let keyboardRows = [];

    if (currentPath === 'supervision') {
      keyboardRows = [
        ['تعديل المشرفين', 'إرسال رسالة جماعية'],
        ['الإحصائيات', 'تعديل رسالة الترحيب'],
        ['رجوع']
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
        if (currentRow.length === 2) {
          keyboardRows.push(currentRow);
          currentRow = [];
        }
      }
    });
    if (currentRow.length > 0) keyboardRows.push(currentRow);

    if (isAdmin) {
      if (state === 'EDITING_BUTTONS' && currentPath !== 'supervision') {
        keyboardRows.push(['+ إضافة زر']);
      }
      if (state === 'EDITING_CONTENT' && currentPath !== 'root' && currentPath !== 'supervision') {
        keyboardRows.push(['إضافة رسالة']);
      }
    }
    
    const fixedButtons = [];
    if (currentPath !== 'root') {
      fixedButtons.push('رجوع');
    }
    fixedButtons.push('القائمة الرئيسية');
    
    if (isAdmin && currentPath === 'root') {
      fixedButtons.push('الإشراف');
    }
    if (fixedButtons.length > 0) keyboardRows.push(fixedButtons);
    
    if (isAdmin && currentPath !== 'supervision') {
      const adminControlRow = [];
      const editButtonsText = state === 'EDITING_BUTTONS' ? 'إلغاء تعديل الأزرار' : 'تعديل الأزرار';
      const editContentText = state === 'EDITING_CONTENT' ? 'إلغاء تعديل المحتوى' : 'تعديل المحتوى';
      adminControlRow.push(editButtonsText, editContentText);
      keyboardRows.push(adminControlRow);
    }
    
    keyboardRows.push(['التواصل مع الإدارة']);

    return keyboardRows;
  } catch (error) {
    console.error('Error generating keyboard:', error);
    return [['حدث خطأ في عرض الأزرار']];
  }
}

/**
 * دالة لإرسال الرسائل المرتبطة بزر معين
 */
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
          Markup.button.callback('حذف', `msg_delete_${messageId}`),
          Markup.button.callback('تعديل', `msg_edit_${messageId}`),
        ],
        [
          Markup.button.callback('أعلى', `msg_up_${messageId}`),
          Markup.button.callback('أسفل', `msg_down_${messageId}`),
        ],
        [
          Markup.button.callback('إضافة تالية', `msg_addnext_${messageId}`),
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
          await ctx.replyWithPhoto(message.fileId, options);
          break;
        case 'video':
          await ctx.replyWithVideo(message.fileId, options);
          break;
        case 'document':
          await ctx.replyWithDocument(message.fileId, options);
          break;
      }
    } catch (e) {
      console.error(`Failed to send message with file_id: ${message.fileId}`, e.message);
    }
  }
}

async function updateButtonStats(buttonId) {
  const today = new Date().toISOString().split('T')[0];
  const buttonRef = db.collection('buttons').doc(buttonId);
  const buttonDoc = await buttonRef.get();
  if (!buttonDoc.exists) return;

  let stats = buttonDoc.data().stats || { totalClicks: 0, dailyClicks: 0, lastDay: '' };
  stats.totalClicks += 1;
  if (stats.lastDay === today) {
    stats.dailyClicks += 1;
  } else {
    stats.dailyClicks = 1;
    stats.lastDay = today;
  }
  await buttonRef.update({ stats });
}

async function recursiveDeleteButton(buttonId) {
  // Delete messages
  const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
  for (const msg of messages.docs) {
    await msg.ref.delete();
  }

  // Delete subbuttons recursively
  const subButtons = await db.collection('buttons').where('parentId', '==', buttonId).get();
  for (const sub of subButtons.docs) {
    await recursiveDeleteButton(sub.id);
  }

  // Delete self
  await db.collection('buttons').doc(buttonId).delete();
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
  if (!userDoc.exists) {
    const adminsDoc = await db.collection('config').doc('admins').get();
    const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
    isAdmin = adminIds.includes(userId);
    await userRef.set({
      chatId: ctx.chat.id,
      isAdmin,
      currentPath: 'root',
      state: 'NORMAL',
      stateData: {},
      lastActive: today
    });
  } else {
    isAdmin = userDoc.data().isAdmin;
    await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {}, lastActive: today });
  }

  const settingsDoc = await db.collection('config').doc('settings').get();
  const welcomeMessage = settingsDoc.exists && settingsDoc.data().welcomeMessage ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';

  await ctx.reply(welcomeMessage, Markup.keyboard(await generateKeyboard(userId)).resize());
});

// --- معالج الرسائل النصية الرئيسي ---
bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const text = ctx.message.text;
  const today = new Date().toISOString().split('T')[0];
  const userRef = db.collection('users').doc(userId);
  await userRef.update({ lastActive: today });
  const userDoc = await userRef.get();

  if (!userDoc.exists) return bot.start(ctx);

  const userData = userDoc.data();
  const { currentPath, state, isAdmin, stateData } = userData;

  // --- التعامل مع الحالات التي تتطلب إدخالاً ---
  if (state === 'AWAITING_NEW_BUTTON_NAME') {
    const existing = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', text).get();
    if (!existing.empty) return ctx.reply('الاسم موجود مسبقاً، جرب اسماً آخر.');
    const buttons = await db.collection('buttons').where('parentId', '==', currentPath).get();
    const newOrder = buttons.size;
    await db.collection('buttons').doc().set({
      text,
      parentId: currentPath,
      adminOnly: false,
      order: newOrder,
      stats: { totalClicks: 0, dailyClicks: 0, lastDay: '' }
    });
    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
    await ctx.reply('تم إضافة الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  if (state === 'AWAITING_BUTTON_RENAME') {
    await db.collection('buttons').doc(stateData.buttonId).update({ text });
    await userRef.update({ state: 'EDITING_BUTTONS', stateData: {} });
    await ctx.reply('تم تعديل الاسم.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  if (state === 'AWAITING_WELCOME_MESSAGE') {
    await db.collection('config').doc('settings').set({ welcomeMessage: text }, { merge: true });
    await userRef.update({ state: 'NORMAL', stateData: {} });
    await ctx.reply('تم تعديل رسالة الترحيب.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  if (state === 'AWAITING_ADMIN_ADD') {
    await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayUnion(text) });
    await userRef.update({ state: 'NORMAL', stateData: {} });
    await ctx.reply('تم إضافة المشرف.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  if (state === 'AWAITING_ADMIN_REMOVE') {
    await db.collection('config').doc('admins').update({ ids: admin.firestore.FieldValue.arrayRemove(text) });
    await userRef.update({ state: 'NORMAL', stateData: {} });
    await ctx.reply('تم حذف المشرف.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  if (state === 'AWAITING_MESSAGE_EDIT') {
    await db.collection('messages').doc(stateData.messageId).update({ caption: text });
    await userRef.update({ state: 'EDITING_CONTENT', stateData: {} });
    await ctx.reply('تم تعديل الشرح.');
    await sendButtonMessages(ctx, currentPath, true);
    return;
  }

  if (state === 'CONTACT_ADMIN') {
    const adminsDoc = await db.collection('config').doc('admins').get();
    const adminIds = adminsDoc.exists ? adminsDoc.data().ids : [];
    for (const adminId of adminIds) {
      try {
        await ctx.forwardMessage(adminId);
      } catch (e) {}
    }
    await userRef.update({ state: 'NORMAL', stateData: {} });
    await ctx.reply('تم إرسال الرسالة إلى الإدارة.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  // --- التعامل مع الأزرار الثابتة وأزرار التحكم ---
  switch (text) {
    case 'القائمة الرئيسية':
      await userRef.update({ currentPath: 'root', state: 'NORMAL', stateData: {} });
      await ctx.reply('القائمة الرئيسية', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    case 'رجوع':
      const parentPath = currentPath.split('/').slice(0, -1).join('/') || 'root';
      await userRef.update({ currentPath: parentPath, stateData: {} });
      await ctx.reply('تم الرجوع.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    case 'التواصل مع الإدارة':
      await userRef.update({ state: 'CONTACT_ADMIN' });
      await ctx.reply('أرسل رسالتك إلى الإدارة:');
      return;
    case 'الإشراف':
      if (isAdmin) {
        await userRef.update({ currentPath: 'supervision' });
        await ctx.reply('قائمة الإشراف', Markup.keyboard(await generateKeyboard(userId)).resize());
      }
      return;
    case 'تعديل الأزرار':
    case 'إلغاء تعديل الأزرار':
      const newButtonState = state === 'EDITING_BUTTONS' ? 'NORMAL' : 'EDITING_BUTTONS';
      await userRef.update({ state: newButtonState });
      await ctx.reply(`وضع تعديل الأزرار: ${newButtonState === 'EDITING_BUTTONS' ? 'مفعل' : 'معطل'}`, Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    case 'تعديل المحتوى':
    case 'إلغاء تعديل المحتوى':
      const newContentState = state === 'EDITING_CONTENT' ? 'NORMAL' : 'EDITING_CONTENT';
      await userRef.update({ state: newContentState });
      await ctx.reply(`وضع تعديل المحتوى: ${newContentState === 'EDITING_CONTENT' ? 'مفعل' : 'معطل'}`, Markup.keyboard(await generateKeyboard(userId)).resize());
      if (newContentState === 'EDITING_CONTENT') {
        await sendButtonMessages(ctx, currentPath, true);
      }
      return;
    case '+ إضافة زر':
      if (isAdmin && state === 'EDITING_BUTTONS') {
        await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME' });
        await ctx.reply('أدخل اسم الزر الجديد:');
      }
      return;
    case 'إضافة رسالة':
      if (isAdmin && state === 'EDITING_CONTENT') {
        await userRef.update({ state: 'AWAITING_NEW_MESSAGE' });
        await ctx.reply('أرسل الرسالة الجديدة (نص، صورة، فيديو، ملف):');
      }
      return;
  }

  if (currentPath === 'supervision' && isAdmin) {
    switch (text) {
      case 'الإحصائيات':
        const totalUsers = (await db.collection('users').get()).size;
        const today = new Date().toISOString().split('T')[0];
        const dailyUsers = (await db.collection('users').where('lastActive', '==', today).get()).size;
        const totalButtons = (await db.collection('buttons').get()).size;
        const totalMessages = (await db.collection('messages').get()).get().size;
        await ctx.reply(`عدد المستخدمين الكلي: ${totalUsers}\nعدد المستخدمين اليومي: ${dailyUsers}\nعدد الأزرار: ${totalButtons}\nعدد الرسائل: ${totalMessages}`);
        return;
      case 'إرسال رسالة جماعية':
        await userRef.update({ state: 'AWAITING_BROADCAST' });
        await ctx.reply('أرسل الرسالة الجماعية الآن (نص، صورة، إلخ):');
        return;
      case 'تعديل المشرفين':
        const adminsDoc = await db.collection('config').doc('admins').get();
        const adminList = adminsDoc.exists ? adminsDoc.data().ids.join(', ') : 'لا يوجد';
        await ctx.reply(`المشرفون: ${adminList}`, Markup.inlineKeyboard([
          [Markup.button.callback('إضافة', 'admin_add')],
          [Markup.button.callback('حذف', 'admin_remove')]
        ]));
        return;
      case 'تعديل رسالة الترحيب':
        await userRef.update({ state: 'AWAITING_WELCOME_MESSAGE' });
        await ctx.reply('أدخل رسالة الترحيب الجديدة:');
        return;
    }
  }

  // Find button
  const buttonSnapshot = await db.collection('buttons')
    .where('parentId', '==', currentPath)
    .where('text', '==', text)
    .limit(1)
    .get();

  if (!buttonSnapshot.empty) {
    const buttonDoc = buttonSnapshot.docs[0];
    const buttonId = buttonDoc.id;

    if (state === 'EDITING_BUTTONS' && isAdmin) {
      // Show inline for edit
      const inlineKb = [
        [Markup.button.callback('تعديل اسم', `btn_rename_${buttonId}`)],
        [Markup.button.callback('حذف', `btn_delete_${buttonId}`)],
        [Markup.button.callback('تحريك يمين', `btn_right_${buttonId}`), Markup.button.callback('تحريك يسار', `btn_left_${buttonId}`)],
        [Markup.button.callback('تحريك أعلى', `btn_up_${buttonId}`), Markup.button.callback('تحريك أسفل', `btn_down_${buttonId}`)],
        [Markup.button.callback('جعل للمشرفين فقط', `btn_adminonly_${buttonId}`)],
        [Markup.button.callback('إحصائيات', `btn_stats_${buttonId}`)]
      ];
      await ctx.reply(`خيارات للزر ${text}:`, Markup.inlineKeyboard(inlineKb));
      return;
    }

    await updateButtonStats(buttonId);

    const subButtons = await db.collection('buttons').where('parentId', '==', buttonId).get();
    const newPath = subButtons.empty ? buttonId : buttonId;
    await userRef.update({ currentPath: newPath });
    await sendButtonMessages(ctx, buttonId);
    await ctx.reply('اختر:', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }

  // If in EDITING_CONTENT and text not button, add as text message
  if (state === 'EDITING_CONTENT' && isAdmin) {
    const buttonId = currentPath;
    const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
    const newOrder = messages.size;
    await db.collection('messages').doc().set({
      buttonId,
      type: 'text',
      content: text,
      caption: '',
      order: newOrder
    });
    await ctx.reply('تم إضافة النص.');
    await sendButtonMessages(ctx, buttonId, true);
    return;
  }
});

bot.on(['photo', 'video', 'document'], async (ctx) => {
  const userId = String(ctx.from.id);
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  const { state, isAdmin, currentPath } = userDoc.data();

  if (state === 'EDITING_CONTENT' && isAdmin) {
    let type, fileId, caption = ctx.message.caption || '';
    if (ctx.message.photo) {
      type = 'photo';
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.video) {
      type = 'video';
      fileId = ctx.message.video.file_id;
    } else if (ctx.message.document) {
      type = 'document';
      fileId = ctx.message.document.file_id;
    }

    const buttonId = currentPath;
    const messages = await db.collection('messages').where('buttonId', '==', buttonId).get();
    const newOrder = messages.size;
    await db.collection('messages').doc().set({
      buttonId,
      type,
      fileId,
      caption,
      order: newOrder
    });
    await ctx.reply('تم إضافة المحتوى.');
    await sendButtonMessages(ctx, buttonId, true);
    return;
  }
});

bot.on('message', async (ctx) => {
  const userId = String(ctx.from.id);
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  const { state, isAdmin } = userDoc.data();

  if (state === 'AWAITING_BROADCAST' && isAdmin) {
    const users = await db.collection('users').get();
    for (const user of users.docs) {
      try {
        await ctx.copyMessage(user.data().chatId);
      } catch (e) {}
    }
    await userRef.update({ state: 'NORMAL' });
    await ctx.reply('تم الإرسال الجماعي.', Markup.keyboard(await generateKeyboard(userId)).resize());
    return;
  }
});

// --- معالج الـ Callback Queries ---
bot.on('callback_query', async (ctx) => {
  const userId = String(ctx.from.id);
  const data = ctx.callbackQuery.data;
  const parts = data.split('_');
  const action = parts[0];
  const targetId = parts[1];

  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  const { isAdmin, currentPath, state } = userDoc.data();

  if (!isAdmin) return;

  if (action === 'admin') {
    if (targetId === 'add') {
      await userRef.update({ state: 'AWAITING_ADMIN_ADD' });
      await ctx.answerCbQuery();
      await ctx.editMessageText('أدخل ID المشرف الجديد:');
      return;
    }
    if (targetId === 'remove') {
      await userRef.update({ state: 'AWAITING_ADMIN_REMOVE' });
      await ctx.answerCbQuery();
      await ctx.editMessageText('أدخل ID المشرف لحذفه:');
      return;
    }
  }

  if (action === 'btn') {
    const buttonId = targetId; // Wait, parts[0]='btn', parts[1]='rename', parts[2]=id
    // Fix: const actionType = parts[1];
    // const buttonId = parts[2];
    // But in code, data = `btn_rename_${buttonId}`, so parts = ['btn', 'rename', buttonId]
    // No, in reply data `btn_rename_${buttonId}`, split('_') = ['btn', 'rename', buttonId]

    const realAction = parts[1];
    const realButtonId = parts[2];

    if (realAction === 'rename') {
      await userRef.update({ state: 'AWAITING_BUTTON_RENAME', stateData: { buttonId: realButtonId } });
      await ctx.answerCbQuery();
      await ctx.reply('أدخل الاسم الجديد:');
      return;
    }

    if (realAction === 'delete') {
      await recursiveDeleteButton(realButtonId);
      await ctx.answerCbQuery('تم الحذف');
      await ctx.reply('تم حذف الزر.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    }

    if (['up', 'down', 'left', 'right'].includes(realAction)) {
      const buttons = await db.collection('buttons').where('parentId', '==', currentPath).orderBy('order').get();
      const buttonList = buttons.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const index = buttonList.findIndex(b => b.id === realButtonId);
      if (index === -1) return;

      let swapIndex = -1;
      if (realAction === 'up' && index > 0) swapIndex = index - 1;
      if (realAction === 'down' && index < buttonList.length - 1) swapIndex = index + 1;
      if (realAction === 'left' && index > 0 && index % 2 === 1) swapIndex = index - 1;
      if (realAction === 'right' && index < buttonList.length - 1 && index % 2 === 0) swapIndex = index + 1;

      if (swapIndex !== -1) {
        const tempOrder = buttonList[index].order;
        await db.collection('buttons').doc(realButtonId).update({ order: buttonList[swapIndex].order });
        await db.collection('buttons').doc(buttonList[swapIndex].id).update({ order: tempOrder });
        await ctx.answerCbQuery('تم التحريك');
        await ctx.reply('تم التحريك.', Markup.keyboard(await generateKeyboard(userId)).resize());
      } else {
        await ctx.answerCbQuery('لا يمكن التحريك هنا');
      }
      return;
    }

    if (realAction === 'adminonly') {
      const buttonDoc = await db.collection('buttons').doc(realButtonId).get();
      const adminOnly = !buttonDoc.data().adminOnly;
      await db.collection('buttons').doc(realButtonId).update({ adminOnly });
      await ctx.answerCbQuery(`الزر الآن ${adminOnly ? 'للمشرفين فقط' : 'للجميع'}`);
      await ctx.reply('تم التعديل.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    }

    if (realAction === 'stats') {
      const buttonDoc = await db.collection('buttons').doc(realButtonId).get();
      const stats = buttonDoc.data().stats || { totalClicks: 0, dailyClicks: 0 };
      await ctx.reply(`ضغطات اليوم: ${stats.dailyClicks}\nضغطات كلية: ${stats.totalClicks}`);
      await ctx.answerCbQuery();
      return;
    }
  }

  if (action === 'msg') {
    const realAction = parts[1];
    const realMessageId = parts[2];

    if (realAction === 'delete') {
      await db.collection('messages').doc(realMessageId).delete();
      await ctx.answerCbQuery('تم الحذف');
      await sendButtonMessages(ctx, currentPath, true);
      return;
    }

    if (realAction === 'edit') {
      await userRef.update({ state: 'AWAITING_MESSAGE_EDIT', stateData: { messageId: realMessageId } });
      await ctx.answerCbQuery();
      await ctx.reply('أدخل الشرح الجديد أو المحتوى:');
      return;
    }

    if (realAction === 'up' || realAction === 'down') {
      const messages = await db.collection('messages').where('buttonId', '==', currentPath).orderBy('order').get();
      const messageList = messages.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const index = messageList.findIndex(m => m.id === realMessageId);
      if (index === -1) return;

      let swapIndex = -1;
      if (realAction === 'up' && index > 0) swapIndex = index - 1;
      if (realAction === 'down' && index < messageList.length - 1) swapIndex = index + 1;

      if (swapIndex !== -1) {
        const tempOrder = messageList[index].order;
        await db.collection('messages').doc(realMessageId).update({ order: messageList[swapIndex].order });
        await db.collection('messages').doc(messageList[swapIndex].id).update({ order: tempOrder });
        await ctx.answerCbQuery('تم التحريك');
        await sendButtonMessages(ctx, currentPath, true);
      }
      return;
    }

    if (realAction === 'addnext') {
      const messages = await db.collection('messages').where('buttonId', '==', currentPath).orderBy('order').get();
      const messageList = messages.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const msg = messageList.find(m => m.id === realMessageId);
      if (msg) {
        await userRef.update({ state: 'AWAITING_NEW_MESSAGE_NEXT', stateData: { targetOrder: msg.order } });
        await ctx.answerCbQuery();
        await ctx.reply('أرسل الرسالة التالية:');
      }
      return;
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
```
