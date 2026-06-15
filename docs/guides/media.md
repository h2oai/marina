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
| Image | **Local Stable Diffusion** (Automatic1111 / SD.Next) | — *(keyless; `A1111_API_KEY` optional)* | `automatic1111/<checkpoint>`, `a1111` |
| Image | **Any OpenAI-compatible image server** (Together, Fireworks, DeepInfra, LocalAI, …) | `<PROVIDER>_API_KEY` *(optional)* | `<provider>/<model>` |
| Video | Runway | `RUNWAY_API_KEY` | `runway/gen3-alpha` |
| Video | Google Veo | `GEMINI_API_KEY` *(reused)* | `google/veo-3.0-generate-preview` |

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
`openai/gpt-image-1`; override the instance default in Admin → Model). Optional
daily caps (0 = unlimited):

```bash
MAX_IMAGE_JOBS_PER_DAY=0
MAX_VIDEO_JOBS_PER_DAY=0
```

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

## Troubleshooting

- **"Provider not yet supported"** — built-in image providers are `openai`,
  `stability`, `google`, `automatic1111`; video providers are `runway` and
  `google` (Veo). For any other image provider, set `<PROVIDER>_IMAGE_BASE_URL`
  first (see *Local & custom*).
- **Job stuck `pending` / errors immediately** — the provider key is missing
  (`OPENAI_API_KEY` / `RUNWAY_API_KEY`) or the daily cap is hit.
- **Agent has no generate tool** — its model isn't image/video-capable. Spawn it
  on a media model, or have it run the `image generate` command instead.
- **Nothing appears in chat** — make sure you're in **Rich** view (Compact view
  doesn't render the canvas timeline); the result is also always in `media jobs`.
