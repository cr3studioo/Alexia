// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Curated text-only GGUF builds. File metadata was fetched from the official HF API
 * by scripts/local-catalog.mjs --json, and is pinned rather than tracking main.
 * https://huggingface.co/docs/hub/api
 *
 * Provider means the original model publisher; repo names identify external quantizers.
 * Neither party is affiliated with Alexia. Licence links identify the pinned model card;
 * an uploader's missing licence is inherited from its declared upstream, explicitly below.
 * Params are the HF GGUF tensor totals, which may count duplicated tied embeddings.
 * tools denotes documented template capability, not a measured tool-use success rate.
 * Modified abliterated tool use is unverified and stays false. nsfwOk is a catalog routing
 * opt-in for those explicitly modified entries, not a guarantee of what they will answer.
 * vision is true only for an entry with a pinned projector (mmproj), downloaded beside the model.
 * KV is full-attention FP16 K+V for one sequence; no YaRN, cache compression, or
 * sliding-window savings. Context limits use the pinned GGUF, not expanded upstream limits.
 * These metadata pins do not claim compatibility with every runner release.
 */
export interface ModelFile {
  name: string
  bytes: number
  sha256: string
}
export type QuantFile = ModelFile
export interface Quantized {
  quant: string
  bytes: number
  files: ModelFile[]
}
export interface LocalEntry {
  format?: 'gguf' | 'mlx'
  id: string
  name: string
  publisher: string
  repo: string
  revision: string
  /** Billions of stored parameters reported by HF GGUF metadata. */
  params: number
  contextMax: number
  tools: boolean
  vision: boolean
  licence: { name: string; url: string; restrictive: boolean }
  gated: boolean
  abliterated: boolean
  nsfwOk: 'yes' | 'no' | 'unknown'
  blurb: string
  quants: Quantized[]
  /** The vision projector (mmproj) every quant of a vision entry is installed with. */
  projector?: ModelFile
  /** FP16 K+V per token, derived from source.configUrl. Optional for search results. */
  kvBytesPerToken?: number
  source?: { repo: string; revision: string; configUrl: string }
}

export const QUANT_NOTES: Readonly<Record<string, string>> = {
  IQ3_M: 'Three-bit weights: less storage, more quantization. Use Q4 or above when there is room.',
  Q3_K_M: 'Three-bit weights: less storage, more quantization. Use Q4 or above when there is room.',
  Q4_K_M: 'Four-bit mixed weights. The default download balances storage and precision.',
  Q5_K_M: 'Five-bit mixed weights. More storage and precision than Q4.',
  Q6_K: 'Six-bit weights. More storage and precision than Q5.',
  Q8_0: 'Eight-bit weights. The largest download offered here; not full precision.',
}

export const LOCAL_CATALOG: LocalEntry[] = [
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/tree/60b85c0e3d8fe0f6474f406922a26d12aca4550d
  // Model/config: https://huggingface.co/Qwen/Qwen3-0.6B/raw/c1899de289a04d12100db370d81485cdf75e47ca/config.json
  // Licence (apache-2.0): https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/README.md
  // FP16 KV: 2 * 2 * 28 layers * 8 KV heads * 128 dim = 114688 bytes/token.
  {
    "id": "qwen3-0.6b",
    "name": "Qwen3 0.6B",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-0.6B-GGUF",
    "revision": "60b85c0e3d8fe0f6474f406922a26d12aca4550d",
    "params": 0.751632384,
    "contextMax": 32768,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 114688,
    "source": {
      "repo": "Qwen/Qwen3-0.6B",
      "revision": "c1899de289a04d12100db370d81485cdf75e47ca",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-0.6B/raw/c1899de289a04d12100db370d81485cdf75e47ca/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 484220320,
        "files": [
          {
            "name": "Qwen_Qwen3-0.6B-Q4_K_M.gguf",
            "bytes": 484220320,
            "sha256": "9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 551378336,
        "files": [
          {
            "name": "Qwen_Qwen3-0.6B-Q5_K_M.gguf",
            "bytes": 551378336,
            "sha256": "2df7894c99ee7716f0ed3c7d454c2386a7ae976c4b0ad0e716d55399c1360648"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 622733728,
        "files": [
          {
            "name": "Qwen_Qwen3-0.6B-Q6_K.gguf",
            "bytes": 622733728,
            "sha256": "21e95febea68b223089e2382378e8c3155e587f5a6618ae3595e3d00c6885575"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 804753824,
        "files": [
          {
            "name": "Qwen_Qwen3-0.6B-Q8_0.gguf",
            "bytes": 804753824,
            "sha256": "c159d1518f16bc42533d9a09f034eb598b670341adc2b08b9a9751614aea71eb"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/tree/dcb19155b962dbb6389f4691a982043a8e651022
  // Model/config: https://huggingface.co/Qwen/Qwen3-1.7B/raw/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/config.json
  // Licence (apache-2.0): https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/README.md
  // FP16 KV: 2 * 2 * 28 layers * 8 KV heads * 128 dim = 114688 bytes/token.
  {
    "id": "qwen3-1.7b",
    "name": "Qwen3 1.7B",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-1.7B-GGUF",
    "revision": "dcb19155b962dbb6389f4691a982043a8e651022",
    "params": 2.031739904,
    "contextMax": 32768,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 114688,
    "source": {
      "repo": "Qwen/Qwen3-1.7B",
      "revision": "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-1.7B/raw/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 1282439584,
        "files": [
          {
            "name": "Qwen_Qwen3-1.7B-Q4_K_M.gguf",
            "bytes": 1282439584,
            "sha256": "72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 1471805856,
        "files": [
          {
            "name": "Qwen_Qwen3-1.7B-Q5_K_M.gguf",
            "bytes": 1471805856,
            "sha256": "4287aca1b231f27dbd20012c4bf9693c89b6c849dc02b7027096da54564d4037"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 1673007520,
        "files": [
          {
            "name": "Qwen_Qwen3-1.7B-Q6_K.gguf",
            "bytes": 1673007520,
            "sha256": "95aec3c8e76caf949b5a7a3b02adbb7e307eb0aa55880f6a6f9fb5f46abe6d4f"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 2165039520,
        "files": [
          {
            "name": "Qwen_Qwen3-1.7B-Q8_0.gguf",
            "bytes": 2165039520,
            "sha256": "74bb7c53538ab2cc81b93f0c64da14a503159de68cff3c6770428d3850479db3"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/tree/ae44f08e1392f39c0e474af10c3ff8355c8b6688
  // Model/config: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/raw/cdbee75f17c01a7cc42f958dc650907174af0554/config.json
  // Licence (apache-2.0): https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/README.md
  // FP16 KV: 2 * 2 * 36 layers * 8 KV heads * 128 dim = 147456 bytes/token.
  {
    "id": "qwen3-4b-instruct-2507",
    "name": "Qwen3 4B-Instruct-2507",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF",
    "revision": "ae44f08e1392f39c0e474af10c3ff8355c8b6688",
    "params": 4.022468096,
    "contextMax": 262144,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 147456,
    "source": {
      "repo": "Qwen/Qwen3-4B-Instruct-2507",
      "revision": "cdbee75f17c01a7cc42f958dc650907174af0554",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/raw/cdbee75f17c01a7cc42f958dc650907174af0554/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 2497280736,
        "files": [
          {
            "name": "Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
            "bytes": 2497280736,
            "sha256": "2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 2889513696,
        "files": [
          {
            "name": "Qwen_Qwen3-4B-Instruct-2507-Q5_K_M.gguf",
            "bytes": 2889513696,
            "sha256": "66713ce35a58a82fe87642d4ec13425bf9b9a46800fff5c49a665ef5701439dc"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 3306261216,
        "files": [
          {
            "name": "Qwen_Qwen3-4B-Instruct-2507-Q6_K.gguf",
            "bytes": 3306261216,
            "sha256": "324bcc583feabe9485df2521099bf913e2613048e7aa2bdcdbfe74f1acc7531e"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 4280405216,
        "files": [
          {
            "name": "Qwen_Qwen3-4B-Instruct-2507-Q8_0.gguf",
            "bytes": 4280405216,
            "sha256": "260b5b5b6ad73e44df81a43ea1f5c11c37007b6bac18eb3cd2016e8667c19662"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/tree/0b69f75b7472688e6808490aa2b85efdb81b5ce7
  // Model/config: https://huggingface.co/Qwen/Qwen3-8B/raw/b968826d9c46dd6066d109eabc6255188de91218/config.json
  // Licence (apache-2.0): https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/blob/0b69f75b7472688e6808490aa2b85efdb81b5ce7/README.md
  // FP16 KV: 2 * 2 * 36 layers * 8 KV heads * 128 dim = 147456 bytes/token.
  {
    "id": "qwen3-8b",
    "name": "Qwen3 8B",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-8B-GGUF",
    "revision": "0b69f75b7472688e6808490aa2b85efdb81b5ce7",
    "params": 8.19073536,
    "contextMax": 32768,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/blob/0b69f75b7472688e6808490aa2b85efdb81b5ce7/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 147456,
    "source": {
      "repo": "Qwen/Qwen3-8B",
      "revision": "b968826d9c46dd6066d109eabc6255188de91218",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-8B/raw/b968826d9c46dd6066d109eabc6255188de91218/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 5027784224,
        "files": [
          {
            "name": "Qwen_Qwen3-8B-Q4_K_M.gguf",
            "bytes": 5027784224,
            "sha256": "54fffa050078e984116639c83dfb64b5aa6d4cd474e018b076777c632bbccccd"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 5851112992,
        "files": [
          {
            "name": "Qwen_Qwen3-8B-Q5_K_M.gguf",
            "bytes": 5851112992,
            "sha256": "fa45032e10b515a10374426bee3a41d5340aa78b67f0bed503469479a9772d9b"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 6725899808,
        "files": [
          {
            "name": "Qwen_Qwen3-8B-Q6_K.gguf",
            "bytes": 6725899808,
            "sha256": "69a45d3c366bab1736b201fdb21eb9d58160999a0f330a79d2c096f50de8985d"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 8709518880,
        "files": [
          {
            "name": "Qwen_Qwen3-8B-Q8_0.gguf",
            "bytes": 8709518880,
            "sha256": "edbd7ae01df991a2d4061e61451ad3d6829d8ca19f7cc846f7177499ac280c33"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-14B-GGUF/tree/bd080f768a6401c2d5a7fa53a2e50cd8218a9ce2
  // Model/config: https://huggingface.co/Qwen/Qwen3-14B/raw/40c069824f4251a91eefaf281ebe4c544efd3e18/config.json
  // Licence (apache-2.0): https://huggingface.co/Qwen/Qwen3-14B/blob/40c069824f4251a91eefaf281ebe4c544efd3e18/README.md
  // FP16 KV: 2 * 2 * 40 layers * 8 KV heads * 128 dim = 163840 bytes/token.
  {
    "id": "qwen3-14b",
    "name": "Qwen3 14B",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-14B-GGUF",
    "revision": "bd080f768a6401c2d5a7fa53a2e50cd8218a9ce2",
    "params": 14.7683072,
    "contextMax": 32768,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/Qwen/Qwen3-14B/blob/40c069824f4251a91eefaf281ebe4c544efd3e18/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 163840,
    "source": {
      "repo": "Qwen/Qwen3-14B",
      "revision": "40c069824f4251a91eefaf281ebe4c544efd3e18",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-14B/raw/40c069824f4251a91eefaf281ebe4c544efd3e18/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 9001753632,
        "files": [
          {
            "name": "Qwen_Qwen3-14B-Q4_K_M.gguf",
            "bytes": 9001753632,
            "sha256": "915913e22399475dbe6c968ac014d9f1fbe08975e489279aede9d5c7b2c98eb6"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 10514570272,
        "files": [
          {
            "name": "Qwen_Qwen3-14B-Q5_K_M.gguf",
            "bytes": 10514570272,
            "sha256": "bf19bf5c77c530762012f71215b62aa8f0bae08111ee0d537b8496479e17cfa3"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 12121937952,
        "files": [
          {
            "name": "Qwen_Qwen3-14B-Q6_K.gguf",
            "bytes": 12121937952,
            "sha256": "de571a7d7c72b99de6d67e7f2b780d774c74f998e088c77133069568cad54294"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 15698534432,
        "files": [
          {
            "name": "Qwen_Qwen3-14B-Q8_0.gguf",
            "bytes": 15698534432,
            "sha256": "62e390154916e1dc6b00f63d997bda39e8f9679c209dcabb69bdff5043fac2e0"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/tree/533fbb1ae5f2ce96c9171acc169e1f68f9352eca
  // Model/config: https://huggingface.co/Qwen/Qwen3-32B/raw/9216db5781bf21249d130ec9da846c4624c16137/config.json
  // Licence (apache-2.0): https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/533fbb1ae5f2ce96c9171acc169e1f68f9352eca/README.md
  // FP16 KV: 2 * 2 * 64 layers * 8 KV heads * 128 dim = 262144 bytes/token.
  {
    "id": "qwen3-32b",
    "name": "Qwen3 32B",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen3-32B-GGUF",
    "revision": "533fbb1ae5f2ce96c9171acc169e1f68f9352eca",
    "params": 32.762123264,
    "contextMax": 32768,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/533fbb1ae5f2ce96c9171acc169e1f68f9352eca/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "General text model with documented tool calling. Memory estimates include its conversation cache.",
    "kvBytesPerToken": 262144,
    "source": {
      "repo": "Qwen/Qwen3-32B",
      "revision": "9216db5781bf21249d130ec9da846c4624c16137",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-32B/raw/9216db5781bf21249d130ec9da846c4624c16137/config.json"
    },
    "quants": [
      {
        "quant": "IQ3_M",
        "bytes": 14930083136,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-IQ3_M.gguf",
            "bytes": 14930083136,
            "sha256": "3d551f95bd02fcfb96fc53c9bdb8d709531f53cfb9170e13c951d72b306617c3"
          }
        ]
      },
      {
        "quant": "Q3_K_M",
        "bytes": 15971777856,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-Q3_K_M.gguf",
            "bytes": 15971777856,
            "sha256": "26f662712fa72a0649c5578a7e29afb34e7b73650181338e8c3a507cbd7bec50"
          }
        ]
      },
      {
        "quant": "Q4_K_M",
        "bytes": 19762149696,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-Q4_K_M.gguf",
            "bytes": 19762149696,
            "sha256": "e41ec56ddd376963a116da97506fadfccb50fb402bb6f3cb4be0bc179a582bd6"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 23214831936,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-Q5_K_M.gguf",
            "bytes": 23214831936,
            "sha256": "7fdd925c783007dc039e335a1ae0d792fff081e023b48d7fc86e781aa6344949"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 26883306816,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-Q6_K.gguf",
            "bytes": 26883306816,
            "sha256": "a2769b0ded67d384cbfd42e740c61feec4207566b86f36f3d915da2248f291b6"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 34817719616,
        "files": [
          {
            "name": "Qwen_Qwen3-32B-Q8_0.gguf",
            "bytes": 34817719616,
            "sha256": "bcb4c2d84e1d413fd3239ddaff64d5cca0928fe84af2349dee5f0ee3cc8ed84a"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/tree/b17cb02dd882d5b6ab62fc777ad2995f19668350
  // Model/config: https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/b2cff646eb4bb1d68355c01b18ae02e7cf42d120/config.json
  // Licence (apache-2.0): https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/blob/b17cb02dd882d5b6ab62fc777ad2995f19668350/README.md
  // FP16 KV: 2 * 2 * 48 layers * 4 KV heads * 128 dim = 98304 bytes/token.
  {
    "id": "qwen3-coder-30b-a3b-instruct",
    "name": "Qwen3 Coder-30B-A3B-Instruct",
    "publisher": "Qwen",
    "repo": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    "revision": "b17cb02dd882d5b6ab62fc777ad2995f19668350",
    "params": 30.532122624,
    "contextMax": 262144,
    "tools": true,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/blob/b17cb02dd882d5b6ab62fc777ad2995f19668350/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "Coding-focused text model with documented tool calling. All expert weights count toward memory.",
    "kvBytesPerToken": 98304,
    "source": {
      "repo": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "revision": "b2cff646eb4bb1d68355c01b18ae02e7cf42d120",
      "configUrl": "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/b2cff646eb4bb1d68355c01b18ae02e7cf42d120/config.json"
    },
    "quants": [
      {
        "quant": "Q3_K_M",
        "bytes": 14711850144,
        "files": [
          {
            "name": "Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf",
            "bytes": 14711850144,
            "sha256": "30c83da425db2324444b6a6cecaf4c410038a2ec73a78de2436879dc0316a371"
          }
        ]
      },
      {
        "quant": "Q4_K_M",
        "bytes": 18556689568,
        "files": [
          {
            "name": "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
            "bytes": 18556689568,
            "sha256": "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 21725584544,
        "files": [
          {
            "name": "Qwen3-Coder-30B-A3B-Instruct-Q5_K_M.gguf",
            "bytes": 21725584544,
            "sha256": "4b78837bbec5ee248e4a5642bf608b6793721af41b92589e40c8da0bce58b907"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 25092535456,
        "files": [
          {
            "name": "Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf",
            "bytes": 25092535456,
            "sha256": "100b5121d09553fb1af3b873b21fb3ec3da5c306fc5cb09bd338c48e21b10875"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 32483935392,
        "files": [
          {
            "name": "Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf",
            "bytes": 32483935392,
            "sha256": "4ff1cff607804037bf6d2168249c570baa4e1621292b159c0e06591e0d7c3066"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/mlabonne_Qwen3-8B-abliterated-GGUF/tree/0e66e6f836c802246b69941780ec8ef32670dc09
  // Model/config: https://huggingface.co/mlabonne/Qwen3-8B-abliterated/raw/30c72fa348f37c72d12ecbb259068ddee98aa9ed/config.json
  // Licence (apache-2.0): https://huggingface.co/bartowski/mlabonne_Qwen3-8B-abliterated-GGUF/blob/0e66e6f836c802246b69941780ec8ef32670dc09/README.md
  // FP16 KV: 2 * 2 * 36 layers * 8 KV heads * 128 dim = 147456 bytes/token.
  {
    "id": "qwen3-8b-abliterated",
    "name": "Qwen3 8B-abliterated",
    "publisher": "mlabonne / Qwen",
    "repo": "bartowski/mlabonne_Qwen3-8B-abliterated-GGUF",
    "revision": "0e66e6f836c802246b69941780ec8ef32670dc09",
    "params": 8.19073536,
    "contextMax": 40960,
    "tools": false,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/bartowski/mlabonne_Qwen3-8B-abliterated-GGUF/blob/0e66e6f836c802246b69941780ec8ef32670dc09/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": true,
    "nsfwOk": "yes",
    "blurb": "Separately modified abliterated text model. Tool use has not been verified.",
    "kvBytesPerToken": 147456,
    "source": {
      "repo": "mlabonne/Qwen3-8B-abliterated",
      "revision": "30c72fa348f37c72d12ecbb259068ddee98aa9ed",
      "configUrl": "https://huggingface.co/mlabonne/Qwen3-8B-abliterated/raw/30c72fa348f37c72d12ecbb259068ddee98aa9ed/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 5027784288,
        "files": [
          {
            "name": "mlabonne_Qwen3-8B-abliterated-Q4_K_M.gguf",
            "bytes": 5027784288,
            "sha256": "361557e69ad101ee22b1baf427283b7ddcf81bc7532b8cee8ac2c6b4d1b81ead"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 5851113056,
        "files": [
          {
            "name": "mlabonne_Qwen3-8B-abliterated-Q5_K_M.gguf",
            "bytes": 5851113056,
            "sha256": "0dec7daafa1fa3df665ccb79577d4b71d0f8bea0e7bc74c07f5b0a40cdfbb8fa"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 6725899872,
        "files": [
          {
            "name": "mlabonne_Qwen3-8B-abliterated-Q6_K.gguf",
            "bytes": 6725899872,
            "sha256": "1e1b047d8cf005dc57985727ce2cbd5d59c4e23cbda0cb8fca4448250add25c7"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 8709518944,
        "files": [
          {
            "name": "mlabonne_Qwen3-8B-abliterated-Q8_0.gguf",
            "bytes": 8709518944,
            "sha256": "94cb715802d16be9c082b3c6ae0350014e36dbcbfe78ad2d5122f42f2e2b5599"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/mlabonne_Qwen3-14B-abliterated-GGUF/tree/e42ad8d737563dc9c98f4cadf69b076394cec802
  // Model/config: https://huggingface.co/mlabonne/Qwen3-14B-abliterated/raw/9d8db58cddb750e732cd2179fa504e8830b733ce/config.json
  // Licence (apache-2.0): https://huggingface.co/bartowski/mlabonne_Qwen3-14B-abliterated-GGUF/blob/e42ad8d737563dc9c98f4cadf69b076394cec802/README.md
  // FP16 KV: 2 * 2 * 40 layers * 8 KV heads * 128 dim = 163840 bytes/token.
  {
    "id": "qwen3-14b-abliterated",
    "name": "Qwen3 14B-abliterated",
    "publisher": "mlabonne / Qwen",
    "repo": "bartowski/mlabonne_Qwen3-14B-abliterated-GGUF",
    "revision": "e42ad8d737563dc9c98f4cadf69b076394cec802",
    "params": 14.7683072,
    "contextMax": 40960,
    "tools": false,
    "vision": false,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/bartowski/mlabonne_Qwen3-14B-abliterated-GGUF/blob/e42ad8d737563dc9c98f4cadf69b076394cec802/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": true,
    "nsfwOk": "yes",
    "blurb": "Separately modified abliterated text model. Tool use has not been verified.",
    "kvBytesPerToken": 163840,
    "source": {
      "repo": "mlabonne/Qwen3-14B-abliterated",
      "revision": "9d8db58cddb750e732cd2179fa504e8830b733ce",
      "configUrl": "https://huggingface.co/mlabonne/Qwen3-14B-abliterated/raw/9d8db58cddb750e732cd2179fa504e8830b733ce/config.json"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 9001753696,
        "files": [
          {
            "name": "mlabonne_Qwen3-14B-abliterated-Q4_K_M.gguf",
            "bytes": 9001753696,
            "sha256": "3fe972a7c6e847ec791453b89a7333d369fbde329cbd4cc9a4f0598854db5d54"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 10514570336,
        "files": [
          {
            "name": "mlabonne_Qwen3-14B-abliterated-Q5_K_M.gguf",
            "bytes": 10514570336,
            "sha256": "6ba161c229e6e6442864bea87b311ce36b62c0c664f0c8eac75cc43ee0fb619b"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 12121938016,
        "files": [
          {
            "name": "mlabonne_Qwen3-14B-abliterated-Q6_K.gguf",
            "bytes": 12121938016,
            "sha256": "db037b17caecc0f5be69fb8e0fd759810acce911fe64d61a0116d46029509a16"
          }
        ]
      },
      {
        "quant": "Q8_0",
        "bytes": 15698534496,
        "files": [
          {
            "name": "mlabonne_Qwen3-14B-abliterated-Q8_0.gguf",
            "bytes": 15698534496,
            "sha256": "98244eaddf92baf49c9c820d0b1108d8c7906e5abd1575c7f8942873c578f9d8"
          }
        ]
      }
    ]
  },
  // Quantizer: https://huggingface.co/bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF/tree/956c2bbb32ce10ac80761c127daa18f77063fab1
  // Model/config: https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/raw/cc594898137f460bfe9f0759e9844b3ce807cfb5/config.json
  // Licence (apache-2.0): https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/blob/cc594898137f460bfe9f0759e9844b3ce807cfb5/README.md
  // FP16 KV: 2 * 2 * 28 layers * 4 KV heads * 128 dim = 57344 bytes/token.
  // Projector: the f16 mmproj from the same pinned revision; without it the model reads text only.
  {
    "id": "qwen2.5-vl-7b-instruct",
    "name": "Qwen2.5-VL 7B-Instruct",
    "publisher": "Qwen",
    "repo": "bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF",
    "revision": "956c2bbb32ce10ac80761c127daa18f77063fab1",
    "params": 7.615616512,
    "contextMax": 128000,
    "tools": false,
    "vision": true,
    "licence": {
      "name": "apache-2.0",
      "url": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/blob/cc594898137f460bfe9f0759e9844b3ce807cfb5/README.md",
      "restrictive": false
    },
    "gated": false,
    "abliterated": false,
    "nsfwOk": "no",
    "blurb": "Sees pictures as well as reading text: what the image editor plans and checks with. Memory estimates include its conversation cache, not the 1.4 GB projector.",
    "kvBytesPerToken": 57344,
    "source": {
      "repo": "Qwen/Qwen2.5-VL-7B-Instruct",
      "revision": "cc594898137f460bfe9f0759e9844b3ce807cfb5",
      "configUrl": "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/raw/cc594898137f460bfe9f0759e9844b3ce807cfb5/config.json"
    },
    "projector": {
      "name": "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf",
      "bytes": 1354162912,
      "sha256": "c24a7f5fcfc68286f0a217023b6738e73bea4f11787a43e8238d4bb1b8604cde"
    },
    "quants": [
      {
        "quant": "Q4_K_M",
        "bytes": 4683072320,
        "files": [
          {
            "name": "Qwen_Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
            "bytes": 4683072320,
            "sha256": "3f4513330aa7f109922bd701d773575484ae2b4a4090d6511260a2a4f8e3d069"
          }
        ]
      },
      {
        "quant": "Q5_K_M",
        "bytes": 5444830016,
        "files": [
          {
            "name": "Qwen_Qwen2.5-VL-7B-Instruct-Q5_K_M.gguf",
            "bytes": 5444830016,
            "sha256": "325935d89110f25765b1627de643fcb7dbb4a9a52ce3da1820fce170cb0ed4fb"
          }
        ]
      },
      {
        "quant": "Q6_K",
        "bytes": 6254197568,
        "files": [
          {
            "name": "Qwen_Qwen2.5-VL-7B-Instruct-Q6_K.gguf",
            "bytes": 6254197568,
            "sha256": "9cbdf6e5b899f5a5a65d904ea7891284768caeacfb1e5e2a6deb7406ecb71dac"
          }
        ]
      }
    ]
  },
]

export const entry = (id: string): LocalEntry | undefined => LOCAL_CATALOG.find((e) => e.id === id)
