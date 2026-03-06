/**
 * Scene Queue Controller + Distributor — Frontend
 *
 * Architecture:
 *   - Controller reads the collection, outputs a SCENE_COMBO list via OUTPUT_IS_LIST.
 *   - ComfyUI iterates the downstream subgraph once per combination automatically.
 *   - Distributor receives one combo at a time and outputs preset text to PromptDrafter nodes.
 *   - Distributor is auto-created and connected when the Controller is placed.
 *   - "+ Add Node" in the Controller editor auto-wires Distributor outputs → PromptDrafter inputs.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SQ_PREFIX = "[SceneQueue]";

const NODE_TYPE_DISPLAY = {
    "Dual_PromptDrafter":     "Dual Prompts",
    "DualLora_PromptDrafter": "Dual + LoRA",
    "Single_PromptDrafter":   "Single Prompt",
};

// Fields each node type contributes as Distributor output slots.
// Order must match what Python's execute() appends to the outputs tuple.
const NODE_TYPE_FIELDS = {
    "Dual_PromptDrafter":     ["positive_prompt", "negative_prompt"],
    "DualPromptDrafter":      ["positive_prompt", "negative_prompt"],
    "DualLora_PromptDrafter": ["positive_prompt", "negative_prompt", "lora_string"],
    "DualLoraPromptDrafter":  ["positive_prompt", "negative_prompt", "lora_string"],
    "Single_PromptDrafter":   ["prompt"],
    "SinglePromptDrafter":    ["prompt"],
};


// ── API helpers ───────────────────────────────────────────────────────────────

const SceneQueueAPI = {
    async listScenes() {
        const r = await api.fetchApi("/scenequeue/scenes/list");
        return await r.json();
    },
    async loadScene(name) {
        const r = await api.fetchApi(`/scenequeue/scenes/load?name=${encodeURIComponent(name)}`);
        return await r.json();
    },
    async saveScene(name, data) {
        const r = await api.fetchApi("/scenequeue/scenes/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        return await r.json();
    },
    async deleteScene(name) {
        const r = await api.fetchApi(`/scenequeue/scenes/delete?name=${encodeURIComponent(name)}`, {
            method: "DELETE",
        });
        return await r.json();
    },
    async listPresets(nodeType) {
        const r = await api.fetchApi(`/scenequeue/presets?node_type=${encodeURIComponent(nodeType)}`);
        if (!r.ok) {
            const text = await r.text().catch(() => "");
            return { success: false, error: `HTTP ${r.status}: ${text.slice(0, 200) || r.statusText}` };
        }
        return await r.json();
    },
};


// ── Distributor helpers ───────────────────────────────────────────────────────

/**
 * Rebuild the Distributor's dynamic output slots to match the current groups.
 * Slot 0 (combination_tag) is always preserved.
 * All slots from index 1 onward are removed (back-to-front) and re-added in
 * group order — matching PromptDrafter's pattern for dynamic input slots.
 *
 * NOTE: LiteGraph's removeOutput() severs attached links — intentional.
 * Call _rewireAllGroups() afterward to restore wires.
 */
function _updateDistributorOutputs(dist, groupsConfig) {
    if (!dist) return;

    // Remove all slots after slot 0 (back-to-front to keep indices stable)
    for (let i = dist.outputs.length - 1; i >= 1; i--) {
        dist.removeOutput(i);
    }

    // Re-add slots for each group in order
    for (const group of groupsConfig) {
        const fields = NODE_TYPE_FIELDS[group.node_type] || [];
        for (const field of fields) {
            dist.addOutput(`${group.group_name}: ${field}`, "STRING");
        }
    }

    dist.setDirtyCanvas(true, true);
}

/**
 * Update the Distributor's hidden sq_groups_config widget so Python knows
 * the output order at execution time.
 */
function _updateDistributorWidget(dist, groupsConfig) {
    if (!dist) return;
    const widget = dist.widgets?.find(w => w.name === "sq_groups_config");
    if (widget) {
        widget.value = JSON.stringify(groupsConfig);
    }
}

/**
 * Wire every group's Distributor output slots to the matching PromptDrafter inputs.
 * Existing wires are replaced (reconnecting is safe).
 */
function _rewireAllGroups(dist, groups) {
    if (!dist || !groups) return;

    let slotIdx = 1; // slot 0 is always combination_tag
    for (const group of groups) {
        const pdNode = app.graph.getNodeById(parseInt(group.node_id));
        const fields = NODE_TYPE_FIELDS[group.node_type] || [];

        if (pdNode) {
            for (let fi = 0; fi < fields.length; fi++) {
                const pdInputName = fields[fi];
                const inSlotIdx   = pdNode.inputs?.findIndex(inp => inp.name === pdInputName);
                if (inSlotIdx !== undefined && inSlotIdx >= 0) {
                    dist.connect(slotIdx + fi, pdNode, inSlotIdx);
                }
            }
        }
        slotIdx += fields.length;
    }
}

/**
 * Full sync: update widget, rebuild output slots, re-wire all groups.
 * Call whenever the collection's group structure changes.
 */
function _pushGroupsToDistributor(controllerNode) {
    if (!controllerNode.sqDistributorId) return;
    const dist = app.graph.getNodeById(controllerNode.sqDistributorId);
    if (!dist) return;

    const groups       = controllerNode.sqCollection?.groups || [];
    const groupsConfig = groups.map(g => ({
        group_id:   g.group_id,
        group_name: g.group_name,
        node_type:  g.node_type,
        node_id:    g.node_id,
    }));

    _updateDistributorWidget(dist, groupsConfig);
    _updateDistributorOutputs(dist, groupsConfig);
    _rewireAllGroups(dist, groups);
}

/**
 * Create a new Distributor node and connect it to the Controller.
 */
function _createAndConnectDistributor(controllerNode) {
    const dist = LiteGraph.createNode("SceneQueueDistributor");
    if (!dist) {
        console.warn(`${SQ_PREFIX} SceneQueueDistributor type not registered — Distributor not auto-created.`);
        return null;
    }
    dist.pos = [
        controllerNode.pos[0] + controllerNode.size[0] + 80,
        controllerNode.pos[1],
    ];
    app.graph.add(dist);

    // Connect Controller output 0 (SCENE_COMBO) → Distributor input 0 (scene_combo)
    controllerNode.connect(0, dist, 0);
    controllerNode.sqDistributorId = dist.id;

    console.log(`${SQ_PREFIX} Distributor #${dist.id} created and connected to Controller.`);
    return dist;
}


// ── Node Registration ─────────────────────────────────────────────────────────

app.registerExtension({
    name: "PromptDrafter.SceneQueue",

    async beforeRegisterNodeDef(nodeType, nodeData) {

        // ── SceneQueueController ───────────────────────────────────────────
        if (nodeData.name === "SceneQueueController") {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const node = this;
                node.sqCollection    = null;
                node.sqSceneFile     = "";
                node.sqDirty         = false;
                node.sqDistributorId = null;

                // Hide scene_file and sq_collection_data widgets — managed programmatically
                for (const wname of ["scene_file", "sq_collection_data"]) {
                    const w = node.widgets?.find(w => w.name === wname);
                    if (w) {
                        w.computeSize = () => [0, -4];
                        if (w.inputEl) w.inputEl.style.display = "none";
                    }
                }

                // Build DOM editor
                const container = _buildEditorDOM(node);
                const domWidget = node.addDOMWidget("sq_editor", "SQ_EDITOR", container, {
                    serialize: false,
                });
                domWidget.computeSize = function (width) {
                    return [width, node.sqEditorHeight || 400];
                };

                node.size[0] = Math.max(node.size[0], 620);
                node.size[1] = Math.max(node.size[1], 480);

                const origOnResize = node.onResize;
                node.onResize = function (size) {
                    if (origOnResize) origOnResize.apply(this, arguments);
                    node.sqEditorHeight = Math.max(300, size[1] - 80);
                    if (domWidget) domWidget.computeSize = () => [size[0], node.sqEditorHeight];
                };

                const origOnNodeRemoved = app.graph.onNodeRemoved;
                app.graph.onNodeRemoved = function () {
                    if (origOnNodeRemoved) origOnNodeRemoved.apply(this, arguments);
                    node.sqRenderEditor?.();
                };

                // Auto-create Distributor only for fresh placement.
                // onConfigure (called before this timeout fires) sets sqDistributorId
                // from a saved workflow, so the check prevents duplicates.
                setTimeout(() => {
                    if (!node.sqDistributorId) {
                        _createAndConnectDistributor(node);
                    }
                    node.sqRenderEditor?.();
                    // If a collection was auto-loaded before sqDistributorId was known
                    // (race between onConfigure and _refreshCollectionPicker), push now
                    // that the graph is fully set up.
                    if (node.sqCollection) {
                        _pushGroupsToDistributor(node);
                    }
                }, 200);
            };

            // ── Serialization ──────────────────────────────────────────────
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function (o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                o.sq_scene_file     = this.sqSceneFile ?? "";
                o.sq_distributor_id = this.sqDistributorId ?? null;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                this.sqDistributorId = o.sq_distributor_id ?? null;
                if (o.sq_scene_file) {
                    this.sqSceneFile = o.sq_scene_file;
                    const w = this.widgets?.find(w => w.name === "scene_file");
                    if (w) w.value = o.sq_scene_file;
                }
                setTimeout(() => this.sqRenderEditor?.(), 150);
            };
        }

        // ── SceneQueueDistributor ──────────────────────────────────────────
        if (nodeData.name === "SceneQueueDistributor") {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // Hide sq_groups_config widget — managed programmatically by the Controller
                const cfgWidget = this.widgets?.find(w => w.name === "sq_groups_config");
                if (cfgWidget) {
                    cfgWidget.computeSize = () => [0, -4];
                    if (cfgWidget.inputEl) cfgWidget.inputEl.style.display = "none";
                }
            };
        }
    },
});


// ── Editor DOM builder ────────────────────────────────────────────────────────

function _buildEditorDOM(node) {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;min-height:300px;background:#1a1a1a;border-radius:6px;overflow:hidden;font-family:sans-serif;font-size:13px;color:#ddd;box-sizing:border-box;";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px 10px;background:#222;border-bottom:1px solid #333;flex-shrink:0;flex-wrap:wrap;";

    const titleEl = document.createElement("span");
    titleEl.textContent = "Scene Queue";
    titleEl.style.cssText = "font-weight:bold;color:#fff;margin-right:6px;";
    toolbar.appendChild(titleEl);

    const collectionSelect = document.createElement("select");
    collectionSelect.style.cssText = "background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;cursor:pointer;max-width:160px;";
    collectionSelect.title = "Active collection";
    toolbar.appendChild(collectionSelect);

    const newBtn  = _btn("New",  "#2a4a2a", "#4a8a4a");
    const saveBtn = _btn("Save", "#2a3a5a", "#4a6aaa");
    toolbar.appendChild(newBtn);
    toolbar.appendChild(saveBtn);

    root.appendChild(toolbar);

    // Scroll area (grid lives here)
    const scrollArea = document.createElement("div");
    scrollArea.style.cssText = "flex:1;overflow:auto;padding:8px;";
    root.appendChild(scrollArea);

    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "padding:6px 10px;background:#222;border-top:1px solid #333;flex-shrink:0;font-size:12px;color:#aaa;min-height:24px;";
    root.appendChild(footer);

    // Attach render method to node
    node.sqRenderEditor = () => _renderEditor(node, scrollArea, footer, collectionSelect, saveBtn);

    // Wire up toolbar actions
    collectionSelect.addEventListener("change", async () => {
        const name = collectionSelect.value;
        if (!name) return;
        await _loadCollection(node, name);
        node.sqRenderEditor();
    });

    newBtn.addEventListener("click", () => _newCollection(node, collectionSelect));

    saveBtn.addEventListener("click", async () => {
        if (!node.sqSceneFile || !node.sqCollection) return;
        const result = await SceneQueueAPI.saveScene(node.sqSceneFile, node.sqCollection);
        if (result.success) {
            node.sqDirty = false;
            saveBtn.textContent = "Saved!";
            setTimeout(() => { saveBtn.textContent = node.sqDirty ? "Save*" : "Save"; }, 1500);
        }
    });

    _refreshCollectionPicker(node, collectionSelect, saveBtn);

    return root;
}


// ── Editor renderer ───────────────────────────────────────────────────────────

function _renderEditor(node, scrollArea, footer, collectionSelect, saveBtn) {
    saveBtn.textContent = node.sqDirty ? "Save*" : "Save";
    scrollArea.innerHTML = "";

    if (!node.sqCollection) {
        const msg = document.createElement("div");
        msg.style.cssText = "color:#888;padding:24px;text-align:center;";
        msg.textContent = "No collection loaded. Select one above or click New.";
        scrollArea.appendChild(msg);
        footer.textContent = "";
        return;
    }

    const col    = node.sqCollection;
    const groups = col.groups || [];
    const scenes = col.scenes || [];

    // ── Header row (group columns) ──────────────────────────────────────────
    const headerRow = document.createElement("div");
    headerRow.style.cssText = "display:flex;align-items:stretch;margin-bottom:2px;position:sticky;top:0;background:#1a1a1a;z-index:10;";

    const sceneLabelHeader = document.createElement("div");
    sceneLabelHeader.style.cssText = "min-width:160px;max-width:160px;box-sizing:border-box;padding:6px 8px;font-weight:bold;color:#aaa;border-bottom:1px solid #444;";
    sceneLabelHeader.textContent = "Scene";
    headerRow.appendChild(sceneLabelHeader);

    for (const group of groups) {
        headerRow.appendChild(_buildColumnHeader(node, group, col));
    }

    // "+ Add Node" button
    const addNodeCell = document.createElement("div");
    addNodeCell.style.cssText = "min-width:100px;padding:6px 4px;border-bottom:1px solid #444;";
    const addNodeBtn = _btn("+ Add Node", "#2a2a3a", "#5a5a8a");
    addNodeBtn.style.fontSize = "11px";
    addNodeBtn.addEventListener("click", () => _showAddNodePicker(node, col, node.sqRenderEditor));
    addNodeCell.appendChild(addNodeBtn);
    headerRow.appendChild(addNodeCell);

    scrollArea.appendChild(headerRow);

    // ── Scene rows ──────────────────────────────────────────────────────────
    for (let si = 0; si < scenes.length; si++) {
        scrollArea.appendChild(_buildSceneRow(node, scenes[si], groups, col, si));
    }

    // Add Scene button
    const addSceneRow = document.createElement("div");
    addSceneRow.style.cssText = "padding:8px 4px;";
    const addSceneBtn = _btn("+ Add Scene", "#2a3a2a", "#4a7a4a");
    addSceneBtn.addEventListener("click", () => {
        const newScene = _newScene(col);
        col.scenes.push(newScene);
        _markDirty(node);
        node.sqRenderEditor();
        setTimeout(() => {
            const inputs = scrollArea.querySelectorAll(".sq-scene-name-input");
            if (inputs.length) inputs[inputs.length - 1].focus();
        }, 50);
    });
    addSceneRow.appendChild(addSceneBtn);
    scrollArea.appendChild(addSceneRow);

    // ── Footer ──────────────────────────────────────────────────────────────
    _renderFooter(node, col, footer);
}


// ── Column header ─────────────────────────────────────────────────────────────

function _buildColumnHeader(node, group, col) {
    const state = _resolveColumnState(group);

    const cell = document.createElement("div");
    cell.style.cssText = "min-width:160px;width:160px;max-width:160px;box-sizing:border-box;padding:6px 8px;border-bottom:1px solid #444;border-left:1px solid #333;flex-shrink:0;";

    const titleLine = document.createElement("div");
    titleLine.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:2px;";

    if (state.status !== "ok") {
        const warn = document.createElement("span");
        warn.textContent = "⚠";
        warn.style.color = "#f88";
        titleLine.appendChild(warn);
    }

    const nameEl = document.createElement("span");
    nameEl.textContent = state.displayName;
    nameEl.style.cssText = `font-weight:bold;color:${state.status === "ok" ? "#ddd" : "#f88"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;`;
    nameEl.title = state.message || state.displayName;
    titleLine.appendChild(nameEl);

    const retargetBtn = _iconBtn("→", "#5a8aaa", "Retarget to a different node");
    retargetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _showRetargetPicker(node, group, col, node.sqRenderEditor);
    });
    titleLine.appendChild(retargetBtn);

    const tagToggle = _iconBtn(group.include_in_tag ? "tag:✓" : "tag:✗", group.include_in_tag ? "#4a8a4a" : "#666", "Toggle tag inclusion");
    tagToggle.style.fontSize = "10px";
    tagToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        group.include_in_tag = !group.include_in_tag;
        _markDirty(node);
        node.sqRenderEditor();
    });
    titleLine.appendChild(tagToggle);

    const removeBtn = _iconBtn("×", "#8a4a4a", "Remove this group column");
    removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _confirmRemoveColumn(node, group, col, node.sqRenderEditor);
    });
    titleLine.appendChild(removeBtn);

    cell.appendChild(titleLine);

    const subtitleEl = document.createElement("div");
    subtitleEl.style.cssText = "font-size:10px;color:#888;";
    const typeShort = NODE_TYPE_DISPLAY[group.node_type] || group.node_type;
    subtitleEl.textContent = `${typeShort} #${group.node_id}`;
    if (state.status === "missing") {
        subtitleEl.textContent += " — not found";
        subtitleEl.style.color = "#f66";
    } else if (state.status === "type_mismatch") {
        subtitleEl.textContent += " — type mismatch";
        subtitleEl.style.color = "#f88";
    }
    cell.appendChild(subtitleEl);

    return cell;
}


function _resolveColumnState(group) {
    const liveNode = app.graph.getNodeById(parseInt(group.node_id));
    if (!liveNode) {
        return { status: "missing", displayName: group.group_name, message: `Was: "${group.node_title}" — not found in this workflow` };
    }
    if (liveNode.type !== group.node_type) {
        return { status: "type_mismatch", displayName: liveNode.title || group.group_name, message: `Node #${group.node_id} type mismatch` };
    }
    return { status: "ok", displayName: liveNode.title || group.group_name };
}


// ── Scene row ─────────────────────────────────────────────────────────────────

function _buildSceneRow(node, scene, groups, col, sceneIndex) {
    const isExpanded   = scene._expanded || false;
    const sceneEnabled = scene.enabled !== false;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = `border-bottom:1px solid #2a2a2a;opacity:${sceneEnabled ? "1" : "0.55"};`;

    // Scene header
    const headerRow = document.createElement("div");
    headerRow.style.cssText = `display:flex;align-items:center;cursor:pointer;padding:5px 8px 5px 0;background:${sceneEnabled ? "#222" : "#1c1c1c"};`;

    const sceneNameCell = document.createElement("div");
    sceneNameCell.style.cssText = "min-width:160px;max-width:160px;flex-shrink:0;display:flex;align-items:center;overflow:hidden;";

    const chevron = document.createElement("span");
    chevron.textContent = isExpanded ? "▼" : "▶";
    chevron.style.cssText = "margin-right:6px;font-size:10px;color:#888;user-select:none;flex-shrink:0;";
    sceneNameCell.appendChild(chevron);

    const nameInput = document.createElement("input");
    nameInput.className = "sq-scene-name-input";
    nameInput.value = scene.scene_name;
    nameInput.style.cssText = "background:transparent;border:none;color:#ddd;font-size:13px;font-weight:bold;min-width:0;flex:1;outline:none;cursor:text;";
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("change", (e) => {
        scene.scene_name = e.target.value.trim() || "Unnamed Scene";
        if (!scene.scene_label || scene.scene_label === _slugify(scene.scene_name)) {
            scene.scene_label = _slugify(scene.scene_name);
        }
        _markDirty(node);
    });
    sceneNameCell.appendChild(nameInput);
    headerRow.appendChild(sceneNameCell);

    const comboCount = _countCombinations(scene, groups, col.loop_order || []);
    const countEl    = document.createElement("span");
    countEl.style.cssText = "margin-left:8px;color:#888;font-size:11px;white-space:nowrap;";
    countEl.textContent   = sceneEnabled
        ? `${comboCount} combo${comboCount !== 1 ? "s" : ""}`
        : "disabled";
    headerRow.appendChild(countEl);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    headerRow.appendChild(spacer);

    const enableBtn = _iconBtn(
        sceneEnabled ? "✓ On" : "✗ Off",
        sceneEnabled ? "#4a8a4a" : "#666",
        sceneEnabled ? "Enabled — click to disable" : "Disabled — click to enable"
    );
    enableBtn.style.fontSize = "10px";
    enableBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        scene.enabled = !sceneEnabled;
        _markDirty(node);
        node.sqRenderEditor();
    });
    headerRow.appendChild(enableBtn);

    const dupBtn = _iconBtn("⧉", "#5a5a5a", "Duplicate scene");
    dupBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const copy = JSON.parse(JSON.stringify(scene));
        copy.scene_id    = _newId("scene");
        copy.scene_name  = scene.scene_name + " (copy)";
        copy.scene_label = _slugify(copy.scene_name);
        col.scenes.splice(sceneIndex + 1, 0, copy);
        _markDirty(node);
        node.sqRenderEditor();
    });
    headerRow.appendChild(dupBtn);

    const delBtn = _iconBtn("×", "#8a4a4a", "Delete scene");
    delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        col.scenes.splice(sceneIndex, 1);
        _markDirty(node);
        node.sqRenderEditor();
    });
    headerRow.appendChild(delBtn);

    headerRow.addEventListener("click", () => {
        scene._expanded = !scene._expanded;
        node.sqRenderEditor();
    });

    wrapper.appendChild(headerRow);

    // Expanded cells
    if (isExpanded) {
        const cellsRow = document.createElement("div");
        cellsRow.style.cssText = "display:flex;align-items:flex-start;background:#1e1e1e;";

        const labelCell = document.createElement("div");
        labelCell.style.cssText = "min-width:160px;max-width:160px;box-sizing:border-box;padding:6px 8px;border-right:1px solid #2a2a2a;";
        const labelHint = document.createElement("div");
        labelHint.style.cssText = "font-size:10px;color:#888;margin-bottom:2px;";
        labelHint.textContent = "tag label:";
        labelCell.appendChild(labelHint);
        const labelInput = document.createElement("input");
        labelInput.value = scene.scene_label || _slugify(scene.scene_name);
        labelInput.style.cssText = "background:#2a2a2a;border:1px solid #444;color:#ccc;font-size:11px;padding:2px 4px;border-radius:3px;width:120px;";
        labelInput.title = "Appears as first segment in combination_tag";
        labelInput.addEventListener("change", (e) => {
            scene.scene_label = e.target.value.trim();
            _markDirty(node);
        });
        labelCell.appendChild(labelInput);
        cellsRow.appendChild(labelCell);

        for (const group of groups) {
            cellsRow.appendChild(_buildPresetCell(node, scene, group, col));
        }

        const trailingSpacer = document.createElement("div");
        trailingSpacer.style.cssText = "min-width:100px;flex-shrink:0;";
        cellsRow.appendChild(trailingSpacer);

        wrapper.appendChild(cellsRow);
    }

    return wrapper;
}


// ── Preset cell ───────────────────────────────────────────────────────────────

function _buildPresetCell(node, scene, group, col) {
    const cell    = document.createElement("div");
    cell.style.cssText = "min-width:160px;width:160px;max-width:160px;box-sizing:border-box;padding:6px 8px;border-left:1px solid #2a2a2a;vertical-align:top;flex-shrink:0;";
    const entries = scene.group_presets?.[group.group_id] || [];

    for (let ei = 0; ei < entries.length; ei++) {
        cell.appendChild(_buildPresetEntry(node, scene, group, col, entries[ei], ei, entries));
    }

    const addBtn = _btn("+ Add", "#1e2e1e", "#3a6a3a");
    addBtn.style.cssText += "font-size:11px;margin-top:4px;width:100%;";
    addBtn.addEventListener("click", () => {
        _showPresetPicker(node, scene, group, col, entries, node.sqRenderEditor);
    });
    cell.appendChild(addBtn);

    return cell;
}


function _buildPresetEntry(node, scene, group, col, entry, entryIndex, entries) {
    const wrapper   = document.createElement("div");
    wrapper.style.cssText = "margin-bottom:4px;";
    const isMissing = entry._missing || false;

    const row = document.createElement("div");
    row.style.cssText = `display:flex;align-items:center;gap:3px;background:${isMissing ? "#3a1a1a" : "#2a2a2a"};border-radius:3px;padding:3px 5px;`;

    const nameEl = document.createElement("span");
    nameEl.textContent = entry.label || _truncateDisplay(entry.preset, 18);
    nameEl.title = entry.preset;
    nameEl.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${isMissing ? "#f88" : "#ddd"};font-size:12px;`;
    if (isMissing) {
        const warnIcon = document.createElement("span");
        warnIcon.textContent = "⚠ ";
        warnIcon.style.color = "#f88";
        row.appendChild(warnIcon);
    }
    row.appendChild(nameEl);

    const removeBtn = _iconBtn("×", "#6a3a3a", "Remove from this scene");
    removeBtn.addEventListener("click", () => {
        entries.splice(entryIndex, 1);
        _markDirty(node);
        node.sqRenderEditor();
    });
    row.appendChild(removeBtn);

    const labelBtn = _iconBtn("≡", "#444", "Edit tag label for this preset");
    row.appendChild(labelBtn);
    wrapper.appendChild(row);

    const labelRow = document.createElement("div");
    labelRow.style.cssText = "display:none;padding:3px 5px;background:#222;border-radius:0 0 3px 3px;margin-top:-2px;";
    const labelHint = document.createElement("span");
    labelHint.textContent = "In tag, show as: ";
    labelHint.style.cssText = "font-size:10px;color:#888;";
    labelRow.appendChild(labelHint);
    const labelInput = document.createElement("input");
    labelInput.value = entry.label || "";
    labelInput.placeholder = _truncateDisplay(entry.preset, 20);
    labelInput.style.cssText = "background:#2a2a2a;border:1px solid #444;color:#ccc;font-size:11px;padding:2px 4px;border-radius:3px;width:120px;";
    labelInput.addEventListener("change", (e) => {
        entry.label = e.target.value.trim();
        _markDirty(node);
        node.sqRenderEditor();
    });
    labelRow.appendChild(labelInput);
    wrapper.appendChild(labelRow);

    let labelOpen = false;
    labelBtn.addEventListener("click", () => {
        labelOpen = !labelOpen;
        labelRow.style.display = labelOpen ? "block" : "none";
    });

    return wrapper;
}


// ── Footer ────────────────────────────────────────────────────────────────────

function _renderFooter(node, col, footer) {
    const warnings    = [];
    let totalCombos   = 0;
    let enabledScenes = 0;
    const groups      = col.groups || [];

    for (const group of groups) {
        const state = _resolveColumnState(group);
        if (state.status === "missing")        warnings.push(`⚠ "${group.group_name}" (#${group.node_id}) not found in this workflow`);
        else if (state.status === "type_mismatch") warnings.push(`⚠ "${group.group_name}" type mismatch on #${group.node_id}`);
    }

    for (const scene of (col.scenes || [])) {
        if (!scene.enabled && scene.enabled !== undefined) continue;
        enabledScenes++;
        const combos = _countCombinations(scene, groups, col.loop_order || []);
        if (combos === 0) warnings.push(`⚠ "${scene.scene_name}" — one or more groups has no presets`);
        totalCombos += combos;
    }

    if (enabledScenes === 0) warnings.push("⚠ No enabled scenes — nothing will run");

    footer.innerHTML = "";
    const summary = document.createElement("div");
    summary.style.cssText = "color:#aaa;";
    summary.textContent = `${totalCombos} combination${totalCombos !== 1 ? "s" : ""} across ${enabledScenes} enabled scene${enabledScenes !== 1 ? "s" : ""}`;
    footer.appendChild(summary);

    for (const w of warnings) {
        const wEl = document.createElement("div");
        wEl.style.cssText = "color:#f88;font-size:11px;";
        wEl.textContent = w;
        footer.appendChild(wEl);
    }
}


// ── Pickers ───────────────────────────────────────────────────────────────────

function _showPresetPicker(node, scene, group, col, existingEntries, onDone) {
    const existingNames = new Set(existingEntries.map(e => e.preset));

    SceneQueueAPI.listPresets(group.node_type).then((result) => {
        if (!result.success) {
            alert(`[SceneQueue] Could not load presets for "${group.group_name}":\n${result.error || "Unknown error"}\n\nCheck that PromptDrafter is installed and its save path is configured correctly.`);
            return;
        }
        const available = result.presets.filter(p => !existingNames.has(p));

        if (available.length === 0) {
            const allCount = result.presets.length;
            if (allCount === 0) {
                alert(`[SceneQueue] No presets found for "${group.group_name}" (${NODE_TYPE_DISPLAY[group.node_type] || group.node_type}).\n\nSave at least one preset in PromptDrafter first.`);
            } else {
                alert(`[SceneQueue] All ${allCount} preset(s) for "${group.group_name}" are already added to this scene.`);
            }
            return;
        }

        const picker = _buildPicker(
            `Add preset — ${group.group_name}`,
            available,
            (chosen) => {
                if (!scene.group_presets) scene.group_presets = {};
                if (!scene.group_presets[group.group_id]) scene.group_presets[group.group_id] = [];
                scene.group_presets[group.group_id].push({ preset: chosen, label: "" });
                _markDirty(node);
                onDone();
            }
        );
        document.body.appendChild(picker);
    }).catch((err) => {
        alert(`[SceneQueue] Failed to fetch presets: ${err.message || err}`);
    });
}


function _showAddNodePicker(node, col, onDone) {
    const existingNodeIds = new Set((col.groups || []).map(g => parseInt(g.node_id)));
    const pdTypes         = new Set(Object.keys(NODE_TYPE_DISPLAY));

    const candidates = (app.graph._nodes || []).filter(n =>
        pdTypes.has(n.type) && !existingNodeIds.has(n.id)
    );

    if (candidates.length === 0) {
        alert("No compatible PromptDrafter nodes found in this workflow that aren't already added.");
        return;
    }

    const labels = candidates.map(n => `${n.title || n.type} (#${n.id})`);
    const picker = _buildPicker(
        "Add Node Column",
        labels,
        (chosen, idx) => {
            const n = candidates[idx];
            const newGroup = {
                group_id:       _newId("grp"),
                group_name:     n.title || n.type,
                node_type:      n.type,
                node_title:     n.title || "",
                node_id:        n.id,
                include_in_tag: true,
            };
            if (!col.groups)     col.groups     = [];
            if (!col.loop_order) col.loop_order = [];
            col.groups.push(newGroup);
            col.loop_order.push(newGroup.group_id);
            _markDirty(node);

            // Rebuild Distributor outputs and auto-wire to the new PromptDrafter node
            _pushGroupsToDistributor(node);

            onDone();
        }
    );
    document.body.appendChild(picker);
}


function _showRetargetPicker(node, group, col, onDone) {
    const pdNodes = (app.graph._nodes || []).filter(n => n.type === group.node_type);

    if (pdNodes.length === 0) {
        alert(`No nodes of type "${group.node_type}" found in this workflow.`);
        return;
    }

    const labels = pdNodes.map(n => `${n.title || n.type} (#${n.id})`);
    const picker = _buildPicker(
        `Retarget "${group.group_name}"`,
        labels,
        (chosen, idx) => {
            const n = pdNodes[idx];
            group.node_id    = n.id;
            group.node_title = n.title || "";
            group.group_name = n.title || n.type;
            _markDirty(node);
            // Rebuild output slot labels and re-wire to the new target node
            _pushGroupsToDistributor(node);
            onDone();
        }
    );
    document.body.appendChild(picker);
}


function _buildPicker(title, items, onSelect) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;";

    const box = document.createElement("div");
    box.style.cssText = "background:#222;border:1px solid #555;border-radius:8px;padding:16px;min-width:280px;max-width:400px;max-height:70vh;display:flex;flex-direction:column;";

    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.cssText = "font-weight:bold;color:#ddd;margin-bottom:10px;font-size:14px;";
    box.appendChild(titleEl);

    const searchInput = document.createElement("input");
    searchInput.placeholder = "Filter…";
    searchInput.style.cssText = "background:#333;border:1px solid #555;color:#ddd;padding:5px 8px;border-radius:4px;margin-bottom:8px;width:100%;box-sizing:border-box;";
    box.appendChild(searchInput);

    const listEl = document.createElement("div");
    listEl.style.cssText = "overflow-y:auto;flex:1;";
    box.appendChild(listEl);

    const renderItems = (filter) => {
        listEl.innerHTML = "";
        const filtered = items.map((label, idx) => ({ label, idx })).filter(({ label }) =>
            label.toLowerCase().includes(filter.toLowerCase())
        );
        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:#888;padding:8px;";
            empty.textContent = "No matches";
            listEl.appendChild(empty);
        }
        for (const { label, idx } of filtered) {
            const item = document.createElement("div");
            item.textContent = label;
            item.style.cssText = "padding:6px 8px;cursor:pointer;border-radius:4px;color:#ddd;";
            item.addEventListener("mouseenter", () => item.style.background = "#333");
            item.addEventListener("mouseleave", () => item.style.background = "");
            item.addEventListener("click", () => {
                overlay.remove();
                onSelect(label, idx);
            });
            listEl.appendChild(item);
        }
    };

    searchInput.addEventListener("input", () => renderItems(searchInput.value));
    renderItems("");

    const cancelBtn = _btn("Cancel", "#3a2a2a", "#7a4a4a");
    cancelBtn.style.marginTop = "10px";
    cancelBtn.addEventListener("click", () => overlay.remove());
    box.appendChild(cancelBtn);

    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    return overlay;
}


// ── Confirmation dialog ───────────────────────────────────────────────────────

function _confirmRemoveColumn(node, group, col, onDone) {
    const sceneCount = (col.scenes || []).length;
    const confirmed  = confirm(
        `Remove "${group.group_name}" group?\n\n` +
        `This will remove the column and all its preset selections from ${sceneCount} scene(s). ` +
        `This cannot be undone.`
    );
    if (!confirmed) return;

    col.groups     = (col.groups     || []).filter(g => g.group_id !== group.group_id);
    col.loop_order = (col.loop_order || []).filter(id => id !== group.group_id);
    for (const scene of (col.scenes || [])) {
        if (scene.group_presets) delete scene.group_presets[group.group_id];
    }
    _markDirty(node);

    // Rebuild Distributor outputs (removing this group's slots) and re-wire remaining
    _pushGroupsToDistributor(node);

    onDone();
}


// ── Collection management ─────────────────────────────────────────────────────

async function _refreshCollectionPicker(node, selectEl, saveBtn) {
    const result = await SceneQueueAPI.listScenes();
    selectEl.innerHTML = '<option value="">— select collection —</option>';
    for (const name of (result.scenes || [])) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        if (name === node.sqSceneFile) opt.selected = true;
        selectEl.appendChild(opt);
    }
    if (node.sqSceneFile && !node.sqCollection) {
        await _loadCollection(node, node.sqSceneFile);
        node.sqRenderEditor?.();
    }
}


async function _loadCollection(node, name) {
    const result = await SceneQueueAPI.loadScene(name);
    if (result.success) {
        node.sqCollection = result.data;
        node.sqSceneFile  = name;
        node.sqDirty      = false;
        const w = node.widgets?.find(w => w.name === "scene_file");
        if (w) w.value = name;
        _syncCollectionWidget(node);
        // Rebuild Distributor output slots and re-wire all groups to match the
        // loaded collection. This also handles switching between collections.
        _pushGroupsToDistributor(node);
    }
}



function _newCollection(node, selectEl) {
    const name = prompt("New collection name:", "my-collection");
    if (!name || !name.trim()) return;
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");

    node.sqCollection = {
        schema_version:  2,
        collection_name: clean,
        combination_tag: { separator: "_", max_segment_length: 20 },
        groups:          [],
        loop_order:      [],
        scenes:          [],
    };
    node.sqSceneFile = clean;
    node.sqDirty     = true;
    _syncCollectionWidget(node);

    const opt       = document.createElement("option");
    opt.value       = clean;
    opt.textContent = clean;
    opt.selected    = true;
    selectEl.appendChild(opt);

    const w = node.widgets?.find(w => w.name === "scene_file");
    if (w) w.value = clean;

    node.sqRenderEditor?.();
}


// ── Shared utilities ──────────────────────────────────────────────────────────

function _syncCollectionWidget(node) {
    const w = node.widgets?.find(w => w.name === "sq_collection_data");
    if (w) w.value = node.sqCollection ? JSON.stringify(node.sqCollection) : "";
}

function _markDirty(node) {
    node.sqDirty = true;
    _syncCollectionWidget(node);
    node.sqRenderEditor?.();
}


function _countCombinations(scene, groups, loopOrder) {
    let count = 1;
    const groupPresets = scene.group_presets || {};
    const orderedIds   = [...loopOrder, ...Object.keys(groupPresets).filter(id => !loopOrder.includes(id))];
    for (const gid of orderedIds) {
        const entries = groupPresets[gid] || [];
        if (entries.length === 0) return 0;
        count *= entries.length;
    }
    return Object.keys(groupPresets).length > 0 ? count : 0;
}

function _newScene(col) {
    const n    = (col.scenes?.length || 0) + 1;
    const name = `Scene ${n}`;
    const id   = _newId("scene");
    const gp   = {};
    for (const g of (col.groups || [])) gp[g.group_id] = [];
    return {
        scene_id:      id,
        scene_name:    name,
        scene_label:   _slugify(name),
        enabled:       true,
        _expanded:     true,
        group_presets: gp,
    };
}

function _slugify(name) {
    return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function _truncateDisplay(name, max) {
    if (name.length <= max) return name;
    return name.slice(0, max) + "…";
}

let _idCounter = 0;
function _newId(prefix) {
    return `${prefix}_${Date.now()}_${_idCounter++}`;
}

function _btn(label, bgColor, borderColor) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `background:${bgColor};border:1px solid ${borderColor};color:#ddd;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;`;
    return btn;
}

function _iconBtn(label, color, title) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title || "";
    btn.style.cssText = `background:transparent;border:1px solid ${color};color:${color};padding:1px 5px;border-radius:3px;cursor:pointer;font-size:11px;flex-shrink:0;`;
    return btn;
}
