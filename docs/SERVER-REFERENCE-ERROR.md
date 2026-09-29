# Known runtime: Server Reference ID

## Symptom

Next.js may log:

`Error: The Server Reference ID did not match the expected format. Received "y".`

## Investigation (this repo)

- There are **no** `"use server"` Server Action modules in `src/`.
- Forms and mutations use **Route Handlers** (`/api/...`) + `fetch`, not Server Actions.
- Therefore this is not an application-authored Server Action ID bug.

## Likely root cause

Stale client HTML/JS after a deploy (or a CDN/browser cache) posting an old/corrupt Next action payload against a new server build. The truncated id `"y"` is consistent with a corrupted or truncated Flight/Action identifier, not with our API contracts.

## Mitigation

1. Hard refresh / clear site data after deploy.
2. Ensure the host does not serve mixed old static assets with a new server (single deploy unit via Dockerfile — already the case).
3. Do not catch-and-ignore this error in app code.

## Regression

No stable automated reproduction without forcing a stale client against a new build. If the error reappears on a clean browser session against a single deploy SHA, reopen with request headers + Network payload for the failing POST.
