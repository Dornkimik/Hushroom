# Hushroom

An anonymous chatroom website with live public rooms, private conversations, and password-protected room management. All source files are included. No visitor accounts are required. Browser encryption uses a pinned, locally served TweetNaCl dependency.

## Open in Visual Studio

1. Install Node.js 22.9 or newer (Node 24 LTS recommended).
2. In Visual Studio Installer, enable the **Node.js development** workload.
3. Open **Hushroom.sln** in Visual Studio. You can also use **File → Open → Folder** and choose this folder, or open it in Visual Studio Code.
4. In a terminal opened in this folder, run `npm ci`, then `npm start`.
5. Open **http://localhost:3000**. Keep the terminal running.

Visual Studio's project launcher is included; the terminal command is the dependable fallback if your installed Node tools do not launch `.mjs` entry points. If Node is not found, install it and restart Visual Studio.

## Admin password

This local copy includes a generated admin password in `.env`, on the `ADMIN_PASSWORD=` line. Click **Room management** in the website and enter that password. Visitors never need a password. If `.env` is absent, the terminal prints a temporary admin password instead.

For a permanent password, copy `.env.example` to `.env`, fill in `ADMIN_PASSWORD` with a long, unique password, and restart `npm start`. Keep `.env` private. Admin access expires after one hour, and **Lock admin controls** ends it immediately. Rooms can be created or removed in the admin panel. Hosts can also ban an active anonymous browser session, unban it later, or remove individual messages from everyone’s view. Session bans survive server restarts in `data/bans.json`, which stores hashed session-cookie values; clearing browser cookies creates a new session and is not prevented by a session ban.

## Try a private chat

Open the site in two separate browsers, or one normal and one private browser window. Each receives its own alias. Click a person under **In good company** to chat privately. Tabs in the same browser profile share one identity. On phones, the people list is below the chat area. Incoming private conversations appear in the sidebar with unread counts.

Private messages, captions, mentions, and image keys are encrypted in the browser. Use **Verify identity** and compare the code through another trusted channel before marking the conversation verified. Changed keys block the conversation. The initial key is trusted on first use until verified.

Use **＋** in a private chat to select a JPEG, PNG, or WebP image. The browser removes original metadata by re-encoding to WebP, resizes to at most 2048 pixels on the longest edge, and encrypts the result before upload. Original filenames are never sent. Captions are optional. Images cannot be uploaded to public rooms.

Images expire after 24 hours (or a shorter configured period), and disappear on restart. Offline recipients can retrieve messages and images while their anonymous session and the recent history remain available. Clearing browser storage or ending an incognito session loses the local keys; there is no server-side recovery. If the cookie remains but the key is lost, start a fresh browser session by clearing site data.

## Where to edit

| File | What it controls |
| --- | --- |
| `public/index.html` | Layout and interface text |
| `public/style.css` | Colors, typography, spacing, responsive layout |
| `public/app.js` | Browser interactions and live updates |
| `public/crypto.js` | Browser key storage, verification and authenticated encryption |
| `public/private.js` | Local image preparation |
| `lib/attachments.mjs` | Temporary encrypted attachment storage and quotas |
| `public/favicon.svg` | Browser-tab icon |
| `server.mjs` | Chat server, temporary identities, room management |
| `.env` | Password and hosting settings; create from `.env.example` |
| `data/rooms.json` | Saved rooms, generated after the first room change |
| `data/bans.json` | Hashed session-cookie bans, generated when a session is banned |

Refresh after frontend edits. Restart the server after changing `server.mjs` or `.env`. The main colors are at the beginning of `style.css`.

## Privacy and storage

- A random alias and an HttpOnly session cookie identify each visitor. No real name or email is requested.
- Public rooms and their latest history are accessible to all visitors.
- Private message contents and images are end-to-end encrypted. The server relays ciphertext and public keys; private keys and image keys are never sent in plaintext. Admin controls do not give access to decrypt other people’s private conversations.
- The server can still see participant IDs, aliases, timing, encrypted sizes, attachment IDs and reply relationships. Identity verification, browser trust and the absence of forward secrecy are explained in [SECURITY.md](SECURITY.md).
- Only the latest 100 messages per conversation are retained, in memory. Restarting the server clears messages, identities, and admin sessions. Reconnects within the same live session reload the current conversation's available history.
- After 24 hours offline, an identity and its private histories are removed. Server restarts also discard the list of private conversations. This is a temporary chat service, not a durable inbox.
- Encrypted images stay in bounded server memory, never in the data directory. Limits: 12 MB input, 32 megapixels, 4 MB after local resizing; 20 MB per uploader and 128 MB total storage including upload reservations. Unsent uploads expire after 10 minutes. Sent images also disappear on message removal, history eviction or either participant’s ban/session expiry.
- Room names and descriptions are saved in `data/rooms.json` and survive restarts. Back up that file to preserve your room setup.
- The app does not write chat contents or IP addresses to log files. It temporarily uses connection addresses for admin login throttling; a host or reverse proxy may keep its own access logs.

## Put it online

This delivery runs locally; it has not been published. To share it publicly, deploy the entire project to a host that runs long-lived Node.js processes. Static-only hosting cannot run the chat server.

Set `HOST=0.0.0.0`, `PORT` to the host's assigned port, a strong `ADMIN_PASSWORD`, `ORIGIN` to your exact public HTTPS origin (no trailing slash), and `SECURE_COOKIES=true`. Put HTTPS in front of the server and keep the `data` directory on persistent storage. Configure the proxy to allow streaming responses on `/api/events`, with buffering disabled and a timeout longer than the 20-second heartbeat. Install production dependencies with `npm ci --omit=dev`, then start with `npm start`. HTTPS (or localhost) and IndexedDB are required for private chats. Configure the reverse proxy to accept encrypted uploads up to 4 MB plus 16 bytes. Set `ATTACHMENT_TTL_SECONDS` to 1–86400 to shorten image retention; the default is 86400.

Run **one server process / one replica**. Live sessions and message histories are held in that process; multiple replicas require a shared identity store and message broker first. The app includes message limits, admin login throttling, origin checks, escaped text rendering, and security headers. A larger public community will also need moderation/reporting controls, abuse protection at the host, and load testing appropriate to its size.

## Verify

Run `npm test`. Crypto and storage tests cover authentication, tampering, verification codes, ownership, expiry and quotas. Integration tests use separate anonymous sessions and a separate temporary data directory to check real-time public and private delivery, private-history isolation, admin permissions, input limits, room persistence, deletion, and origin protection.

For real browser checks, install dev dependencies with `npm ci`, then install a test browser with `npx playwright install chromium` and run `npm run test:browser`. To use an existing Chromium installation, set `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`). These checks use temporary data and isolated browser profiles for encrypted text/images/replies, identity verification, refreshes, multiple tabs, offline delivery, key substitution and key loss. They do not use your normal browser profile or running chat instance.

## Replies, mentions, emoji, and commands

Choose **Delete** on your own message to remove it for everyone, including any attached image. No admin access is needed. Replies to deleted messages show that the original was removed.

Choose **Reply** on a message to quote it in the same room or private conversation. Cancel the preview with ×. Quoted text is removed when the original message is moderated.

Type `@` and part of an alias to tag someone. Choose a suggestion with the mouse, ↑/↓ and Enter, or Tab; Escape dismisses suggestions. Mentions use the full alias, including its unique suffix, and highlight messages for the tagged person. In private chats, only the two participants can be mentioned. The ☺ button opens a searchable emoji picker and inserts the selected emoji at the cursor.

Type `/help` for command help. Unlock **Room management** before using moderation commands:

- `/ban @Full Alias` bans that anonymous session. User autocomplete also works after `/ban `.
- `/unban @Full Alias` restores a banned session; suggestions include current bans.
- `/remove` removes the message selected with **Reply**.

Ban and unban also accept an exact session ID. Commands and their feedback stay local to the sender; they are not posted as chat messages. Prefix a message with `//` to send a literal leading slash. All moderation actions retain server-side admin permission checks.
