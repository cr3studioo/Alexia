# SPDX-License-Identifier: AGPL-3.0-only
"""Controlled browser replay; no network research or model calls.

Run with a Python that has Playwright installed and PLAYWRIGHT_BROWSERS_PATH
pointing at its Chromium installation. Requires the workspace Node dependencies.
Measures browser producer latency and viewer display lag, not live research latency.
"""
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
REPLAY = """async (mode) => {
  let snapshot = null, polls = 0, frames = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function(...args) { frames++; return clear.apply(this,args) };
  const view = mode === 'closed' ? null : researchViewer({plugin:'fixture', send: async () => { polls++; return {snapshot} }});
  if (view) { document.body.append(view); if (mode === 'hidden') view.style.display = 'none' }
  await new Promise(r => setTimeout(r, 50));
  const begin = performance.now(), startedAt = Date.now();
  const sources = [];
  for (let i=1; i<=8; i++) {
    await new Promise(r => setTimeout(r, 500));
    sources.push({id:'S'+i,url:'https://example.org/'+i,title:'Recorded source '+i,state:'complete',passages:Array.from({length:3},(_,p)=>({id:'P'+(p+1),text:('Research evidence describes the measured behavior of a controlled browser fixture. ').repeat(5)}))});
    snapshot={runId:'fixture',conversationId:'fixture',sequence:i,topic:'Measured browser behavior',startedAt,elapsedMs:performance.now()-begin,stage:'reading',completion:'running',currentSourceId:'S'+i,sources:[...sources],counters:{read:i,inProgress:0,failed:0},gaps:[]};
  }
  await new Promise(r => setTimeout(r, 300));
  snapshot={...snapshot,sequence:9,stage:'finished',completion:'complete'};
  const completed = performance.now();
  let displayMs = null;
  if (mode === 'visible') {
    const deadline=completed+2000;
    while(!view.querySelector('.research-stage').textContent.startsWith('Finished')) {
      if(performance.now()>deadline) throw new Error('Viewer did not display completion');
      await new Promise(r=>setTimeout(r,10));
    }
    displayMs=performance.now()-completed;
  }
  return {mode,producerMs:completed-begin,displayMs,polls,frames};
}"""

with tempfile.TemporaryDirectory(prefix='alexia-viewer-benchmark-') as temp:
    bundle = Path(temp) / 'viewer.js'
    subprocess.run(['node', '--input-type=module', '-e',
        "import {build} from 'esbuild'; await build({entryPoints:['packages/ui/src/research.ts'],bundle:true,format:'iife',globalName:'ResearchModule',outfile:process.argv[1]})", str(bundle)], cwd=ROOT, check=True)
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for iteration in range(6):
                # Rotate order to avoid assigning all warm-up effects to one mode.
                modes = ['closed', 'visible', 'hidden']
                modes = modes[iteration % 3:] + modes[:iteration % 3]
                for mode in modes:
                    page = browser.new_page(viewport={'width': 1100, 'height': 800})
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    try:
                        page.set_content('<html><body></body></html>')
                        page.add_style_tag(path=str(ROOT / 'packages/ui/app.css'))
                        page.add_style_tag(content='.research-viewer{width:700px;height:489px}')
                        page.add_script_tag(path=str(bundle))
                        page.add_script_tag(content='const researchViewer = ResearchModule.researchViewer;')
                        result = page.evaluate(REPLAY, mode)
                        if errors:
                            raise RuntimeError(errors)
                        if mode == 'visible' and (not result['polls'] or not result['frames']):
                            raise RuntimeError('Visible replay did not poll and animate')
                        if mode == 'hidden' and (result['polls'] or result['frames']):
                            raise RuntimeError('Hidden viewer did work')
                        results.append(result)
                    finally:
                        page.close()
        finally:
            browser.close()
    summary = {}
    for mode in ['closed', 'visible', 'hidden']:
        rows = [row for row in results if row['mode'] == mode]
        summary[mode] = {'samples': len(rows), 'producerMedianMs': round(statistics.median(row['producerMs'] for row in rows), 2), 'maxPolls': max(row['polls'] for row in rows), 'maxFrames': max(row['frames'] for row in rows)}
        if mode == 'visible':
            summary[mode]['domCompletionLagMedianMs'] = round(statistics.median(row['displayMs'] for row in rows), 2)
    print(json.dumps({'scope': 'synthetic browser replay; excludes retrieval and synthesis', 'summary': summary, 'samples': results}, indent=2))
