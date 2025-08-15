// --- 1. استدعاء المكتبات والإعدادات الأولية ---
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

// --- 2. تهيئة Firebase ---
// نتأكد من عدم تهيئة التطبيق أكثر من مرة
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

// --- 4. دوال مساعدة (Helper Functions) ---

/**
 * دالة لإنشاء لوحة المفاتيح بناءً على حالة المستخدم وموقعه
 * @param {number} userId - معرف المستخدم في تليجرام
 * @returns {Promise<Array<Array<string>>>} - مصفوفة الأزرار
 */
async function generateKeyboard(userId) {
  try {
    const userDocRef = db.collection('users').doc(String(userId));
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) return [[]];

    const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDoc.data();

    // جلب الأزرار من قاعدة البيانات
    const buttonsSnapshot = await db.collection('buttons')
      .where('parentId', '==', currentPath)
      .orderBy('order')
      .get();

    const keyboardRows = [];
    let currentRow = [];

    buttonsSnapshot.forEach(doc => {
      const button = doc.data();
      if (!button.adminOnly || isAdmin) {
        currentRow.push(button.text);
        if (currentRow.length === 2) { // عرض زرين في كل صف
          keyboardRows.push(currentRow);
          currentRow = [];
        }
      }
    });
    if (currentRow.length > 0) {
      keyboardRows.push(currentRow);
    }

    // إضافة أزرار الأدمن الديناميكية
    if (isAdmin) {
      const adminRow = [];
      if (state === 'EDITING_BUTTONS') {
        adminRow.push('➕ إضافة زر');
      }
       if (state === 'EDITING_CONTENT' && currentPath !== 'root') {
        adminRow.push('➕ إضافة رسالة');
      }
      if (adminRow.length > 0) keyboardRows.push(adminRow);
    }
    
    // الأزرار الثابتة السفلية
    const fixedButtons = [];
    if (currentPath !== 'root') {
      fixedButtons.push('🔙 رجوع');
      fixedButtons.push('🔝 القائمة الرئيسية');
    }
    
    // أزرار التحكم للأدمن
    if (isAdmin) {
      const adminControlRow = [];
      adminControlRow.push(state === 'EDITING_BUTTONS' ? '🚫 إلغاء تعديل الأزرار' : '✏️ تعديل الأزرار');
      adminControlRow.push(state === 'EDITING_CONTENT' ? '🚫 إلغاء تعديل المحتوى' : '📄 تعديل المحتوى');
      keyboardRows.push(adminControlRow);
    }
    
    if(fixedButtons.length > 0) keyboardRows.push(fixedButtons);

    return keyboardRows;
  } catch (error) {
    console.error('Error generating keyboard:', error);
    return [['حدث خطأ في عرض الأزرار']];
  }
}

/**
 * دالة لإرسال الرسائل المرتبطة بزر معين
 * @param {object} ctx - سياق Telegraf
 * @param {string} buttonId - معرف الزر
 */
async function sendButtonMessages(ctx, buttonId) {
    const messagesSnapshot = await db.collection('messages')
        .where('buttonId', '==', buttonId)
        .orderBy('order')
        .get();

    if (messagesSnapshot.empty) {
        await ctx.reply('لا يوجد محتوى مرتبط بهذا الزر بعد.');
        return;
    }

    for (const doc of messagesSnapshot.docs) {
        const message = doc.data();
        const options = { caption: message.caption || '' };
        try {
            switch (message.type) {
                case 'text':
                    await ctx.reply(message.content);
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
            await ctx.reply(`حدث خطأ أثناء إرسال إحدى الرسائل. ربما تم تغيير الملف ${message.type}.`);
        }
    }
}


// --- 5. أوامر البوت الأساسية ---

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    // تسجيل مستخدم جديد
    await userRef.set({
      chatId: ctx.chat.id,
      firstName: ctx.from.first_name || 'User',
      isAdmin: false, // أول أدمن يجب إضافته يدوياً في Firestore
      currentPath: 'root',
      state: 'NORMAL',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
     // تحديث المسار والحالة للمستخدم العائد
     await userRef.update({ currentPath: 'root', state: 'NORMAL' });
  }

  // جلب رسالة الترحيب من الإعدادات
  const settingsDoc = await db.collection('config').doc('settings').get();
  const welcomeMessage = settingsDoc.exists && settingsDoc.data().welcomeMessage ? settingsDoc.data().welcomeMessage : 'أهلاً بك في البوت!';

  const keyboard = await generateKeyboard(userId);
  await ctx.reply(welcomeMessage, Markup.keyboard(keyboard).resize());
});

// --- 6. معالج الرسائل النصية (الضغط على الأزرار) ---

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return bot.start(ctx); // إذا لم يكن المستخدم مسجلاً، ابدأ من جديد
  }

  const { currentPath, state, isAdmin } = userDoc.data();

  // --- التعامل مع الأزرار الثابتة ---
  switch (text) {
    case '🔝 القائمة الرئيسية':
      await userRef.update({ currentPath: 'root', state: 'NORMAL' });
      await ctx.reply('تم العودة للقائمة الرئيسية.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    case '🔙 رجوع':
      const newPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || 'root';
      await userRef.update({ currentPath: newPath });
      await ctx.reply('تم الرجوع خطوة.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
  }
  
  // --- التعامل مع أزرار الأدمن ---
  if (isAdmin) {
    switch(text) {
        case '✏️ تعديل الأزرار':
            await userRef.update({ state: 'EDITING_BUTTONS' });
            await ctx.reply('تم تفعيل وضع تعديل الأزرار. اضغط على أي زر لتعديله أو اضغط "إضافة زر".', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '🚫 إلغاء تعديل الأزرار':
            await userRef.update({ state: 'NORMAL' });
            await ctx.reply('تم إلغاء وضع تعديل الأزرار.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '📄 تعديل المحتوى':
            await userRef.update({ state: 'EDITING_CONTENT' });
            await ctx.reply('تم تفعيل وضع تعديل المحتوى. أرسل ملفات أو نصوص لإضافتها للقسم الحالي.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '🚫 إلغاء تعديل المحتوى':
            await userRef.update({ state: 'NORMAL' });
            await ctx.reply('تم إلغاء وضع تعديل المحتوى.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
    }
  }

  // --- التعامل مع الحالات الخاصة (مثل انتظار إدخال) ---
  if(isAdmin && state === 'AWAITING_NEW_BUTTON_NAME') {
    const newButtonName = text;
    const existingButton = await db.collection('buttons').where('parentId', '==', currentPath).where('text', '==', newButtonName).get();
    if (!existingButton.empty) {
        return ctx.reply('هذا الاسم مستخدم بالفعل. الرجاء اختيار اسم آخر.');
    }
    const countSnapshot = await db.collection('buttons').where('parentId', '==', currentPath).count().get();
    await db.collection('buttons').add({
        text: newButtonName,
        parentId: currentPath,
        adminOnly: false,
        order: countSnapshot.data().count,
        stats: { totalClicks: 0 }
    });
    await userRef.update({ state: 'EDITING_BUTTONS' }); // العودة لوضع التعديل
    return ctx.reply(`✅ تم إضافة زر "${newButtonName}".`, Markup.keyboard(await generateKeyboard(userId)).resize());
  }


  // --- البحث عن الزر المضغوط والانتقال ---
  const buttonSnapshot = await db.collection('buttons')
    .where('parentId', '==', currentPath)
    .where('text', '==', text)
    .limit(1)
    .get();

  if (!buttonSnapshot.empty) {
    const buttonDoc = buttonSnapshot.docs[0];
    const buttonId = buttonDoc.id;

    if (isAdmin && state === 'EDITING_BUTTONS') {
        await ctx.reply(`اختر إجراء للزر "${text}":`, Markup.inlineKeyboard([
            [Markup.button.callback('✏️ تعديل الاسم', `rename_btn:${buttonId}`)],
            [Markup.button.callback('🗑️ حذف الزر', `delete_btn:${buttonId}`)],
        ]));
        return;
    }

    const newPath = `${currentPath}/${buttonId}`;
    await userRef.update({ currentPath: newPath });
    await sendButtonMessages(ctx, buttonId);
    await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
  
  } else if (isAdmin && text === '➕ إضافة زر' && state === 'EDITING_BUTTONS') {
    await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME' });
    await ctx.reply('📝 من فضلك، أرسل اسم الزر الجديد.');

  } else {
    // تجاهل الرسائل غير المعروفة بصمت لتجنب إزعاج المستخدم
  }
});


// --- 7. معالج الـ Callback Queries (للأزرار المضمنة Inline) ---
bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id;
    const [action, buttonId] = ctx.callbackQuery.data.split(':');
    const user = (await db.collection('users').doc(String(userId)).get()).data();
    if (!user.isAdmin) return ctx.answerCbQuery('هذا الإجراء مخصص للمشرفين فقط!');

    if (action === 'delete_btn') {
        try {
            await db.collection('buttons').doc(buttonId).delete();
            await ctx.editMessageText('✅ تم حذف الزر بنجاح.');
            await ctx.reply('تم تحديث القائمة:', Markup.keyboard(await generateKeyboard(userId)).resize());
        } catch (error) {
            console.error('Error deleting button:', error);
            await ctx.editMessageText('❌ حدث خطأ أثناء الحذف.');
        }
    }
});

// --- 8. معالج الملفات والوسائط ---
const mediaHandler = async (ctx) => {
    const userId = ctx.from.id;
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (!userDoc.exists || !userDoc.data().isAdmin || userDoc.data().state !== 'EDITING_CONTENT') return;
    
    const currentPath = userDoc.data().currentPath;
    if (currentPath === 'root') return ctx.reply('لا يمكن إضافة محتوى للقائمة الرئيسية مباشرة.');

    const buttonId = currentPath.split('/').pop();
    let fileId, type;
    const msg = ctx.message;

    if (msg.photo) { type = 'photo'; fileId = msg.photo.pop().file_id; }
    else if (msg.video) { type = 'video'; fileId = msg.video.file_id; }
    else if (msg.document) { type = 'document'; fileId = msg.document.file_id; }
    else { return; }

    const countSnapshot = await db.collection('messages').where('buttonId', '==', buttonId).count().get();
    await db.collection('messages').add({
        buttonId: buttonId,
        type: type,
        content: fileId,
        caption: msg.caption || '',
        order: countSnapshot.data().count
    });

    await ctx.reply(`✅ تم حفظ الملف (${type}) بنجاح في هذا القسم.`);
};
bot.on(['photo', 'video', 'document'], mediaHandler);


// --- 9. إعداد Vercel Webhook ---
module.exports = async (req, res) => {
    // First, check if the request is a POST request from Telegram
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body, res);
        } catch (err) {
            console.error('Error in webhook handler:', err);
        }
    } else {
        // If it's not a POST request, just send a friendly response
        res.status(200).send('Bot is running and waiting for messages from Telegram.');
    }
};
