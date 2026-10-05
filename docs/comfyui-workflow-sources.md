# ComfyUI community workflow sources

Checked **2026-10-03**. This is an engineering access and licensing assessment of the published interfaces and terms, not a claim that every uploaded workflow, model or node pack has unrestricted rights. An accessible website or download is not a blanket redistribution licence. Author attribution and the source's permission metadata must survive installation.

The implemented interface is [`plugins/media/sources/index.js`](../plugins/media/sources/index.js): `sources` and `createSources({ fetch?, civitaiApiKey?, githubToken? })`. Each source provides `id`, `name`, `homepage`, `search(query, { task?, signal? })` and `fetch(entryId, { signal? })`. Search returns the requested `Entry` shape; fetch returns an untouched API/editor workflow, its format, attribution, permission metadata, source URL, custom node class types and model descriptors. A source failure is an error, not an empty successful catalogue. No adapter uses HTML scraping, private website endpoints or browser session cookies.

## Decisions

| Source | Public interface / authentication | Decision |
|---|---|---|
| Comfy Registry | Documented anonymous node-pack REST reads; publishing needs authentication | Use for node resolution; no community-workflow catalogue found |
| Civitai | Public/mixed REST catalogue and public attachment downloads; restricted downloads need the person's token | Implement Workflow model attachments; no image/post scraping |
| OpenArt workflows | No documented public workflow discovery/download API established | Exclude: terms prohibit automated scraping |
| comfyworkflows.com | Neither a dependable public API nor current terms could be verified | Defer; do not scrape or reverse-engineer |
| Licensed GitHub collections | Public Git Trees API and raw files; optional token raises rate limits | Implement two explicitly MIT-licensed, pinned collections |
| ComfyUI_examples | GitHub public repository and explicit permissive workflow licence; many examples live in images | Implement its JSON files through the GitHub adapter; defer image-embedded workflows |
| Hugging Face Hub | Public repository/file APIs; gated/private files need authentication | Defer a general workflow source until a specific licensed corpus is reviewed |

## Comfy Registry

[Registry documentation](https://docs.comfy.org/registry/api-reference/overview) describes publishers, node packs and versions. The [live OpenAPI](https://api.comfy.org/openapi) and [published backend schema](https://github.com/Comfy-Org/registry-backend/blob/c4fd416025996de3729c61b58f7a4c2be5fbdfdf/openapi.yml) expose `/comfy-nodes/{class}/node`, `/nodes/search`, and exact `/nodes/{id}/versions/{version}` reads. Anonymous calls succeeded. Registry records include repository, publisher, licence, pack id, version, dependency strings, platform compatibility and release status; releases include download URLs. These are node packs, not downloadable workflow graphs. A `workflowresult` endpoint is CI information, not a community workflow library.

[Comfy's terms](https://comfy.org/terms-of-service) distinguish its commercial products from OSS and retain the respective OSS licences. The Registry's own documented read API is used, not its UI. Pack licences remain separate. Reliability is good for published packs, with incomplete extraction and older unregistered packs as known gaps. Only active, non-deprecated releases with an official CDN URL are returned; an unavailable or flagged release remains unresolved. **Decision: node metadata only, excluded from `sources`.**

## Civitai

The current [model API reference](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/models.md) supports `GET /api/v1/models?types=Workflows`, `query`, `tag`, and stable model/version/file ids. [Authentication documentation](https://github.com/civitai/civitai-developer-docs/blob/main/site/guide/authentication.md) expressly documents anonymous public/mixed endpoints. Anonymous catalogue, model detail and a 1,907-byte workflow attachment download succeeded on the check date. Restricted downloads may require a personal bearer token; 401/403 errors say so. Keys use headers and are removed across CDN redirects.

The [official terms](https://civitai.com/content/tos), modified August 26, 2026, §11.4 allow expressly provided automated interfaces, subject to credentials and rate limits. They also contain the credential phrase “your own valid credentials”; this is broader than the public API documentation's anonymous-access statement. **The anonymous implementation follows the explicit public-endpoint documentation, an interpretation rather than a legal resolution of that wording.** Credentialed access must use the person's own token. No scraping or statistical manipulation is supported.

Metadata includes title, HTML description, tags, creator, previews, permission flags, versions, file sizes and download URLs. Permission flags are preserved as `Civitai permissions: {…}`, not labelled MIT or another invented SPDX licence. Node/model requirements and VRAM are not dependable catalogue fields. The graph supplies class names and recognizable model filenames; missing URLs remain unknown. [Image metadata](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md) is generation metadata, not a guaranteed runnable graph. **Decision: implement public Workflow-model JSON/ZIP attachments only.** The first 20 catalogue results are searched; other generation tools also use the `Workflows` type, so fetch validates the actual graph. Multi-graph ZIPs require a member-qualified id instead of silently selecting one. Older workflow/node versions still need runtime compatibility checks.

## OpenArt

[OpenArt's terms](https://openart.ai/suite/terms) display July 30, 2026 at the top (July 20 at the footer). §4.4 restricts generation to human interaction, and §5.6 prohibits automated tools used to scrape, crawl or copy service data. No published API contract for discovering and downloading the public workflow library was established. Website workflow descriptions, thumbnails and author-provided dependency notes are not a machine-readable compatibility guarantee. Authentication, API stability and an author licence suitable for automated redistribution could not be established for such an interface. **Decision: no adapter and no scraping.** Revisit only with a documented authorized API or written permission.

## comfyworkflows.com

The [site](https://comfyworkflows.com/), `/terms`, `/terms-of-service`, `/api`, `/robots.txt` and `/privacy-policy` all failed access checks with HTTP 402 on this date. Public documentation searches did not establish a supported API. The [ComfyWorkflows launcher repository](https://github.com/ComfyWorkflows/ComfyUI-Launcher) is software and is not proof that the website authorizes workflow-library extraction. Current terms, authentication requirements, dependency metadata and availability could therefore not be verified. **Decision: defer, no adapter.** This is an evidence gap, not an assertion that its terms forbid all automation; do not use undocumented endpoints to bypass it.

## GitHub community collections

[GitHub's API terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms) and [rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) support programmatic API reads subject to limits. Public reads work anonymously (60 requests/hour per originating IP); an optional personal token increases the allowance. The adapter uses Git Trees and raw immutable commit URLs, caches successful trees in memory, and refuses a truncated tree. No authenticated code search is required.

The reviewed community collections are [diffustar/comfyui-workflow-collection](https://github.com/diffustar/comfyui-workflow-collection/tree/91779af19b6c2675b5e39d5d091d4c2bbdc619e5), [its MIT licence](https://github.com/diffustar/comfyui-workflow-collection/blob/91779af19b6c2675b5e39d5d091d4c2bbdc619e5/LICENSE), and [wyrde/wyrde-comfyui-workflows](https://github.com/wyrde/wyrde-comfyui-workflows/tree/0924119652cca4bfd53684c8ccd6999b30b8bbbb), [its MIT licence](https://github.com/wyrde/wyrde-comfyui-workflows/blob/0924119652cca4bfd53684c8ccd6999b30b8bbbb/LICENSE). Commit pins retain the reviewed licence and catalogue. Wyrde's examples are from 2023; descriptions explicitly say compatibility requires checking. The same adapter also carries the separately licensed upstream JSON examples below.

Tree paths provide filenames and size; titles/tags come from those paths, author from repository ownership, and licence from the reviewed revision. Graphs provide nodes and model filenames/descriptors. VRAM is unknown. **Decision: implement this limited catalogue, not arbitrary GitHub search.** A new collection/revision requires licence review; third-party model/node licences and MIT attribution notices must be retained independently.

## Other sources considered

[ComfyUI_examples](https://github.com/comfyanonymous/ComfyUI_examples) is an established upstream example source. GitHub labels its licence `NOASSERTION`, but the [actual licence](https://github.com/comfyanonymous/ComfyUI_examples/blob/f9431bb000ce792094ff345446e22cac1ea6cef3/LICENSE) explicitly permits workflow use, modification and distribution for any purpose, with or without fee. **Decision: include the 21 standalone JSON examples at commit `f9431bb000ce792094ff345446e22cac1ea6cef3` in the GitHub adapter.** Many other examples are PNGs containing workflow metadata and remain unlisted pending an image metadata reader. Public reads are reliable and anonymous; requirements come from the actual JSON and VRAM remains unknown. Its permission grant is retained by name and link, without inventing an SPDX id. This is separate from ComfyUI's [MIT-licensed official templates](https://github.com/Comfy-Org/workflow_templates), already served by the plugin's existing catalogue.

The [Hugging Face Hub API](https://huggingface.co/docs/hub/api) can list repository files and retrieve pinned raw JSON. [Hub terms](https://huggingface.co/terms-of-service) and each repository's licence/gating rules still apply; the platform API does not establish rights to every uploaded workflow. Auth is optional for public files and necessary for gated/private repositories. Metadata is repository-level; a general workflow/node/model/VRAM contract was not found. **Decision: defer the general adapter until a named, licensed workflow corpus has been evaluated.**

## Custom node resolution and integration

[`sources/nodes.js`](../plugins/media/sources/nodes.js) exports:

```js
customNodeTypes(workflow, { builtins? }) // string[], API or editor JSON
resolveNodes(workflow, { signal?, fetch?, builtins?, githubToken? })
// { nodes: string[], packs: Pack[], unresolved: [{ type, reason }] }
// Pack: { id, name, repository, registryId?, version?, commit?,
//         downloadUrl?, license?, nodeTypes: string[], mapping }
```

The primary mapping is the Registry's class-to-pack endpoint. A matching editor `properties.cnr_id` / `properties.ver` supplies an exact release; otherwise the returned latest release is resolved immediately to its exact version and official archive URL. Installation must use this returned version, not look up `latest` again. Registry extraction can omit aliases and older classes: mapping a pack does not prove that an editor workflow can be converted or that every runtime class is present. The existing renderer must still validate against its own `/object_info`.

The fallback is ComfyUI-Manager's published [extension-node-map.json at commit `855a0f50ecc842adacab08aa24d8655a742fae40`](https://github.com/Comfy-Org/ComfyUI-Manager/blob/855a0f50ecc842adacab08aa24d8655a742fae40/extension-node-map.json). The full mapping is bundled under `sources/data`; provenance records the upstream SHA-256 and date, and its GPL-3.0 licence is included. Manager's exact names, declared patterns and preemptions resolve ownership; ambiguous ownership is reported. A repository found through Manager is checked for an exact Registry repository match first. An unregistered GitHub repository gets a full 40-character commit from GitHub. Gist/single-file/pip mappings are unresolved because the node-pack installer cannot safely treat them as repositories.

Built-ins are the ComfyUI entry of that same pinned Manager snapshot, plus frontend-only Note/MarkdownNote/Reroute/PrimitiveNode and subgraph input/output furniture. Referenced nested subgraphs are traversed and container UUIDs are excluded. Newer runtimes can pass their own **core-only** class list as `builtins`; passing all installed nodes would incorrectly hide custom requirements. All-built-in graphs return no packs and make no network requests. Unknown types, inactive releases, conflicts and rate limits retain reasons in `unresolved`; cancellation is propagated. Do not install a partial resolution as if it were complete.

The caller installs packs automatically on the **chosen rendering computer**, in Alexia's owned ComfyUI, without a per-pack question. These source modules perform no installation or process launch. The installer records each returned pack's name, repository/source URL, exact version/commit and installation date; the workflow details display that record and retain author/permission metadata. Model downloads and the ComfyUI setup button remain the worker's responsibility. These modules do not change an installation owned by the person, library UI, or the integration plan; those files are outside this task's ownership. The requested `docs/spec/pages.md` path is absent; the equivalent existing page contract read for this task is `docs/authoring/pages.md`.

## Validation and remaining limits

Recorded responses and their provenance are in [`plugins/media/test/fixtures/sources`](../plugins/media/test/fixtures/sources/README.md). Tests stub every request and never use the network. Adapter tests cover search and fetch for both implemented sources, editor/API JSON, real ZIP decoding, member selection, authentication, redirects, cancellation, bounded downloads and incomplete catalogues. Resolver tests cover the real IPAdapter example, built-ins, subgraphs, exact Registry versions, Manager patterns/preemptions, unresolved classes, inactive releases and commit pins.

Validation commands and results:

- `pnpm vitest run --project unit plugins/media/test/sources.test.js` initially failed two fixture expectations (the actual creator is `maitruclam`, and the recorded download URL contains `fileId`); the expectations were corrected.
- `pnpm vitest run --project unit plugins/media/test/sources.test.js plugins/media/test/sources-nodes.test.js` passed **21 tests** before the additional upstream JSON example test.
- Final `pnpm vitest run --project unit plugins/media` passed **17 files / 155 tests**, including the upstream example test.
- Final `pnpm exec eslint plugins/media/sources plugins/media/test/sources.test.js plugins/media/test/sources-nodes.test.js` passed with no findings.

Actual rendering, installing Python packs, gated downloads, paid content and a paired Windows host were not exercised by this source task. No source supplies a general reliable VRAM estimator; model filename detection is deliberately incomplete for dynamically structured custom widgets. Current Civitai credential wording and unavailable comfyworkflows.com terms remain explicitly recorded access/legal limits.
