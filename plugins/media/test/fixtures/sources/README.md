# Recorded workflow-source fixtures

Recorded on **2026-10-03** with anonymous HTTPS GET requests. Tests use these files through an injected fetch stub; the global fetch is replaced with a throwing stub. No test performs a live HTTP request.

| Files | Recorded endpoint / revision |
|---|---|
| `civitai-search.json` | `https://civitai.com/api/v1/models?ids=617060&types=Workflows&limit=1&nsfw=false` |
| `civitai-model.json` | `https://civitai.com/api/v1/models/617060` |
| `civitai-workflow.zip` | `https://civitai.com/api/download/models/819999` (same primary attachment as file id 733789) |
| `github-tree.json` | `https://api.github.com/repos/diffustar/comfyui-workflow-collection/git/trees/master?recursive=1`, tree commit `91779af19b6c2675b5e39d5d091d4c2bbdc619e5` |
| `github-workflow.json` | `https://raw.githubusercontent.com/diffustar/comfyui-workflow-collection/91779af19b6c2675b5e39d5d091d4c2bbdc619e5/workflows/sal-vton-clothing-swap/workflow.json` |
| `github-license.txt` | The same diffustar revision's `LICENSE`, MIT, copyright 2024 Niels |
| `github-examples-tree.json` | `https://api.github.com/repos/comfyanonymous/ComfyUI_examples/git/trees/master?recursive=1`, commit `f9431bb000ce792094ff345446e22cac1ea6cef3` |
| `github-examples-workflow.json` | That examples commit's `wan22/text_to_video_wan22_5B.json`; permissive grant preserved in `sources/data/LICENSE.ComfyUI-examples` |
| `ipadapter-workflow.json` | `https://raw.githubusercontent.com/cubiq/ComfyUI_IPAdapter_plus/a0f451a5113cf9becb0847b92884cb10cbdec0ef/examples/ipadapter_advanced.json` |
| `registry-ipadapter.json` | `https://api.comfy.org/comfy-nodes/IPAdapterAdvanced/node` |
| `registry-ipadapter-version.json` | `https://api.comfy.org/nodes/comfyui_ipadapter_plus/versions/2.0.0` |
| `registry-rgthree.json` | `https://api.comfy.org/comfy-nodes/Power%20Lora%20Loader%20%28rgthree%29/node` |
| `registry-rgthree-version.json` | `https://api.comfy.org/nodes/rgthree-comfy/versions/1.0.2608210019` |
| `registry-missing.json` | HTTP 404 body from `https://api.comfy.org/comfy-nodes/AlexiaNonexistentFixtureClass/node` |
| `registry-empty-search.json` | `https://api.comfy.org/nodes/search?repository_url_search=https%3A%2F%2Fgithub.com%2Falkemann%2FComfyUI-Image-Selectors&include_banned=false&limit=100` |
| `github-fallback-commit.json` | `https://api.github.com/repos/kijai/ComfyUI-ELLA-wrapper/commits/HEAD`; projected `sha`, `url`, `html_url` |

Small projections preserve the protocol fields exercised: Civitai descriptions are truncated to 80 characters and image lists to one item containing URL/rating; Registry publisher membership lists are omitted; the upstream examples tree retains only its JSON entries. Values such as ids, versions, permission flags, URLs, filenames, byte sizes and graph contents are recorded, not invented. JSON formatting is normalized in some files. Registry response licences and node examples retain their upstream ownership; the Civitai creator is `maitruclam` (the workflow filename credits Lam Panda).

Failure tests deliberately change statuses, permission-independent file names, archive bytes and catalogue truncation to exercise unavailable/malformed responses. The Manager unregistered-pack test simulates absent registration with the real empty-search response and real GitHub commit response: it does not assert that ELLA-wrapper is unregistered today. Synthetic tiny ZIPs contain only test graphs and exercise ambiguity/size/corruption; the successful Civitai path reads the real ZIP above.

The full Manager mapping and built-in list are runtime data, separately pinned under `sources/data/provenance.json`, with their GPL-3.0 licence included. Workflow/model/node licensing and source eligibility are discussed in `docs/comfyui-workflow-sources.md`.
