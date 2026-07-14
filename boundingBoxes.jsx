/**
 * boundingBoxes.jsx
 * After Effects 2026 — ExtendScript
 *
 * Generates for all visible layers in the active composition:
 *   - live oriented bounding boxes (shape + expression)
 *   - baked motion paths from Position keyframes (bezier + markers at keyframes)
 *
 * Supports: Text, Shape, Footage (image/video), Precomp, Null.
 * Ignores: Audio, Camera, Light, Adjustment.
 *
 * Limitations:
 *   - Processes only top-level layers in the active composition (not inside precomps).
 *   - For 3D layers, toComp returns a 2D projection through the active camera.
 *   - Trajectories are baked once; re-run the script after editing animation.
 *   - When layer names are duplicated, expressions reference the topmost layer with that name.
 *   - Bounding boxes and trajectories are created in a single precomp inside the active composition.
 */

(function (thisObj) {
    // ─── Settings ────────────────────────────────────────────────────────────
    var BBOX_STROKE_WIDTH = 1;   // bounding box stroke width (px)
    var TRAJ_STROKE_WIDTH = 1;   // trajectory stroke width (px)
    var BBOX_IN_PRECOMP = true;  // bbox and trajectories in a single precomp
    var BBOX_PRECOMP_PREFIX = "BBox Overlay";
    var CROSS_HALF_SIZE = 10; // half length of the '+' cross arm (px)
    var HANDLE_HALF_SIZE = 4; // half side length of bbox handle squares (px)
    var TRAJ_KEYFRAME_SQUARE_HALF = 4; // half side length of motion path keyframe squares (px)
    var BOX_PREFIX = "BBox: ";
    var TRAJ_PREFIX = "Traj: ";
    var GROUP_PREFIX = "BBox Group";
    var GENERATE_TRAJECTORY = true;
    var GROUP_UNDER_NULL = false;
    var USE_LABEL_COLORS = true;
    var SHOW_HANDLES = true;
    var DEBUG_MODE = false;
    var DEFAULT_LAYER_MODE = "all"; // all | selected
    var INCLUDE_TEXT = true;
    var INCLUDE_SHAPE = true;
    var INCLUDE_FOOTAGE = true;
    var INCLUDE_PRECOMP = true;
    var INCLUDE_NULL = true;
    var SOURCE_RECT_INCLUDE_EXTENTS = true;
    var FALLBACK_COLOR = [1, 0.2, 0.2]; // red, visible on any background
    var NULL_DEFAULT_LEFT = -50;
    var NULL_DEFAULT_TOP = -50;
    var NULL_DEFAULT_WIDTH = 100;
    var NULL_DEFAULT_HEIGHT = 100;

    // Standard AE label colors (RGB 0–1), indices 1–16
    var LABEL_COLORS = [
        null,
        [0.8, 0.8, 0.8],
        [0.8, 0.2, 0.2],
        [1.0, 0.55, 0.26],
        [0.2, 0.65, 0.32],
        [0.2, 0.45, 0.9],
        [0.55, 0.35, 0.85],
        [0.95, 0.55, 0.75],
        [0.55, 0.75, 0.25],
        [0.15, 0.55, 0.55],
        [0.65, 0.45, 0.25],
        [0.85, 0.2, 0.55],
        [0.25, 0.7, 0.35],
        [0.75, 0.75, 0.2],
        [0.45, 0.45, 0.75],
        [0.35, 0.35, 0.35],
        [0.15, 0.15, 0.15]
    ];

    // ─── Entry point ─────────────────────────────────────────────────────────
    function defaultOptions() {
        return {
            layerMode: DEFAULT_LAYER_MODE,
            generateTrajectory: GENERATE_TRAJECTORY,
            useLabelColors: USE_LABEL_COLORS,
            showHandles: SHOW_HANDLES,
            debugMode: DEBUG_MODE,
            includeText: INCLUDE_TEXT,
            includeShape: INCLUDE_SHAPE,
            includeFootage: INCLUDE_FOOTAGE,
            includePrecomp: INCLUDE_PRECOMP,
            includeNull: INCLUDE_NULL
        };
    }

    function main(options) {
        options = mergeOptions(defaultOptions(), options || {});

        var comp = app.project.activeItem;

        if (!(comp instanceof CompItem)) {
            alert("Open a composition and run the script again.");
            return;
        }

        var debug = createDebugLog(options.debugMode);

        app.beginUndoGroup("Bounding Boxes");

        try {
            ensureJavaScriptExpressionEngine();

            removeGeneratedLayers(comp);
            debug.log("Cleaned generated layers in " + comp.name);

            var collected = collectTargetLayers(comp, options, debug);
            var targets = collected.targets;
            var stats = collected.stats;

            if (targets.length === 0) {
                alert(
                    "No suitable layers found.\n\n" +
                    "Total in composition: " + stats.total + "\n" +
                    "Disabled: " + stats.disabled + "\n" +
                    "No video / audio only: " + stats.noVideo + "\n" +
                    "Adjustment: " + stats.adjustment + "\n" +
                    "Guide / generated: " + stats.guideOrGenerated
                );
                app.endUndoGroup();
                return;
            }

            var parentNull = GROUP_UNDER_NULL ? createGroupNull(comp) : null;
            var createdLayers = [];
            var bboxLayerCount = 0;
            var trajLayerCount = 0;
            var skipped = 0;
            var errors = [];
            var captured = [];
            var ci;

            for (ci = 0; ci < targets.length; ci++) {
                var src = targets[ci].layer;
                if (!src) {
                    skipped++;
                    continue;
                }
                try {
                    captured.push({
                        info: captureSourceLayerInfo(src, comp, options),
                        color: colorForLayer(src, options),
                        suffix: " #" + targets[ci].index
                    });
                    debug.log("Captured layer #" + targets[ci].index + ": " + targets[ci].name);
                } catch (captureErr) {
                    skipped++;
                    errors.push(targets[ci].name + " [capture]: " + captureErr.toString());
                }
            }

            var overlayTarget = { comp: comp, sourceCompName: null, overlayLayerName: null, precompLayer: null };
            if (BBOX_IN_PRECOMP) {
                var bboxSetup = ensureBBoxPrecomp(comp);
                overlayTarget.comp = bboxSetup.precomp;
                overlayTarget.sourceCompName = comp.name;
                overlayTarget.overlayLayerName = bboxPrecompNameFor(comp);
                overlayTarget.precompLayer = bboxSetup.layer;
                createdLayers.push(bboxSetup.layer);
                debug.log("Created overlay precomp: " + overlayTarget.overlayLayerName);
            }

            for (ci = 0; ci < captured.length; ci++) {
                var entry = captured[ci];
                try {
                    var boxLayer = createBoundingBox(
                        overlayTarget.comp,
                        entry.info,
                        entry.color,
                        entry.suffix,
                        overlayTarget.sourceCompName,
                        overlayTarget.overlayLayerName,
                        options
                    );
                    if (boxLayer) {
                        bboxLayerCount++;
                        if (!BBOX_IN_PRECOMP) {
                            createdLayers.push(boxLayer);
                        }
                        debug.log("Created bbox: " + boxLayer.name);
                    }

                    if (options.generateTrajectory && entry.info.motionPath.vertices.length >= 2) {
                        var trajLayer = createTrajectory(
                            overlayTarget.comp,
                            entry.info,
                            entry.color,
                            entry.suffix
                        );
                        if (trajLayer) {
                            trajLayerCount++;
                            if (!BBOX_IN_PRECOMP) {
                                createdLayers.push(trajLayer);
                            }
                            debug.log("Created trajectory: " + trajLayer.name);
                        }
                    }
                } catch (layerErr) {
                    skipped++;
                    errors.push(entry.info.name + " [create]: " + layerErr.toString());
                }
            }

            if (parentNull) {
                for (var j = 0; j < createdLayers.length; j++) {
                    createdLayers[j].parent = parentNull;
                }
            }

            moveLayersToTop(comp, createdLayers);

            alert(
                "Done.\n\n" +
                "Layers in composition: " + stats.total + "\n" +
                "Suitable targets: " + targets.length + "\n" +
                "Overlay layers created: " + createdLayers.length + "\n" +
                "  — bounding boxes: " + bboxLayerCount +
                (BBOX_IN_PRECOMP ? " (in precomp)" : "") + "\n" +
                "  — trajectories: " + trajLayerCount +
                (BBOX_IN_PRECOMP ? " (in precomp)" : "") + "\n" +
                "Skipped: " + skipped + "\n\n" +
                "Not processed: " + (stats.total - targets.length) + " layers\n" +
                "  — disabled: " + stats.disabled + "\n" +
                "  — audio only / no video: " + stats.noVideo + "\n" +
                "  — adjustment: " + stats.adjustment + "\n" +
                "  — camera/light/guide: " + stats.notAV + "\n" +
                "  — generated BBox: " + stats.guideOrGenerated + "\n" +
                "  — not selected: " + stats.notSelected + "\n" +
                "  — type filter: " + stats.typeFiltered +
                "\n\nOptions:\n" +
                "  — layer mode: " + options.layerMode + "\n" +
                "  — trajectories: " + (options.generateTrajectory ? "on" : "off") +
                (errors.length > 0 ? "\n\nErrors (" + errors.length + "):\n" + errors.slice(0, 5).join("\n") : "")
            );

            debug.flush(errors);
        } catch (e) {
            alert("Error: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
            debug.log("Fatal: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
            debug.flush([e.toString()]);
        }

        app.endUndoGroup();
    }

    function mergeOptions(base, override) {
        for (var key in override) {
            if (override.hasOwnProperty(key)) {
                base[key] = override[key];
            }
        }
        return base;
    }

    function createDebugLog(enabled) {
        var lines = [];
        return {
            log: function (message) {
                if (!enabled) {
                    return;
                }
                var line = "[BBox] " + message;
                lines.push(line);
                try {
                    $.writeln(line);
                } catch (e) {}
            },
            flush: function (errors) {
                if (!enabled) {
                    return;
                }
                var report = lines.join("\n");
                if (errors && errors.length > 0) {
                    report += "\n\nErrors:\n" + errors.join("\n");
                }
                if (report.length === 0) {
                    report = "[BBox] No debug events.";
                }
                alert("BBox Debug Report\n\n" + report.slice(0, 3000));
            }
        };
    }

    // ─── UI ─────────────────────────────────────────────────────────────────
    function isScriptUIPanel(thisObj) {
        try {
            return typeof Panel !== "undefined" && thisObj instanceof Panel;
        } catch (e) {
            return false;
        }
    }

    function openUrl(url) {
        try {
            var command = $.os.toLowerCase().indexOf("windows") >= 0
                ? 'cmd /c start "" "' + url + '"'
                : 'open "' + url + '"';
            system.callSystem(command);
        } catch (e) {
            alert(url);
        }
    }

    function buildUI(thisObj) {
        var win = isScriptUIPanel(thisObj)
            ? thisObj
            : new Window("palette", "Bounding Boxes", undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 8;
        win.margins = 12;

        var modePanel = win.add("panel", undefined, "Layers");
        modePanel.orientation = "column";
        modePanel.alignChildren = ["fill", "top"];
        modePanel.margins = 10;

        var layerMode = modePanel.add("dropdownlist", undefined, [
            "All eligible layers",
            "Selected layers only"
        ]);
        layerMode.selection = DEFAULT_LAYER_MODE === "selected" ? 1 : 0;

        var typesGroup = modePanel.add("group");
        typesGroup.orientation = "column";
        typesGroup.alignChildren = ["left", "top"];
        var textCheck = typesGroup.add("checkbox", undefined, "Text");
        var shapeCheck = typesGroup.add("checkbox", undefined, "Shape");
        var footageCheck = typesGroup.add("checkbox", undefined, "Footage");
        var precompCheck = typesGroup.add("checkbox", undefined, "Precomp");
        var nullCheck = typesGroup.add("checkbox", undefined, "Null");
        textCheck.value = INCLUDE_TEXT;
        shapeCheck.value = INCLUDE_SHAPE;
        footageCheck.value = INCLUDE_FOOTAGE;
        precompCheck.value = INCLUDE_PRECOMP;
        nullCheck.value = INCLUDE_NULL;

        var optionsPanel = win.add("panel", undefined, "Overlay");
        optionsPanel.orientation = "column";
        optionsPanel.alignChildren = ["left", "top"];
        optionsPanel.margins = 10;

        var trajectoriesCheck = optionsPanel.add("checkbox", undefined, "Show trajectories");
        var handlesCheck = optionsPanel.add("checkbox", undefined, "Show handles");
        var labelColorsCheck = optionsPanel.add("checkbox", undefined, "Use label colors");
        var debugCheck = optionsPanel.add("checkbox", undefined, "Debug report");
        trajectoriesCheck.value = GENERATE_TRAJECTORY;
        handlesCheck.value = SHOW_HANDLES;
        labelColorsCheck.value = USE_LABEL_COLORS;
        debugCheck.value = DEBUG_MODE;

        var actions = win.add("group");
        actions.orientation = "row";
        actions.alignChildren = ["right", "center"];
        var generateBtn = actions.add("button", undefined, "Generate");
        var closeBtn = actions.add("button", undefined, "Close");

        var authorPanel = win.add("panel", undefined, "Author");
        authorPanel.orientation = "column";
        authorPanel.alignChildren = ["fill", "top"];
        authorPanel.margins = 10;

        authorPanel.add("statictext", undefined, "Michael Mohonov");
        var authorLinks = authorPanel.add("group");
        authorLinks.orientation = "row";
        authorLinks.alignChildren = ["left", "center"];
        var telegramBtn = authorLinks.add("button", undefined, "Telegram");
        var githubBtn = authorLinks.add("button", undefined, "GitHub");

        generateBtn.onClick = function () {
            main({
                layerMode: layerMode.selection && layerMode.selection.index === 1 ? "selected" : "all",
                generateTrajectory: trajectoriesCheck.value,
                useLabelColors: labelColorsCheck.value,
                showHandles: handlesCheck.value,
                debugMode: debugCheck.value,
                includeText: textCheck.value,
                includeShape: shapeCheck.value,
                includeFootage: footageCheck.value,
                includePrecomp: precompCheck.value,
                includeNull: nullCheck.value
            });
        };

        closeBtn.onClick = function () {
            if (win instanceof Window) {
                win.close();
            }
        };

        telegramBtn.onClick = function () {
            openUrl("https://t.me/mohonovschannel");
        };

        githubBtn.onClick = function () {
            openUrl("https://github.com/MohonovProduction/bounding-box__AE");
        };

        win.onResizing = win.onResize = function () {
            this.layout.resize();
        };

        return win;
    }

    function showUI(thisObj) {
        var win = buildUI(thisObj);
        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.layout(true);
            win.layout.resize();
        }
    }

    // ─── Filtering and cleanup ───────────────────────────────────────────────
    function safeGetLayer(comp, index) {
        try {
            if (!comp || index < 1 || index > comp.numLayers) {
                return null;
            }
            return comp.layer(index);
        } catch (e) {
            return null;
        }
    }

    function isGeneratedLayer(layer) {
        try {
            if (!layer) {
                return false;
            }
            var name = layer.name;
            return (
                name.indexOf(BOX_PREFIX) === 0 ||
                name.indexOf(TRAJ_PREFIX) === 0 ||
                name === GROUP_PREFIX ||
                name.indexOf(BBOX_PRECOMP_PREFIX) === 0
            );
        } catch (e) {
            return false;
        }
    }

    function bboxPrecompNameFor(comp) {
        return BBOX_PRECOMP_PREFIX + ": " + comp.name;
    }

    function isNullLayer(layer) {
        try {
            return layer.nullLayer === true;
        } catch (e) {
            return false;
        }
    }

    function isTextLayer(layer) {
        try {
            return layer.property("ADBE Text Properties") !== null;
        } catch (e) {
            return false;
        }
    }

    function isShapeLayer(layer) {
        try {
            return layer.property("ADBE Root Vectors Group") !== null &&
                layer.property("ADBE Text Properties") === null;
        } catch (e) {
            return false;
        }
    }

    function isAdjustmentLayer(layer) {
        try {
            return layer.adjustmentLayer === true;
        } catch (e) {
            return false;
        }
    }

    function isPrecompLayer(layer) {
        try {
            return layer.source instanceof CompItem;
        } catch (e) {
            return false;
        }
    }

    function isFootageLayer(layer) {
        try {
            return layer.source instanceof FootageItem;
        } catch (e) {
            return false;
        }
    }

    function isLayerSelected(layer) {
        try {
            return layer.selected === true;
        } catch (e) {
            return false;
        }
    }

    function layerMatchesTypeOptions(layer, options) {
        if (isNullLayer(layer)) {
            return options.includeNull;
        }
        if (isTextLayer(layer)) {
            return options.includeText;
        }
        if (isShapeLayer(layer)) {
            return options.includeShape;
        }
        if (isPrecompLayer(layer)) {
            return options.includePrecomp;
        }
        if (isFootageLayer(layer)) {
            return options.includeFootage;
        }
        return options.includeFootage;
    }

    function isCameraOrLight(layer) {
        try {
            if (typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) {
                return true;
            }
            if (typeof LightLayer !== "undefined" && layer instanceof LightLayer) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    function isAudioOnly(layer) {
        try {
            if (isNullLayer(layer)) {
                return false;
            }
            if (layer.hasVideo) {
                return false;
            }
            if (isTextLayer(layer) || isShapeLayer(layer)) {
                return false;
            }
            return layer.hasAudio === true;
        } catch (e) {
            return false;
        }
    }

    function collectTargetLayers(comp, options, debug) {
        var result = [];
        var stats = {
            total: comp.numLayers,
            disabled: 0,
            noVideo: 0,
            notAV: 0,
            guideOrGenerated: 0,
            adjustment: 0,
            typeFiltered: 0,
            notSelected: 0
        };

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (!layer) {
                continue;
            }

            if (isGeneratedLayer(layer)) {
                stats.guideOrGenerated++;
                continue;
            }
            if (!layer.enabled) {
                stats.disabled++;
                debug.log("Skipped disabled layer #" + i + ": " + layer.name);
                continue;
            }
            if (layer.guideLayer) {
                stats.guideOrGenerated++;
                debug.log("Skipped guide layer #" + i + ": " + layer.name);
                continue;
            }
            if (isCameraOrLight(layer)) {
                stats.notAV++;
                debug.log("Skipped camera/light #" + i + ": " + layer.name);
                continue;
            }
            if (isAdjustmentLayer(layer)) {
                stats.adjustment++;
                debug.log("Skipped adjustment layer #" + i + ": " + layer.name);
                continue;
            }
            if (isAudioOnly(layer)) {
                stats.noVideo++;
                debug.log("Skipped audio-only layer #" + i + ": " + layer.name);
                continue;
            }
            if (options.layerMode === "selected" && !isLayerSelected(layer)) {
                stats.notSelected++;
                continue;
            }
            if (!layerMatchesTypeOptions(layer, options)) {
                stats.typeFiltered++;
                debug.log("Skipped by type filter #" + i + ": " + layer.name);
                continue;
            }

            result.push({
                index: i,
                name: layer.name,
                layer: layer
            });
            debug.log("Accepted layer #" + i + ": " + layer.name);
        }

        return { targets: result, stats: stats };
    }

    function removeGeneratedLayers(comp) {
        removeBBoxPrecomp(comp);

        var namesToRemove = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (layer && isGeneratedLayer(layer)) {
                namesToRemove.push(layer.name);
            }
        }
        for (var j = 0; j < namesToRemove.length; j++) {
            var target = findLayerByName(comp, namesToRemove[j]);
            if (target) {
                try {
                    target.remove();
                } catch (e) {}
            }
        }
    }

    function removeBBoxPrecomp(comp) {
        var precompName = bboxPrecompNameFor(comp);
        var layer = findLayerByName(comp, precompName);
        if (layer) {
            try {
                var source = layer.source;
                layer.remove();
                if (source instanceof CompItem && source.name === precompName) {
                    source.remove();
                }
            } catch (e) {}
        }

        for (var i = app.project.numItems; i >= 1; i--) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === precompName && item !== comp) {
                try {
                    item.remove();
                } catch (e) {}
            }
        }
    }

    function ensureBBoxPrecomp(mainComp) {
        removeBBoxPrecomp(mainComp);

        var precompName = bboxPrecompNameFor(mainComp);
        var precomp = app.project.items.addComp(
            precompName,
            mainComp.width,
            mainComp.height,
            mainComp.pixelAspect,
            mainComp.duration,
            mainComp.frameRate
        );

        var layer = mainComp.layers.add(precomp);
        layer.name = precompName;
        layer.label = 9;
        layer.startTime = 0;
        layer.inPoint = 0;
        layer.outPoint = mainComp.duration;

        var transform = layer.property("ADBE Transform Group");
        transform.property("ADBE Anchor Point").setValue([0, 0]);
        transform.property("ADBE Position").setValue([0, 0]);
        transform.property("ADBE Scale").setValue([100, 100]);
        transform.property("ADBE Rotate Z").setValue(0);

        return { precomp: precomp, layer: layer };
    }

    function findLayerByName(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (layer && layer.name === name) {
                return layer;
            }
        }
        return null;
    }

    // ─── Colors ──────────────────────────────────────────────────────────────
    function captureSourceLayerInfo(sourceLayer, comp, options) {
        var motionPath = { vertices: [], inTangents: [], outTangents: [], keyframePoints: [] };
        if (options.generateTrajectory) {
            try {
                motionPath = collectMotionPathData(sourceLayer);
            } catch (e) {
                motionPath = { vertices: [], inTangents: [], outTangents: [], keyframePoints: [] };
            }
        }

        return {
            name: sourceLayer.name,
            label: safeLayerLabel(sourceLayer),
            startTime: sourceLayer.startTime,
            inPoint: sourceLayer.inPoint,
            outPoint: sourceLayer.outPoint,
            stretch: safeLayerStretch(sourceLayer),
            enabled: sourceLayer.enabled,
            motionPath: motionPath
        };
    }

    function safeLayerLabel(layer) {
        try {
            return layer.label;
        } catch (e) {
            return 1;
        }
    }

    function safeLayerStretch(layer) {
        try {
            return layer.stretch;
        } catch (e) {
            return 100;
        }
    }

    function applyLayerTiming(targetLayer, info) {
        targetLayer.startTime = info.startTime;
        targetLayer.inPoint = info.inPoint;
        targetLayer.outPoint = info.outPoint;
        try {
            targetLayer.stretch = info.stretch;
        } catch (e) {}
        try {
            targetLayer.enabled = info.enabled;
        } catch (e) {}
    }

    function colorForLayer(layer, options) {
        if (!options.useLabelColors) {
            return FALLBACK_COLOR;
        }
        var idx = layer.label;
        if (idx >= 1 && idx < LABEL_COLORS.length && LABEL_COLORS[idx]) {
            return LABEL_COLORS[idx];
        }
        return FALLBACK_COLOR;
    }

    // ─── Bounding Box (live, expression) ─────────────────────────────────────
    function createBoundingBox(comp, info, color, uniqueSuffix, sourceCompName, overlayLayerName, options) {
        var layerName = BOX_PREFIX + info.name + uniqueSuffix;
        var setup = createBBoxShapeLayer(comp, layerName, info.label, color, options);

        var expressions = buildBBoxExpressions(info.name, sourceCompName, overlayLayerName);
        for (var oi = 0; oi < expressions.length; oi++) {
            setPathExpression(setup.outlinePaths[oi], expressions[oi]);
        }

        if (options.showHandles) {
            var handleExpressions = buildHandleExpressions(info.name, sourceCompName, overlayLayerName);
            for (var hi = 0; hi < handleExpressions.length; hi++) {
                setPathExpression(setup.handlePaths[hi], handleExpressions[hi]);
            }
        }

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function layerRefSnippet(safeName, sourceCompName, overlayLayerName) {
        if (sourceCompName && overlayLayerName) {
            var safeComp = escapeForExpression(sourceCompName);
            var safeOverlay = escapeForExpression(overlayLayerName);
            return [
                'var main = comp("' + safeComp + '");',
                'var overlay = main.layer("' + safeOverlay + '");',
                'var L = main.layer("' + safeName + '");'
            ];
        }
        return ['var L = thisComp.layer("' + safeName + '");'];
    }

    function compPointSnippet(pointExpr, sourceCompName, overlayLayerName) {
        if (sourceCompName && overlayLayerName) {
            return 'overlay.fromComp(' + pointExpr + ')';
        }
        return 'fromComp(' + pointExpr + ')';
    }

    function bboxCornersSnippet(safeName, sourceCompName, overlayLayerName) {
        var toLocal = function (pointExpr) {
            return compPointSnippet(pointExpr, sourceCompName, overlayLayerName);
        };

        return layerRefSnippet(safeName, sourceCompName, overlayLayerName).concat([
            "function bboxToComp(x, y) {",
            "    return L.threeDLayer ? L.toComp([x, y, 0]) : L.toComp([x, y]);",
            "}",
            "var r = L.sourceRectAtTime(time, " + (SOURCE_RECT_INCLUDE_EXTENTS ? "true" : "false") + ");",
            "var ok = r.width > 0 && r.height > 0;",
            "if (!ok && L.nullLayer) {",
            "    r = { left: " + NULL_DEFAULT_LEFT + ", top: " + NULL_DEFAULT_TOP +
                ", width: " + NULL_DEFAULT_WIDTH + ", height: " + NULL_DEFAULT_HEIGHT + " };",
            "    ok = true;",
            "}",
            "var tl = ok ? " + toLocal("bboxToComp(r.left, r.top)") + " : [0, 0];",
            "var tr = ok ? " + toLocal("bboxToComp(r.left + r.width, r.top)") + " : [0, 0];",
            "var br = ok ? " + toLocal("bboxToComp(r.left + r.width, r.top + r.height)") + " : [0, 0];",
            "var bl = ok ? " + toLocal("bboxToComp(r.left, r.top + r.height)") + " : [0, 0];"
        ]);
    }

    function bboxAxesSnippet() {
        return [
            "var ax = [tr[0] - tl[0], tr[1] - tl[1]];",
            "var axLen = length(ax);",
            "if (axLen > 0) ax = [ax[0] / axLen, ax[1] / axLen]; else ax = [1, 0];",
            "var ay = [bl[0] - tl[0], bl[1] - tl[1]];",
            "var ayLen = length(ay);",
            "if (ayLen > 0) ay = [ay[0] / ayLen, ay[1] / ayLen]; else ay = [0, 1];",
            "var hs = " + HANDLE_HALF_SIZE + ";"
        ];
    }

    function buildBBoxExpressions(sourceLayerName, sourceCompName, overlayLayerName) {
        var safeName = escapeForExpression(sourceLayerName);
        var corners = bboxCornersSnippet(safeName, sourceCompName, overlayLayerName);
        var crossH = CROSS_HALF_SIZE;

        var rectExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    createPath([tl, tr, br, bl], [], [], true);",
            "}"
        ]);

        var triangleExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var apex = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];",
            "    createPath([apex, br, bl], [], [], true);",
            "}"
        ]);

        var crossHExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var c = [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4];",
            "    var ax = [tr[0] - tl[0], tr[1] - tl[1]];",
            "    var axLen = length(ax);",
            "    if (axLen > 0) ax = [ax[0] / axLen, ax[1] / axLen]; else ax = [1, 0];",
            "    var ch = " + crossH + ";",
            "    createPath([",
            "        [c[0] - ax[0] * ch, c[1] - ax[1] * ch],",
            "        [c[0] + ax[0] * ch, c[1] + ax[1] * ch]",
            "    ], [], [], false);",
            "}"
        ]);

        var crossVExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var c = [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4];",
            "    var ay = [bl[0] - tl[0], bl[1] - tl[1]];",
            "    var ayLen = length(ay);",
            "    if (ayLen > 0) ay = [ay[0] / ayLen, ay[1] / ayLen]; else ay = [0, 1];",
            "    var ch = " + crossH + ";",
            "    createPath([",
            "        [c[0] - ay[0] * ch, c[1] - ay[1] * ch],",
            "        [c[0] + ay[0] * ch, c[1] + ay[1] * ch]",
            "    ], [], [], false);",
            "}"
        ]);

        return [
            rectExpr.join("\n"),
            triangleExpr.join("\n"),
            crossHExpr.join("\n"),
            crossVExpr.join("\n")
        ];
    }

    function buildHandleExpressions(sourceLayerName, sourceCompName, overlayLayerName) {
        var safeName = escapeForExpression(sourceLayerName);
        var prefix = bboxCornersSnippet(safeName, sourceCompName, overlayLayerName).concat(bboxAxesSnippet());
        var pointDefs = [
            "var p = tl;",
            "var p = tr;",
            "var p = br;",
            "var p = bl;",
            "var p = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];",
            "var p = [(tr[0] + br[0]) / 2, (tr[1] + br[1]) / 2];",
            "var p = [(bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2];",
            "var p = [(tl[0] + bl[0]) / 2, (tl[1] + bl[1]) / 2];"
        ];
        var squareBody = [
            "    createPath([",
            "        [p[0] - ax[0] * hs - ay[0] * hs, p[1] - ax[1] * hs - ay[1] * hs],",
            "        [p[0] + ax[0] * hs - ay[0] * hs, p[1] + ax[1] * hs - ay[1] * hs],",
            "        [p[0] + ax[0] * hs + ay[0] * hs, p[1] + ax[1] * hs + ay[1] * hs],",
            "        [p[0] - ax[0] * hs + ay[0] * hs, p[1] - ax[1] * hs + ay[1] * hs]",
            "    ], [], [], true);"
        ];
        var result = [];

        for (var i = 0; i < pointDefs.length; i++) {
            result.push(prefix.concat([
                "if (!ok) {",
                "    createPath([[0, 0]], [], [], false);",
                "} else {",
                pointDefs[i]
            ]).concat(squareBody).concat(["}"]).join("\n"));
        }

        return result;
    }

    // ─── Trajectory (motion path from Position keyframes) ────────────────────
    function createTrajectory(comp, info, color, uniqueSuffix) {
        var motionPath = info.motionPath;
        var markerCount = motionPath.keyframePoints.length;
        var layerName = TRAJ_PREFIX + info.name + uniqueSuffix;
        var setup = createTrajectoryShapeLayer(comp, layerName, info.label, color, markerCount);

        setup.path.setValue(buildMotionPathShape(motionPath));

        for (var mi = 0; mi < markerCount; mi++) {
            setup.markerPaths[mi].setValue(
                buildKeyframeSquareShape(motionPath.keyframePoints[mi], TRAJ_KEYFRAME_SQUARE_HALF)
            );
        }

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function getPositionPropertyInfo(layer) {
        var transform = layer.property("ADBE Transform Group");
        var pos = transform.property("ADBE Position");

        try {
            if (pos.dimensionsSeparated) {
                return {
                    separated: true,
                    props: [
                        transform.property("ADBE Position_0"),
                        transform.property("ADBE Position_1")
                    ]
                };
            }
        } catch (e) {}

        return { separated: false, pos: pos };
    }

    function isSpatialPosition(posInfo) {
        if (posInfo.separated) {
            return false;
        }
        try {
            if (posInfo.pos.isSpatial) {
                return true;
            }
            var pvt = posInfo.pos.propertyValueType;
            return (
                pvt === PropertyValueType.TwoD_SPATIAL ||
                pvt === PropertyValueType.ThreeD_SPATIAL
            );
        } catch (e) {
            return false;
        }
    }

    function collectPositionKeyframeTimes(layer) {
        var posInfo = getPositionPropertyInfo(layer);
        var props = posInfo.separated ? posInfo.props : [posInfo.pos];
        var timeMap = {};
        var times = [];
        var pi;
        var k;

        for (pi = 0; pi < props.length; pi++) {
            var prop = props[pi];
            if (!prop || prop.numKeys === 0) {
                continue;
            }
            for (k = 1; k <= prop.numKeys; k++) {
                var keyTime = prop.keyTime(k);
                if (keyTime >= layer.inPoint - 0.0001 && keyTime <= layer.outPoint + 0.0001) {
                    var key = keyTime.toFixed(6);
                    if (!timeMap[key]) {
                        timeMap[key] = keyTime;
                        times.push(keyTime);
                    }
                }
            }
        }

        times.sort(function (a, b) {
            return a - b;
        });

        return { times: times, posInfo: posInfo };
    }

    function compTangentFromLayerSpatial(layer, time, keyIndex, posInfo, direction) {
        var pos = posInfo.pos;
        var layerPos = pos.keyValue(keyIndex);
        var px = layerPos[0];
        var py = layerPos[1];
        var tangent;

        if (direction === "out") {
            tangent = pos.keyOutSpatialTangent(keyIndex);
        } else {
            tangent = pos.keyInSpatialTangent(keyIndex);
        }

        var compBase = transformPointToComp(layer, [px, py], time);
        var compTip = transformPointToComp(layer, [px + tangent[0], py + tangent[1]], time);
        return [compTip[0] - compBase[0], compTip[1] - compBase[1]];
    }

    function collectMotionPathData(layer) {
        var empty = {
            vertices: [],
            inTangents: [],
            outTangents: [],
            keyframePoints: []
        };
        var collected = collectPositionKeyframeTimes(layer);
        var times = collected.times;
        var posInfo = collected.posInfo;
        var spatial = isSpatialPosition(posInfo);
        var vertices = [];
        var inTangents = [];
        var outTangents = [];
        var keyframePoints = [];
        var i;

        for (i = 0; i < times.length; i++) {
            var t = times[i];
            var vtx = layerAnchorToComp(layer, t);
            if (!vtx) {
                continue;
            }

            vertices.push(vtx);
            keyframePoints.push(vtx);

            var inTan = [0, 0];
            var outTan = [0, 0];

            if (spatial) {
                var keyIndex = posInfo.pos.nearestKeyIndex(t);
                if (Math.abs(posInfo.pos.keyTime(keyIndex) - t) < 0.0001) {
                    try {
                        inTan = compTangentFromLayerSpatial(layer, t, keyIndex, posInfo, "in");
                        outTan = compTangentFromLayerSpatial(layer, t, keyIndex, posInfo, "out");
                    } catch (e) {}
                }
            }

            inTangents.push(inTan);
            outTangents.push(outTan);
        }

        if (vertices.length < 2) {
            return empty;
        }

        return {
            vertices: vertices,
            inTangents: inTangents,
            outTangents: outTangents,
            keyframePoints: keyframePoints
        };
    }

    function buildMotionPathShape(motionPath) {
        var shape = new Shape();
        shape.vertices = motionPath.vertices;
        shape.inTangents = motionPath.inTangents;
        shape.outTangents = motionPath.outTangents;
        shape.closed = false;
        return shape;
    }

    function buildKeyframeSquareShape(center, half) {
        var x = center[0];
        var y = center[1];
        var h = half;
        var shape = new Shape();
        shape.vertices = [
            [x - h, y - h],
            [x + h, y - h],
            [x + h, y + h],
            [x - h, y + h]
        ];
        shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        shape.closed = true;
        return shape;
    }

    function createTrajectoryShapeLayer(comp, layerName, label, color, markerCount) {
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = layerName;
        shapeLayer.label = label;
        shapeLayer.threeDLayer = false;

        var root = shapeLayer.property("ADBE Root Vectors Group");

        var pathGroup = root.addProperty("ADBE Vector Group");
        var pathContents = pathGroup.property("ADBE Vectors Group");
        addPathsToGroup(pathContents, 1);
        addStrokeToGroup(pathContents, color, TRAJ_STROKE_WIDTH);

        var markerPaths = [];
        if (markerCount > 0) {
            var markerGroup = root.addProperty("ADBE Vector Group");
            var markerContents = markerGroup.property("ADBE Vectors Group");
            addPathsToGroup(markerContents, markerCount);
            addStrokeToGroup(markerContents, color, TRAJ_STROKE_WIDTH);
            markerPaths = getFreshPathsInGroup(shapeLayer, 2, markerCount);
        }

        zeroTransform(shapeLayer);

        return {
            layer: shapeLayer,
            path: getFreshPathsInGroup(shapeLayer, 1, 1)[0],
            markerPaths: markerPaths
        };
    }

    function addPathsToGroup(groupContents, count) {
        for (var p = 0; p < count; p++) {
            groupContents.addProperty("ADBE Vector Shape - Group");
        }
    }

    function addStrokeToGroup(groupContents, color, strokeWidth) {
        var stroke = groupContents.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("ADBE Vector Stroke Color").setValue(color);
        stroke.property("ADBE Vector Stroke Width").setValue(strokeWidth);

        var fill = groupContents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Opacity").setValue(0);
    }

    function createBBoxShapeLayer(comp, layerName, label, color, options) {
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = layerName;
        shapeLayer.label = label;
        shapeLayer.threeDLayer = false;

        var root = shapeLayer.property("ADBE Root Vectors Group");

        var outlineGroup = root.addProperty("ADBE Vector Group");
        var outlineContents = outlineGroup.property("ADBE Vectors Group");
        addPathsToGroup(outlineContents, 4);
        addStrokeToGroup(outlineContents, color, BBOX_STROKE_WIDTH);

        var handlePaths = [];
        if (options.showHandles) {
            var handlesGroup = root.addProperty("ADBE Vector Group");
            var handlesContents = handlesGroup.property("ADBE Vectors Group");
            addPathsToGroup(handlesContents, 8);
            addStrokeToGroup(handlesContents, color, BBOX_STROKE_WIDTH);
            handlePaths = getFreshPathsInGroup(shapeLayer, 2, 8);
        }

        zeroTransform(shapeLayer);

        return {
            layer: shapeLayer,
            outlinePaths: getFreshPathsInGroup(shapeLayer, 1, 4),
            handlePaths: handlePaths
        };
    }

    function getFreshPathAt(shapeLayer, groupIndex, pathIndex) {
        var root = shapeLayer.property("ADBE Root Vectors Group");
        var group = root.property(groupIndex);
        var gc = group.property("ADBE Vectors Group");
        var found = 0;

        for (var i = 1; i <= gc.numProperties; i++) {
            var prop = gc.property(i);
            if (prop.matchName === "ADBE Vector Shape - Group") {
                if (found === pathIndex) {
                    return prop.property("ADBE Vector Shape");
                }
                found++;
            }
        }

        return null;
    }

    function getFreshPathsInGroup(shapeLayer, groupIndex, count) {
        var paths = [];
        for (var i = 0; i < count; i++) {
            var pathProp = getFreshPathAt(shapeLayer, groupIndex, i);
            if (!pathProp) {
                throw new Error("Path property not found at group " + groupIndex + ", index " + i);
            }
            paths.push(pathProp);
        }
        return paths;
    }

    function layerAnchorToComp(layer, time) {
        try {
            var anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point").valueAtTime(time, false);
            var point = layer.threeDLayer ? [anchor[0], anchor[1], anchor[2] || 0] : [anchor[0], anchor[1]];
            if (typeof layer.toComp === "function") {
                return layer.toComp(point, time);
            }
            return transformPointToComp(layer, point, time);
        } catch (e) {
            return null;
        }
    }

    function transformPointToComp(layer, point, time) {
        var current = layer;
        var x = point[0];
        var y = point[1];

        while (current) {
            var t = current.property("ADBE Transform Group");
            var ap = t.property("ADBE Anchor Point").valueAtTime(time, false);
            var pos = t.property("ADBE Position").valueAtTime(time, false);
            var scale = t.property("ADBE Scale").valueAtTime(time, false);
            var rot = t.property("ADBE Rotate Z").valueAtTime(time, false);
            var rad = rot * Math.PI / 180;
            var cos = Math.cos(rad);
            var sin = Math.sin(rad);
            var sx = scale[0] / 100;
            var sy = scale[1] / 100;

            x -= ap[0];
            y -= ap[1];
            x *= sx;
            y *= sy;
            var rx = x * cos - y * sin;
            var ry = x * sin + y * cos;
            x = rx + pos[0];
            y = ry + pos[1];

            current = current.parent;
        }

        return [x, y];
    }

    // ─── Utilities ───────────────────────────────────────────────────────────
    function ensureJavaScriptExpressionEngine() {
        try {
            if (app.project.expressionEngine !== "javascript-1.0") {
                app.project.expressionEngine = "javascript-1.0";
            }
        } catch (e) {
            // older AE versions — continue with the current engine
        }
    }

    function setPathExpression(pathProperty, expr) {
        var placeholder = new Shape();
        placeholder.vertices = [[0, 0], [10, 0], [10, 10], [0, 10]];
        placeholder.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        placeholder.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        placeholder.closed = true;
        pathProperty.setValue(placeholder);
        pathProperty.expression = expr;
    }

    function zeroTransform(layer) {
        var transform = layer.property("ADBE Transform Group");
        transform.property("ADBE Anchor Point").setValue([0, 0]);
        transform.property("ADBE Position").setValue([0, 0]);
        transform.property("ADBE Scale").setValue([100, 100]);
        transform.property("ADBE Rotate Z").setValue(0);
        transform.property("ADBE Opacity").setValue(100);
    }

    function moveLayersToTop(comp, layers) {
        for (var i = layers.length - 1; i >= 0; i--) {
            if (layers[i]) {
                layers[i].moveToBeginning();
            }
        }
    }

    function createGroupNull(comp) {
        var nullLayer = comp.layers.addNull();
        nullLayer.name = GROUP_PREFIX;
        nullLayer.label = 9;
        return nullLayer;
    }

    function escapeForExpression(name) {
        return name
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
    }

    showUI(thisObj);
})(this);
