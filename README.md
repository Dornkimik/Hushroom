# SilenzaChat

An anonymous chatroom for live public conversations and private, end-to-end encrypted chats. Visitors do not need an account, email address, or real name. https://silenzachat.cc

## Visitor guide

### Joining a conversation

You appear under a random alias. Choose someone in **In good company** to start a private chat. On phones, the people list is below the chat. Tabs in the same browser profile share one identity, and incoming private conversations appear in the sidebar.

### Public rooms and private chats

Public-room messages are visible to other visitors and are not end-to-end encrypted. In private chats, text, captions, mentions, and images are encrypted in your browser and decrypted in the participants’ browsers. The server relays the encrypted content; admin controls do not provide keys to read private chats.

This protection depends on trusting the website code delivered to your browser. Someone who controls the website could change that code to capture messages or keys. A compromised device or browser extension could expose them too.

### Temporary rooms

Choose **＋ Create** beside **Temporary rooms** to create a user-owned room. Give it a name, description, and rules, and choose **Open to everyone** or **Invite only**. Invite-only rooms appear only to their members and invited sessions; owners invite people from **Room details & members**. Owners can edit details and access, kick members, transfer ownership to another member, or delete the room. Members can leave; an owner with other members must transfer ownership or delete the room first.

Room text, images, captions, replies, and mentions are end-to-end encrypted using the same browser identities and authenticated encryption as private chats. Each message is encrypted separately for every current member, including its sender. Use **＋** to attach an image with an optional caption, and **Verify identity** beside a member to compare identity codes through another trusted channel. Names, descriptions, rules, membership, and message counts are metadata visible to the server. Open rooms can be joined by anyone, so use invite-only access for a restricted conversation.

New members receive only future messages. Leaving and rejoining starts a new membership. Kicking a member blocks this session from rejoining and excludes it from subsequent message delivery and encryption; it cannot erase copies already received. A changed membership list requires the sender to encrypt again before sending. Room owners see each current member’s total accepted messages during that membership, including deleted messages. Other members do not receive these counters.

Rooms support up to 20 members. Each visitor can own three rooms and join up to 20. They exist only in server memory and disappear on server restart, after 24 hours without a message or membership/management action, or when the last member leaves. If an owner’s anonymous session expires or is banned, ownership passes to the earliest remaining member. History retains up to 100 messages, subject to a 4 MiB ciphertext budget per room and a 32 MiB total room-history budget.

### Privacy and identity

A random alias means you do not have to provide an account or real name, but it does not make you untraceable. The server can see connection IP addresses, aliases, who is talking to whom, message times, encrypted data sizes, and reply or attachment relationships. A hosting provider or reverse proxy may keep its own logs. What you write or show in an image could identify you as well.

The app does not write chat contents or IP addresses to its own log files. It temporarily uses connection addresses for admin login throttling.

To check a private-chat partner’s encryption key, choose **Verify identity** and compare the entire code in person, on a call, or through another trusted channel. Only mark the codes as matching after an independent comparison. This confirms the key you checked, not someone’s real-world identity. If a key changes unexpectedly, pause and check with the person before continuing.

### Images and message history

Images can be sent in private chats and temporary encrypted rooms. Your browser resizes each image, removes the original file metadata by re-encoding it, then encrypts it before upload. JPEG, PNG, and WebP images are accepted. The original filename is not sent; the image key is shared inside the encrypted message. In a room, only members addressed by that message can download its image while they remain in the same membership. Newcomers, kicked members, and members who leave and rejoin cannot download earlier images. Deleting the message or room also removes its stored image bytes. The server temporarily holds encrypted image data in memory, not as image files on disk.

Metadata removal cannot hide details visible in the picture, and the recipient can save or share a decrypted copy. Choose **Delete** on your own public or private message to remove it for everyone, including an attached image. Deletion cannot remove screenshots, downloads, or copies someone has already made.

Only the latest 100 messages in a conversation are kept in server memory. Messages disappear when the server restarts; private histories and sessions expire after 24 hours offline. Images expire within 24 hours of upload, or sooner if the host configures a shorter period. They can also disappear when their message is deleted or leaves recent history, a participant is banned or their session expires, or the server restarts. This is a temporary chat, not a permanent inbox or backup.

### Your browser identity

Your browser stores a session cookie, encryption keys, remembered peer identities, and your theme preference. Decrypted messages and unsent drafts stay in the current page’s memory; SilenzaChat does not save a permanent local chat archive.

Refreshing normally keeps your session and keys, and tabs in the same browser profile share them. Another browser, profile, or device has a separate identity; there is no account sync. Clearing site data or ending an incognito session can erase your session and keys. The server cannot recover lost keys. If the session remains but its key is lost, private chat is blocked; clear the site’s data to start a new anonymous session.

### Security limits

Encryption cannot protect a compromised device or a modified website, and a recipient can copy or share what you send. SilenzaChat does not provide forward secrecy: someone who steals a browser’s private key could decrypt previously captured messages for that identity. The encryption integration has not had an independent security audit, so avoid sharing information whose exposure could put you at risk.

---

## Developer documentation

SilenzaChat is a self-hosted Node.js application with a browser client. The browser encrypts private messages and images; the server relays ciphertext and manages temporary sessions, public rooms, and recent message history. Source code: [Dornkimik/SilenzaChat on GitHub](https://github.com/Dornkimik/SilenzaChat).

### Project layout

| File | What it controls |
| --- | --- |
| `public/index.html` | Interface layout, text, and the in-app privacy guide |
| `public/style.css` | Colors, typography, spacing, and responsive layout |
| `public/app.js` | Browser interactions and live updates |
| `public/crypto.js` | Browser keys, identity verification, and authenticated encryption |
| `public/private.js` | Local image preparation |
| `lib/attachments.mjs` | Temporary encrypted attachment storage and quotas |
| `server.mjs` | Chat server, temporary identities, rooms, and admin controls |
| `SECURITY.md` | Private-chat security model and limitations |
| `data/rooms.json` | Saved room names and descriptions; generated after a room change |
| `data/bans.json` | Hashed session-cookie bans; generated when a session is banned |

The browser encryption uses a pinned, locally served TweetNaCl dependency. Refresh after frontend edits. Restart the server after changing `server.mjs` or `.env`.

### Run locally

Install Node.js 22.9 or newer (Node 24 LTS recommended), then run:

```sh
npm ci
npm start
```

Open **http://localhost:3000** and keep the terminal running. You can also open **SilenzaChat.sln** in Visual Studio with the **Node.js development** workload, or open this folder in Visual Studio Code. The terminal command is the dependable fallback if Visual Studio does not launch `.mjs` entry points.

### Admin access

The included local copy has a generated admin password in `.env`, on the `ADMIN_PASSWORD=` line. Enter it under **Room management** in the website. Visitors never need a password. If `.env` is absent, the terminal prints a temporary admin password.

For a permanent password, copy `.env.example` to `.env`, set `ADMIN_PASSWORD` to a long, unique value, and restart the server. Keep `.env` private. Admin access expires after one hour; **Lock admin controls** ends it immediately. Hosts can manage rooms, ban or unban an active anonymous session, and remove messages. Session bans survive restarts in `data/bans.json`; clearing browser cookies creates a new session and is not prevented by a session ban.

### Deploy

Deploy the full project to a host that can run a long-lived Node.js process; static-only hosting cannot run the chat server. Set `HOST=0.0.0.0`, `PORT` to the host's assigned port, a strong `ADMIN_PASSWORD`, `ORIGIN` to the exact public HTTPS origin with no trailing slash, and `SECURE_COOKIES=true`.

Put HTTPS in front of the server and keep the `data` directory on persistent storage. Configure the proxy to allow streaming responses on `/api/events`, with buffering disabled and a timeout longer than the 20-second heartbeat. Install production dependencies with `npm ci --omit=dev`, then start with `npm start`. HTTPS (or localhost) and IndexedDB are required for private chats. Configure the reverse proxy to accept encrypted uploads up to 4 MB plus 16 bytes. Set `ATTACHMENT_TTL_SECONDS` to 1–86400 to shorten image retention; the default is 86400.

Run **one server process / one replica**. Sessions and message histories are held in that process; multiple replicas need a shared identity store and message broker. The app includes message limits, admin login throttling, origin checks, escaped text rendering, and security headers. Larger public communities also need host-level abuse protection, moderation/reporting controls, and appropriate load testing.

### Search visibility

The homepage explains how SilenzaChat works; visitors enter the live chat at `/chat/` by choosing Connect. Both pages have descriptive titles, canonical URLs, and a sitemap at `/sitemap.xml`. The canonical URLs and sitemap currently use `https://silenzachat.cc`; update them if you deploy under another public domain. After deployment, add the site to Google Search Console, submit the sitemap, and inspect both URLs to check whether Google can index them. Search appearance and ranking depend on Google's crawl and evaluation, so these changes do not guarantee traffic.

### Verify

Run `npm test` for crypto, storage, and integration tests covering authentication, tampering, verification codes, ownership, expiry, quotas, real-time delivery, private-history isolation, admin permissions, input limits, room persistence, deletion, and origin protection.

Run `npm run test:groups:browser` for the temporary-room browser flow, including open and invite-only access, encryption, replies, identity checks, participation counts, ownership transfer, kicks, reloads, and desktop/mobile layout. These browser checks require Playwright Chromium, just like `npm run test:browser`.

For browser tests, install dependencies with `npm ci`, install Chromium with `npx playwright install chromium`, and run `npm run test:browser`. You can use an existing browser by setting `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`). Browser checks use temporary data and isolated profiles; they do not use your normal browser profile or a running chat instance.
