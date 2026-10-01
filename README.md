# SilenzaChat

An anonymous chatroom for live public conversations and private, end-to-end encrypted chats. Visitors do not need an account, email address, or real name. https://silenzachat.cc

## Visitor guide

### Joining a conversation

You appear under a random alias. Choose someone in **In good company** to start a private chat. On phones, the people list is below the chat. Tabs in the same browser profile share one identity, and incoming private conversations appear in the sidebar.

### Public rooms and private chats

Public-room messages are visible to other visitors and are not end-to-end encrypted. In private chats, text, captions, mentions, and images are encrypted in your browser and decrypted in the participants’ browsers. The server relays the encrypted content; admin controls do not provide keys to read private chats.

This protection depends on trusting the website code delivered to your browser. Someone who controls the website could change that code to capture messages or keys. A compromised device or browser extension could expose them too.

### Blocking and removing private chats

Choose **Block** beside someone in **In good company**, or **Block user** in a private chat, to stop private messages, edits, and new image uploads in both directions. Account blocks apply to all of that account's sessions and survive sign-out and server restarts. Guest blocks last for the current guest session. Open **Sound & account settings** to unblock someone. Blocking does not hide people or messages in shared public or temporary rooms.

Choose **×** beside a private chat to remove it from your sidebar. This also clears its unread count and local draft. Removal survives refresh in that session and applies to its other open tabs. It leaves the conversation and messages available to the other participant; a new message or selecting the person again restores it.

Run `npm run test:private-controls:browser` to check blocking, unblocking, sidebar removal, refresh, shared tabs, and mobile controls. `npm test` also covers server enforcement and account block persistence.

### Temporary rooms

Choose **＋ Create** beside **Temporary rooms** to create a user-owned room. Give it a name, description, and rules, and choose **Open to everyone** or **Invite only**. Invite-only rooms appear in the chat directory only to their members and invited sessions; owners invite people from **Room details & members**. Owners can edit details and access, kick members, transfer ownership to another member, or delete the room. Members can leave; an owner with other members must transfer ownership or delete the room first.

Room text, images, captions, replies, and mentions are end-to-end encrypted using the same browser identities and authenticated encryption as private chats. Each message is encrypted separately for every current member, including its sender. Use **＋** to attach an image with an optional caption, and **Verify identity** beside a member to compare identity codes through another trusted channel. Names, descriptions, rules, membership, and message counts are metadata visible to the server. Open rooms can be joined by anyone, so use invite-only access for a restricted conversation.

New members receive only future messages. Leaving and rejoining starts a new membership. Kicking a member blocks this session from rejoining and excludes it from subsequent message delivery and encryption; it cannot erase copies already received. A changed membership list requires the sender to encrypt again before sending. Room owners see each current member’s total accepted messages during that membership, including deleted messages. Other members do not receive these counters.

Rooms support up to 20 members. Each visitor can own three rooms and join up to 20. They exist only in server memory and disappear on server restart, after 24 hours without a message or membership/management action, or when the last member leaves. If an owner’s anonymous session expires or is banned, ownership passes to the earliest remaining member. History retains up to 100 messages, subject to a 4 MiB ciphertext budget per room and a 32 MiB total room-history budget.

### Feedback

Choose **Feedback** on the landing page or in the chat header to send a title and message. No name or email is required. Feedback is readable by site admins and saved on the server until an admin deletes it; it is not an encrypted chat message.

Admins can open **Room management**, unlock the controls, and use the **Feedback** inbox at the top. Submissions appear newest first with their date and a new/reviewed status. Expand an entry to read it, mark it reviewed (or new again), or delete it. Use **Refresh** to load new submissions.

The server persists feedback in `data/feedback.json` (or the configured `DATA_DIR`), including across restarts. Entries contain the title, text, timestamp, random ID, and review status, without a saved sender identity. Titles allow 120 characters and messages 5,000. Each anonymous session can submit three times per ten minutes. The inbox holds up to 1,000 entries and rejects new submissions when full; admins can delete old entries to make space. This session-based limit is basic throttling, not protection against a determined spammer creating new sessions.

Run `npm run test:feedback:browser` to check submission, retries, responsive layout, and admin review/deletion. `npm test` also checks feedback access control, validation, throttling, and persistence.

### Privacy and identity

A random alias means you do not have to provide an account or real name, but it does not make you untraceable. The server can see connection IP addresses, aliases, who is talking to whom, message times, encrypted data sizes, and reply or attachment relationships. A hosting provider or reverse proxy may keep its own logs. What you write or show in an image could identify you as well.

The app does not write chat contents or IP addresses to its own log files. It temporarily uses connection addresses for admin login throttling.

To check a private-chat partner’s encryption key, choose **Verify identity** and compare the entire code in person, on a call, or through another trusted channel. Only mark the codes as matching after an independent comparison. This confirms the key you checked, not someone’s real-world identity. If a key changes unexpectedly, pause and check with the person before continuing.

### Images and message history

Images can be sent in private chats and temporary encrypted rooms. Your browser resizes each image, removes the original file metadata by re-encoding it, then encrypts it before upload. JPEG, PNG, and WebP images are accepted. The original filename is not sent; the image key is shared inside the encrypted message. In a room, only members addressed by that message can download its image while they remain in the same membership. Newcomers, kicked members, and members who leave and rejoin cannot download earlier images. Deleting the message or room also removes its stored image bytes. The server temporarily holds encrypted image data in memory, not as image files on disk.

Metadata removal cannot hide details visible in the picture, and the recipient can save or share a decrypted copy. Choose **Delete** on your own public or private message to remove it for everyone, including an attached image. Deletion cannot remove screenshots, downloads, or copies someone has already made.

Announcements are retained on disk until an admin deletes them. In other conversations, only the latest 100 messages are kept in server memory. Messages disappear when the server restarts; private histories and sessions expire after 24 hours offline. Images expire within 24 hours of upload, or sooner if the host configures a shorter period. They can also disappear when their message is deleted or leaves recent history, a participant is banned or their session expires, or the server restarts. This is a temporary chat, not a permanent inbox or backup.

### Your browser identity

Your browser stores a session cookie, encryption keys, remembered peer identities, and your theme preference. Decrypted messages and unsent drafts stay in the current page’s memory; SilenzaChat does not save a permanent local chat archive.

Refreshing normally keeps your session and keys, and tabs in the same browser profile share them. Another browser, profile, or device has a separate identity; you can reuse an account username, but messages, memberships, and encryption keys do not sync. Clearing site data or ending an incognito session can erase your session and keys. The server cannot recover lost keys. If the session remains but its key is lost, private chat is blocked; clear the site’s data to start a new anonymous session.

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

Visitors choose a random guest name or a persistent username/password account on the landing page. Accounts require no email. Passwords must be 15-128 characters; there is no password recovery. Accounts persist in `accounts.json` in the configured data directory. Messages, private encryption keys, and temporary-room memberships do not sync between devices or logins.

Before the first account is created, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (15-128 characters), then start the server. This creates a persistent account with the admin role. Log in on the landing page with those credentials. Remove the bootstrap environment credentials afterward; the password hash and role are saved. Existing accounts are never automatically promoted by a matching environment username. Existing installations must configure both values before enabling registration; the old admin code no longer works.

Admins manage rooms, feedback, and bans from Room management. Their permissions last for their signed-in session, without a one-hour timer. Sign out from Sound & account settings. The optional admin badge is recorded when a message is sent and remains on that message after the sender hides their badge, signs out, or disconnects. Account bans block future logins and all current sessions of that account; guest bans still apply only to that session. Admin access does not decrypt private chats or grant temporary-room membership.

Sound & account settings offers separate, optional sounds for private chats, temporary groups, and main rooms. Preferences stay in the browser; browsers may require Test sound after reopening the page. Public-room sidebar previews update after sends, edits, and deletions.

### Deploy

Deploy the full project to a host that can run a long-lived Node.js process; static-only hosting cannot run the chat server. Set `HOST=0.0.0.0`, `PORT` to the host's assigned port, an initial `ADMIN_USERNAME` and strong `ADMIN_PASSWORD`, `ORIGIN` to the exact public HTTPS origin with no trailing slash, and `SECURE_COOKIES=true`.

On Railway, attach a **Volume** to the SilenzaChat service and mount it at **`/data`**. Leave `DATA_DIR` unset: the app automatically uses Railway's `RAILWAY_VOLUME_MOUNT_PATH`. If you already set `DATA_DIR`, remove it or point it inside the mounted volume (for example `/data`). Redeploy after attaching the volume. [Railway volume setup](https://docs.railway.com/volumes).

Main/public rooms created under Room management are saved in `rooms.json` on that volume. Their IDs, names, descriptions, and deletions survive restarts and new deployments. The three starter rooms are seeded only when no saved room file exists; deleting all main rooms keeps the list empty after restart. Accounts, bans, and feedback use the same storage. Message history and user-created temporary rooms still live only in memory.

If you currently have rooms you want to keep on an ephemeral deployment, copy its `rooms.json` into the volume before starting the new deployment. Data already lost in an earlier deployment cannot be recovered by this change. Keep the volume attached to the same service and use one replica. The app logs a storage warning on Railway if the selected data directory is outside the attached volume.

Put HTTPS in front of the server and keep the `data` directory on persistent storage. Configure the proxy to allow streaming responses on `/api/events`, with buffering disabled and a timeout longer than the 20-second heartbeat. Install production dependencies with `npm ci --omit=dev`, then start with `npm start`. HTTPS (or localhost) and IndexedDB are required for private chats. Configure the reverse proxy to accept encrypted uploads up to 4 MB plus 16 bytes. Set `ATTACHMENT_TTL_SECONDS` to 1–86400 to shorten image retention; the default is 86400.

Run **one server process / one replica**. Sessions and message histories are held in that process; multiple replicas need a shared identity store and message broker. The app includes message limits, admin login throttling, origin checks, escaped text rendering, and security headers. Larger public communities also need host-level abuse protection, moderation/reporting controls, and appropriate load testing.

### Search visibility

The homepage explains how SilenzaChat works; visitors enter the live chat at `/chat/` by choosing Connect. Both pages have descriptive titles, canonical URLs, and a sitemap at `/sitemap.xml`. The canonical URLs and sitemap currently use `https://silenzachat.cc`; update them if you deploy under another public domain. After deployment, add the site to Google Search Console, submit the sitemap, and inspect both URLs to check whether Google can index them. Search appearance and ranking depend on Google's crawl and evaluation, so these changes do not guarantee traffic.

### Verify

Run `npm test` for crypto, storage, and integration tests covering authentication, tampering, verification codes, ownership, expiry, quotas, real-time delivery, private-history isolation, admin permissions, input limits, room persistence, deletion, and origin protection.

Run `npm run test:groups:browser` for the temporary-room browser flow, including open and invite-only access, encryption, replies, identity checks, participation counts, ownership transfer, kicks, reloads, and desktop/mobile layout. These browser checks require Playwright Chromium, just like `npm run test:browser`.

For browser tests, install dependencies with `npm ci`, install Chromium with `npx playwright install chromium`, and run `npm run test:browser`. You can use an existing browser by setting `CHROMIUM_PATH` (for example, `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`). Browser checks use temporary data and isolated profiles; they do not use your normal browser profile or a running chat instance.

### Editing messages

Choose **Edit** on your own message to change its text or image caption, then **Save changes**. Cancel keeps the original message and your unsent draft. Edited messages show an **(edited)** label and update for other participants, including reply previews. Attached images stay unchanged. Only the sender can edit; admin and room-owner roles do not grant permission to edit other people�s messages.

Private and temporary-room edits remain end-to-end encrypted. An older room message is updated only for original recipients who still have access; later members cannot see it. Deleted or expired messages cannot be edited. Concurrent edits are rejected so you can reopen the latest version. Sending and editing share the existing rate limit. Run `npm run test:editing:browser` for browser coverage.

### Announcements

Announcements appears in its own **Community updates** sidebar section, separate from public and temporary rooms. All visitors can read it. Only account admins can publish, edit, or remove announcements, including posts from earlier sessions or other admins. Announcement posts always carry the admin badge. The room itself cannot be deleted.

Posts, edits, reply updates, and deletions are atomically saved in `announcements.json` under `DATA_DIR` (or the Railway volume). A successful response and live update are sent only after saving succeeds. Announcements are not subject to the temporary chat’s 100-message limit. They are public plaintext with author names and timestamps; private chat retention is unchanged. Use a persistent volume to keep announcements across deployments, and back up the data directory.
