import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { assetUrl } from './config';

export interface TopologyVm {
    id: string;
    title?: string;
    x: number;
    y: number;
    eth_ports?: number;
    mem_size?: number;
    cmdline?: string;
    cols?: number;
    rows?: number;
    font_size?: number;
    files?: Record<string, string>;
}

export interface TopologyHub {
    id: string;
    title?: string;
    ports?: number;
    x: number;
    y: number;
}

export type TopologySwitch = TopologyHub;

export interface TopologyWire {
    vm: { id: string; iface: string };
    hub: { id: string; port: number };
}

export interface TopologyPeerWire {
    peers: [{ id: string; iface: string }, { id: string; iface: string }];
}

export interface TopologyDoc {
    id: string;
    title?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    markdown: string;
}

export interface Topology {
    title: string;
    vms: TopologyVm[];
    hubs: TopologyHub[];
    switches: TopologySwitch[];
    wires: (TopologyWire | TopologyPeerWire)[];
    docs: TopologyDoc[];
    default_window?: string;
}

const DEFAULT_CMDLINE = 'console=hvc0 root=/dev/vda rw earlycon=sbi rcupdate.rcu_cpu_stall_timeout=300';

export function buildVmConfigJson(vm: TopologyVm): string {
    const ethPorts = vm.eth_ports ?? 1;
    const cfg: Record<string, any> = {
        version: 1,
        machine: 'riscv64',
        memory_size: vm.mem_size ?? 256,
        bios: assetUrl('assets/opensbi.bin.zst'),
        kernel: assetUrl('assets/kernel.bin.zst'),
        cmdline: vm.cmdline ?? DEFAULT_CMDLINE,
        drive0: { file: assetUrl('assets/disk/blk.txt') },
        rng0: {},
    };
    for (let i = 0; i < ethPorts; i++) {
        cfg[`eth${i}`] = { driver: 'user' };
    }
    return JSON.stringify(cfg);
}

export function buildInitFiles(vm: TopologyVm): Map<string, Uint8Array> {
    const enc = new TextEncoder();
    const files = new Map<string, Uint8Array>();
    for (const [name, content] of Object.entries(vm.files ?? {})) {
        files.set(name, enc.encode(content));
    }
    return files;
}

export function serializeTopology(topo: Topology): string {
    return yamlDump(topo, {
        lineWidth: -1,
        noRefs: true,
    });
}

export async function loadTopology(url: string): Promise<Topology> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    let raw: any;
    try {
        raw = yamlLoad(text);
    } catch (e) {
        console.error('Failed to parse topology YAML:', e);
        throw e;
    }
    if (typeof raw?.title !== 'string' || !raw.title.trim()) {
        throw new Error('Topology is missing a required "title" field');
    }
    return {
        title:          raw.title,
        vms:            Array.isArray(raw?.vms)      ? raw.vms      : [],
        hubs:           Array.isArray(raw?.hubs)     ? raw.hubs     : [],
        switches:       Array.isArray(raw?.switches) ? raw.switches : [],
        wires:          Array.isArray(raw?.wires)    ? raw.wires    : [],
        docs:           Array.isArray(raw?.docs)     ? raw.docs     : [],
        default_window: typeof raw?.default_window === 'string' ? raw.default_window : undefined,
    };
}
