"""
SceneQueueController — Python node

Reads the active collection file, builds the full list of all combination
objects, and outputs them as a list. ComfyUI iterates the downstream
subgraph once per combination via OUTPUT_IS_LIST.
"""

import os
import itertools
import json


class SceneQueueController:

    CATEGORY = "PromptDrafter"
    FUNCTION = "execute"
    RETURN_TYPES = ("SCENE_COMBO",)
    RETURN_NAMES = ("scene_combos",)
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "scene_file": ("STRING", {"default": ""}),
            },
            "optional": {
                # Live collection state serialized by JS — always reflects the
                # current in-memory editor state, including enabled/disabled scenes.
                # Python uses this instead of reading the file, so unsaved changes
                # (e.g. toggling scenes on/off) are respected at queue time.
                "sq_collection_data": ("STRING", {"default": ""}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, scene_file, sq_collection_data=""):
        # ── Load collection ──────────────────────────────────────────────────
        # Prefer the live widget state (always reflects the current editor,
        # including unsaved enable/disable changes). Fall back to the file only
        # if the widget is empty (e.g. old workflow without the widget).
        if sq_collection_data:
            try:
                collection = json.loads(sq_collection_data)
            except (json.JSONDecodeError, TypeError) as e:
                raise ValueError(f"[SceneQueue] Invalid sq_collection_data: {e}")
        else:
            if not scene_file:
                raise ValueError("[SceneQueue] No collection file specified.")
            collection_path = _resolve_collection_path(scene_file)
            if not os.path.exists(collection_path):
                raise ValueError(f"[SceneQueue] Collection file not found: {collection_path}")
            with open(collection_path, "r", encoding="utf-8") as f:
                collection = json.load(f)

        groups       = {g["group_id"]: g for g in collection.get("groups", [])}
        all_scenes   = collection.get("scenes", [])
        enabled_scenes = [s for s in all_scenes if s.get("enabled", True)]
        tag_cfg      = collection.get("combination_tag", {})
        separator    = tag_cfg.get("separator", "_")
        max_seg_len  = tag_cfg.get("max_segment_length", 20)
        loop_order   = collection.get("loop_order", list(groups.keys()))

        if not enabled_scenes:
            raise ValueError("[SceneQueue] No enabled scenes in collection.")

        # ── Pre-flight validation ─────────────────────────────────────────────
        missing = []
        for scene in enabled_scenes:
            for group_id, preset_entries in scene.get("group_presets", {}).items():
                group = groups.get(group_id)
                if not group:
                    continue
                folder = _get_preset_folder(group["node_type"])
                for entry in preset_entries:
                    preset_path = _get_preset_path(folder, entry["preset"])
                    if not os.path.exists(preset_path):
                        missing.append(
                            f"'{entry['preset']}' "
                            f"({group.get('group_name', group_id)} / {scene['scene_name']})"
                        )
        if missing:
            raise ValueError(
                f"[SceneQueue] {len(missing)} preset(s) not found — "
                f"fix or remove before running:\n" +
                "\n".join(f"  • {m}" for m in missing)
            )

        # ── Build flat combination list ───────────────────────────────────────
        combinations = _build_combinations(enabled_scenes, loop_order)
        total = len(combinations)

        if total == 0:
            raise ValueError("[SceneQueue] No combinations found in enabled scenes.")

        print(f"[SceneQueue] Queuing {total} combinations for this run.")

        # ── Build combo objects with pre-computed tags ────────────────────────
        combo_list = []
        for combo in combinations:
            tag = _build_tag(combo, groups, loop_order, separator, max_seg_len)
            combo_list.append({
                "combination_tag": tag,
                "presets": combo["presets"],   # {group_id: {preset, label}}
            })

        return (combo_list,)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_pd_base_path():
    """Resolve PromptDrafter's saved/ base path from its config.json."""
    this_dir   = os.path.dirname(os.path.abspath(__file__))
    pd_dir     = os.path.join(os.path.dirname(this_dir), "ComfyUI-PromptDrafter")
    config_path = os.path.join(pd_dir, "config.json")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        base = cfg.get("save_paths", {}).get("base", None)
        if base:
            return os.path.join(pd_dir, base)
    return os.path.join(pd_dir, "saved")


def _resolve_collection_path(scene_file):
    """Resolve a collection filename to its full path in saved/scenes/."""
    this_dir = os.path.dirname(os.path.abspath(__file__))
    scenes_dir = os.path.join(this_dir, "saved", "scenes")
    fname = scene_file if scene_file.endswith(".json") else f"{scene_file}.json"
    return os.path.join(scenes_dir, fname)


# Node type → preset subfolder name mapping
_FOLDER_MAP = {
    "Dual_PromptDrafter":     "dual_prompts",
    "DualPromptDrafter":      "dual_prompts",
    "DualLora_PromptDrafter": "dual_lora_prompts",
    "DualLoraPromptDrafter":  "dual_lora_prompts",
    "Single_PromptDrafter":   "single_prompts",
    "SinglePromptDrafter":    "single_prompts",
}


def _get_preset_folder(node_type):
    folder = _FOLDER_MAP.get(node_type)
    if not folder:
        raise ValueError(f"[SceneQueue] Unknown node type: {node_type}")
    return folder


def _get_preset_path(folder, preset_name):
    """Full path to a preset JSON file."""
    base = _get_pd_base_path()
    fname = preset_name if preset_name.endswith(".json") else f"{preset_name}.json"
    return os.path.join(base, folder, fname)


def _build_combinations(enabled_scenes, loop_order):
    """
    Build the flat list of all combinations across all enabled scenes.
    Each combination is a dict:
        { scene_id, scene_name, scene_label, presets: { group_id: preset_entry } }
    """
    combinations = []
    for scene in enabled_scenes:
        group_presets = scene.get("group_presets", {})
        ordered_group_ids = [gid for gid in loop_order if gid in group_presets]
        for gid in group_presets:
            if gid not in ordered_group_ids:
                ordered_group_ids.append(gid)

        preset_arrays = []
        for gid in ordered_group_ids:
            entries = group_presets[gid]
            if entries:
                preset_arrays.append((gid, entries))

        if not preset_arrays:
            continue

        group_ids   = [pa[0] for pa in preset_arrays]
        entry_lists = [pa[1] for pa in preset_arrays]

        for combo_tuple in itertools.product(*entry_lists):
            presets = {group_ids[i]: combo_tuple[i] for i in range(len(group_ids))}
            combinations.append({
                "scene_id":    scene["scene_id"],
                "scene_name":  scene["scene_name"],
                "scene_label": scene.get("scene_label", _slugify(scene["scene_name"])),
                "presets":     presets,
            })

    return combinations


def _build_tag(combo, groups, loop_order, separator, max_seg_len):
    """Build the combination_tag string for a given combination."""
    segments = [combo["scene_label"]]

    for group_id in loop_order:
        group = groups.get(group_id)
        if not group or not group.get("include_in_tag", True):
            continue
        preset_entry = combo["presets"].get(group_id)
        if not preset_entry:
            continue
        label = preset_entry.get("label", "").strip()
        if label:
            segments.append(label)
        else:
            segments.append(_truncate(preset_entry["preset"], max_seg_len))

    return separator.join(s for s in segments if s)


def _truncate(name, max_len):
    if len(name) <= max_len:
        return name
    truncated = name[:max_len]
    last_break = max(truncated.rfind("_"), truncated.rfind("-"))
    if last_break > max_len // 2:
        return truncated[:last_break]
    return truncated


def _slugify(name):
    return name.lower().replace(" ", "-").replace("_", "-")


# ── Node registration ──────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "SceneQueueController": SceneQueueController,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SceneQueueController": "Scene Queue Controller",
}
