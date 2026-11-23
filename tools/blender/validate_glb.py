"""Headless check that an exported garment imports into Blender as one UV-mapped mesh.

Usage: blender --background --factory-startup --python tools/blender/validate_glb.py -- <render.glb>
"""
import sys

import bmesh
import bpy


def main() -> int:
    path = sys.argv[sys.argv.index("--") + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if len(meshes) != 1:
        print(f"GLB_INVALID expected 1 mesh, found {len(meshes)}")
        return 1
    mesh = meshes[0].data
    checked = bmesh.new()
    checked.from_mesh(mesh)
    degenerate = sum(1 for face in checked.faces if face.calc_area() < 1e-10)
    checked.free()
    if not mesh.uv_layers or not mesh.polygons or degenerate:
        print(f"GLB_INVALID uv_layers={len(mesh.uv_layers)} faces={len(mesh.polygons)} degenerate={degenerate}")
        return 1
    print(f"GLB_OK vertices={len(mesh.vertices)} faces={len(mesh.polygons)} uv_layers={len(mesh.uv_layers)}")
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    if code:
        sys.exit(code)
