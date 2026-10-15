# Media Generation (images & video)

Marina can generate images and video and surface the results in chat. Generation
runs as a tracked **job** (pending → rendering → complete), stores the result as
an asset, and publishes it to the canvas so it shows up inline in the Rich web
chat — click it to view full-size.

## Enable it

Generation calls out to a provider, so you need that provider's key:

| Media | Provider | Key | Example models |
|-------|----------|-----|----------------|
| Image | OpenAI Images (GPT Image models) | `OPENAI_API_KEY` | `openai/gpt-image-2` (default), `openai/gpt-image-1.5`, `openai/gpt-image-1-mini` |
| Image | Stability AI (Stable Image v2) | `STABILITY_API_KEY` | `stability/core`, `stability/sd3`, `stability/ultra` |
| Image | Google Imagen | `GEMINI_API_KEY` *(reused)* | `google/imagen-3.0-generate-002` |
| Image | Flux (Black Forest Labs) | `BFL_API_KEY` | `flux/flux-pro-1.1`, `flux/flux-dev` |
| Image | **Local Stable Diffusion** (Automatic1111 / SD.Next) | — *(keyless; `A1111_API_KEY` optional)* | `automatic1111/<checkpoint>`, `a1111` |
| Image | **Any OpenAI-compatible image server** (Together, Fireworks, DeepInfra, LocalAI, …) | `<PROVIDER>_API_KEY` *(optional)* | `<provider>/<model>` |
| Video | Runway (developer API) | `RUNWAY_API_KEY` | `runway/gen4.5` (default, text or image to video), `runway/gen4_turbo` (image to video only), `runway/veo3.1` |
| Video | Google Veo | `GEMINI_API_KEY` *(reused)* | `google/veo-3.1-generate-preview`, `google/veo-3.1-fast-generate-preview` |
| Video | Luma Dream Machine | `LUMA_API_KEY` | `luma/ray-2`, `luma/ray-flash-2` |

OpenAI retired `dall-e-2` and `dall-e-3` on 2026-05-12; Marina refuses them with a
pointer to `openai/gpt-image-2` and no longer treats them as image models.

### Local & custom image models

You can use **any** image model, including local ones — no code change:

- **Automatic1111 / SD.Next** (the common local SD WebUI): point Marina at it with
  `A1111_BASE_URL` (default `http://localhost:7860`) and use `automatic1111/<checkpoint>`
  (or just `a1111` for the loaded checkpoint). Keyless.
- **Any OpenAI-compatible `/v1/images/generations` server** (hosted or local): set
  `<PROVIDER>_IMAGE_BASE_URL` (and `<PROVIDER>_API_KEY` if it needs auth), then address
  models as `<provider>/<model>`. Example:
  ```bash
  TOGETHER_IMAGE_BASE_URL=https://api.together.xyz/v1
  TOGETHER_API_KEY=...
  # image generate a fox in snow --model together/black-forest-labs/FLUX.1-schnell
  ```
  Local servers (LocalAI, vLLM image, etc.) work the same way — just point the base URL at
  `http://localhost:<port>/v1`.

Pick a provider per request with `--model` (default image model is
`openai/gpt-image-2`; override the instance default in Admin → Model). Each participant may start at most
50 image and 5 video jobs in any 24 hours by default (`0` = unlimited):

```bash
MAX_IMAGE_JOBS_PER_DAY=50
MAX_VIDEO_JOBS_PER_DAY=5
```

Priced cloud jobs also count toward the world's daily spend cap
(`MARINA_DAILY_SPEND_CAP_USD`, default $50, `0` = no cap) at their estimated price, and are
refused once it is reached. Local endpoints with no known price are not refused by it.

Notes:
- **Prompt moderation** runs against OpenAI when an `OPENAI_API_KEY` is present,
  regardless of the image provider; without one it's skipped (generation still
  works).
- **Sizes** snap to each provider's supported aspect ratios — `--width/--height`
  are a hint, not exact pixels, for Stability/Imagen. OpenAI: `gpt-image-2` (and
  its snapshots, `gpt-image-2.5-*`) takes any size with both edges multiples of 16,
  aspect 1:3–3:1, no edge above 3840 and 655,360–8,294,400 pixels, so a request is
  mapped into that space keeping its aspect; `gpt-image-1`, `-1.5` and `-1-mini`
  take only 1024x1024, 1536x1024 or 1024x1536 (nearest aspect). With no
  dimensions the model chooses.
- **Style** — GPT Image models reject the legacy `style` parameter, so `--style`
  is written into the prompt (`Style: …`) instead.
- **Video** is async (rendered server-side, then polled) — Runway, Google Veo and
  Luma are supported; other providers return a clear "not supported" error.
- **Video limits per provider** — Runway takes `ratio` as an output resolution
  (`--aspect 16:9` becomes `1280:720`, `9:16` becomes `720:1280`) and 2–10 s
  for `gen4.5`/`gen4_turbo`; Veo takes 4, 6 or 8 s (8 with a reference image) at
  16:9 or 9:16. No provider API takes a frame rate: `--fps` is recorded on the
  job but not sent.
- **`--reference`** — an `https://` URL is passed to the provider as is. A
  stored asset or canvas node (`<asset id>`, `asset:<id>`, `node:<id>`) is read
  as you (a private asset you cannot read is "not found"), must be a PNG, JPEG,
  GIF or WebP up to ~3.9 MB, and is sent inline (Runway `promptImage`, Veo
  first frame). Luma takes only a public image URL, so a stored asset is
  refused for Luma rather than sent.

## Generate

There are three ways to kick off a job; all land in the same pipeline.

### 1. A command (any user, any connection)

```
image generate a neon koi pond at dusk
image generate a logo for "Marina" --width 1024 --height 1024 --style synthwave
video generate a slow dolly over misty mountains --duration 5 --aspect 16:9
```

Flags — image: `--model`, `--style`, `--width`, `--height`, `--canvas`.
Video: `--model`, `--duration`, `--fps`, `--aspect`, `--reference <asset>`, `--canvas`.
Omit `--canvas` and the result publishes to your own canvas.

### 2. An agent generates it

Generation is a **provider** capability, not a property of the agent's model.
Any agent, on any model, is offered `marina_generate_image` when an image
provider is configured (a key for `openai`, `stability`, `google` or `flux`,
`A1111_BASE_URL`, or a `<PROVIDER>_IMAGE_BASE_URL` endpoint) and
`marina_generate_video` when a video provider key is set (`runway`, `google`,
`luma`). Both are deferred tools (find them with `marina_tool_search`) and run
under the same per-entity job caps and the daily spend cap as the command.

- An agent config that sets `supports.image` / `supports.video` explicitly is
  still offered the tool even when no provider is detected at spawn.
- Without either, an agent can still run the `image generate` / `video
  generate` **command** through `marina_command`; it reports what is missing.

### 3. HTTP (external integrations)

```bash
curl -X POST http://localhost:3300/v1/media \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MARINA_MODEL_KEY" \
  -d '{"type":"image","prompt":"a futuristic city at dawn","model":"openai/gpt-image-2"}'
# → poll GET /v1/media/<jobId>
```

The job runs as the caller the key authenticates: a `secret:entity` key in
`MODEL_API_KEYS` is that entity (its quota, spend and canvas), an unbound key is
the anonymous `system` caller. `entityId` / `entityName` in the body may only
name the caller itself; naming another entity is a 403 unless the key is the
internal token or a multi-tenant `secret:*` operator key. `GET /v1/media/<jobId>`
answers only the job's owner (or such a trusted caller); anyone else gets 404.

## View results

- **Rich web chat (recommended):** finished media appears inline in the
  conversation timeline. **Click an image/video/doc to pop it out** in an
  in-app viewer (full-size image, `<video>` player, PDF/doc iframe) with the
  prompt + model and Open/Download. (Switch to Rich view with the toggle in the
  Web Chat header.)
- **Media Jobs overlay:** type `media jobs` (or `media status`) in chat to see
  every job with status, cost estimate, errors, and Retry / Open / Delete /
  re-run-Command actions. "Open" uses the same pop-out viewer.
- **Per-entity:** selecting an agent shows its recent media jobs in the context
  panel.

## How it works (pipeline)

1. The command/tool/HTTP call creates a `media_jobs` row (`pending`) and emits a
   feed event.
2. Image prompts are run through OpenAI moderation first; a blocked prompt ends
   the job as `blocked`.
3. The provider generates; the bytes are stored as an **asset** (served at
   `/assets/<key>`, metadata at `/api/assets/<id>`).
4. The asset is published as a canvas node (`image`/`video`), which is what makes
   it appear inline in Rich chat.
5. The job flips to `succeeded` (or `failed`) and emits a final feed event.

Video is asynchronous and durable. Starting a render stores the provider's
task id on the job (`provider_job_id`) and leaves it `running`; the
`media-video-poll` tick job (about every 5 s) polls every `running` video job
from the database, so a restart resumes jobs in flight. `progress` updates as
the provider reports it. A transient provider error (network, throttling, a
5xx, a failed download of a finished render) keeps the job running for the
next pass and is shown as `lastPollError` in its metadata. A job still
rendering after `MARINA_VIDEO_JOB_TIMEOUT_MIN` minutes (default 30) fails with
a timeout reason naming the provider task. A finished job records its spend
once: the provider's reported charge when it gives one (Runway's
`cost.credits`), else the job's estimate.

**Checking a generated image (optional).** With `MARINA_MEDIA_VERIFY=observe`,
each finished image is shown to the world's decision backend with two
questions: does it depict the prompt, and how usable is it. The answer is
stored as numbers and a label (`match`, `mismatch` or `unjudged`) under the
job's `metadata.mediaVerify` and logged as an `agent_decision` event; the job
itself never waits for it. `on` also regenerates a mismatch once, as an
ordinary job (the daily quota and spend cap apply, and a regeneration is never
regenerated). The default, `off`, makes no call. The backend must read images:
Jev (`MARINA_DECISIONS=jev`), or a chat classifier on a vision model. See
[harness decisions](../architecture/decisions.md#images-and-boxes-srcdecisionsimagests).

## Seeing images and video

The same canvas that shows generated media is where agents *read* it. Anything
on a canvas (an image, a PDF or document, a video, a text node), a stored
asset, or an http(s) URL can be looked at:

```
canvas look <node_id> [question...] [model:<provider/model>]
image describe <node|asset|url> [question...]
video describe <node|asset|url> [question...]
```

Agents have the same thing as the `marina_see` tool (a deferred tool; find it
with `marina_tool_search`).

**Agents see with their own model.** When the agent's model accepts image
input, `marina_see` returns the image itself in the tool result, with a short
header (source reference, dimensions, type, the question) that marks the
content as untrusted. No second model is called. A model that cannot read
images gets the text description instead, exactly as before.
`MARINA_AGENT_VISION` chooses:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | native when the model accepts images, otherwise describe |
| `native` | always return the image (the operator asserts the model reads it) |
| `describe` | always ask a vision model for text |

Image input is read from the model registry and the provider catalogs; for
`marina/default` it is the upstream the default route uses at the moment of
the look. An agent config can set `supports.imageInput` to `true` or `false`
explicitly. The command form is `mode:native` on `canvas look`,
`image describe` and `video describe`, and `"mode":"native"` on `code see`.
A native view uses the same access checks and rate limit as a description.

Native images are prepared for model input: rotated upright, long side at most
1568 px, at most 1.6 megapixels and 3.75 MB, as PNG, JPEG or WebP (an animated
GIF sends its first frame). A PDF returns its first pages as images plus the
extracted text, a video up to 4 keyframes, a text node its text. When an image
cannot be prepared (for example it needs resizing and `sharp` is missing), the
look falls back to a description and says why.

Only the newest images stay in the agent's live transcript
(`MARINA_AGENT_VISION_MAX_IMAGES`, default 4). Older ones are replaced by a
one-line placeholder such as `[asset:<id> 1024x768 — no longer in view; call
marina_see asset:<id> to view it again]`. The continuity journal and
compaction archives never store image bytes.

What a description is built from depends on the source:

| Source | Sent to the model |
| --- | --- |
| PNG, JPEG, GIF, WebP | the image (checked by magic bytes, not the declared type) |
| PDF | extracted text from the first 12 pages plus the first 3 pages as images (`pdftotext`, `pdftoppm`) |
| Video | 4 representative keyframes (`ffmpeg`) |
| Text node or text file | the text (clamped) |
| SVG | refused: it is markup, not pixels |

When `pdftotext`, `pdftoppm` or `ffmpeg` is not installed, the answer says so
and works with what remains. The tools run asynchronously with a 30 s timeout
and capped output, at most two documents at a time across the server (a few
more wait; beyond that a look is refused with a note). Each entity may look 6
times in a burst, then once every 10 s (the local profile lifts the limit).

**Write-back.** When the source is a canvas node, the answer is written to the
same canvas as a text node beside it, linked by a `derived_from` edge, so it is
visible in the dashboard and reusable by every agent. Repeated looks with the
same question and model come from a cache.

**Which model looks.** An explicit `model:` is used alone. Otherwise the
agent's own model is tried first; if it cannot read images, Marina falls
through to `MARINA_VISION_MODEL`; if neither can, the reply is labelled
`[no vision]` and names the setting. Calls go through Marina's passthru, so
spend, the daily cap and traces apply as for any model call.

**Crews.** A crew (`marina:<crew>` model id) hears a request as text, so images
in an agents-mode `/v1/chat/completions` or `/v1/responses` request are stored
as assets and placed on the caller's private inbox canvas (`inbox:<entity id>`
for a bound key or name-mapped agent, `inbox:model-key-<hash>` for any other
API key; only the owner and operators see it in the dashboard). The crew's
prompt names each node and the `canvas look` command to read it. The agents
serving the request (the endpoint channel's members and its crew) get a read
grant on those nodes that expires 60 s after the request deadline. Anyone else
who uses the node id gets "not found". A request's
images are capped at `MARINA_VISION_MAX_BYTES` in total, and staged images are
deleted after 7 days (`MARINA_RETENTION_OVERRIDES` entries `assets` and
`canvas_nodes`, which apply to request images only). An open-API caller outside
the local profile stages nothing; each image is labelled as not staged. A request may now be image-only. Remote image URLs are
not fetched at request time; the prompt names the URL, which `canvas look`
reads through the SSRF guard if an agent chooses to.

**Judging an image.** `decision check` and `decision choose` take
`image:asset:<id>` or `image:node:<id>` (up to 4) for a quick number about a
picture you can read: `decision choose image:node:n1 Which logo is legible? |
left | right`. The images are loaded with your own read access, prepared to the
decision model's limits, and sent with the question. External harnesses send
the same image parts to `POST /v1/decisions`; a `box` question returns where
something is in the image.

**`marina/verify`.** The checker sees the conversation's four most recent images
(from user and tool messages) alongside the text review, so a visual answer is
checked against the same pixels the proposer saw.

**Limits.** Inputs are untrusted: bytes are capped by `MARINA_VISION_MAX_BYTES`
(default 20 MB), URLs go through the SSRF guard, and the PDF and video tools run
without a shell, in a private temporary directory, with a 30-second timeout.

**Image processing.** Marina reads an image's format, size, EXIF orientation and
animation from its header without extra software. Rotating, resizing,
re-encoding and thumbnails use the optional `sharp` package, which a normal
`bun install` includes. Without it, an image that already meets a destination's
limits is sent unchanged, and one that needs processing is refused with a reason
that names the missing package. It is never sent out of spec.

## Assets

Every stored file (an upload, a generated image or video, a model-API request
image, a file published from `exec`) is an **asset**. Besides its bytes, the
record keeps:

- **Origin:** `upload`, `generated`, `request`, `tool`, or `derived` for a
  thumbnail, poster or preview made from another asset.
- **Facts:** the SHA-256 of the bytes and, for images, width and height. These
  are read from the file header when it is stored. Video and audio duration,
  video size and PDF page counts are filled in afterwards when `ffprobe` or
  `pdfinfo` is installed.
- **Provenance:** for generated media, the prompt, model, provider, media job
  and its cost.
- **Reader text:** caption, alt text and tags.
- **Lineage:** links to the assets it was made from or made into.

**Upload dedupe.** If you upload bytes you have already uploaded, with the same
type, you get your existing asset back instead of a second copy:
`POST /api/assets` answers `200` with `deduplicated: true`, and
`canvas asset upload` says "Already uploaded". Two people uploading the same
file still get separate assets.

**Thumbnails.** After an asset is stored, Marina makes its thumbnails in the
background, one asset at a time, so an upload never waits for them:

| Source | Made | Needs |
|---|---|---|
| PNG, JPEG, WebP, GIF | WebP thumbnails (256 px and 1024 px long side) and a 16 px inline placeholder | `sharp` |
| Video | a poster frame, then its thumbnails | `ffmpeg` (+ `sharp` for thumbnails) |
| PDF | a first-page preview, then its thumbnails | `pdftoppm` (+ `sharp` for thumbnails) |

A missing tool means no derivative. The reason is recorded on the asset
(`derivative_state` `unavailable`, with a note naming the tool). It is not an
error. Derivatives are assets with origin `derived`. They are exactly as
readable as the asset they were made from. A thumbnail of a private asset is
hidden from anyone who cannot read the original, and its bytes are signed or
refused the same way. Deleting an asset deletes its derivatives. Assets stored
before this record existed get their facts and thumbnails from the
`asset-backfill` tick job, a few every 30 seconds, so startup never waits for
them. `MARINA_ASSET_DERIVATIVES` controls this: `on` (default) makes them in
the background, `sync` makes them before the upload returns, and `off` never
starts `sharp`, `ffmpeg` or `pdftoppm` for assets. Shutdown waits for the job
in flight and skips queued ones; the backfill picks those up later.

**In world.** The `asset` command lists, shows, searches, tags, captions and
deletes. Anyone can read with it, subject to the asset read check. Only the
owner, an agent's creator or an operator can change or delete an asset.

```
asset list owner:me type:image sort:new
asset list tag:moodboard origin:generated since:7d
asset show <id>
asset search red fox
asset tag <id> +moodboard -draft
asset caption <id> -- A fox at dusk
asset alt <id> -- Red fox standing in snow
asset delete <id>
```

**Over HTTP.** `GET /api/assets?view=library` returns
`{ items, nextCursor, facets? }`. Each item carries its thumbnail URLs, the
placeholder, dimensions, origin, tags and caption. URLs for private assets come
back signed for the caller. The query accepts `type`, `owner`, `origin`, `tag`,
`canvas`, `since`, `q`, `sort`, `limit`, `cursor` and `facets=1`.
`GET /api/assets/<id>` adds provenance, lineage and the canvases that show the
asset. `PATCH /api/assets/<id>` sets `caption`, `alt`, `tags`, `addTags` or
`removeTags`. It is allowed for the owner or an operator. Anyone else gets 403,
or 404 when they cannot read the asset at all. The plain `GET /api/assets`
array is unchanged.

**Retention.** Only request images age out (7 days). Uploaded, generated and
tool assets are kept until someone deletes them. Deleting a canvas node or a
whole canvas never deletes the asset it shows: one asset can sit on many nodes
and canvases, and whoever removes a node need not own the asset. Delete the
asset itself from the library, with `asset delete` or `DELETE /api/assets/<id>`.

## Troubleshooting

- **"Provider not yet supported"** — built-in image providers are `openai`,
  `stability`, `google`, `flux`, `automatic1111`; video providers are `runway`,
  `google` (Veo), and `luma`. For any other image provider, set
  `<PROVIDER>_IMAGE_BASE_URL` first (see *Local & custom*).
- **Job stuck `pending` / errors immediately** — the provider key is missing
  (`OPENAI_API_KEY` / `RUNWAY_API_KEY`) or the daily cap is hit.
- **Video job `running` for a long time** — check its `lastPollError` in
  `media jobs`; `readiness` lists a failing `media-video-poll` tick job. The job
  fails on its own at `MARINA_VIDEO_JOB_TIMEOUT_MIN`.
- **Agent has no generate tool** — its model isn't image/video-capable. Spawn it
  on a media model, or have it run the `image generate` command instead.
- **Nothing appears in chat** — make sure you're in **Rich** view (Compact view
  doesn't render the canvas timeline); the result is also always in `media jobs`.
