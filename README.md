# CPU RAM GPU Status

Shows CPU usage, RAM usage, and GPU VRAM in the VS Code status bar, grouped together on the left side.

**Example:** `CPU: 12.34%  RAM: 7.45/15.89 GB  GPU: 2048/8192 MiB`

Click the GPU item to switch between GPUs when multiple are detected.

## Display Format

| Item | Format | Example |
|---|---|---|
| CPU | percentage (2 decimal places) | `CPU: 12.34%` |
| RAM | used/total in GB (2 decimal places) | `RAM: 7.45/15.89 GB` |
| GPU | VRAM used/total in MiB | `GPU: 2048/8192 MiB` |

## Requirements

- **CPU**: Built-in (`wmic` on Windows, `/proc/stat` on Linux, `top` on macOS)
- **RAM**: Built-in (Node.js `os` module — no external tools needed)
- **GPU** (optional): one of:
  - **NVIDIA** — `nvidia-smi` must be on PATH
  - **AMD on Linux** — `rocm-smi` must be on PATH

## Configuration

| Setting | Default | Description |
|---|---|---|
| `cpuRamGpuStatus.pollInterval` | `2000` | Refresh interval in milliseconds (min 500) |

## Commands

- **CPU RAM GPU Status: Select GPU to Display** — choose which GPU appears in the status bar (when multiple GPUs are present)
