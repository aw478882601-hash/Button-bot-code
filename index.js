// index.js

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

    /* // The original code is temporarily disabled below
    const userDocRef = db.collection('users').doc(String(userId));
    const userDoc = await userDocRef.get();
    // ... the rest of your original code
    */
  } catch (error) {
    console.error('Error during simple connection test:', error);
    return [['Connection Failed']];
  }
}
