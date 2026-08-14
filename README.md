<p align="center">
  <img src="src/balto-mark.svg" width="88" alt="Balto dog mark" />
</p>

# Balto Speedrunner

Qwen 3.8 27B at 2x the speed on one RTX 5090. Code at 150 tok/s. Chat at up to 300 tok/s.

The normal path has no infrastructure screens. Run the installer, approve Windows if it asks to enable WSL, and Balto handles the rest. It resumes setup after a required restart, preserves partial downloads, and opens the coding workspace as soon as the model is ready.

The Windows app uses Tauri and the system WebView2 runtime. It does not bundle Chromium. Model inference runs in Docker, and Balto keeps its Node.js workspace runtime in its own app data directory.

## Measured on our RTX 5090

| Workload | Output speed | Context | Notes |
| --- | ---: | ---: | --- |
| Chat | Up to 300 tok/s | Short prompt | Warm model |
| Code | 150 tok/s | Live agent session | Real tool calls |

These are measurements from one machine, not a guarantee for every prompt. Prompt length, tool latency, GPU temperature, other GPU workloads, and sampling all affect speed.

## What the installer does

1. Confirms that the PC has one RTX 5090, enough free disk space, and current NVIDIA support.
2. Installs Docker Desktop in its official per-user WSL 2 mode, or starts an existing installation.
3. Downloads the `lmsysorg/sglang:qwen38-27b` image at the exact tested digest.
4. Creates a persistent Docker volume for model files, so interrupted downloads resume and updates do not erase weights.
5. Starts `RadixArk/Qwen3.8-27B-NVFP4` with `RadixArk/Qwen3.8-27B-DSpark` using the tested 80K configuration.
6. Installs the coding workspace into Balto's private app directory.
7. Runs one model at a time and refuses to compete with another app already using significant GPU memory.
8. Applies future performance configuration updates without deleting the persistent model cache.

The small app installer does not contain the Docker image or model weights. First launch requires a large download and at least 90 GB of free disk space.

## Private remote steering

Balto can use Tailscale Serve after the owner signs in to Tailscale. It keeps the workspace bound to `127.0.0.1` and exposes private HTTPS endpoints only inside the user's tailnet. Balto does not enable Tailscale Funnel or open a public router port.

The Settings screen shows the exact private URL and lets the owner turn remote access off without changing unrelated Tailscale routes.

## Tested configuration

The inference arguments live in [`runtime/balto.ps1`](runtime/balto.ps1). The important settings are:

```text
context length        80000
KV cache              fp8_e4m3
attention backend     flashinfer
max running requests  1
speculation           DSpark, block size 7
sampling              temperature 0.6, top_p 0.95, top_k 20
reasoning effort       off by default
```

Balto uses safe sampling defaults for coding. It does not force greedy temperature zero sampling, which can trap this model in repetitive reasoning loops.

## Development

Requirements:

- Windows 11
- Node.js 22 or newer
- Rust stable with the MSVC target
- WebView2

```powershell
npm install
npm run check
npm run dev
```

Build the NSIS installer:

```powershell
npm run build
```

## Release signing

Balto supports two different signatures:

- Tauri updater signatures protect update artifacts and are required by the in-app updater.
- Windows Authenticode identifies Adore LLC as the publisher and prevents the unsigned-app SmartScreen warning.

The release workflow requires an Azure Artifact Signing account and certificate profile. It refuses to publish a release without those credentials. Local development builds remain unsigned.

## License and credits

Balto Speedrunner is copyright 2026 Adore LLC and distributed under the MIT License.

The coding agent interface integrates MIT-licensed software from DeepSeek AI. Inference is powered by SGLang. Qwen model weights remain under their own license. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the full notices.

Balto Speedrunner is not affiliated with or endorsed by DeepSeek, Qwen, Alibaba, SGLang, LMSYS, NVIDIA, Docker, Tailscale, Microsoft, or OpenAI.

If Balto saves you setup time, [buy me a coffee](https://buymeacoffee.com/refresh1).
