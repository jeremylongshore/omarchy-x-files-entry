# Fixture capture procedure

The unit suite runs against X API v2 fixtures under `tests/fixtures/`. The
shipped fixtures are **synthesized** to real v2 envelope shapes, because live
capture needs API credits that were not yet purchased when the plugin was
built. They exercise every parse, classify, dedupe, score, digest, and spend
path offline. Endpoints and pricing were verified against `docs.x.com`
(2026-08-20); see `Model.js` for the citations.

## Fixtures

| File | Stands in for |
| --- | --- |
| `user-lookup.json` | `GET /2/users/by/username/:handle` |
| `own-tweets.json` | `GET /2/users/:id/tweets?exclude=retweets,replies` |
| `mentions.json` | `GET /2/users/:id/mentions` |
| `conversation.json` | `GET /2/tweets/search/recent?query=conversation_id:<id>` |
| `chat-completion.json` | a BYOK OpenAI-compatible chat completion |

The `conversation.json` mix is deliberate: two independent Wayland-crash
reports (one a near-duplicate, to exercise the dedupe), a polite feature ask,
a question, praise, a bare `+1`, and spam, so the classifier, the substance
floor, and the needs-reply gate all have something to bite on.

## Live capture (once credits exist)

Buy about $5 of credits at https://console.x.com, mint an app-only bearer
token, then:

```bash
TOKEN='<bearer>'; UID='<your-numeric-id>'; CONV='<a-post-id-with-replies>'
h() { curl -sS --proto =https --header "Authorization: Bearer $TOKEN" "$@"; }

h "https://api.x.com/2/users/$UID/tweets?exclude=retweets,replies&max_results=25&tweet.fields=created_at,conversation_id,author_id,public_metrics&expansions=author_id&user.fields=username,name" > tests/fixtures/own-tweets.json
h "https://api.x.com/2/users/$UID/mentions?max_results=25&tweet.fields=created_at,conversation_id,author_id,in_reply_to_user_id,public_metrics&expansions=author_id&user.fields=username,name" > tests/fixtures/mentions.json
h "https://api.x.com/2/tweets/search/recent?query=conversation_id:$CONV&max_results=25&tweet.fields=created_at,conversation_id,author_id,in_reply_to_user_id,public_metrics&expansions=author_id&user.fields=username,name" > tests/fixtures/conversation.json
```

Two things to confirm at capture time, both flagged in `Model.js`:

1. **Field selector name.** X's current docs show `post.fields`; the
   long-standing `tweet.fields` alias is what this plugin sends and what the
   sibling x-bug-triage plugin uses against the live API. If a capture comes
   back missing `created_at`/`public_metrics`, switch the param name to
   `post.fields` in `Model.js`.
2. **Billing class.** Watch the credit console: confirm whether reply reads
   bill at the $0.005 standard rate or the $0.001 owned-read rate, and set
   the plugin's per-post cost setting to match so the spend meter is honest.

Scrub real handles/text down to a representative sample before committing, and
never commit a token. Run `npm test` after recapture.
