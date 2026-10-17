"""
Converts a Microsoft Rocketbox avatar (MIT) from FBX to a skinned GLB for the game, keeping the "hipoly" mesh.

  blender -b --factory-startup -P tools/blender/rocketbox_to_glb.py -- <avatar_dir> <out.glb>

Materials are rebuilt as Principled BSDF so the glTF exporter writes them: body/head colour, normal and a roughness
derived from the specular map; the opacity map drives the alpha of the hair/eyelash material.
"""
import bpy
import sys
import os
import json

argv = sys.argv[sys.argv.index("--") + 1:]
avatar_dir, out_path = argv[0], argv[1]
name = os.path.basename(os.path.normpath(avatar_dir))
fbx = os.path.join(avatar_dir, "Export", f"{name}.fbx")
tex_dir = os.path.join(avatar_dir, "Textures")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx, automatic_bone_orientation=False, ignore_leaf_bones=False)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
print("MESHES", [(m.name, len(m.data.polygons)) for m in meshes])
print("ARMATURES", [a.name for a in arms])

# keep the highest poly level
keep = [m for m in meshes if "hipoly" in m.name.lower()] or [max(meshes, key=lambda m: len(m.data.polygons))]
for m in meshes:
    if m not in keep:
        bpy.data.objects.remove(m, do_unlink=True)

texs = {f.lower(): os.path.join(tex_dir, f) for f in os.listdir(tex_dir)}


def find_tex(part, kind):
    for k, p in texs.items():
        if part in k and kind in k:
            return p
    return None


def img(path, colorspace):
    if not path:
        return None
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = colorspace
    return im


for m in keep:
    for slot in m.material_slots:
        mat = slot.material
        if mat is None:
            continue
        lname = mat.name.lower()
        part = "head" if "head" in lname else "opacity" if ("opacity" in lname or "hair" in lname or "lash" in lname) else "body"
        mat.use_nodes = True
        nt = mat.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        if part == "opacity":
            col = img(find_tex("opacity", "color"), "sRGB")
            if col:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = col
                nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
                nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
            mat.blend_method = "CLIP" if hasattr(mat, "blend_method") else None
            bsdf.inputs["Roughness"].default_value = 0.6
        else:
            col = img(find_tex(part, "color"), "sRGB")
            nor = img(find_tex(part, "normal"), "Non-Color")
            spec = img(find_tex(part, "specular"), "Non-Color")
            if col:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = col
                nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
            if nor:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = nor
                nm = nt.nodes.new("ShaderNodeNormalMap")
                nt.links.new(t.outputs["Color"], nm.inputs["Color"])
                nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
            if spec:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = spec
                inv = nt.nodes.new("ShaderNodeMath")
                inv.operation = "SUBTRACT"
                inv.inputs[0].default_value = 1.0
                nt.links.new(t.outputs["Color"], inv.inputs[1])
                nt.links.new(inv.outputs["Value"], bsdf.inputs["Roughness"])
            else:
                bsdf.inputs["Roughness"].default_value = 0.7
        print("MATERIAL", mat.name, part)

# bone report (names, parents, rest heads in armature space)
info = {}
for a in arms:
    for b in a.data.bones:
        info[b.name] = {"parent": b.parent.name if b.parent else None, "head": list(b.head_local), "tail": list(b.tail_local)}
with open(out_path + ".bones.json", "w") as f:
    json.dump(info, f, indent=1)

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    export_animations=False,
    export_skins=True,
    export_yup=True,
    export_apply=False,
    export_image_format="JPEG",
    export_jpeg_quality=92,
)
print("EXPORTED", out_path)
