// index.js

// (All your other code like require('telegraf'), firebase init, bot.start, etc. should be here)
// ...
// ...

async function generateKeyboard(userId) {
  try {
    // --- TEMPORARY TEST CODE ---
    console.log(`[TEST] Attempting to connect for user: ${userId}`);
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (userDoc.exists) {
        console.log('[SUCCESS] Successfully connected and fetched a document from Firestore!');
    } else {
        console.log('[SUCCESS] Connected to Firestore, but user doc does not exist.');
    }
    return [['Test Button']]; // Just return a simple button for the test
    // --- END OF TEST CODE ---

  } catch (error) {
    console.error('Error during simple connection test:', error);
    return [['Connection Failed']];
  }
}

// ... (The rest of your bot handlers like bot.on('text'), etc.)
// ...
// ...


// ===============================================================
// THIS IS THE CRUCIAL PART THAT WAS LIKELY MISSING
// ===============================================================
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
