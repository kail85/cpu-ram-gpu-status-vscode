import * as vscode from 'vscode';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execAsync = promisify(exec);

// ─── GPU ──────────────────────────────────────────────────────────────────────

interface GpuInfo {
  index: number;
  name: string;
  usedMiB: number;
  totalMiB: number;
}

async function queryNvidiaSmi(): Promise<GpuInfo[]> {
  const { stdout } = await execAsync(
    'nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader,nounits',
    { timeout: 5000 }
  );
  return stdout
    .trim()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      const parts = line.split(',');
      if (parts.length < 4) return null;
      const index = parseInt(parts[0].trim(), 10);
      const totalMiB = parseInt(parts[parts.length - 1].trim(), 10);
      const usedMiB = parseInt(parts[parts.length - 2].trim(), 10);
      const name = parts.slice(1, parts.length - 2).join(',').trim();
      if (isNaN(index) || isNaN(usedMiB) || isNaN(totalMiB)) return null;
      return { index, name, usedMiB, totalMiB };
    })
    .filter((g): g is GpuInfo => g !== null);
}

async function queryRocmSmi(): Promise<GpuInfo[]> {
  const { stdout } = await execAsync('rocm-smi --showmeminfo vram --json', { timeout: 5000 });
  const data: Record<string, Record<string, string>> = JSON.parse(stdout);
  const gpus: GpuInfo[] = [];
  let index = 0;
  for (const [key, val] of Object.entries(data)) {
    if (key.toLowerCase().startsWith('card')) {
      const usedBytes = parseInt(val['VRAM Total Used Memory (B)'] ?? '0', 10);
      const totalBytes = parseInt(val['VRAM Total Memory (B)'] ?? '0', 10);
      gpus.push({
        index,
        name: `AMD GPU (${key})`,
        usedMiB: Math.round(usedBytes / 1_048_576),
        totalMiB: Math.round(totalBytes / 1_048_576),
      });
      index++;
    }
  }
  return gpus;
}

async function detectGpus(): Promise<GpuInfo[]> {
  try {
    const gpus = await queryNvidiaSmi();
    if (gpus.length > 0) return gpus;
  } catch {
    // nvidia-smi not available
  }
  try {
    const gpus = await queryRocmSmi();
    if (gpus.length > 0) return gpus;
  } catch {
    // rocm-smi not available
  }
  return [];
}

// ─── CPU ──────────────────────────────────────────────────────────────────────

// Linux: track previous /proc/stat snapshot for delta calculation
let prevLinuxCpu: { idle: number; total: number } | null = null;

function readLinuxCpuStat(): { idle: number; total: number } {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // fields: user, nice, system, idle, iowait, irq, softirq, steal, ...
  const idle = parts[3] + (parts[4] ?? 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function queryCpuPercent(): Promise<number> {
  switch (process.platform) {
    case 'win32': {
      const { stdout } = await execAsync(
        'wmic cpu get loadpercentage /value',
        { timeout: 5000 }
      );
      const match = stdout.match(/LoadPercentage=(\d+)/);
      if (match) return parseFloat(match[1]);
      throw new Error('Could not parse CPU usage from wmic');
    }

    case 'linux': {
      const curr = readLinuxCpuStat();
      if (prevLinuxCpu === null) {
        // First call: no delta yet, store snapshot and return 0
        prevLinuxCpu = curr;
        return 0;
      }
      const dIdle = curr.idle - prevLinuxCpu.idle;
      const dTotal = curr.total - prevLinuxCpu.total;
      prevLinuxCpu = curr;
      return dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    }

    case 'darwin': {
      // Run top twice so the second sample is an actual delta
      const { stdout } = await execAsync(
        'top -l 2 -s 0 | grep "CPU usage" | tail -1',
        { timeout: 10000, shell: '/bin/bash' }
      );
      const match = stdout.match(/([\d.]+)%\s+user.*?([\d.]+)%\s+sys/);
      if (match) return parseFloat(match[1]) + parseFloat(match[2]);
      throw new Error('Could not parse CPU usage from top');
    }

    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ─── RAM ──────────────────────────────────────────────────────────────────────

function queryRam(): { usedGiB: number; totalGiB: number } {
  const GiB = 1024 ** 3;
  const totalGiB = os.totalmem() / GiB;
  const usedGiB = (os.totalmem() - os.freemem()) / GiB;
  return { usedGiB, totalGiB };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Three left-aligned items grouped together (priorities 100 → 98, left-to-right)
  const cpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const ramItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const gpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);

  cpuItem.name = 'CPU Usage';
  ramItem.name = 'RAM Usage';
  gpuItem.name = 'GPU VRAM';

  cpuItem.text = '$(pulse) CPU: …';
  ramItem.text = '$(database) RAM: …';
  gpuItem.text = '$(circuit-board) GPU: …';
  gpuItem.command = 'cpuRamGpuStatus.selectGpu';

  cpuItem.show();
  ramItem.show();
  gpuItem.show();

  context.subscriptions.push(cpuItem, ramItem, gpuItem);

  let selectedGpuIndex = 0;
  let cachedGpus: GpuInfo[] = [];

  async function updateStatus(): Promise<void> {
    // CPU
    try {
      const pct = await queryCpuPercent();
      cpuItem.text = `$(pulse) CPU: ${pct.toFixed(2)}%`;
      cpuItem.tooltip = `CPU Usage: ${pct.toFixed(2)}%`;
    } catch (err) {
      cpuItem.text = '$(pulse) CPU: N/A';
      cpuItem.tooltip = `Error reading CPU: ${String(err)}`;
    }

    // RAM
    try {
      const { usedGiB, totalGiB } = queryRam();
      ramItem.text = `$(database) RAM: ${usedGiB.toFixed(2)}/${totalGiB.toFixed(2)} GB`;
      ramItem.tooltip = `RAM: ${usedGiB.toFixed(2)} GB used / ${totalGiB.toFixed(2)} GB total`;
    } catch (err) {
      ramItem.text = '$(database) RAM: N/A';
      ramItem.tooltip = `Error reading RAM: ${String(err)}`;
    }

    // GPU
    try {
      const gpus = await detectGpus();
      cachedGpus = gpus;

      if (gpus.length === 0) {
        gpuItem.text = '$(circuit-board) GPU: N/A';
        gpuItem.tooltip = 'No GPU detected. Ensure nvidia-smi or rocm-smi is on PATH.';
        return;
      }

      if (selectedGpuIndex >= gpus.length) selectedGpuIndex = 0;
      const gpu = gpus[selectedGpuIndex];
      gpuItem.text = `$(circuit-board) GPU: ${gpu.usedMiB}/${gpu.totalMiB} MiB`;

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${gpu.name}**\n\nVRAM: ${gpu.usedMiB} MiB / ${gpu.totalMiB} MiB`);
      if (gpus.length > 1) {
        md.appendMarkdown(`\n\n*Click to switch GPU (${gpus.length} GPUs detected)*`);
      }
      gpuItem.tooltip = md;
    } catch (err) {
      gpuItem.text = '$(circuit-board) GPU: Error';
      gpuItem.tooltip = `Error querying GPU: ${String(err)}`;
    }
  }

  async function selectGpu(): Promise<void> {
    if (cachedGpus.length === 0) {
      vscode.window.showWarningMessage('No GPUs detected. Ensure nvidia-smi or rocm-smi is on PATH.');
      return;
    }
    if (cachedGpus.length === 1) {
      const gpu = cachedGpus[0];
      vscode.window.showInformationMessage(
        `${gpu.name}: ${gpu.usedMiB} MiB / ${gpu.totalMiB} MiB (only one GPU detected)`
      );
      return;
    }

    const items = cachedGpus.map(gpu => ({
      label: gpu.name,
      description: `${gpu.usedMiB} MiB / ${gpu.totalMiB} MiB`,
      detail: `GPU index: ${gpu.index}`,
      gpuIndex: gpu.index,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select GPU to display in status bar',
    });

    if (picked) {
      selectedGpuIndex = picked.gpuIndex;
      await updateStatus();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('cpuRamGpuStatus.selectGpu', selectGpu)
  );

  updateStatus();

  const config = vscode.workspace.getConfiguration('cpuRamGpuStatus');
  let pollInterval = Math.max(500, config.get<number>('pollInterval', 2000));
  let timer = setInterval(updateStatus, pollInterval);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cpuRamGpuStatus.pollInterval')) {
        clearInterval(timer);
        pollInterval = Math.max(
          500,
          vscode.workspace.getConfiguration('cpuRamGpuStatus').get<number>('pollInterval', 2000)
        );
        timer = setInterval(updateStatus, pollInterval);
      }
    }),
    { dispose: () => clearInterval(timer) }
  );
}

export function deactivate(): void {}
