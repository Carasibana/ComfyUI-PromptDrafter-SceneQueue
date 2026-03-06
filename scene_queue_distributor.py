"""
SceneQueueDistributor — Python node

Receives one SCENE_COMBO object at a time (ComfyUI iterates via the
Controller's OUTPUT_IS_LIST). Reads the preset file for each group in the
combination and outputs the text fields directly, ready to wire into
PromptDrafter nodes.

Output slot 0 is always combination_tag (STRING).
Subsequent output slots are dynamically managed by the JS frontend —
one or more STRING slots per group depending on the node type:
  Dual_PromptDrafter     → positive_prompt, negative_prompt
  DualLora_PromptDrafter → positive_prompt, negative_prompt, lora_string
  Single_PromptDrafter   → prompt

The hidden widget sq_groups_config (JSON string) tells Python the ordered
list of groups so it knows the output order. The JS frontend keeps this
widget in sync with the Controller's collection.
"""

import os
import json


class SceneQueueDistributor:

    CATEGORY = "PromptDrafter"
    FUNCTION = "execute"
    # combination_tag is always slot 0.
    # Slot 0 is always combination_tag. Slots 1-N are added dynamically by JS
    # via addOutput() — one or more STRING slots per group. RETURN_TYPES must
    # have at least as many entries as the highest wired slot index, or ComfyUI's
    # validator throws "tuple index out of range". We declare a fixed maximum
    # (1 + 8 groups × 3 fields = 25) so the validator always succeeds.
    # execute() returns a tuple sized to the actual groups in use; unused trailing
    # slots in RETURN_TYPES are never wired so they are never validated.
    _MAX_OUTPUTS = 25
    RETURN_TYPES = ("STRING",) * _MAX_OUTPUTS
    RETURN_NAMES = ("combination_tag",) + tuple(f"output_{i}" for i in range(1, _MAX_OUTPUTS))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene_combo": ("SCENE_COMBO", {}),
            },
            "optional": {
                # JSON list of ordered group configs — managed by JS, hidden in UI.
                # Format: [{"group_id": str, "node_type": str, "group_name": str}, ...]
                "sq_groups_config": ("STRING", {"default": "[]"}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, scene_combo, sq_groups_config="[]"):
        # Parse groups config from the hidden widget
        try:
            groups_config = json.loads(sq_groups_config) if sq_groups_config else []
        except (json.JSONDecodeError, TypeError):
            groups_config = []

        combination_tag = scene_combo.get("combination_tag", "")
        presets = scene_combo.get("presets", {})

        # Slot 0 is always combination_tag
        outputs = [combination_tag]

        for group_cfg in groups_config:
            group_id  = group_cfg.get("group_id", "")
            node_type = group_cfg.get("node_type", "")

            field_count = _fields_count(node_type)

            preset_entry = presets.get(group_id)
            if not preset_entry:
                # This group has no preset in this combination — output empty strings
                outputs.extend([""] * field_count)
                continue

            preset_name = preset_entry.get("preset", "")
            folder = _get_preset_folder(node_type)
            if not folder:
                print(f"[SceneQueue Distributor] Unknown node type '{node_type}' — skipping group '{group_id}'")
                outputs.extend([""] * field_count)
                continue

            preset_path = _get_preset_path(folder, preset_name)
            try:
                with open(preset_path, "r", encoding="utf-8") as f:
                    preset_data = json.load(f)
            except Exception as e:
                print(f"[SceneQueue Distributor] Could not load preset '{preset_name}': {e}")
                outputs.extend([""] * field_count)
                continue

            # Extract fields in the order the JS output slots expect
            if node_type in ("Dual_PromptDrafter", "DualPromptDrafter"):
                outputs.append(preset_data.get("positive", ""))
                outputs.append(preset_data.get("negative", ""))
            elif node_type in ("DualLora_PromptDrafter", "DualLoraPromptDrafter"):
                outputs.append(preset_data.get("positive", ""))
                outputs.append(preset_data.get("negative", ""))
                outputs.append(preset_data.get("loaded_loras", ""))
            elif node_type in ("Single_PromptDrafter", "SinglePromptDrafter"):
                outputs.append(preset_data.get("prompt", ""))

        return tuple(outputs)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _fields_count(node_type):
    """Number of output fields this node type produces."""
    if node_type in ("Dual_PromptDrafter", "DualPromptDrafter"):
        return 2
    if node_type in ("DualLora_PromptDrafter", "DualLoraPromptDrafter"):
        return 3
    if node_type in ("Single_PromptDrafter", "SinglePromptDrafter"):
        return 1
    return 0


def _get_pd_base_path():
    """Resolve PromptDrafter's saved/ base path from its config.json."""
    this_dir    = os.path.dirname(os.path.abspath(__file__))
    pd_dir      = os.path.join(os.path.dirname(this_dir), "ComfyUI-PromptDrafter")
    config_path = os.path.join(pd_dir, "config.json")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        base = cfg.get("save_paths", {}).get("base", None)
        if base:
            return os.path.join(pd_dir, base)
    return os.path.join(pd_dir, "saved")


_FOLDER_MAP = {
    "Dual_PromptDrafter":     "dual_prompts",
    "DualPromptDrafter":      "dual_prompts",
    "DualLora_PromptDrafter": "dual_lora_prompts",
    "DualLoraPromptDrafter":  "dual_lora_prompts",
    "Single_PromptDrafter":   "single_prompts",
    "SinglePromptDrafter":    "single_prompts",
}


def _get_preset_folder(node_type):
    return _FOLDER_MAP.get(node_type)


def _get_preset_path(folder, preset_name):
    base  = _get_pd_base_path()
    fname = preset_name if preset_name.endswith(".json") else f"{preset_name}.json"
    return os.path.join(base, folder, fname)


# ── Node registration ──────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "SceneQueueDistributor": SceneQueueDistributor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SceneQueueDistributor": "Scene Queue Distributor",
}
