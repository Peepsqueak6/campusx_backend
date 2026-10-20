# Campus X backend: Module D (messaging) and Module E (admin and moderation)

Implements the "Modules D & E Implementation Spec (MongoDB)". TypeScript, Express 5, Mongoose, Socket.io, Redis, BullMQ.

## Run it

```bash
docker compose up -d          # MongoDB 7 as a one-node replica set (transactions need it) + Redis 7
cp .env.example .env
npm install
npm run dev                   # REST on :4000, sockets on path /ws/v1/chat
```

```bash
npm run typecheck
npm run build
MONGO_TEST_URL="mongodb://127.0.0.1:27017/campusx_test?replicaSet=rs0" npm test
```

Without `MONGO_TEST_URL`, only the 15 pure unit tests run and the 29 integration tests are skipped.
Tests use Redis database 15 and empty every collection between tests, so point `MONGO_TEST_URL` at a throwaway database.

## Try it by hand

Modules A and B are not here, so there is no signup or login. `npm run seed` creates six users (two students who follow each other, one who follows nobody, a moderator, a tenant admin, a super admin) and prints a token for each.

```bash
npm run seed                   # prints lines starting with "export": paste them into your shell
npm run dev                    # second terminal

# Ada opens a chat with Tunde (they follow each other, so it is ACTIVE) and sends a message
CHAT=$(curl -s -X POST localhost:4000/api/v1/chats/direct -H "Authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d "{\"userId\":\"$TUNDE_ID\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST localhost:4000/api/v1/chats/$CHAT/messages -H "Authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d '{"clientMessageId":"a1","text":"Are you going to the #CSC301 lecture?"}'
curl -s localhost:4000/api/v1/chats/$CHAT/messages -H "Authorization: Bearer $TUNDE"

# Chidi follows nobody, so a chat with Ada becomes a message request she must accept
curl -s -X POST localhost:4000/api/v1/chats/direct -H "Authorization: Bearer $CHIDI" \
  -H 'content-type: application/json' -d "{\"userId\":\"$ADA_ID\"}"

# Report Tunde's post, then review it as the moderator
curl -s -X POST localhost:4000/api/v1/reports -H "Authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d "{\"targetType\":\"POST\",\"targetPostId\":\"$POST_ID\",\"reason\":\"SPAM\"}"
curl -s localhost:4000/api/v1/admin/moderation -H "Authorization: Bearer $MOD"

# Super admin issues a Gold badge
curl -s -X POST localhost:4000/api/v1/admin/badges/issue -H "Authorization: Bearer $SADMIN" \
  -H 'content-type: application/json' -d "{\"userId\":\"$TUNDE_ID\",\"type\":\"GOLD\"}"
```

To watch the 10-report rule, create ten more users in `mongosh`, sign a token for each with the `signToken` helper in `src/auth/jwt.ts`, and post ten reports against one user. Their next request returns `ACCOUNT_SUSPENDED`.

For sockets, connect with `socket.io-client` to `http://localhost:4000` with `{ path: '/ws/v1/chat', auth: { token } }`, wait for `READY`, then emit `SEND_MESSAGE`. `test/moduleD.int.test.ts` (the "realtime" block) is a working example.

## What is where

| Path | Purpose |
| --- | --- |
| `src/services/enforcement.ts` | Tier 1 / Tier 2 policy, suspend, deactivate, restore, auto-restore job body |
| `src/services/reports.ts` | Report intake, 30-day dedup lock, atomic counting |
| `src/services/moderation.ts`, `moderationQueue.ts` | Queue list, review, approve, remove |
| `src/services/adminUsers.ts` | Accounts, roles, badges, banned terms, audit log |
| `src/services/contentFilter.ts` | `checkContent` and `holdPostForReview` for Module B to call |
| `src/services/chat.ts` | Direct chats, requests, groups, messages, read pointers, blocks |
| `src/realtime/socket.ts` | Socket auth, events, `FORCE_DISCONNECT` from Redis pub/sub |
| `src/jobs/restoreSuspensions.ts` | BullMQ job, every minute |
| `src/models/User.ts`, `Follow.ts`, `Post.ts` | **Stand-ins** for Modules A and B (see below) |
| `src/integrations.ts` | Two empty hooks for Module B's feed cache |

## What Modules A and B must do

- **User model (A):** add the moderation fields in `src/models/User.ts` (`role`, `status`, `suspendedUntil`, `deactivatedAt`, `reportCount`, `flaggedForAudit`, `tokensInvalidBefore`, `badge.revokedAt`).
- **Login (A):** reject `SUSPENDED` and `DEACTIVATED` accounts with `ACCOUNT_SUSPENDED` (include `suspendedUntil`) and `ACCOUNT_DEACTIVATED`. Reject any token whose `iat` is at or before `tokensInvalidBefore`, as `src/auth/middleware.ts` does.
- **Register (A):** look up `banned_emails` by `emailHash(email)` and return `EMAIL_BANNED` (403).
- **Follow graph (A):** replace `isMutualFollow` in `src/models/Follow.ts`.
- **Posts (B):** add `moderationStatus` (`PUBLISHED` | `PENDING_REVIEW` | `REMOVED`) and `removedReason`; filter every feed, thread and search query on `PUBLISHED`. On post creation call `checkContent(text, tenantDomain)`; if `ok` is false, save the post as `PENDING_REVIEW` and call `holdPostForReview`.
- **Feed cache (B):** fill in `src/integrations.ts`.
- **Mounting:** mount `chatsRouter`, `blocksRouter` (at `/api/v1/users`), `reportsRouter` and `adminRouter` in the shared app. Replace the JWT helper in `src/auth/jwt.ts` with Module A's.

## Decisions assumed (all spec defaults)

Message requests for non-mutual followers; cross-campus 1-on-1 chats and groups; per-member `lastReadMessageId` instead of `readBy`; sender can delete for everyone, no editing; one attachment up to 10 MB; Gold and staff accounts never auto-suspended; both post and account reports count; running report total never resets on suspension; Tier 2 is automatic; four roles; Gold badges by `SUPER_ADMIN` only; filtered posts are held until approved; one `tokensInvalidBefore` per user; no appeals.

## Where the code differs from the spec document

These came up while building. The spec doc has not been changed.

1. **`moderation_queue` has `targetMessageId`.** Message reports need it to stay unique per message. The partial unique index is on `(targetType, targetPostId, targetMessageId, targetUserId)` while `PENDING`.
2. **`conversations` has `declinedAt`.** It drives the 30-day cool-down after a declined request.
3. **`directKey` index is partial, not sparse.** `{ unique: true, partialFilterExpression: { directKey: { $type: 'string' } } }`. A sparse index would still reject groups that store an explicit null.
4. **Reversing a deactivation resets `reportCount` to 0** (and clears `flaggedForAudit`). Otherwise the next report would deactivate the account again.
5. **The "equal or higher role" rule** applies to suspend, restore, deactivate and role changes. Badges use the issuing rules from decision 11 and the campus scope instead.
6. **`SUPER_ADMIN` cannot be granted through `PATCH /admin/users/:id/role`.** Create super admins directly in the database.
7. **New `READY` socket event** after a connection has joined its rooms. Clients should wait for it before sending.
8. **Socket handshake errors** arrive as `connect_error` with `message` set to the error code and `data` holding the standard error body, since Socket.io has no separate "close with reason" step.
9. **Auth check order:** status first, then token revocation, so a suspended user sees `ACCOUNT_SUSPENDED` with the end date rather than a generic revoked-token error.
10. **Extra error codes:** `CHAT_REQUEST_DECLINED`, `CANNOT_MESSAGE_SELF`, `GROUP_NEEDS_MEMBERS`, `UNKNOWN_MEMBER`, `ALREADY_MEMBER`, `LAST_ADMIN`, `NOT_A_GROUP`, `NOT_MESSAGE_OWNER`, `NOT_DELETABLE`, `NOT_REPORTABLE`, `NOT_CONTENT`, `INVALID_STATE`, `INVALID_MEDIA`, `EMPTY_MESSAGE`, `VALIDATION_FAILED`.

## Known limits

- Socket connections are not closed when their JWT expires. Module A's refresh flow should decide that.
- Blocking stops sending and new chats between two users but does not delete the existing conversation.
- `REGEX` banned terms are length-limited and checked for validity, not for catastrophic backtracking. Keep that list to trusted moderators.
- Messages from a deactivated user stay in conversations (shown as "Deactivated account") for evidence. A retention period is not implemented.
