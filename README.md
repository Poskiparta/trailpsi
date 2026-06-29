# TrailPSI

Bike route analyzer and tire pressure calculator with GPX upload.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Start the app and local dev server:

```bash
npm run dev
```

Open the Vite URL shown in Terminal.

## GPX surface analysis

TrailPSI parses GPX distance and elevation locally. Surface analysis uses nearby OpenStreetMap roads and paths through public Overpass endpoints in the browser.

This version does **not** reroute the GPX through openrouteservice. Instead, it samples the GPX track and looks for nearby OSM ways with `surface`, `tracktype`, `highway` and related tags. This should avoid the previous problem where gravel/forest-road GPX tracks could be snapped onto paved roads and reported as almost entirely paved.

OpenStreetMap surface tags are incomplete in some regions, so the result is still an estimate. Review and adjust the surface sliders when needed.

No API key is required for the OpenStreetMap-based surface estimate.
