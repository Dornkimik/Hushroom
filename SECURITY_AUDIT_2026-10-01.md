# SilenzaChat security and privacy audit — 1 October 2026

## Assessment

The public website is serving an older client than local checkout `1f46771`. Several security fixes already present and tested locally are absent from the deployed JavaScript. Deploying the reviewed version and correcting HTTPS/header configuration are the first priorities.

Private conversations and temporary rooms use real authenticated encryption, but the service provides pseudonymity, not network anonymity. The protocol has no forward secrecy and trusts the website-delivered code and server-supplied identities and membership lists. No new ordinary-user plaintext-read or administrator-authentication bypass was found in the reviewed local paths. Passing tests do not establish that every path is secure or that the deployed backend matches this checkout.

## Scope and evidence

Reviewed server routing, sessions, accounts, rate limits, proxy trust, private/group history and edits, attachments, browser encryption, rendering, key storage, sign-out, and privacy disclosures. Existing review documents were treated as historical context and material findings were checked again.

Validation performed:

- `npm test`: **31 passed, zero failures**.
- `npm run test:security:browser`: **passed**, including private/group missing and unauthenticated envelope rejection, mixed routing rejection, key removal across current/legacy stores and tabs, and invite-only admin boundaries.
- `npm audit --omit=dev --json`: **zero reported production dependency vulnerabilities**. This is an advisory check, not an assurance of vulnerability-free dependencies.
- Six read-only live GET requests: HTTP homepage, HTTPS homepage, HTTPS encryption script twice, HTTPS application script, and HTTPS authentication script. No production login, guest creation, messages, uploads, or admin actions.
- Isolated execution of the downloaded `receive()` function with mocked UI state, and isolated cryptographic tests using the downloaded encryption module. These reproduce client behavior locally; they are not attacks on production users or end-to-end production backend tests.

Network requests and the headless security browser check initially encountered sandbox restrictions; both subsequently completed with reviewed execution access. Existing application code and deployment settings were not changed. This report is the only workspace change.

## Confirmed deployed findings

### 1. Medium — private and group live messages can bypass authentication

**Evidence:** deployed [app.js](https://silenzachat.cc/app.js), `receive()`, lines 223–246. The handler decides whether to decrypt from `message.encrypted`. An envelope without that property is appended directly as plaintext, even when routed to a private conversation or temporary encrypted room.

**Reproduction:** executed the downloaded handler in an isolated context with matching conversation state. Both private and group inputs displayed the supplied text with `locked=false` and **zero calls to the decryption function**.

**Impact:** a malicious or compromised relay can present forged plaintext as a participant's live message without a valid cryptographic envelope. This is a message-authenticity failure, not proof that an ordinary visitor can inject another user's SSE events or recover encrypted plaintext. Browser-delivered JavaScript remains a separate trust boundary even after this flaw is fixed.

**Remediation:** deploy the local conversation-based authentication and routing checks in `public/app.js:125`, `:230`, `:256`, and `:313`. Local automated browser checks confirm private/group live messages, history, and edits remain locked for missing, malformed, or unauthenticated envelopes.

### 2. Medium — group ciphertext can be misrepresented as a private message

**Evidence:** deployed [crypto.js](https://silenzachat.cc/crypto.js), `decryptMessage()`, starting at line 46. It authenticates the encryption and checks basic IDs, but does not reject the authenticated group context inside the ciphertext.

**Reproduction:** encrypted a room message using the downloaded module, selected the envelope intended for one recipient, and supplied private routing metadata with the same message/sender/recipient IDs. The deployed module successfully decrypted it as a private message. The local module rejected the identical ciphertext with `Private message context did not match.`

**Impact:** a relay possessing an existing envelope can misrepresent a room statement as a direct message to its original recipient. This does not let a new recipient decrypt it or permit modification of its authenticated text.

**Remediation:** deploy the domain/context checks already present in `public/crypto.js:53` and corresponding browser route checks.

### 3. Medium — deployed sign-out leaves browser encryption keys behind

**Evidence:** deployed [app.js](https://silenzachat.cc/app.js), lines 714–718, and [auth.js](https://silenzachat.cc/auth.js), lines 41–47. Both sign-out handlers log out and navigate/reload without clearing private keys or remembered peers. The downloaded encryption module exports no `clearLocalKeys` function and has no client invalidation/revocation mechanism equivalent to the local version.

**Impact:** signing out does not remove secrets from IndexedDB. Later access to the same browser profile, a browser compromise, or a same-origin script compromise can expose retained keys; those keys can decrypt previously captured ciphertext because the protocol lacks forward secrecy. Server logout may invalidate the cookie, but that does not erase browser keys. This review did not inspect any production user's storage.

**Remediation:** deploy the local cleanup and cross-tab invalidation in `public/crypto.js`, `public/app.js:736`, and `public/auth.js:41`. The security browser check verifies current, obsolete, and legacy key cleanup and prevents stale clients/migration from restoring a retired identity. Storage cleanup does not guarantee forensic erasure.

### 4. Medium — live HTTPS responses lack HSTS

**Evidence:** fresh GETs to the HTTPS homepage and `/crypto.js` returned HTTP 200 with CSP, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`, but **no `Strict-Transport-Security` header**. HTTP redirected to HTTPS with 301.

**Impact:** the redirect alone does not give browsers a persistent HTTPS-only policy. A first HTTP connection can be intercepted by an attacker on the network unless another HTTPS upgrade policy protects that browser. HSTS without preload also requires a successful HTTPS visit before its policy is remembered.

**Remediation:** configure `ORIGIN=https://silenzachat.cc`, use the current server, enforce production settings, and verify `Strict-Transport-Security: max-age=31536000` at the public edge. Local HSTS tests passed. These observations cannot distinguish old server code, environment configuration, and downstream header stripping. Decide separately whether subdomain coverage/preload is appropriate.

### 5. Low/privacy — Cloudflare network-error reporting is enabled

**Evidence:** live responses contain `NEL` and `Report-To` headers with a Cloudflare collector, `success_fraction: 0.0`, and seven-day policy lifetime. Zero successful-request sampling does not disable error reporting.

**Impact:** supporting browsers can send network-error telemetry to a third-party collector. This is an additional privacy exposure beyond ordinary requests passing through the hosting/CDN provider, not evidence of private-message content disclosure.

**Remediation:** review and disable Cloudflare Network Error Logging if minimizing telemetry is the intended policy; document provider logging and retention. The origin application cannot reliably remove headers inserted downstream.

## Anonymity and encryption limitations

- **Pseudonyms are not anonymity:** the server/CDN can observe connection IP addresses and timing; the app sees aliases, session IDs, public keys, participants, group membership, reply/attachment relationships, and ciphertext lengths. Persistent account usernames link activity across sessions. Other users see public presence and aliases. Tor/VPN use can change the origin's observed address but does not remove application metadata or content-based identification.
- **No forward secrecy or post-compromise recovery:** private/group messages use static browser identity keys with NaCl boxes rather than a ratcheting protocol. Stealing a key can expose previously recorded messages to or from that identity. A ratcheting protocol requires a protocol redesign and independent review, not a change of cipher name.
- **First-contact and roster trust:** local key pins detect later changes for the same session ID. An initially substituted key is accepted unless users independently compare verification codes. The server supplies room rosters and could introduce an unwanted recipient; the client encrypts for that roster. Open encrypted rooms can be joined by anyone. Invite-only access is an honest-server authorization control, not a cryptographically authenticated membership policy against a malicious server.
- **Website and device trust:** someone controlling the delivered JavaScript, a same-origin script injection, or a compromised browser/device can obtain plaintext and exportable IndexedDB keys. Existing CSP and safe text rendering reduce script-injection risk; they cannot constrain a malicious deployment that serves allowed same-origin code.
- **Public and retained data:** public rooms, announcements, feedback, and room metadata are plaintext to the service. Accounts store usernames and salted scrypt password hashes on disk. Account block lists and bans also persist. Chat/attachment process-memory retention does not rule out host swap, crash dumps, provider logs, snapshots, or backups. Recipients can retain decrypted copies independently of deletion.
- **Key lifetime and identity resets:** local explicit logout clears keys; expiry, site-data loss, and new device/session identities are separate lifecycle events. Old unused keys may persist until explicit cleanup. Verification binds keys to a session identity, not a person's real-world identity or every future session.
- **Abuse resilience is limited:** application quotas and throttles bound many resources, but distributed visitors can still consume shared budgets. Provider/proxy settings must be reviewed separately; source review does not verify trusted ingress networks, firewall rules, TLS policy, disk access, backups, or operational log retention.

## Controls that checked out locally

NaCl box/secretbox use random keys/nonces and reject authentication failures and low-order public keys. Message IDs, routing context, recipients, replies, image descriptors, and edit versions are bound inside authenticated envelopes in the local version. Images are re-encoded in the browser and encrypted before upload; metadata removal cannot hide visible identifying details.

Server authorization restricts private histories/attachments and group state/history/attachments. Plaintext fields are rejected in encrypted message APIs. Roles come from server-owned account records, registration cannot select an administrator role, cookies have high-entropy tokens and HttpOnly/SameSite protections, authentication rotates cookies, and mutations require an allowed Origin. Password storage uses random salts and bounded asynchronous scrypt work. Static serving uses an explicit allowlist; reviewed dynamic text renders through text nodes rather than user-controlled HTML.

These controls describe the reviewed checkout and exercised tests. They must not be assumed to describe uninspected deployed server code. In particular, the historical invite-only administrator-policy issue cannot be determined from the downloaded frontend assets alone.

## Deployment fingerprints and next actions

SHA-256 over UTF-8 source after CRLF-to-LF normalization:

| Asset | Local | Live |
| --- | --- | --- |
| crypto.js | `7f45882e6d5505005946bdceb605cb6fe7f2adb58643e39e193a62f074bda339` | `57cf8a86d57bb3b5f0081c75652aa896683e1db8ee13610fc07e92804f85720b` |
| app.js | `b1fdd5782a71d790a689d12d1d526a3d2068368ed2bd63df14a0a447f96bfc84` | `81b2de048e012e1299c68559111e0d8e618b73514ed09d1587785725982f28c7` |
| auth.js | `3a91385a9b2729419adee637531f7f610cb1cfbd01c075e206fb98d8c53fa824` | `c2694d85440fc2f21482a5cefcc55ad963f7419950af138bc040af08e792188e` |

1. Deploy the reviewed application version and clear any stale edge asset cache. Recheck source fingerprints and the browser security regressions against an isolated deployment.
2. Correct the production HTTPS origin/header configuration and verify HSTS on public responses.
3. Decide the Cloudflare telemetry policy; inspect ingress trust, direct-origin exposure, logs, volume permissions, and backup retention using provider access.
4. Keep anonymity claims aligned with pseudonymity and visible metadata. Require independent verification for sensitive contacts. For stronger messaging guarantees, evaluate an independently reviewed ratcheting protocol and authenticated group membership.

No deployment or provider configuration change was performed as part of this review.
