# Hushroom

An anonymous chatroom website with live public rooms, private conversations, and password-protected room management. All source files are included. There are no third-party packages or visitor accounts.

## Open in Visual Studio

1. Install Node.js 22.9 or newer (Node 24 LTS recommended).
2. In Visual Studio Installer, enable the **Node.js development** workload.
3. Open **Hushroom.sln** in Visual Studio. You can also use **File → Open → Folder** and choose this folder, or open it in Visual Studio Code.
4. In a terminal opened in this folder, run `npm start`.
5. Open **http://localhost:3000**. Keep the terminal running.

No `npm install` step is needed. Visual Studio's project launcher is included; the terminal command is the dependable fallback if your installed Node tools do not launch `.mjs` entry points. If Node is not found, install it and restart Visual Studio.

## Admin password

This local copy includes a generated admin password in `.env`, on the `ADMIN_PASSWORD=` line. Click **Room management** in the website and enter that password. Visitors never need a password. If `.env` is absent, the terminal prints a temporary admin password instead.

For a permanent password, copy `.env.example` to `.env`, fill in `ADMIN_PASSWORD` with a long, unique password, and restart `npm start`. Keep `.env` private. Admin access expires after one hour, and **Lock admin controls** ends it immediately. Rooms can be created or removed in the admin panel. Hosts can also ban an active anonymous browser session, unban it later, or remove individual messages from everyone’s view. Session bans survive server restarts in `data/bans.json`, which stores hashed session-cookie values; clearing browser cookies creates a new session and is not prevented by a session ban.

## Try a private chat

Open the site in two separate browsers, or one normal and one private browser window. Each receives its own alias. Click a person under **In good company** to chat privately. Tabs in the same browser profile share one identity. On phones, the people list is below the chat area. Incoming private conversations appear in the sidebar with unread counts.

## Where to edit

| File | What it controls |
| --- | --- |
| `public/index.html` | Layout and interface text |
| `public/style.css` | Colors, typography, spacing, responsive layout |
| `public/app.js` | Browser interactions and live updates |
| `public/favicon.svg` | Browser-tab icon |
| `server.mjs` | Chat server, temporary identities, room management |
| `.env` | Password and hosting settings; create from `.env.example` |
| `data/rooms.json` | Saved rooms, generated after the first room change |
| `data/bans.json` | Hashed session-cookie bans, generated when a session is banned |

Refresh after frontend edits. Restart the server after changing `server.mjs` or `.env`. The main colors are at the beginning of `style.css`.

## Privacy and storage

- A random alias and an HttpOnly session cookie identify each visitor. No real name or email is requested.
- Public rooms and their latest history are accessible to all visitors.
- Private messages and private-history API responses are restricted to the two participants. They are **not end-to-end encrypted**; the server handles their contents.
- Only the latest 100 messages per conversation are retained, in memory. Restarting the server clears messages, identities, and admin sessions. Reconnects within the same live session reload the current conversation's available history.
- After 24 hours offline, an identity and its private histories are removed. Server restarts also discard the list of private conversations. This is a temporary chat service, not a durable inbox.
- Room names and descriptions are saved in `data/rooms.json` and survive restarts. Back up that file to preserve your room setup.
- The app does not write chat contents or IP addresses to log files. It temporarily uses connection addresses for admin login throttling; a host or reverse proxy may keep its own access logs.

## Put it online

This delivery runs locally; it has not been published. To share it publicly, deploy the entire project to a host that runs long-lived Node.js processes. Static-only hosting cannot run the chat server.

Set `HOST=0.0.0.0`, `PORT` to the host's assigned port, a strong `ADMIN_PASSWORD`, `ORIGIN` to your exact public HTTPS origin (no trailing slash), and `SECURE_COOKIES=true`. Put HTTPS in front of the server and keep the `data` directory on persistent storage. Configure the proxy to allow streaming responses on `/api/events`, with buffering disabled and a timeout longer than the 20-second heartbeat. Start with `npm start`.

Run **one server process / one replica**. Live sessions and message histories are held in that process; multiple replicas require a shared identity store and message broker first. The app includes message limits, admin login throttling, origin checks, escaped text rendering, and security headers. A larger public community will also need moderation/reporting controls, abuse protection at the host, and load testing appropriate to its size.

## Verify

Run `npm test`. Integration tests use separate anonymous sessions and a separate temporary data directory to check real-time public and private delivery, private-history isolation, admin permissions, input limits, room persistence, deletion, and origin protection.
