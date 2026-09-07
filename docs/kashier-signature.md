# Kashier webhook signature verification

Source: <https://developers.kashier.io/payment/webhook/>

Kashier signs each delivery with HMAC-SHA256 and sends the hex digest in the
`x-kashier-signature` header. Their reference implementation is:

```js
data.signatureKeys.sort();
const picked    = _.pick(data, data.signatureKeys);
const payload   = queryString.stringify(picked);
const signature = crypto.createHmac('sha256', PaymentApiKey)
                        .update(payload).digest('hex');
signature === req.header('x-kashier-signature');
```

Which key signs which event:

| Events | Key |
|---|---|
| `pay` `capture` `authorize` `refund` `void` `reversal` | Payment API key |
| `INITIATED` `TRANSFERRED` `FAILED` | Transfer API key |

Test and live each have their own pair, so there are four possible keys. The
endpoint tries every key it has and reports which one matched — that is also how
it decides whether a delivery is test or live.

## The details that actually matter

The security of the endpoint depends on reproducing `query-string@7.stringify`
**byte for byte**. These are the rules that are easy to get wrong, each one
pinned by a test:

| Rule | Correct | Wrong |
|---|---|---|
| Key order | `Array#sort()`, UTF-16 code units → `Banana, Zebra, apple` | `localeCompare` → `apple, Banana, Zebra` |
| Space | `%20` | `+` |
| `! ' ( ) *` | escaped: `%21 %27 %28 %29 %2A` | left literal by plain `encodeURIComponent` |
| `~ . - _` | left literal | escaped |
| `null` value | bare key, no `=` → `a` | `a=` or `a=null` |
| Empty string | `a=` | key dropped |
| Key missing from `data` | dropped entirely | `a=undefined` |
| Which fields | only those in `signatureKeys` | all of `data` |

`signatureKeys` arrives inside every payload and must be read from it, never
hardcoded — Kashier can change the set.

## Why the vectors are generated, not written

`supabase/tests/kashier-signature-vectors.json` is produced by
`generate-vectors.js`, which runs Kashier's documented algorithm against the
**real** `query-string@7.1.3` and `underscore@1.13.6` packages. The Deno
implementation is then asserted against that output.

That means the tests verify agreement with the actual library rather than with
someone's reading of the docs. CI regenerates the vectors and fails on any
drift.

```bash
node supabase/tests/generate-vectors.js > supabase/tests/kashier-signature-vectors.json
cd supabase && deno task test
```

## Comparison is constant-time

`timingSafeEqual` compares digests byte by byte with no early exit. A plain
`===` on hex strings returns faster the earlier it finds a mismatch, which is
enough to let an attacker recover a valid signature one character at a time.

## Failure is never silent

A delivery that fails verification is rejected with **401** and written to
`webhook_rejections` with the reason and a 2 KB body excerpt. The 401 is
deliberate: Kashier retries for ~23.5 hours, so a misconfigured key can be
fixed without losing the delivery. The excerpt lets you inspect what arrived
without ever having trusted it.
