# Bounding Boxes for After Effects

An ExtendScript utility for **Adobe After Effects** that automatically generates visual overlays for layers in the active composition.

## What it does

For every eligible visible layer, the script creates:

- **Live oriented bounding boxes** — shape layers driven by expressions that follow each layer's bounds in real time, with corner handles and a center crosshair
- **Baked motion paths** — Bezier trajectories from Position keyframes, with square markers at keyframe points

All overlays are grouped into a single **BBox Overlay** precomp inside the active composition, keeping the main timeline clean.

## Supported layers

| Included | Excluded |
|----------|----------|
| Text | Audio |
| Shape | Camera |
| Footage (image/video) | Light |
| Precomp | Adjustment |
| Null | |

## Features

- Bounding boxes update live via expressions
- Motion paths include spatial tangents and keyframe markers
- Colors match layer label colors (configurable)
- Cleans up previously generated overlays on re-run
- Summary dialog with layer statistics after execution

## Requirements

- Adobe After Effects (tested with AE 2026)
- An open composition with at least one suitable layer

## Installation

1. Download or clone this repository.
2. Copy `boundingBoxes.jsx` to your After Effects Scripts folder, or keep it anywhere on disk.

**Default Scripts folder:**

- **macOS:** `/Applications/Adobe After Effects <version>/Scripts/`
- **Windows:** `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\`

## Usage

1. Open a composition in After Effects.
2. Run the script:
   - **File → Scripts → Run Script File…** — if the file is not in the Scripts folder
   - **File → Scripts → boundingBoxes** — if installed in the Scripts folder
3. Choose the overlay settings in the **Bounding Boxes** panel.
4. Click **Generate**. The script removes old generated layers, builds new overlays, and shows a summary dialog.

Re-run the script whenever you need to refresh overlays after editing layer animation or bounds.

For a dockable panel workflow, place `boundingBoxes.jsx` in the After Effects `ScriptUI Panels` folder and open it from the **Window** menu.

## Configuration

Edit the constants at the top of `boundingBoxes.jsx`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BBOX_STROKE_WIDTH` | `1` | Bounding box stroke width (px) |
| `TRAJ_STROKE_WIDTH` | `1` | Trajectory stroke width (px) |
| `BBOX_IN_PRECOMP` | `true` | Place overlays in a dedicated precomp |
| `GENERATE_TRAJECTORY` | `true` | Generate motion path overlays |
| `USE_LABEL_COLORS` | `true` | Match overlay color to layer label |
| `SHOW_HANDLES` | `true` | Show corner and edge handles on bounding boxes |
| `DEBUG_MODE` | `false` | Print debug events to the JavaScript console and show a debug report |
| `DEFAULT_LAYER_MODE` | `all` | Default UI layer mode: `all` or `selected` |
| `SOURCE_RECT_INCLUDE_EXTENTS` | `true` | Use source rect extents for shape/text bounds |
| `FALLBACK_COLOR` | red | Color when label colors are disabled |
| `CROSS_HALF_SIZE` | `10` | Half length of the center cross arm (px) |
| `HANDLE_HALF_SIZE` | `4` | Half side length of bbox handle squares (px) |
| `TRAJ_KEYFRAME_SQUARE_HALF` | `4` | Half side length of keyframe markers (px) |
| `GROUP_UNDER_NULL` | `false` | Parent all generated layers under a null |

## Panel options

- **All eligible layers / Selected layers only** — choose whether to scan the whole composition or only selected layers
- **Layer type filters** — include or exclude Text, Shape, Footage, Precomp, and Null layers
- **Show trajectories** — bake Position keyframe paths into shape layers
- **Show handles** — draw corner and edge handles around each bounding box
- **Use label colors** — match overlay strokes to AE label colors
- **Debug report** — show the accepted/skipped layer log after generation
- **Author** — quick links to [Telegram](https://t.me/mohonovschannel) and [GitHub](https://github.com/MohonovProduction/bounding-box__AE)

## Limitations

- Processes **top-level layers only** — layers inside precomps are not processed
- **3D layers** are projected to 2D via the active camera (`toComp`). Regular 3D layers use `[x, y, 0]` layer-space points; imported 3D/model layers may still expose incomplete `sourceRectAtTime` bounds through AE scripting.
- Motion paths are **baked once** — re-run the script after editing Position animation
- Duplicate layer names: expressions reference the **topmost** layer with that name

## How it works

1. Scans all top-level layers in the active composition and filters out unsuitable ones.
2. Removes any previously generated BBox / trajectory layers and overlay precomp.
3. Creates a **BBox Overlay** precomp (when enabled) and adds shape layers for each target.
4. Applies expressions to bounding boxes so they track `sourceRectAtTime` and layer transforms.
5. Bakes motion path geometry from Position keyframes with spatial tangents.

## License

This project is licensed under the [MIT License](LICENSE).
