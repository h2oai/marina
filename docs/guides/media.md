# Media Generation (images & video)

Marina can generate images and video and surface the results in chat. Generation
runs as a tracked **job** (pending → rendering → complete), stores the result as
an asset, and publishes it to the canvas so it shows up inline in the Rich web
chat — click it to view full-size.

## Enable it

Generation calls out to a provider, so you need that provider's key:

| Media | Provider | Key | Example models |
|-------|----------|-----|----------------|
| Image | OpenAI Images | `OPENAI_API_KEY` | `openai/gpt-image-1`, `openai/dall-e-3` |
| Image | Stability AI (Stable Image v2) | `STABILITY_API_KEY` | `stability/core`, `stability/sd3`, `stability/ultra` |
| Image | Google Imagen | `GEMINI_API_KEY` *(reused)* | `google/imagen-3.0-generate-002` |
| Image | Flux (Black Forest Labs) | `BFL_API_KEY` | `flux/flux-pro-1.1`, `flux/flux-dev` |
| Image | **Local Stable Diffusion** (Automatic1111 / SD.Next) | — *(keyless; `A1111_API_KEY` optional)* | `automatic1111/<checkpoint>`, `a1111` |
| Image | **Any OpenAI-compatible image server** (Together, Fireworks, DeepInfra, LocalAI, …) | `<PROVIDER>_API_KEY` *(optional)* | `<provider>/<model>` |
| Video | Runway | `RUNWAY_API_KEY` | `runway/gen3-alpha` |
| Video | Google Veo | `GEMINI_API_KEY` *(reused)* | `google/veo-3.0-generate-preview` |
| Video | Luma Dream Machine | `LUMA_API_KEY` | `luma/ray-2` |

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
`openai/gpt-image-1`; override the instance default in Admin → Model). Each participant may start at most
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
  are a hint, not exact pixels, for Stability/Imagen.
- **Video** is async (rendered server-side, then polled) — Runway and Google Veo
  are supported; other providers return a clear "not supported" error.

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

An agent gets the `marina_generate_image` / `marina_generate_video` tools **only
if its model is image/video-capable** — the tools are gated by the agent's
`supports` flags, which are inferred from the model at spawn. So:

- Spawn the agent on a media model (e.g. `openai/gpt-image-1` for image) and it
  gains the matching generate tool. The **Launch** panel shows a hint under the
  model picker telling you whether the selected model can generate.
- Or, regardless of model, an agent can run the `image generate` / `video
  generate` **command** via its `marina_command` escape hatch.

### 3. HTTP (external integrations)

```bash
curl -X POST http://localhost:3300/v1/media \
  -H "Content-Type: application/json" \
  -d '{"type":"image","prompt":"a futuristic city at dawn","model":"openai/gpt-image-1","entityName":"artist"}'
# → poll GET /v1/media/<jobId>
```

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

Video is asynchronous: Runway is polled every few seconds and the job's
`progress` updates until the render completes.

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
with `marina_tool_search`). What the model receives depends on the source:

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

**`marina/verify`.** The checker sees the conversation's four most recent images
(from user and tool messages) alongside the text review, so a visual answer is
checked against the same pixels the proposer saw.

**Limits.** Inputs are untrusted: bytes are capped by `MARINA_VISION_MAX_BYTES`
(default 20 MB), URLs go through the SSRF guard, and the PDF and video tools run
without a shell, in a private temporary directory, with a 30-second timeout.

## Troubleshooting

- **"Provider not yet supported"** — built-in image providers are `openai`,
  `stability`, `google`, `flux`, `automatic1111`; video providers are `runway`,
  `google` (Veo), and `luma`. For any other image provider, set
  `<PROVIDER>_IMAGE_BASE_URL` first (see *Local & custom*).
- **Job stuck `pending` / errors immediately** — the provider key is missing
  (`OPENAI_API_KEY` / `RUNWAY_API_KEY`) or the daily cap is hit.
- **Agent has no generate tool** — its model isn't image/video-capable. Spawn it
  on a media model, or have it run the `image generate` command instead.
- **Nothing appears in chat** — make sure you're in **Rich** view (Compact view
  doesn't render the canvas timeline); the result is also always in `media jobs`.
