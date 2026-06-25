/**
 * boundingBoxes.jsx
 * After Effects 2026 — ExtendScript
 *
 * Генерирует для всех видимых слоёв активной композиции:
 *   - живые ориентированные bounding box (shape + expression)
 *   - запечённые траектории движения anchor point (покадровый сэмплинг)
 *
 * Поддерживает: Text, Shape, Footage (image/video), Precomp, Null.
 * Игнорирует: Audio, Camera, Light, Adjustment.
 *
 * Ограничения:
 *   - Обрабатывает только слои верхнего уровня активной композиции (не внутри precomp).
 *   - Для 3D-слоёв toComp даёт 2D-проекцию через активную камеру.
 *   - Траектория запекается один раз; при правке анимации перезапустите скрипт.
 *   - При дублирующихся именах слоёв expression ссылается на верхний слой с таким именем.
 *   - Повторный запуск удаляет ранее созданные слои с префиксами BBox:/Traj:.
 */

(function () {
    // ─── Настройки ───────────────────────────────────────────────────────────
    var STROKE_WIDTH = 3;
    var BOX_PREFIX = "BBox: ";
    var TRAJ_PREFIX = "Traj: ";
    var GROUP_PREFIX = "BBox Group";
    var GENERATE_TRAJECTORY = true;
    var GROUP_UNDER_NULL = false;
    var USE_LABEL_COLORS = true;
    var FALLBACK_COLOR = [1, 0.2, 0.2]; // красный, хорошо виден на любом фоне
    var NULL_BOX_HALF_SIZE = 15; // половина стороны маркера вокруг anchor null-слоя (px)

    // Стандартные цвета меток AE (RGB 0–1), индексы 1–16
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

    // ─── Точка входа ─────────────────────────────────────────────────────────
    function main() {
        var comp = app.project.activeItem;

        if (!(comp instanceof CompItem)) {
            alert("Откройте композицию и запустите скрипт снова.");
            return;
        }

        app.beginUndoGroup("Bounding Boxes");

        try {
            ensureJavaScriptExpressionEngine();

            removeGeneratedLayers(comp);

            var collected = collectTargetLayers(comp);
            var targets = collected.targets;
            var stats = collected.stats;

            if (targets.length === 0) {
                alert(
                    "Нет подходящих слоёв.\n\n" +
                    "Всего в композиции: " + stats.total + "\n" +
                    "Отключены: " + stats.disabled + "\n" +
                    "Без видео (audio/adjustment): " + stats.noVideo + "\n" +
                    "Guide / служебные: " + stats.guideOrGenerated
                );
                app.endUndoGroup();
                return;
            }

            var parentNull = GROUP_UNDER_NULL ? createGroupNull(comp) : null;
            var createdLayers = [];
            var skipped = 0;
            var errors = [];

            var captured = [];
            var ci;

            for (ci = 0; ci < targets.length; ci++) {
                var src = safeGetLayer(comp, targets[ci].index);
                if (!src) {
                    skipped++;
                    continue;
                }
                try {
                    captured.push({
                        info: captureSourceLayerInfo(src, comp),
                        color: colorForLayer(src),
                        suffix: " #" + targets[ci].index
                    });
                } catch (captureErr) {
                    skipped++;
                    errors.push(targets[ci].name + " [capture]: " + captureErr.toString());
                }
            }

            for (ci = 0; ci < captured.length; ci++) {
                var entry = captured[ci];
                try {
                    var boxLayer = createBoundingBox(comp, entry.info, entry.color, entry.suffix);
                    if (boxLayer) {
                        createdLayers.push(boxLayer);
                    }

                    if (GENERATE_TRAJECTORY && entry.info.trajectoryPoints.length >= 2) {
                        var trajLayer = createTrajectory(comp, entry.info, entry.color, entry.suffix);
                        if (trajLayer) {
                            createdLayers.push(trajLayer);
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
                "Готово.\n\n" +
                "Слоёв в композиции: " + stats.total + "\n" +
                "Подходящих целей: " + targets.length + "\n" +
                "Создано overlay-слоёв: " + createdLayers.length + "\n" +
                "Пропущено: " + skipped + "\n\n" +
                "Не обработано: " + (stats.total - targets.length) + " слоёв\n" +
                "  — отключены: " + stats.disabled + "\n" +
                "  — audio/adjustment: " + stats.noVideo + "\n" +
                "  — camera/light/guide: " + stats.notAV + "\n" +
                "  — служебные BBox: " + stats.guideOrGenerated +
                (errors.length > 0 ? "\n\nОшибки (" + errors.length + "):\n" + errors.slice(0, 5).join("\n") : "")
            );
        } catch (e) {
            alert("Ошибка: " + e.toString() + (e.line ? " (строка " + e.line + ")" : ""));
        }

        app.endUndoGroup();
    }

    // ─── Фильтрация и очистка ────────────────────────────────────────────────
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
                name === GROUP_PREFIX
            );
        } catch (e) {
            return false;
        }
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

    function collectTargetLayers(comp) {
        var result = [];
        var stats = {
            total: comp.numLayers,
            disabled: 0,
            noVideo: 0,
            notAV: 0,
            guideOrGenerated: 0
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
                continue;
            }
            if (layer.guideLayer) {
                stats.guideOrGenerated++;
                continue;
            }
            if (isCameraOrLight(layer)) {
                stats.notAV++;
                continue;
            }
            if (isAudioOnly(layer)) {
                stats.noVideo++;
                continue;
            }

            result.push({
                index: i,
                name: layer.name
            });
        }

        return { targets: result, stats: stats };
    }

    function removeGeneratedLayers(comp) {
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

    function findLayerByName(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (layer && layer.name === name) {
                return layer;
            }
        }
        return null;
    }

    // ─── Цвета ───────────────────────────────────────────────────────────────
    function captureSourceLayerInfo(sourceLayer, comp) {
        var trajPoints = [];
        if (GENERATE_TRAJECTORY) {
            try {
                trajPoints = sampleAnchorPointsInComp(sourceLayer, comp);
            } catch (e) {
                trajPoints = [];
            }
        }

        return {
            name: sourceLayer.name,
            label: safeLayerLabel(sourceLayer),
            isNull: isNullLayer(sourceLayer),
            startTime: sourceLayer.startTime,
            inPoint: sourceLayer.inPoint,
            outPoint: sourceLayer.outPoint,
            stretch: safeLayerStretch(sourceLayer),
            enabled: sourceLayer.enabled,
            trajectoryPoints: trajPoints
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

    function colorForLayer(layer) {
        if (!USE_LABEL_COLORS) {
            return FALLBACK_COLOR;
        }
        var idx = layer.label;
        if (idx >= 1 && idx < LABEL_COLORS.length && LABEL_COLORS[idx]) {
            return LABEL_COLORS[idx];
        }
        return FALLBACK_COLOR;
    }

    // ─── Bounding Box (живой, expression) ────────────────────────────────────
    function createBoundingBox(comp, info, color, uniqueSuffix) {
        var layerName = BOX_PREFIX + info.name + uniqueSuffix;
        var setup = createOverlayShapeLayer(comp, layerName, info.label, color);

        var expr = buildBBoxExpression(info.name, info.isNull);
        setPathExpression(setup.path, expr);

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function buildBBoxExpression(sourceLayerName, isNull) {
        var safeName = escapeForExpression(sourceLayerName);

        if (isNull) {
            return [
                'var L = thisComp.layer("' + safeName + '");',
                "var ap = L.anchorPoint;",
                "var h = " + NULL_BOX_HALF_SIZE + ";",
                "var tl = fromComp(L.toComp([ap[0] - h, ap[1] - h]));",
                "var tr = fromComp(L.toComp([ap[0] + h, ap[1] - h]));",
                "var br = fromComp(L.toComp([ap[0] + h, ap[1] + h]));",
                "var bl = fromComp(L.toComp([ap[0] - h, ap[1] + h]));",
                "createPath([tl, tr, br, bl], [], [], true);"
            ].join("\n");
        }

        return [
            'var L = thisComp.layer("' + safeName + '");',
            "var r = L.sourceRectAtTime(time, false);",
            "if (r.width <= 0 || r.height <= 0) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var tl = fromComp(L.toComp([r.left, r.top]));",
            "    var tr = fromComp(L.toComp([r.left + r.width, r.top]));",
            "    var br = fromComp(L.toComp([r.left + r.width, r.top + r.height]));",
            "    var bl = fromComp(L.toComp([r.left, r.top + r.height]));",
            "    createPath([tl, tr, br, bl], [], [], true);",
            "}"
        ].join("\n");
    }

    // ─── Траектория (запечённый path) ────────────────────────────────────────
    function createTrajectory(comp, info, color, uniqueSuffix) {
        var layerName = TRAJ_PREFIX + info.name + uniqueSuffix;
        var setup = createOverlayShapeLayer(comp, layerName, info.label, color);

        var shape = buildOpenPathShape(info.trajectoryPoints);
        setup.path.setValue(shape);

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function createOverlayShapeLayer(comp, layerName, label, color) {
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = layerName;
        shapeLayer.label = label;
        shapeLayer.threeDLayer = false;

        var root = shapeLayer.property("ADBE Root Vectors Group");

        var group = root.addProperty("ADBE Vector Group");
        var groupContents = group.property("ADBE Vectors Group");

        var pathGroup = groupContents.addProperty("ADBE Vector Shape - Group");

        var stroke = groupContents.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("ADBE Vector Stroke Color").setValue(color);
        stroke.property("ADBE Vector Stroke Width").setValue(STROKE_WIDTH);

        var fill = groupContents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Opacity").setValue(0);

        zeroTransform(shapeLayer);

        // Извлекаем path свежей навигацией от слоя (кэшированные ссылки могли инвалидироваться)
        var pathProp = getFreshPath(shapeLayer);
        if (!pathProp) {
            throw new Error("Path property not found");
        }

        return { layer: shapeLayer, path: pathProp };
    }

    function getFreshPath(shapeLayer) {
        var root = shapeLayer.property("ADBE Root Vectors Group");
        var group = root.property(1);
        var gc = group.property("ADBE Vectors Group");
        var pathGroup = gc.property("ADBE Vector Shape - Group");
        if (!pathGroup) {
            pathGroup = gc.property(1);
        }
        return pathGroup ? pathGroup.property("ADBE Vector Shape") : null;
    }

    function sampleAnchorPointsInComp(layer, comp) {
        var frameStep = comp.frameDuration;
        var startTime = layer.inPoint;
        var endTime = layer.outPoint;
        var points = [];
        var t = startTime;

        while (t <= endTime + frameStep * 0.001) {
            var compPoint = layerAnchorToComp(layer, t);
            if (compPoint) {
                points.push(compPoint);
            }
            t += frameStep;
        }

        return dedupeConsecutivePoints(points);
    }

    function layerAnchorToComp(layer, time) {
        try {
            var anchor = layer.property("ADBE Anchor Point").valueAtTime(time, false);
            var point = [anchor[0], anchor[1]];
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

    function buildOpenPathShape(points) {
        var shape = new Shape();
        shape.vertices = points;
        shape.inTangents = [];
        shape.outTangents = [];
        shape.closed = false;

        for (var i = 0; i < points.length; i++) {
            shape.inTangents.push([0, 0]);
            shape.outTangents.push([0, 0]);
        }

        return shape;
    }

    function dedupeConsecutivePoints(points) {
        if (points.length <= 1) {
            return points;
        }

        var result = [points[0]];
        for (var i = 1; i < points.length; i++) {
            var prev = result[result.length - 1];
            var cur = points[i];
            if (prev[0] !== cur[0] || prev[1] !== cur[1]) {
                result.push(cur);
            }
        }
        return result;
    }

    // ─── Вспомогательные ─────────────────────────────────────────────────────
    function ensureJavaScriptExpressionEngine() {
        try {
            if (app.project.expressionEngine !== "javascript-1.0") {
                app.project.expressionEngine = "javascript-1.0";
            }
        } catch (e) {
            // старые версии AE — продолжаем с текущим движком
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

    main();
})();
