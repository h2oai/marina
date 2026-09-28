# Dashboard accessibility

Run `bun run test:a11y` to check the lint exception contract, build the dashboard,
and scan it in Chromium with axe-core. CI runs the same command in a dedicated job.
The browser checks cover desktop and mobile participation, inline command discovery,
the discovery dialog, the canvas workspace, and unified-canvas panels and shortcut help. They fail on any detected WCAG
2.0/2.1/2.2 A or AA violation, including contrast and target size. No browser rules
or page regions are excluded. Full axe results (including checks needing manual
review), screenshots, and failure traces are preserved as CI artifacts.

The unified canvas is checked in all six themes, including collapsed and expanded
controls and shortcut help. Panels stay opaque, and map labels have an opaque
outline so moving graphics cannot wash out their text. Full-screen scanline and
pixel overlays are removed from the reading surface.

Axe can still report incomplete contrast results for SVG text or overlapping
layers. The browser suite supplements these with resolved foreground/background
measurements (minimum 4.5:1), including the map-label outline. Unknown backgrounds
or translucent ancestors fail this check. The measurements are attached as
`*-contrast-paints` artifacts; they do not prove layout visibility, so inspect the
screenshots for clipping and occlusion. An incomplete axe result alone is never
evidence that contrast passes.

Keyboard actions use native controls. Entity inspection, stopping an agent, and
removing an entity are separate controls. SVG map actions are native buttons over
the artwork. Canvas connection handles remain outside those buttons. The context
inspector's move handle supports arrow keys; shortcut help uses a native modal
dialog to contain focus and return it on dismissal.

## Content-dependent exceptions

The only lint exceptions are listed in
[`dashboard/accessibility-exceptions.json`](../../dashboard/accessibility-exceptions.json).
They disable `useMediaCaption` only in the uploaded audio and video renderers.
Marina's asset contract currently has no caption or transcript field. A blank track
would not make the content accessible. These exceptions describe a content limitation,
not a claim of WCAG conformance. Publish captioned video and add a text node containing
a transcript or equivalent description for audio/video content.

`bun run check:a11y` verifies that this allowlist matches the exact Biome overrides
and rejects inline accessibility suppressions. Structural controls cannot be added
to the allowlist. Dashboard accessibility lint rules are errors.

## Manual review

Automated scans catch only a subset of accessibility problems. Before changing an
interaction, also verify:

- Tab and Shift+Tab reach each action in a useful order, with a visible focus indicator.
- Enter/Space perform a focused button's action once; nested controls do not activate
  the surrounding row. Editors retain their typing and navigation keys.
- Escape dismisses modal content, focus returns to the opener, and background controls
  cannot receive focus while a modal is open.
- Map selection, node dragging, connection handles, and file-picker alternatives to
  dropping files still work. Test zoom and reduced motion as well as pointer input.
- A screen reader announces names, selected/expanded state, command suggestions,
  and memory tiers accurately. Review uploaded media and axe's incomplete results.
  Inspect text at different zoom levels and check that floating panels do not
  obscure labels or focused controls.

The [Playwright accessibility guide](https://playwright.dev/docs/accessibility-testing)
explains the automated checks and their limits.
