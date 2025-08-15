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

// --- 4. دوال مساعدة (Helper Functions) ---

async function generateKeyboard(userId) {
  try {
    const userDocRef = db.collection('users').doc(String(userId));
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) return [[]];

    const { isAdmin, currentPath = 'root', state = 'NORMAL' } = userDoc.data();

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
        if (currentRow.length === 2) {
          keyboardRows.push(currentRow);
          currentRow = [];
        }
      }
    });
    if (currentRow.length > 0) {
      keyboardRows.push(currentRow);
    }

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
    
    const fixedButtons = [];
    if (currentPath !== 'root') {
      fixedButtons.push('🔙 رجوع');
      fixedButtons.push('🔝 القائمة الرئيسية');
    }
    
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
    await userRef.set({
      chatId: ctx.chat.id,
      firstName: ctx.from.first_name || 'User',
      isAdmin: false,
      currentPath: 'root',
      state: 'NORMAL',
      lastClickedButtonId: null, // إضافة الحقل الجديد هنا
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
     await userRef.update({ currentPath: 'root', state: 'NORMAL', lastClickedButtonId: null });
  }

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
    return bot.start(ctx);
  }

  const userData = userDoc.data();
  const { currentPath, state, isAdmin, lastClickedButtonId } = userData;

  // --- التعامل مع الأزرار الثابتة ---
  switch (text) {
    case '🔝 القائمة الرئيسية':
      await userRef.update({ currentPath: 'root', state: 'NORMAL', lastClickedButtonId: null });
      await ctx.reply('تم العودة للقائمة الرئيسية.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
    case '🔙 رجوع':
      const newPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || 'root';
      await userRef.update({ currentPath: newPath, lastClickedButtonId: null });
      await ctx.reply('تم الرجوع خطوة.', Markup.keyboard(await generateKeyboard(userId)).resize());
      return;
  }
  
  // --- التعامل مع أزرار الأدمن ---
  if (isAdmin) {
    switch(text) {
        case '✏️ تعديل الأزرار':
            await userRef.update({ state: 'EDITING_BUTTONS' });
            await ctx.reply('تم تفعيل وضع تعديل الأزرار. اضغط على أي زر مرة لعرض الخيارات، أو مرتين للدخول إليه.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '🚫 إلغاء تعديل الأزرار':
            await userRef.update({ state: 'NORMAL', lastClickedButtonId: null }); // تنظيف عند الخروج
            await ctx.reply('تم إلغاء وضع تعديل الأزرار.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '📄 تعديل المحتوى':
            await userRef.update({ state: 'EDITING_CONTENT', lastClickedButtonId: null });
            await ctx.reply('تم تفعيل وضع تعديل المحتوى.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
        case '🚫 إلغاء تعديل المحتوى':
            await userRef.update({ state: 'NORMAL', lastClickedButtonId: null });
            await ctx.reply('تم إلغاء وضع تعديل المحتوى.', Markup.keyboard(await generateKeyboard(userId)).resize());
            return;
    }
  }

  // --- التعامل مع الحالات الخاصة (مثل انتظار إدخال) ---
  if(isAdmin && state === 'AWAITING_NEW_BUTTON_NAME') {
    // ... (الكود الخاص بإضافة زر جديد كما هو) ...
    return;
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

    // --- ⭐⭐⭐ منطق التعديل الجديد هنا ⭐⭐⭐ ---
    if (isAdmin && state === 'EDITING_BUTTONS') {
        // التحقق مما إذا كان هذا الزر هو نفسه الذي تم الضغط عليه آخر مرة
        if (lastClickedButtonId === buttonId) {
            // **هذه هي الضغطة الثانية (الدخول للزر)**
            const newPath = `${currentPath}/${buttonId}`;
            await userRef.update({ currentPath: newPath, lastClickedButtonId: null }); // الدخول وإعادة تعيين الذاكرة
            await ctx.reply(`تم الدخول إلى زر "${text}"، يمكنك الآن إضافة أزرار فرعية.`, Markup.keyboard(await generateKeyboard(userId)).resize());
        } else {
            // **هذه هي الضغطة الأولى (عرض الخيارات)**
            await userRef.update({ lastClickedButtonId: buttonId }); // تسجيل الزر كآخر زر تم الضغط عليه
            await ctx.reply(`زر "${text}":\nاضغط مرة أخرى للدخول وإضافة أزرار فرعية، أو اختر أحد الخيارات:`, Markup.inlineKeyboard([
                [Markup.button.callback('✏️ تعديل الاسم', `rename_btn:${buttonId}`)],
                [Markup.button.callback('🗑️ حذف الزر', `delete_btn:${buttonId}`)],
            ]));
        }
        return; // إنهاء التنفيذ هنا لوضع التعديل
    }
    // --- نهاية منطق التعديل ---

    // الوضع الطبيعي: الانتقال وعرض المحتوى
    const newPath = `${currentPath}/${buttonId}`;
    await userRef.update({ currentPath: newPath, lastClickedButtonId: null });
    await sendButtonMessages(ctx, buttonId);
    await ctx.reply(`أنت الآن في قسم: ${text}`, Markup.keyboard(await generateKeyboard(userId)).resize());
  
  } else if (isAdmin && text === '➕ إضافة زر' && state === 'EDITING_BUTTONS') {
    await userRef.update({ state: 'AWAITING_NEW_BUTTON_NAME', lastClickedButtonId: null });
    await ctx.reply('📝 من فضلك، أرسل اسم الزر الجديد.');
  }
});


// ... (باقي الكود الخاص بـ callback_query و mediaHandler كما هو) ...
// --- 7. معالج الـ Callback Queries (للأزرار المضمنة Inline) ---
bot.on('callback_query', async (ctx) => {
    // ... الكود لم يتغير ...
});

// --- 8. معالج الملفات والوسائط ---
const mediaHandler = async (ctx) => {
    // ... الكود لم يتغير ...
};
bot.on(['photo', 'video', 'document'], mediaHandler);


// --- 9. إعداد Vercel Webhook ---
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body, res);
        } catch (err) {
            console.error('Error in webhook handler:', err);
        }
    } else {
        res.status(200).send('Bot is running and waiting for messages from Telegram.');
    }
};
