// SPDX-License-Identifier: AGPL-3.0-only
import type { LocalEntry } from './localCatalog.js'

/** Pinned, checksum-verified MLX Qwen3 builds. Metadata from the Hugging Face tree API. */
export const MLX_CATALOG: LocalEntry[] = [
  {
    "format": "mlx",
    "id": "mlx-qwen3-0.6b",
    "name": "MLX Qwen3 0.6B",
    "publisher": "mlx-community",
    "repo": "mlx-community/Qwen3-0.6B-4bit",
    "revision": "73e3e38d981303bc594367cd910ea6eb48349da8",
    "params": 0.59604992,
    "contextMax": 40960,
    "kvBytesPerToken": 114688,
    "tools": false,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/mlx-community/Qwen3-0.6B-4bit/tree/73e3e38d981303bc594367cd910ea6eb48349da8",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "Apple Silicon MLX 4-bit build. Tool use has not been checked.",
    "quants": [
      {
        "quant": "MLX_4BIT",
        "bytes": 351383618,
        "files": [
          {
            "name": "added_tokens.json",
            "bytes": 707,
            "sha256": "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680"
          },
          {
            "name": "config.json",
            "bytes": 937,
            "sha256": "15d3ac26c043ae477273ed5802ee0f0b33bb14f18c9d3dd70910c02d906e3f1f"
          },
          {
            "name": "merges.txt",
            "bytes": 1671853,
            "sha256": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"
          },
          {
            "name": "model.safetensors",
            "bytes": 335450584,
            "sha256": "392e8d466d56100ada00eb82031fb854297fc9e389b7d303eba3af114e87bce2"
          },
          {
            "name": "model.safetensors.index.json",
            "bytes": 49731,
            "sha256": "7b294141456f6904936db03c00bca50fb5f6198f652fe8483f9cd2a1018accfb"
          },
          {
            "name": "special_tokens_map.json",
            "bytes": 613,
            "sha256": "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd"
          },
          {
            "name": "tokenizer_config.json",
            "bytes": 9706,
            "sha256": "253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0"
          },
          {
            "name": "tokenizer.json",
            "bytes": 11422654,
            "sha256": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"
          },
          {
            "name": "vocab.json",
            "bytes": 2776833,
            "sha256": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"
          }
        ]
      }
    ]
  },
  {
    "format": "mlx",
    "id": "mlx-qwen3-1.7b",
    "name": "MLX Qwen3 1.7B",
    "publisher": "mlx-community",
    "repo": "mlx-community/Qwen3-1.7B-4bit",
    "revision": "3b1b1768f8f8cf8351c712464f906e86c2b8269e",
    "params": 1.720574976,
    "contextMax": 40960,
    "kvBytesPerToken": 114688,
    "tools": false,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/mlx-community/Qwen3-1.7B-4bit/tree/3b1b1768f8f8cf8351c712464f906e86c2b8269e",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "Apple Silicon MLX 4-bit build. Tool use has not been checked.",
    "quants": [
      {
        "quant": "MLX_4BIT",
        "bytes": 984013244,
        "files": [
          {
            "name": "added_tokens.json",
            "bytes": 707,
            "sha256": "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680"
          },
          {
            "name": "config.json",
            "bytes": 937,
            "sha256": "507a6701220524eb8b283425bf0856a9ae4f21f4052e563896ddd668994b1dc7"
          },
          {
            "name": "merges.txt",
            "bytes": 1671853,
            "sha256": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"
          },
          {
            "name": "model.safetensors",
            "bytes": 968080210,
            "sha256": "0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f"
          },
          {
            "name": "model.safetensors.index.json",
            "bytes": 49731,
            "sha256": "1e3058d4ba4b04e4de35b74467725cbef90ff022198404218e48f21adc9cfa15"
          },
          {
            "name": "special_tokens_map.json",
            "bytes": 613,
            "sha256": "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd"
          },
          {
            "name": "tokenizer_config.json",
            "bytes": 9706,
            "sha256": "253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0"
          },
          {
            "name": "tokenizer.json",
            "bytes": 11422654,
            "sha256": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"
          },
          {
            "name": "vocab.json",
            "bytes": 2776833,
            "sha256": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"
          }
        ]
      }
    ]
  }
]
