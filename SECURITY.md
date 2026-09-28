# Private chat security model

Private messages and images are encrypted and authenticated by the browser. The server does not receive plaintext messages, captions, original image filenames, private identity keys or attachment keys through the supported client. Public rooms remain plaintext. This application integration has not undergone an independent cryptographic audit.

## Construction and key lifecycle

- The browser uses the pinned `tweetnacl@1.0.3` implementation, served from the same origin without a CDN. [TweetNaCl documentation and audit information](https://github.com/dchest/tweetnacl-js) describe the underlying NaCl constructions. The library audit is not an audit of this application.
- An anonymous session gets an X25519 identity key pair, stored in IndexedDB. Creation is atomic across tabs. Only the public key is registered on the server; the server refuses replacement keys for an existing session. Losing the local key requires a new anonymous session.
- Private envelopes use NaCl `box` (X25519–XSalsa20–Poly1305) with fresh cryptographically random 24-byte nonces. Session IDs, sender, recipient, client message ID, reply reference, text and image descriptor are inside the authenticated ciphertext. Clients check these against the transport envelope after decryption. This prevents silently moving a ciphertext to another sender, conversation, reply or message ID. Invalid or unauthenticated content is never rendered as a message.
- Each image gets a fresh independent 32-byte key and 24-byte nonce for NaCl `secretbox`. Its key, nonce, raster MIME type, dimensions and size travel inside the private message. Only a random attachment ID and expiry are exposed outside. Images are locally decoded and re-encoded as WebP before encryption; original metadata and filenames are not uploaded. No server-side plaintext thumbnails are created.
- Only raster WebP images are displayed after authentication, with blob URLs that are revoked on conversation changes, message removal and expiry. Decrypted message state and drafts remain in browser memory; they are not saved to server storage or browser persistent message storage.

This uses established authenticated-encryption constructions, not Signal's messaging protocol. **There is no double ratchet, forward secrecy or post-compromise recovery.** A stolen browser identity private key can expose previously captured ciphertext for that identity. Clearing site data loses access; server restart creates a new session identity. There is no multi-device sync or key backup. Old, unused identity records may remain in IndexedDB until site data is cleared.

## Identity verification

First contact pins the peer's public key locally (trust on first use). A different key for the same anonymous session blocks private communication; it is not accepted silently. Both participants can compare the same 256-bit verification code through another trusted channel. The code is a domain-separated SHA-512 hash truncated to 256 bits over the sorted session IDs and public keys. Verification is stored locally for that peer and key.

An initial server-substituted key cannot be detected by trust on first use alone. Compare the code out of band to authenticate the contact. Encryption does not establish a person's real-world identity from their random alias.

## Storage, delivery and deletion

The server holds only the latest 100 encrypted envelopes per private conversation. Attachments use bounded process memory (128 MB total, 20 MB per uploader, including reservations for simultaneous uploads) and are never written to disk by the application. Uploads are limited to 4 MiB plus the 16-byte authentication tag. The server cannot prove arbitrary client-supplied bytes are encrypted; the supported browser client encrypts before sending, and the API rejects plaintext message fields.

An attachment can be claimed once, by its uploader, for the intended recipient. Both participants must have registered encryption identities. Downloads require a session cookie and are restricted to the uploader and, after publication, the recipient. No public attachment links exist. Responses use `Cache-Control: no-store`.

Unpublished uploads expire after 10 minutes. Published images expire 24 hours after upload, or sooner with `ATTACHMENT_TTL_SECONDS`. Expired downloads are immediately denied; a sweep frees expired memory at least once per minute. Removal, history eviction, a participant's ban/session expiry and server restart also delete attachments. Offline recipients can retrieve them while that session/history remains available. Downloaded or captured copies cannot be remotely erased. A malicious server could retain ciphertext despite expiry; encryption is the confidentiality protection.

Private reply quotes are resolved from the locally decrypted original message instead of duplicating its text into another persistent ciphertext. Removed or evicted originals are shown as unavailable. The server sees reply relationships, but not quoted contents. Admins cannot decrypt other users' private content and cannot inspect images for moderation. Admin message removal still works by message ID.

## Trust boundaries

- The server still knows participants, aliases, public keys, IP addresses during connections, message timing, reply relationships, attachment IDs and ciphertext sizes. This does not provide metadata anonymity.
- HTTPS is required outside localhost. Keys require available IndexedDB. Failures disable private messaging; there is no plaintext fallback.
- Browser-side encryption cannot protect against compromised devices, malicious extensions, same-origin script injection, or a malicious deployment serving modified JavaScript that steals plaintext/keys. Trust in the delivered client is required. The CSP permits same-origin scripts only, with no inline/eval or external CDN scripts.
- A recipient can save or share received content. Expiry is a retention policy, not protection from screenshots or copying.
- Message IDs are deduplicated within the retained history. The protocol does not provide durable replay protection, ordering guarantees, or an authenticated server clock. A malicious server can suppress messages or replay an old valid message after it leaves recent history.

Tests cover ciphertext-only API delivery, authentication failures, metadata binding, key pinning, matching verification codes, local key loss, cross-session download isolation, ownership, expiry and quotas. These checks are not a substitute for an independent security review when stronger messaging guarantees are required.
