"""Use the installed ComfyUI's real validator, without queueing or generating.

Usage: <ComfyUI python> validate-work-fisher.py <ComfyUI root> <API JSON directory>
The directory must contain wf-*.json exported by the application (not canvas JSON).
"""
import asyncio
import json
import os
import sys
from pathlib import Path

comfy_root, graph_dir = map(lambda p: Path(p).resolve(), sys.argv[1:3])
sys.argv = [sys.argv[0], '--disable-auto-launch', '--offline']
sys.path.insert(0, str(comfy_root))
os.chdir(comfy_root)

async def main():
    import nodes
    import execution
    import server
    from app.assets.manager import default_asset_manager
    server.PromptServer(asyncio.get_running_loop(), default_asset_manager())
    await nodes.init_extra_nodes(init_custom_nodes=False, init_api_nodes=False)
    for module in ['comfyui-kjnodes', 'ComfyUI_Comfyroll_CustomNodes', 'ComfyUI-SeedVR2_VideoUpscaler',
                   'comfyui_memory_cleanup', 'rgthree-comfy', 'ComfyUI-SolAttnMiniMax', 'comfyui-videohelpersuite', 'RES4LYF']:
        if not await nodes.load_custom_node(str(comfy_root / 'custom_nodes' / module)):
            raise RuntimeError(f'Cannot load {module}')
    results = []
    for file in sorted(graph_dir.glob('wf-*.json')):
        if file.name.endswith('.canvas.json'):
            continue
        graph = json.loads(file.read_text(encoding='utf-8'))
        result = await execution.validate_prompt(f'validate-{file.stem}', graph, None)
        # A partial success can silently skip some outputs; require every output to pass.
        outputs = sorted(k for k, v in graph.items() if getattr(nodes.NODE_CLASS_MAPPINGS[v['class_type']], 'OUTPUT_NODE', False))
        item = dict(mode=file.stem, valid=result[0] and not result[3] and sorted(result[2]) == outputs,
                    outputs=outputs, validated_outputs=sorted(result[2]), error=result[1], node_errors=result[3])
        results.append(item)
    (graph_dir / 'validation.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('WORK_FISHER_VALIDATION=' + json.dumps(results, ensure_ascii=False))
    if len(results) != 4 or not all(x['valid'] for x in results):
        raise SystemExit(1)

asyncio.run(main())
