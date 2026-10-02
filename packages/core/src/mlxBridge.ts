// SPDX-License-Identifier: AGPL-3.0-only
/** Bundled as source so packaged core needs no loose Python files. No Hub code is executed.
 * The pinned mlx-lm public Python API supplies inference; this bridge owns HTTP, authentication,
 * exact context limits, a single active cache and shutdown when core's ownership pipe closes. */
export const MLX_BRIDGE = String.raw`
import gc, hmac, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

settings = json.loads(sys.stdin.buffer.readline(65536))
def watch_owner():
    while os.read(0, 4096):
        pass
    os._exit(0)
threading.Thread(target=watch_owner, daemon=True).start()

import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler
# mlx-lm 0.31.3 predates the load(..., trust_remote_code=...) argument. Refuse
# its custom architecture escape hatch before calling the pinned public loader.
with open(os.path.join(settings['path'], 'config.json')) as source:
    config = json.load(source)
if config.get('model_type') != 'qwen3' or 'model_file' in config or 'auto_map' in config:
    raise ValueError('Custom MLX model code is unsupported.')
model, tokenizer = load(settings['path'], tokenizer_config={'trust_remote_code': False, 'local_files_only': True})

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def authorized(self):
        if self.headers.get('Origin') is not None or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + settings['key']):
            self.reply(401, {'error': 'Unauthorized local model request.'})
            return False
        return True
    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if not self.authorized(): return
        if self.path == '/health':
            self.reply(200, {'status': 'ok', 'model': settings['id']})
        elif self.path == '/v1/models':
            self.reply(200, {'object': 'list', 'data': [{'id': settings['id'], 'object': 'model'}]})
        else:
            self.reply(404, {'error': 'Unknown endpoint.'})
    def do_POST(self):
        if not self.authorized(): return
        if self.path != '/v1/chat/completions':
            self.reply(404, {'error': 'Unknown endpoint.'}); return
        streaming = False
        generator = None
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4 * 1024 * 1024: raise ValueError('Invalid request size.')
            request = json.loads(self.rfile.read(length))
            if request.get('model') != settings['id']: raise ValueError('The requested model is not loaded.')
            if request.get('tools'): raise ValueError('Tool use is not supported by this MLX runner yet.')
            messages = request.get('messages')
            if not isinstance(messages, list) or not messages: raise ValueError('Messages are required.')
            for message in messages:
                if not isinstance(message, dict) or message.get('role') not in ('system', 'user', 'assistant') or not isinstance(message.get('content'), str):
                    raise ValueError('This MLX runner accepts text messages only.')
            prompt = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False)
            maximum = request.get('max_tokens', min(512, settings['context'] - len(prompt)))
            if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1 or len(prompt) + maximum > settings['context']:
                raise ValueError('Prompt and answer exceed the configured context. Shorten the conversation or increase context in Models.')
            generator = stream_generate(model, tokenizer, prompt, max_tokens=maximum, sampler=make_sampler(0.0), kv_bits=settings['kvBits'], kv_group_size=64, quantized_kv_start=0, prefill_step_size=512)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            streaming = True
            stamp = 'local-' + str(time.time_ns())
            usage = {'prompt_tokens': len(prompt), 'completion_tokens': 0, 'total_tokens': len(prompt)}
            for response in generator:
                usage = {'prompt_tokens': response.prompt_tokens, 'completion_tokens': response.generation_tokens, 'total_tokens': response.prompt_tokens + response.generation_tokens}
                value = {'id': stamp, 'object': 'chat.completion.chunk', 'model': settings['id'], 'choices': [{'index': 0, 'delta': {'content': response.text}, 'finish_reason': response.finish_reason}]}
                self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode()); self.wfile.flush()
            self.wfile.write(('data: ' + json.dumps({'id': stamp, 'model': settings['id'], 'choices': [], 'usage': usage}) + '\n\ndata: [DONE]\n\n').encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, TypeError, KeyError) as error:
            if not streaming: self.reply(400, {'error': str(error)})
        except Exception as error:
            if not streaming: self.reply(500, {'error': 'Local generation failed: ' + str(error)[:300]})
            print('Local generation failed: ' + str(error)[:300], file=sys.stderr, flush=True)
        finally:
            if generator is not None: generator.close()
            gc.collect()
            mx.clear_cache()
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

# A sequential server prevents concurrent cache allocations. No port-selection race.
server = HTTPServer(('127.0.0.1', 0), Handler)
print(json.dumps({'ready': True, 'port': server.server_address[1]}), flush=True)
server.serve_forever()
`
