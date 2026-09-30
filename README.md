# zoom-dl

Download Zoom cloud recordings — including **passcode-protected** ones and ones where the
owner disabled the download button.

```bash
./zoom-dl.sh <url> [passcode] [seconds] [-o dir]

./zoom-dl.sh 'https://us02web.zoom.us/rec/play/...' 'KD+ZLT1s'          # full recording
./zoom-dl.sh 'https://us02web.zoom.us/rec/share/...' '*8q*n4mW' 10     # 10s preview
./zoom-dl.sh 'https://us02web.zoom.us/rec/component-page?...' '...' -o /tmp
```

All three URL forms work: `/rec/play/...`, `/rec/share/...`, and the passcode page
(`/rec/component-page?...`, unwrapped via its `originRequestUrl` param). The `?iet=...`
token in the link is what matters — it's the share session token.

Needs: `bun`. The seconds preview trims with a bundled ffmpeg
(`ffmpeg-static` — no system install needed; `trustedDependencies` is set so bun runs
its binary download on install). Output goes to
`~/Downloads` (`-o dir` or `ZOOM_DL_DIR` to change), named after the meeting topic.

## how it works

Zoom's new recording player is an SPA, and none of the community tools (yt-dlp, zoomdl,
zoom-dl) handle it — they still target the legacy `password_form` page and the dead
`/rec/validate_meet_passwd` endpoint. This is the current flow, reverse-engineered from
the player bundles:

```text
url ──► play page ──► fileId ──► play/info ──► need-password? ──► validate ──► play/info
             │                      │                                (passcode)
             └── share links: play/share-info/{meetingId} ──► play page
                                (may itself be the gate)

play/info ──► viewMp4Url ──► playcheck ──► got stream (cookies + Referer) ──► .mp4
```

1. **Session + CSRF.** Every run gets a cookie jar, then a CSRF token:
   `POST /csrf_js?t_x_zm_rid=1` with header `FETCH-CSRF-TOKEN: 1` returns `name:value`
   (OWASP CSRFGuard), sent back as a header on later POSTs.

2. **fileId.** The play page embeds `fileId` in `window.__data__`. Share links don't have
   one: `GET /nws/recording/1.0/play/share-info/{meetingId}` answers with a redirect to
   the play page — or with the passcode gate (step 3).

3. **Passcode gate.** `play/info` (or `share-info`) answers
   `result.componentName = "need-password"` plus a `redirectUrl` pointing at the passcode
   component page. From there:

   - `POST /nws/recording/1.0/validate-context` with `meetingId` (from the component
     page's `window.__data__`), `fileId`, `useWhichPasswd`, `sharelevel`, `iet`
     → returns `encryptMeetId`
   - `POST /nws/recording/1.0/validate-meeting-passwd` with `id=encryptMeetId`,
     `passwd=<passcode>`, `action=viewdetailpage` (or `validate-passwd` with the fileId
     for file-level passcodes) → sets the session cookie

4. **Media URL.** `play/info` returns `viewMp4Url` — a CloudFront-signed mp4 URL that is
   served **even when `disableDownload: true`**. The download button is just UI.

5. **CDN unlock.** `GET /nws/recording/1.0/playcheck/{playId}?accid=...&dur=0` first —
   a Lambda@Edge on `ssrweb.zoom.us` 403s (`Forbbiden`, sic) every media request until
   the session is playchecked.

6. **Transfer.** `got` streams to disk over the shared `tough-cookie` jar with
   `Referer: https://<host>/` — non-2xx throws, so error pages never end up saved as
   `.mp4`. The seconds mode requests a byte range (2x the average byte rate + moov
   headroom — the mp4 has `moov` up front) and trims locally with the bundled
   `ffmpeg -t N -c copy`. Full downloads resume partial files with a Range request
   (append only when the server answers 206); filenames carry the recording id, so a
   resume can only ever resume the same recording, and a finished file is skipped on
   re-runs.

## development

```bash
bun install
bun run check        # oxlint + oxfmt --check + tsc --noEmit
bun run check:fix    # oxlint --fix + oxfmt --write
bun run test         # vitest
```

```text
src/zoom-dl.ts       CLI + flow (got does HTTP, TS does logic)
src/zoom-dl.test.ts  vitest specs for the pure helpers
zoom-dl.sh           wrapper: exec bun src/zoom-dl.ts "$@"
```

Pure helpers (`parseUrl`, `resolveStart`, `pageVal`, `gateOf`, `mediaMeta`, `slug`,
`outName`, `previewBytes`, `parseSeconds`) are unit-tested; the networked flow is proven by real downloads —
all three URL forms above pass end-to-end.

## limits

- multi-clip recordings (`totalClips > 1`) pull the first clip only
- no transcript / chapter export (play/info has the VTT URLs if we ever want it)
