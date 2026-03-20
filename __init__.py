"""
ComfyUI-PromptDrafter-SceneQueue
Requires: comfyui-promptdrafter
"""

__version__ = "1.0.1"

import os
import sys

print("[SceneQueue] __init__.py loading...")

try:
    from .scene_queue_node import (
        NODE_CLASS_MAPPINGS as _CTRL_CLASSES,
        NODE_DISPLAY_NAME_MAPPINGS as _CTRL_NAMES,
    )
    from .scene_queue_distributor import (
        NODE_CLASS_MAPPINGS as _DIST_CLASSES,
        NODE_DISPLAY_NAME_MAPPINGS as _DIST_NAMES,
    )
    NODE_CLASS_MAPPINGS        = {**_CTRL_CLASSES, **_DIST_CLASSES}
    NODE_DISPLAY_NAME_MAPPINGS = {**_CTRL_NAMES,   **_DIST_NAMES}
    print("[SceneQueue] Successfully imported all node classes")
except Exception as e:
    print(f"[SceneQueue] ERROR importing nodes: {e}")
    import traceback
    traceback.print_exc()
    raise

try:
    from .scene_manager import register_routes
    print("[SceneQueue] Successfully imported register_routes")
except Exception as e:
    print(f"[SceneQueue] ERROR importing scene_manager: {e}")
    import traceback
    traceback.print_exc()
    raise

WEB_DIRECTORY = os.path.join(os.path.dirname(__file__), "js")
print(f"[SceneQueue] WEB_DIRECTORY set to: {WEB_DIRECTORY}")

print("[SceneQueue] Attempting to register routes...")
try:
    register_routes()
    print("[SceneQueue] Routes registered successfully at import time")
except Exception as e:
    print(f"[SceneQueue] Warning: Could not register routes at import time: {e}")
    print("[SceneQueue] This may be normal if the server isn't fully initialized yet.")
    import traceback
    traceback.print_exc()

print("[SceneQueue] __init__.py loaded successfully")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
