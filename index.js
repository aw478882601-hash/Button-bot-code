// =================================================================
// |   TELEGRAM FIREBASE BOT - V60 - WITH MIGRATION COMMAND        |
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
// |                 ⭐️ MIGRATION COMMAND ⭐️                 |
// =================================================================
bot.command('startmigration', async (ctx) => {
    // Ensure only the super admin can run this
    if (String(ctx.from.id) !== process.env.SUPER_ADMIN_ID) {
        return ctx.reply('🚫 This command is for the super admin only.');
    }

    try {
        await ctx.reply('⏳ Starting database migration... This may take a few minutes. Please wait.');
        console.log('Starting database migration...');

        const buttonsSnapshot = await db.collection('buttons').get();
        const messagesSnapshot = await db.collection('messages').get();
        console.log(`Found ${buttonsSnapshot.size} buttons and ${messagesSnapshot.size} messages.`);

        const messagesByButton = {};
        messagesSnapshot.forEach(doc => {
            const message = doc.data();
            if (!messagesByButton[message.buttonId]) {
                messagesByButton[message.buttonId] = [];
            }
            messagesByButton[message.buttonId].push({
                id: uuidv4(), // Give it a new unique ID within the array
                order: message.order, type: message.type, content: message.content,
                caption: message.caption || '', entities: message.entities || []
            });
        });

        const subButtonsByParent = {};
        buttonsSnapshot.forEach(doc => {
            const button = doc.data();
            if (button.parentId && button.parentId !== 'root') {
                if (!subButtonsByParent[button.parentId]) {
                    subButtonsByParent[button.parentId] = [];
                }
                subButtonsByParent[button.parentId].push({
                    id: doc.id, // Keep original ID for path consistency
                    text: button.text, order: button.order, isFullWidth: button.isFullWidth || false,
                    adminOnly: button.adminOnly || false
                });
            }
        });

        console.log('Updating button documents...');
        const writeBatch = db.batch();
        let updatedCount = 0;

        for (const doc of buttonsSnapshot.docs) {
            const buttonId = doc.id;
            const buttonData = doc.data();
            const buttonPath = `${buttonData.parentId}/${buttonId}`;

            const messagesForThisButton = (messagesByButton[buttonId] || []).sort((a, b) => a.order - b.order);
            const subButtonsForThisButton = (subButtonsByParent[buttonPath] || []).sort((a, b) => a.order - b.order);

            writeBatch.update(doc.ref, {
                messages: messagesForThisButton,
                subButtons: subButtonsForThisButton
            });
            updatedCount++;
        }

        await writeBatch.commit();
        console.log(`Updated ${updatedCount} button documents.`);
        
        await ctx.reply(`✅ Migration completed successfully! Updated ${updatedCount} buttons.\n\n🚨 IMPORTANT: You can now delete the 'messages' collection from the Firebase console.\n\nFinally, replace the bot code with the FINAL version provided by the assistant.`);
        
    } catch (error) {
        console.error("MIGRATION FAILED:", error);
        await ctx.reply(`❌ MIGRATION FAILED: ${error.message}`);
    }
});

// Add a simple start command to keep the bot alive for the migration
bot.start((ctx) => ctx.reply('Bot is running in migration mode. Use /startmigration if you are the super admin.'));

// --- Vercel Webhook Setup ---
module.exports = async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (err) {
        console.error('Error in webhook handler:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Internal server error.');
        }
    }
};
