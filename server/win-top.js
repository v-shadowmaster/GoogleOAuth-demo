#!/usr/bin/env node
/**
 * win-top-advanced.js
 *
 * Advanced, btop-style system monitor for Windows 10/11 in pure Node.js.
 *
 * Features:
 * - SYSTEM panel:
 *   - CPU usage (% + bar)
 *   - Memory usage (used/total + bar)
 *   - Uptime, process count
 *   - Estimated system power (CPU + RAM in watts)
 *   - Battery charge/status (if present)
 *   - Active power scheme (Balanced/High performance/etc.)
 *   - CPU model + logical cores
 *
 * - PROCESS panel:
 *   - PID, CPU%, Estimated W, MEM, NAME, COMMAND
 *   - Per-process estimated watts from CPU% and RSS
 *
 * - Interaction:
 *   - c/m/p/n: sort
 *   - r: reverse sort
 *   - /: filter
 *   - +/-: change refresh interval
 *   - k: kill PID
 *   - q / Ctrl+C: quit
 *
 * Implementation:
 * - Node.js + PowerShell (Get-CimInstance, Get-Process, Get-Counter, powercfg).
 * - No external npm deps.
 */

const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const readline = require('readline');

const execP = util.promisify(exec);

// ---------------- CLI args ----------------

const argv = process.argv.slice(2);
function getArg(names, fallback) {
    for (const n of names) {
        const idx = argv.indexOf(n);
        if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    }
    return fallback;
}

let intervalMs = parseInt(getArg(['--interval', '-i'], '1000'), 10) || 1000;
let topN = parseInt(getArg(['--top', '-t'], '20'), 10) || 20;

// Power model knobs
const CPU_TDP_W =
    parseFloat(getArg(['--cpu-tdp'], process.env.CPU_TDP_W || '15')) || 15;
const MEM_W_PER_GB =
    parseFloat(getArg(['--mem-watt-gb'], process.env.MEM_W_PER_GB || '1.5')) || 1.5;

// ---------------- ANSI helpers ----------------

const ansi = {
    bold: '\x1b[1m',
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    underline: '\x1b[4m',
};

function pad(text, width) {
    let s = String(text === undefined || text === null ? '' : text);
    if (s.length > width) return s.slice(0, width);
    if (s.length < width) return s + ' '.repeat(width - s.length);
    return s;
}

function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const v = bytes / Math.pow(1024, i);
    return `${v.toFixed(1)} ${units[i]}`;
}

function progressBar(percentage, width) {
    const pct = Math.max(0, Math.min(100, percentage || 0));
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + ' '.repeat(empty);
}

function timestamp() {
    return new Date().toLocaleTimeString();
}

// ---------------- PowerShell helpers ----------------

async function powershellJson(innerCommand) {
    const cmd =
        `powershell -NoProfile -Command "Try{ ${innerCommand} | ConvertTo-Json -Depth 4 -Compress } Catch { 'null' }"`;
    try {
        const { stdout } = await execP(cmd, { maxBuffer: 20 * 1024 * 1024 });
        const out = stdout.trim();
        if (!out || out === 'null') return null;
        return JSON.parse(out);
    } catch {
        return null;
    }
}

// ---------------- System sampling ----------------

let logicalCores = os.cpus().length;
let cpuModel = 'Unknown CPU';

async function detectLogicalCores() {
    try {
        const { stdout } = await execP(
            'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors"',
            { maxBuffer: 200000 }
        );
        const val = parseInt(stdout.trim(), 10);
        if (!Number.isNaN(val) && val > 0) logicalCores = val;
    } catch {
        // fallback
    }
}

async function detectCpuModel() {
    try {
        const { stdout } = await execP(
            'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Name"',
            { maxBuffer: 200000 }
        );
        const s = stdout.trim();
        if (s) cpuModel = s.replace(/\s+/g, ' ');
    } catch {
        cpuModel = 'Unknown CPU';
    }
}

async function sampleBattery() {
    try {
        const data = await powershellJson(
            'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus'
        );
        if (!data) return null;
        const b = Array.isArray(data) ? data[0] : data;
        if (!b) return null;
        const charge = b.EstimatedChargeRemaining;
        const statusCode = b.BatteryStatus;
        let status = 'Unknown';
        switch (statusCode) {
            case 1: status = 'Discharging'; break;
            case 2: status = 'AC/Online'; break;
            case 3: status = 'Fully charged'; break;
            case 4: status = 'Low'; break;
            case 5: status = 'Critical'; break;
            case 6: status = 'Charging'; break;
            case 7: status = 'Charging (High)'; break;
            case 8: status = 'Charging (Low)'; break;
            case 9: status = 'Charging (Critical)'; break;
            case 10: status = 'Undefined'; break;
            case 11: status = 'Partially charged'; break;
            default: status = 'Unknown';
        }
        return {
            charge: Number.isFinite(charge) ? charge : null,
            status,
        };
    } catch {
        return null;
    }
}

async function samplePowerScheme() {
    try {
        const { stdout } = await execP('powercfg /getactivescheme', {
            maxBuffer: 200000,
        });
        const s = stdout.trim();
        const m = s.match(/\(([^)]+)\)/);
        if (m && m[1]) return m[1];
        return s || 'Unknown';
    } catch {
        return 'Unknown';
    }
}

async function sampleSystem() {
    // CPU (total)
    let cpu = 0;
    try {
        const { stdout } = await execP(
            "powershell -NoProfile -Command \"(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue\"",
            { maxBuffer: 200000 }
        );
        cpu = parseFloat(stdout.trim()) || 0;
    } catch {
        cpu = 0;
    }

    // Memory
    let totalMem = os.totalmem();
    let usedMem = totalMem - os.freemem();
    try {
        const memJson = await powershellJson(
            'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory'
        );
        if (memJson) {
            const m = Array.isArray(memJson) ? memJson[0] : memJson;
            const totalKB = m.TotalVisibleMemorySize;
            const freeKB = m.FreePhysicalMemory;
            if (totalKB && freeKB) {
                totalMem = totalKB * 1024;
                const freeMem = freeKB * 1024;
                usedMem = Math.max(0, totalMem - freeMem);
            }
        }
    } catch {
        // fallback
    }

    // Process count
    let procCount = 0;
    try {
        const { stdout } = await execP(
            'powershell -NoProfile -Command "(Get-Process).Count"',
            { maxBuffer: 200000 }
        );
        procCount = parseInt(stdout.trim(), 10) || 0;
    } catch {
        procCount = 0;
    }

    // Uptime
    let uptime = 'N/A';
    try {
        const { stdout } = await execP(
            'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; $u = (Get-Date) - $os.LastBootUpTime; \'{0}d {1}h {2}m\' -f $u.Days,$u.Hours,$u.Minutes"',
            { maxBuffer: 200000 }
        );
        const s = stdout.trim();
        if (s) uptime = s;
    } catch {
        uptime = 'N/A';
    }

    // Estimated power
    const cpuPct = Math.max(0, Math.min(100, cpu || 0));
    const usedMemGB = usedMem / (1024 * 1024 * 1024);
    const cpuW = (cpuPct / 100) * CPU_TDP_W;
    const memW = usedMemGB * MEM_W_PER_GB;
    const estPowerW = cpuW + memW;

    return { cpu, totalMem, usedMem, procCount, uptime, estPowerW, cpuW, memW };
}

// ---------------- Process sampling ----------------

// CPU sampling state: pid -> last CPU seconds
let prevCpuMap = new Map();
let prevSampleTime = Date.now();

async function sampleProcessesRaw() {
    const cmd =
        'Get-CimInstance Win32_Process | ' +
        'Select-Object ProcessId,Name,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize';
    const data = await powershellJson(cmd);
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return [data];
}

async function sampleProcesses() {
    const now = Date.now();
    const dtSec = Math.max((now - prevSampleTime) / 1000, 0.001);
    prevSampleTime = now;

    const raw = await sampleProcessesRaw();
    const rows = [];

    for (const p of raw) {
        const pid = Number(p.ProcessId || 0);
        const kTicks = Number(p.KernelModeTime || 0);
        const uTicks = Number(p.UserModeTime || 0);
        const totalTicks = kTicks + uTicks; // 100ns units
        const cpuSec = totalTicks / 1e7;

        const prev = prevCpuMap.get(pid) || 0;
        const delta = Math.max(0, cpuSec - prev);
        const cpuPct = (delta / dtSec) / Math.max(1, logicalCores) * 100;

        const memBytes = Number(p.WorkingSetSize || 0);
        const memGB = memBytes / (1024 * 1024 * 1024);
        const estW = (Math.max(0, cpuPct) / 100) * CPU_TDP_W + memGB * MEM_W_PER_GB;

        rows.push({
            pid,
            name: p.Name || '',
            cmd: (p.CommandLine || '').trim(),
            cpuSec,
            cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0,
            memBytes,
            estW: Number.isFinite(estW) ? estW : 0,
        });
    }

    prevCpuMap.clear();
    for (const r of rows) prevCpuMap.set(r.pid, r.cpuSec);

    return rows;
}

// ---------------- Sorting & filtering ----------------

let sortBy = 'cpu'; // cpu | mem | pid | name | power
let sortDesc = true;
let filterStr = '';

function sortAndFilterProcesses(rows) {
    let filtered = rows;

    if (filterStr) {
        const f = filterStr.toLowerCase();
        filtered = rows.filter(
            (r) =>
                (r.name && r.name.toLowerCase().includes(f)) ||
                (r.cmd && r.cmd.toLowerCase().includes(f))
        );
    }

    const cmpMap = {
        cpu: (a, b) => a.cpuPct - b.cpuPct,
        mem: (a, b) => a.memBytes - b.memBytes,
        pid: (a, b) => a.pid - b.pid,
        name: (a, b) => a.name.localeCompare(b.name),
        power: (a, b) => a.estW - b.estW,
    };
    const cmp = cmpMap[sortBy] || cmpMap.cpu;

    filtered.sort((a, b) => (sortDesc ? -1 : 1) * cmp(a, b));

    return filtered.slice(0, topN);
}

// ---------------- Rendering ----------------

function render(system, processes, battery, powerScheme) {
    console.clear();

    const width = process.stdout.columns || 120;

    // Title
    process.stdout.write(
        `${ansi.bold}${ansi.cyan}win-top+ — Windows performance monitor${ansi.reset}   ` +
        `${ansi.dim}[${timestamp()}]${ansi.reset}\n`
    );

    // CPU model line
    const trimmedModel =
        cpuModel.length > width - 20 ? cpuModel.slice(0, width - 23) + '...' : cpuModel;
    process.stdout.write(
        `${ansi.dim}CPU:${ansi.reset} ${trimmedModel}   ` +
        `${ansi.dim}Logical cores:${ansi.reset} ${logicalCores}   ` +
        `${ansi.dim}TDP model:${ansi.reset} ${CPU_TDP_W}W CPU, ${MEM_W_PER_GB}W/GB RAM\n`
    );

    // SYSTEM PANEL
    const cpuPct = Math.max(0, Math.min(100, system.cpu || 0));
    const memPct = system.totalMem ? (system.usedMem / system.totalMem) * 100 : 0;
    const barWidth = Math.min(40, Math.max(10, Math.floor(width * 0.4)));

    process.stdout.write('\n');
    process.stdout.write(`${ansi.bold}SYSTEM${ansi.reset}\n`);

    // CPU line
    const cpuBar = progressBar(cpuPct, barWidth);
    let cpuColor = ansi.green;
    if (cpuPct > 70) cpuColor = ansi.red;
    else if (cpuPct > 40) cpuColor = ansi.yellow;

    process.stdout.write(
        ` CPU  ${cpuColor}${pad(cpuPct.toFixed(1) + '%', 7)}${ansi.reset} [${cpuBar}]` +
        `   ${ansi.dim}Processes:${ansi.reset} ${system.procCount}   ` +
        `${ansi.dim}Uptime:${ansi.reset} ${system.uptime}\n`
    );

    // MEM line
    const memBar = progressBar(memPct, barWidth);
    let memColor = ansi.green;
    if (memPct > 80) memColor = ansi.red;
    else if (memPct > 60) memColor = ansi.yellow;

    process.stdout.write(
        ` MEM  ${memColor}${pad(memPct.toFixed(1) + '%', 7)}${ansi.reset} [${memBar}]` +
        `   ${ansi.dim}Used:${ansi.reset} ${humanBytes(system.usedMem)}  ` +
        `${ansi.dim}Total:${ansi.reset} ${humanBytes(system.totalMem)}\n`
    );

    // PWR line
    const totalW = Math.max(0, system.estPowerW || 0);
    const cpuW = Math.max(0, system.cpuW || 0);
    const memW = Math.max(0, system.memW || 0);
    const pwrStr = `~${totalW.toFixed(1)} W`;
    const cpuWStr = `CPU: ${cpuW.toFixed(1)}W`;
    const memWStr = `RAM: ${memW.toFixed(1)}W`;

    const battStr = battery
        ? `${battery.charge !== null ? battery.charge + '%' : '?%'} (${battery.status})`
        : 'N/A';

    const schemeStr = powerScheme || 'Unknown';

    process.stdout.write(
        ` PWR  ${ansi.yellow}${pad(pwrStr, 9)}${ansi.reset}` +
        `   ${ansi.dim}${cpuWStr}, ${memWStr}${ansi.reset}` +
        `   ${ansi.dim}Scheme:${ansi.reset} ${schemeStr}   ` +
        `${ansi.dim}Battery:${ansi.reset} ${battStr}\n`
    );

    // Separator
    process.stdout.write('\n');

    // PROCESSES PANEL
    process.stdout.write(
        `${ansi.bold}PROCESSES${ansi.reset}  ` +
        `${ansi.dim}(sorted by ${sortBy.toUpperCase()} ${sortDesc ? 'desc' : 'asc'}, top ${topN}, filter: ${filterStr || 'none'})${ansi.reset}\n\n\n`
    );

    const cols = {
        pid: 6,
        cpu: 7,
        pwr: 9,
        mem: 10,
        name: 18,
        cmd: Math.max(10, width - (6 + 7 + 9 + 10 + 18 + 5)),
    };

    const header =
        pad('PID', cols.pid) + ' ' +
        pad('CPU%', cols.cpu) + ' ' +
        pad('PWR(W)', cols.pwr) + ' ' +
        pad('MEM', cols.mem) + ' ' +
        pad('NAME', cols.name) + ' ' +
        pad('COMMAND', cols.cmd);

    process.stdout.write(ansi.underline + header + ansi.reset + '\n');

    for (const p of processes) {
        const cpuStr = p.cpuPct.toFixed(1);
        const memStr = humanBytes(p.memBytes);
        const pwrStrProc = p.estW.toFixed(2);

        let color = '';
        let endColor = '';

        if (p.cpuPct > 50 || p.estW > CPU_TDP_W * 0.5) {
            color = ansi.red;
            endColor = ansi.reset;
        } else if (p.cpuPct > 20 || p.estW > CPU_TDP_W * 0.2) {
            color = ansi.yellow;
            endColor = ansi.reset;
        }

        const line =
            pad(p.pid, cols.pid) + ' ' +
            pad(cpuStr, cols.cpu) + ' ' +
            pad(pwrStrProc, cols.pwr) + ' ' +
            pad(memStr, cols.mem) + ' ' +
            pad(p.name, cols.name) + ' ' +
            pad(p.cmd || '', cols.cmd);

        process.stdout.write(color + line + endColor + '\n');
    }

    process.stdout.write('\n');
    process.stdout.write(
        ansi.dim +
        'Keys: c=CPU  m=MEM  p=PID  n=NAME  r=reverse  /=filter  +=faster  -=slower  k=kill  q=quit' +
        ansi.reset + '\n'
    );
}

// ---------------- Input handling ----------------

function setupInput() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
        if (key === '\u0003' || key === 'q') {
            process.exit(0);
        }

        if (key === 'c') { sortBy = 'cpu'; sortDesc = true; }
        if (key === 'm') { sortBy = 'mem'; sortDesc = true; }
        if (key === 'p') { sortBy = 'pid'; sortDesc = false; }
        if (key === 'n') { sortBy = 'name'; sortDesc = false; }
        if (key === 'r') { sortDesc = !sortDesc; }
        if (key === 'w') { sortBy = 'power'; sortDesc = true; } // optional: power sort

        if (key === '+') { intervalMs = Math.max(200, Math.floor(intervalMs * 0.8)); }
        if (key === '-') { intervalMs = Math.min(60000, Math.ceil(intervalMs * 1.25)); }

        if (key === '/') {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            rl.question('Filter (empty = clear): ', (answer) => {
                filterStr = (answer || '').trim();
                if (process.stdin.isTTY) process.stdin.setRawMode(true);
            });
        }

        if (key === 'k') {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            rl.question('Kill PID> ', async (answer) => {
                const pid = parseInt((answer || '').trim(), 10);
                if (!Number.isNaN(pid)) {
                    rl.question(`Confirm kill PID ${pid}? (y/N) `, async (conf) => {
                        if (conf && conf.toLowerCase().startsWith('y')) {
                            try {
                                await execP(`taskkill /PID ${pid} /F`);
                                console.log(`Killed PID ${pid}`);
                            } catch (e) {
                                console.log(`Failed to kill PID ${pid}: ${e && e.message ? e.message : e}`);
                            }
                        }
                        if (process.stdin.isTTY) process.stdin.setRawMode(true);
                    });
                } else {
                    if (process.stdin.isTTY) process.stdin.setRawMode(true);
                }
            });
        }
    });
}

// ---------------- Main loop ----------------

(async function main() {
    await detectLogicalCores();
    await detectCpuModel();

    // Seed CPU map
    const initRaw = await sampleProcessesRaw();
    prevSampleTime = Date.now();
    prevCpuMap.clear();
    for (const p of initRaw) {
        const pid = Number(p.ProcessId || 0);
        const kTicks = Number(p.KernelModeTime || 0); 
        const uTicks = Number(p.UserModeTime || 0);
        const totalTicks = kTicks + uTicks;
        const cpuSec = totalTicks / 1e7;
        prevCpuMap.set(pid, cpuSec);
    }

    setupInput();

    async function tick() {
        try {
            const [system, procsRaw, battery, scheme] = await Promise.all([
                sampleSystem(),
                sampleProcesses(),
                sampleBattery(),
                samplePowerScheme(),
            ]);
            const procs = sortAndFilterProcesses(procsRaw);
            render(system, procs, battery, scheme);
        } catch (e) {
            console.error('Error:', e && e.message ? e.message : e);
        } finally {
            setTimeout(tick, intervalMs);
        }
    }

    tick();
})();
