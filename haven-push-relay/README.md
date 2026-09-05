# MSG Arena Push Relay

FCM push notification relay for MSG Arena mobile apps. Runs as a Firebase Cloud Function so it stays online 24/7 even if your PC is off.

## How it works

```
MSG Arena Server A ──┐
MSG Arena Server B ──┼── POST /sendPush ──→ Cloud Function ──→ FCM ──→ phones
MSG Arena Server C ──┘
```

Self-hosted MSG Arena servers don't need Firebase credentials. They just POST to this relay with a shared key. The relay holds the Firebase service account and forwards to FCM.

## Setup

### 1. Install Firebase CLI
```bash
npm install -g firebase-tools
firebase login
```

### 2. Deploy
```bash
cd haven-push-relay
cd functions && npm install && cd ..
firebase deploy --only functions
```

### 3. Set the push key (a shared secret for authenticating servers)
Generate a random key and set it:
```bash
firebase functions:secrets:set HAVEN_PUSH_KEY
```
Enter a strong random string when prompted (e.g. output of `openssl rand -hex 32`).

Redeploy after setting the secret:
```bash
firebase deploy --only functions
```

### 4. Get the relay URL
After deploy, Firebase will print the function URL:
```
Function URL (sendPush): https://sendpush-xxxxxxxxxx-uc.a.run.app
```

### 5. Configure MSG Arena servers
Each MSG Arena server that wants mobile push notifications adds to their `.env`:
```env
FCM_RELAY_URL=https://sendpush-xxxxxxxxxx-uc.a.run.app
FCM_PUSH_KEY=your-secret-key-from-step-3
```

That's it. Any message sent on that MSG Arena server will trigger push notifications to mobile app users who aren't actively using the app.

## Security

- The relay key prevents unauthorized servers from sending pushes
- Each request is validated (tokens array, title, body required)
- Max 500 tokens per request (FCM limit)
- Failed/expired tokens are reported back so servers can clean them up
- CORS is enabled so it works from any origin
- Max 10 concurrent instances to prevent abuse
