# SilenzaChat security and privacy review

Reviewed 1 October 2026. Checkout: `c998262`. This is a source review with automated tests, bounded local reproductions, and limited live deployment checks; it is not a formal independent cryptographic audit or penetration test. Application behavior was not changed.

The site implements real browser-side authenticated encryption for private messages and temporary-room messages. Its anonymity is limited to guest pseudonyms: operators and infrastructure providers can observe connections and activity metadata, and other visitors can observe public activity. Several concrete privacy and availability issues should be addressed before describing it as hardened secure messaging.

## Confirmed findings, in priority order

### 1. High: cheap guest creation can exhaust capacity; private history has no global byte budget

**Evidence:** [session creation](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:209) creates a new session on every cookie-free `GET /api/session`. It has a 5,000-session ceiling but no creation rate limit. Sessions remain until 24 hours of inactivity and can be kept alive by requests or event streams. The authentication endpoints also reject requests when this shared ceiling is reached. Message throttling is per session, so creating additional sessions multiplies the permitted sending rate.

The local probe created 16 independent sessions consecutively without a creation throttle. The 5,000-session denial of service is inferred from the code, not demonstrated by filling the service. No live load or exhaustion test was performed. External Cloudflare or host rules could mitigate this; their settings were not accessible.

Separately, [private history storage](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:439) limits each conversation to 100 messages, but neither the number of private conversations nor their combined ciphertext bytes has a budget. A ciphertext can contain up to 18,000 decoded bytes. Many attacker-controlled session pairs can therefore grow memory substantially despite the bounded attachment and group stores.

**Impact:** refusal of new guest sessions and account logins, memory pressure, and potentially process failure. Restarting clears memory-only chats and rooms.

**Recommended correction:** apply guest-creation and connection limits at the trusted edge and application boundary, impose global and per-session private-history byte/conversation budgets, and expire unused histories independently of session removal. Preserve reasonable access for shared networks and privacy tools.

### 2. Medium: signing a guest into an account exposes the link to previous guest activity

**Evidence:** [authentication](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:189) reuses an existing guest session object, including its public sender ID and encryption identity. It rotates the secret cookie, changes the alias to the account username, and [broadcasts the appearance change](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:91).

The probe posted a guest message, registered an account in the same session, and confirmed that another guest could map the original message's sender ID to the new account username through the people directory. The public key was also unchanged. The landing page allows a returning guest to select the account form, so this is reachable through ordinary use.

**Impact:** a visitor who used a random alias and later logs in or registers can unexpectedly identify their earlier guest messages and interactions to observers. Cookie rotation does not break that public link.

**Recommended correction:** create a fresh session ID and encryption identity when crossing from guest to account identity. Clear or deliberately end the old identity's memberships and conversations. If retaining guest activity is an intended feature, explicitly explain the identity linkage before the user chooses it. Account usernames are inherently persistent pseudonyms and can also identify users through reuse elsewhere.

### 3. Medium, deployment-dependent: authentication throttling can lock out unrelated users behind a proxy

**Evidence:** [authentication throttling](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:174) keys its address limit on `req.socket.remoteAddress`, with 100 requests per ten minutes. Behind a reverse proxy this may identify a proxy instance rather than the actual visitor. The live site's response headers indicate Cloudflare and Railway infrastructure, but their internal connection topology was not inspected.

The local probe submitted invalid logins bearing different forwarded-client addresses until the common socket limit was reached. A valid administrator login bearing another forwarded address then received 429. Overlong passwords are rejected cheaply after consuming the limit, so exhausting it does not require completing password hashing. This confirms application behavior; the number of live users sharing a bucket remains unknown.

**Impact:** an attacker may consume a shared proxy bucket and deny login/registration to unrelated users for ten minutes. The separate ten-attempt username limit also allows targeted temporary login denial when a username is known.

**Recommended correction:** rate-limit at the edge using its authenticated client identity, or introduce an explicit trusted-proxy configuration with a carefully validated client-address source. Do not blindly trust arbitrary forwarding headers. Combine address, account, and service-wide controls without making a shared proxy address the sole visitor boundary.

### 4. Medium: the live HTTPS responses lack HSTS

**Evidence:** the live homepage and session API returned no `Strict-Transport-Security` header. HTTP redirected to HTTPS with 301. A separately validated TLS connection negotiated TLS 1.3 with a trusted, currently valid certificate. The live session cookie had `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`; its value was not recorded.

**Impact:** an HTTP redirect alone does not instruct browsers to require HTTPS on future visits. An attacker controlling an initial HTTP connection can interfere with that redirect, depending on the browser's other HTTPS enforcement mechanisms. Preload status and all TLS versions/ciphers were not tested. See [MDN's transport-security explanation](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Transport_Layer_Security).

**Recommended correction:** enable HSTS at the HTTPS edge after confirming the affected hosts reliably support HTTPS. Extend to subdomains or preload only after evaluating all affected hosts; preload is the mechanism that can cover an initial visit.

### 5. Low: banning a participant leaves orphaned private ciphertext history

**Evidence:** [ban removal](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:509) removes sessions, memberships, and attachments, but does not remove their private-history entries. Logout and ordinary expiry do remove private histories. The [expiry sweep](/C:/Users/domin/vs-code-projects/website/SilenzaChat/server.mjs:543) iterates remaining sessions, so it will never independently expire the already-removed participant's entries.

The local probe banned one participant, confirmed ordinary history retrieval was denied because that peer no longer existed, then successfully deleted the surviving sender's message from that conversation. This demonstrates the history was still stored after the ban. The longer retention behavior follows from the sweep code; no 24-hour waiting experiment was performed.

**Impact:** ciphertext and conversation metadata can remain until the other participant logs out/expires, the messages are individually removed, or the process restarts. This is excess retention and contributes to memory growth; it is not a demonstrated plaintext disclosure or unauthorized history-read bypass.

**Recommended correction:** centralize session teardown and use the same history cleanup for bans, logout, and expiry. Independently sweep histories with absent participants.

## Encryption assessment and its practical limits

- [Private and group encryption](/C:/Users/domin/vs-code-projects/website/SilenzaChat/public/crypto.js:41) uses TweetNaCl `box`: X25519–XSalsa20–Poly1305, with fresh random 24-byte nonces. Images use independent random 32-byte keys and `secretbox`. This matches the [library's documented constructions](https://github.com/dchest/tweetnacl-js). Its library audit does not audit this application's protocol or integration.
- Authenticated plaintext binds message IDs, participants, replies, attachments, edit versions, and group membership versions. Decryption rejects tampering and metadata mismatch. Low-order public keys are rejected. Group delivery is per recipient, with server membership checks and no plaintext fallback.
- Image preparation decodes and re-encodes raster pixels locally, removing original file metadata and filenames from supported-client uploads. Browser traffic tests confirmed uploads contained the encryption output and did not expose the tested image data or keys. Visible identifying details in images remain visible to recipients.
- **There is no forward secrecy or post-compromise recovery.** A stolen identity private key and captured ciphertext can expose previous conversations and image keys for that identity. Future messages using the same key also remain at risk. Keys persist as accessible secret-key bytes in IndexedDB; logout does not delete the old identity records. This limitation is documented, but particularly matters on shared or compromised devices.
- First-contact key pinning cannot detect a key substituted before the first contact. Compare verification codes through an independent trusted channel. A new session ID creates a new trust relationship, even when the account username is familiar.
- The server controls the delivered browser code. A compromised application deployment or trusted delivery infrastructure could serve code that captures plaintext or keys. CSP reduces script-injection exposure but does not make malicious same-origin application code trustworthy.
- The protocol does not provide durable replay protection or an authenticated roster against a malicious server. Public labels, timestamps, and administrative badges are server-supplied metadata rather than cryptographically verified personal identities.

If stronger compromise resistance is a product requirement, adopt a maintained, reviewed messaging protocol implementation rather than extending this static-key construction with custom cryptography. The [Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/) explains how advancing message keys and changing Diffie–Hellman keys protect earlier and later messages after some compromises. This would be a substantial design change, including persistence, offline delivery, and group handling.

## Anonymity, privacy, and storage

Guests do not need a real name, email, or account. The reviewed client contains no third-party analytics script or external CDN script dependency. This does not make a connection anonymous:

| Information | Exposure / retention |
| --- | --- |
| Public messages, aliases, sender IDs, timing | Available to all visitors with sessions, including through broadcasts and room previews; recent history in process memory |
| Private messages and images | Ciphertext at the server; plaintext available to endpoints and anyone to whom recipients share it |
| IP address, HTTP requests, traffic timing | Visible to network-facing infrastructure; application-visible address depends on proxy topology |
| Private contacts, group membership, reply/attachment links, ciphertext lengths | Visible as application metadata; encryption does not conceal the social graph or traffic pattern |
| Account username, ID, password hash, role | Persistent account file; usernames publicly displayed; no account deletion or password-change/recovery UI found |
| Account blocks | Persistent account-linked block graph, including peer identifiers and aliases |
| Feedback | Plaintext retained on disk until an administrator deletes it; title, text, date, ID, and review status |
| Announcements | Public plaintext retained on disk until deletion, including author alias and original session ID |
| Local identity keys and pinned peers | IndexedDB; old identities remain until site data is cleared; preferences also use localStorage |

The application does not contain routine IP or chat-content log writes. Host, proxy, backup, swap, crash-dump, and infrastructure logging/retention policies were not inspected, so no guarantee about those systems is possible. API replies and attachment downloads use `no-store`; ordinary static assets and the homepage have different cache policies.

**Live infrastructure telemetry:** the site sends `NEL` and `Report-To` headers pointing to `a.nel.cloudflare.com`, with `success_fraction: 0.0` and a seven-day policy. Supporting browsers can send network-error telemetry separately from application requests. This does not imply every request is reported or that private-message plaintext is sent. Cloudflare's [NEL documentation](https://developers.cloudflare.com/network-error-logging/) explains report contents, privacy handling, and how to disable it. Document this processing, or disable it if minimizing browser telemetry is the goal. Provider logging settings and actual retained data remain unverified.

## Protections that held during testing

- Strong random session secrets, HttpOnly/Strict cookies, authentication cookie rotation, logout invalidation, origin checks, and server-owned administrator roles.
- Passwords stored using salted scrypt (`N=32768, r=8, p=3`), constant-time hash comparison, and bounded concurrent hash work. The chosen parameters match one configuration in [OWASP's password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
- Same-origin script CSP without inline/eval permission, frame blocking, `nosniff`, and `no-referrer`. Reviewed dynamic text rendering uses DOM text operations rather than HTML injection sinks. No exploitable script-injection path or unauthenticated administrator bypass was found in this review.
- Private-history isolation, attachment ownership and quotas, group invitations, membership-version checks, original-recipient edit rules, and encryption failure handling passed the relevant automated checks.

These results establish tested behavior, not the absence of all vulnerabilities. There is no MFA, fixed maximum administrator-session lifetime, or independent application cryptographic audit; these are documented or observable hardening limits.

## Validation and scope limits

| Check | Result |
| --- | --- |
| `npm test` | 24 tests passed |
| `npm run test:browser` | Passed private text/images, traffic inspection, isolation, key verification/change/loss handling, reload/shared tabs, expiry/deletion, desktop/mobile checks |
| `npm run test:groups:browser` | Failed at the mobile horizontal-overflow assertion, line 153; earlier encryption/isolation/key-substitution checks passed, later checks in this script were not reached |
| `npm run test:accounts:browser` | Failed at the mobile horizontal-overflow assertion, line 97; later assertions were not reached |
| `node scripts/security-review-check.mjs` | Four bounded reproductions passed: identity linkage, ban-history retention, unthrottled sample guest creation, shared socket-address authentication throttle |
| `npm audit --omit=dev --json` | No reported production dependency vulnerabilities at review time; does not assess application logic or unpublished vulnerabilities |
| Live HTTP/HTTPS, homepage/encryption asset/session API/TLS | HTTPS redirect, TLS 1.3/certificate validation, cookie flags and headers checked; deployed encryption source matched local source after newline normalization |

The browser-test failures were layout assertions, not reported encryption failures. They still prevent claiming those complete browser suites passed. No production account registration, login guessing, message sending, administrator operation, intrusive scan, or live denial-of-service test was performed. One normal guest session was created to inspect cookie attributes; its secret value was not logged.

Only the deployed encryption source was compared byte-for-byte after newline normalization. Deployed server code, secrets, Cloudflare/Railway configuration, access controls on stored files/backups, full TLS configuration, and actual infrastructure retention could not be verified. Local tests used isolated temporary data, not the existing environment file or real accounts. The reproducible probe is [scripts/security-review-check.mjs](/C:/Users/domin/vs-code-projects/website/SilenzaChat/scripts/security-review-check.mjs).
