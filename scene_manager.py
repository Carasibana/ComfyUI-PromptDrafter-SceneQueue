"""
scene_manager.py — Backend HTTP routes for Scene Queue

Registered by __init__.py. Provides:
  GET  /scenequeue/scenes/list
  GET  /scenequeue/scenes/load
  POST /scenequeue/scenes/save
  DELETE /scenequeue/scenes/delete
  GET  /scenequeue/presets
"""

import os
import json
from aiohttp import web
import server


# ── Path helpers ──────────────────────────────────────────────────────────────

def _scenes_dir():
    this_dir = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(this_dir, "saved", "scenes")
    os.makedirs(d, exist_ok=True)
    return d


def _pd_dir():
    """Absolute path to the comfyui-promptdrafter extension folder."""
    this_dir = os.path.dirname(os.path.abspath(__file__))
    # Try both casing variants (Windows is case-insensitive, but be explicit)
    for name in ("comfyui-promptdrafter", "ComfyUI-PromptDrafter"):
        candidate = os.path.join(os.path.dirname(this_dir), name)
        if os.path.isdir(candidate):
            return candidate
    # Fallback: return the lowercase variant regardless
    return os.path.join(os.path.dirname(this_dir), "comfyui-promptdrafter")


_CATEGORY_MAP = {
    "Dual_PromptDrafter":     "dual_prompts",
    "DualLora_PromptDrafter": "dual_lora_prompts",
    "Single_PromptDrafter":   "single_prompts",
}


def _pd_preset_dir(category: str) -> str:
    """Resolve the absolute path to a PromptDrafter preset folder.

    Mirrors FileManager.get_save_path(): reads save_paths.<category> from
    config.json (a relative path from the extension root), falling back to
    'saved/<category>' if the key is absent.
    """
    pd = _pd_dir()
    config_path = os.path.join(pd, "config.json")
    relative = f"saved/{category}"  # default
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        relative = cfg.get("save_paths", {}).get(category, relative)
    return os.path.join(pd, relative)


# ── Route handlers ────────────────────────────────────────────────────────────

async def list_scenes(request):
    scenes_dir = _scenes_dir()
    files = sorted(
        f[:-5] for f in os.listdir(scenes_dir)
        if f.endswith(".json")
    )
    return web.json_response({"success": True, "scenes": files})


async def load_scene(request):
    name = request.rel_url.query.get("name", "").strip()
    if not name:
        return web.json_response({"success": False, "error": "name required"}, status=400)
    fname = name if name.endswith(".json") else f"{name}.json"
    path  = os.path.join(_scenes_dir(), fname)
    if not os.path.exists(path):
        return web.json_response({"success": False, "error": "not found"}, status=404)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return web.json_response({"success": True, "data": data})


async def save_scene(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "invalid JSON"}, status=400)

    name = body.get("name", "").strip()
    data = body.get("data")
    if not name or data is None:
        return web.json_response({"success": False, "error": "name and data required"}, status=400)

    fname = name if name.endswith(".json") else f"{name}.json"
    path  = os.path.join(_scenes_dir(), fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return web.json_response({"success": True})


async def delete_scene(request):
    name = request.rel_url.query.get("name", "").strip()
    if not name:
        return web.json_response({"success": False, "error": "name required"}, status=400)
    fname = name if name.endswith(".json") else f"{name}.json"
    path  = os.path.join(_scenes_dir(), fname)
    if not os.path.exists(path):
        return web.json_response({"success": False, "error": "not found"}, status=404)
    os.remove(path)
    return web.json_response({"success": True})


async def list_presets(request):
    """
    List all preset names in a given node-type folder.
    Query param: node_type (e.g. DualLora_PromptDrafter)
    """
    node_type = request.rel_url.query.get("node_type", "").strip()

    if not node_type:
        return web.json_response({"success": False, "error": "node_type required"}, status=400)

    category = _CATEGORY_MAP.get(node_type)
    if not category:
        return web.json_response({"success": False, "error": f"unknown node_type: {node_type}"}, status=400)

    preset_dir = _pd_preset_dir(category)

    if not os.path.exists(preset_dir):
        return web.json_response({"success": True, "presets": []})

    presets = sorted(
        f[:-5] for f in os.listdir(preset_dir)
        if f.endswith(".json")
    )
    return web.json_response({"success": True, "presets": presets})


# ── Route registration ────────────────────────────────────────────────────────

# Register routes using the standard ComfyUI decorator pattern.
# PromptServer.instance is always available by the time custom-node modules
# are imported, so this fires immediately and reliably — no timing issues.
_routes = server.PromptServer.instance.routes


@_routes.get("/scenequeue/scenes/list")
async def _api_list_scenes(request):
    return await list_scenes(request)


@_routes.get("/scenequeue/scenes/load")
async def _api_load_scene(request):
    return await load_scene(request)


@_routes.post("/scenequeue/scenes/save")
async def _api_save_scene(request):
    return await save_scene(request)


@_routes.delete("/scenequeue/scenes/delete")
async def _api_delete_scene(request):
    return await delete_scene(request)


@_routes.get("/scenequeue/presets")
async def _api_list_presets(request):
    return await list_presets(request)


print("[SceneQueue] ✅ Routes registered via PromptServer.instance.routes")


def register_routes():
    """No-op — routes are registered at module import time via decorators above."""
    pass
