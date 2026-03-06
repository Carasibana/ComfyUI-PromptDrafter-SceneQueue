// ============================================================================
// Public API — for use by Scene Queue and other external packs
// ============================================================================

/**
 * PromptDrafter.loadPresetIntoNode(node, presetData)
 *
 * Programmatically loads a preset into a PromptDrafter node, exactly as if
 * the user had selected it from the load dropdown. Handles all widget updates
 * and LoRA push logic internally.
 *
 * @param {LGraphNode} node       - The target PromptDrafter node instance
 * @param {object}     presetData - Parsed preset JSON. Fields used:
 *   For Dual_PromptDrafter:     { positive, negative }
 *   For DualLora_PromptDrafter: { positive, negative, loaded_loras }
 *   For Single_PromptDrafter:   { prompt }
 *
 * This is the ONLY function external packs should call to load a preset.
 * Do not set PromptDrafter widget values directly.
 */
window.PromptDrafter = window.PromptDrafter || {};

window.PromptDrafter.loadPresetIntoNode = function(node, presetData) {
    if (!node || !presetData) return;

    const type = node.type;

    if (type === "Dual_PromptDrafter" || type === "DualPromptDrafter") {
        // --- Dual Prompts node ---
        const positiveWidget = node.widgets?.find(w => w.name === "positive_prompt");
        const negativeWidget  = node.widgets?.find(w => w.name === "negative_prompt");

        if (positiveWidget) {
            positiveWidget.value = presetData.positive || "";
            if (typeof positiveWidget.callback === "function") positiveWidget.callback(positiveWidget.value);
        }
        if (negativeWidget) {
            negativeWidget.value = presetData.negative || "";
            if (typeof negativeWidget.callback === "function") negativeWidget.callback(negativeWidget.value);
        }
        node.setDirtyCanvas(true, true);

    } else if (type === "DualLora_PromptDrafter" || type === "DualLoraPromptDrafter") {
        // --- Dual Prompts + Loaded Loras node ---
        const positiveWidget  = node.widgets?.find(w => w.name === "positive_prompt");
        const negativeWidget  = node.widgets?.find(w => w.name === "negative_prompt");
        const lorasWidget     = node.widgets?.find(w => w.name === "lora_string");
        const pushLoraWidget  = node.widgets?.find(w => w.name === "push_lora_on_load");

        const newPositive   = presetData.positive     || "";
        const newNegative   = presetData.negative     || "";
        const newLoraString = presetData.loaded_loras || "";

        if (positiveWidget) {
            positiveWidget.value = newPositive;
            if (typeof positiveWidget.callback === "function") positiveWidget.callback(newPositive);
        }
        if (negativeWidget) {
            negativeWidget.value = newNegative;
            if (typeof negativeWidget.callback === "function") negativeWidget.callback(newNegative);
        }
        if (lorasWidget) {
            lorasWidget.value = newLoraString;
            if (typeof lorasWidget.callback === "function") lorasWidget.callback(newLoraString);
        }
        node.setDirtyCanvas(true, true);

        // LoRA push — only when push_lora_on_load is true AND lora_string is wired
        const shouldPush = pushLoraWidget ? pushLoraWidget.value : false;
        if (shouldPush && newLoraString) {
            const loraInputSlot = node.inputs?.find(i => i.name === "lora_string");
            if (loraInputSlot && loraInputSlot.link != null) {
                const link = app.graph.links[loraInputSlot.link];
                if (link) {
                    const targetNode = app.graph.getNodeById(link.origin_id);
                    if (targetNode) {
                        const loraManagerWidget = _findLoraWidget(targetNode);
                        if (loraManagerWidget) {
                            loraManagerWidget.value = newLoraString;
                            if (typeof loraManagerWidget.callback === "function") {
                                loraManagerWidget.callback(newLoraString);
                            }
                            targetNode.setDirtyCanvas(true, true);
                        }
                    }
                }
            }
        }

    } else if (type === "Single_PromptDrafter" || type === "SinglePromptDrafter") {
        // --- Single Prompt node ---
        const promptWidget = node.widgets?.find(w => w.name === "prompt");
        if (promptWidget) {
            promptWidget.value = presetData.prompt || "";
            if (typeof promptWidget.callback === "function") promptWidget.callback(promptWidget.value);
        }
        node.setDirtyCanvas(true, true);

    } else {
        console.warn("[PromptDrafter] loadPresetIntoNode: unrecognised node type:", type);
    }
};

/**
 * Internal helper — finds the LoRA text widget on an upstream LoRA Manager node.
 * Not part of the public API. Uses name-based heuristics, no hardcoded widget names.
 */
function _findLoraWidget(node) {
    if (!node.widgets || node.widgets.length === 0) return null;

    const textWidgets = node.widgets.filter(w =>
        w.type === "customtext" ||
        w.type === "text" ||
        (w.element && w.element.tagName === "TEXTAREA") ||
        (w.inputEl && w.inputEl.tagName === "TEXTAREA")
    );
    if (textWidgets.length === 0) return null;
    if (textWidgets.length === 1) return textWidgets[0];

    const loraNameMatch = textWidgets.find(w => w.name?.toLowerCase().includes("lora"));
    if (loraNameMatch) return loraNameMatch;

    const genericMatch = textWidgets.find(w => {
        const n = w.name?.toLowerCase() ?? "";
        return n.includes("text") || n.includes("input") || n.includes("list") || n.includes("prompt");
    });
    if (genericMatch) return genericMatch;

    const contentMatch = textWidgets.find(w => String(w.value ?? "").includes("<lora:"));
    if (contentMatch) return contentMatch;

    return textWidgets[0];
}
