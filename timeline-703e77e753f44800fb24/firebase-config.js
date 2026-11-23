/* Your Firebase Realtime Database config. Multiplayer needs it; solo play does not.

   Paste ONLY the object itself here — not the whole snippet the Firebase console
   shows you. If you copied the lot, delete its `import ... from "firebase/app"`
   line and its `initializeApp(...)` line: browsers cannot resolve a bare
   "firebase/app" specifier, and the page will refuse to load with it present.
   app/net.js loads the SDK and calls initializeApp itself.

   These values are not secrets. Firebase web config is public by design — the
   database rules are what protect your data, not this file.

   Setup steps are in DEPLOY.md. */

export const firebaseConfig = {
  apiKey: "AIzaSyCJ5wYHuhwaIpbjG36-MId-k7yJwBSmwFI",
  authDomain: "songyear-game.firebaseapp.com",
  databaseURL: "https://songyear-game-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "songyear-game",
  storageBucket: "songyear-game.firebasestorage.app",
  messagingSenderId: "436581360877",
  appId: "1:436581360877:web:5c9cf054eecbeffaa018e4",
};
