import { Vm, type VmParams } from './vm';
import { createHub, createSwitch, type NetworkDevice } from './network_device';
import { DeviceWindow } from './device_window';
import { WireManager } from './wire_manager';
import { DocWindow } from './doc_window';
import {
    buildVmConfigJson, buildInitFiles,
    type Topology, type TopologyVm, type TopologyHub, type TopologyPeerWire,
} from './topology';
import { PanController } from './pan';

// Generic focusable window interface (Vm, DeviceWindow, DocWindow all satisfy this shape)
type Focusable = {
    el: HTMLElement;
    setFocus(f: boolean): void;
    onFocusRequest: (() => void) | null;
    onClose: (() => void) | null;
};

type NetworkDeviceEntry = { networkDevice: NetworkDevice; win: DeviceWindow };

// Default VM position/size constants (mirror Vm constructor defaults) used to place network devices below VMs
const VM_DEFAULT_TOP    = 60;
const VM_DEFAULT_HEIGHT = 640;
const HUB_BELOW_PAD     = 20;

export class Workspace {
    currentTopo: Topology | null = null;

    private readonly container: HTMLElement;
    private readonly wireManager: WireManager;
    private readonly getBaseVmParams: () => VmParams;

    private windows: Focusable[] = [];
    private focused: Focusable | null = null;
    private nextZ = 1;
    private vms: Vm[] = [];
    private vmCount = 0;
    private readonly vmRegistry    = new Map<string, Vm>();
    private readonly hubSocketMap  = new Map<HTMLElement, { networkDevice: NetworkDevice; idx: number }>();
    private readonly vmSocketMap   = new Map<HTMLElement, { vm: Vm; ethIdx: number }>();
    private readonly peerLinkMap   = new Map<HTMLElement, { networkDevice: NetworkDevice; peerSockEl: HTMLElement; peerVm: Vm }>();
    private networkDevices: NetworkDeviceEntry[] = [];
    private readonly topoEls = new Map<string, HTMLElement>();
    readonly panController: PanController;

    constructor(container: HTMLElement, wireManager: WireManager, getBaseVmParams: () => VmParams, panController: PanController) {
        this.container        = container;
        this.wireManager      = wireManager;
        this.getBaseVmParams  = getBaseVmParams;
        this.panController    = panController;
        // Tapping the background (outside any window) blurs the focused VM so the
        // on-screen keyboard is dismissed on touch devices such as iPad.
        container.addEventListener('pointerdown', (ev: PointerEvent) => {
            if (!(ev.target as Element).closest('.vm_window') && this.focused) {
                this.focused.setFocus(false);
                this.focused = null;
            }
        });
    }

    bringToFront(win: Focusable): void {
        if (this.focused === win) return;
        if (this.focused) this.focused.setFocus(false);
        this.focused = win;
        win.setFocus(true);
        win.el.style.zIndex = String(++this.nextZ);
    }

    registerWindow(win: Focusable, onClose?: () => void): void {
        this.windows.push(win);
        this.panController.registerWindow(win.el);
        win.onFocusRequest = () => this.bringToFront(win);
        win.onClose = () => {
            this.windows = this.windows.filter(w => w !== win);
            this.panController.unregisterWindow(win.el);
            this.panController.updateFitState();
            if (this.focused === win) {
                this.focused = null;
                if (this.windows.length > 0) this.bringToFront(this.windows[this.windows.length - 1]);
            }
            onClose?.();
        };
        this.bringToFront(win);
        this.panController.updateFitState();
    }

    private registerDeviceSockets(win: DeviceWindow, device: NetworkDevice, ports: number): () => void {
        const sockEls: HTMLElement[] = [];
        for (let i = 0; i < ports; i++) {
            const sockEl = win.netPanel.getSocketEl(i);
            sockEls.push(sockEl);
            this.hubSocketMap.set(sockEl, { networkDevice: device, idx: i });
            this.wireManager.registerSocket(sockEl, 'hub', (cb) => { win.onDrag = cb; });
        }
        return () => {
            this.vms.forEach(vm => vm.disconnectNetworkDevice(device));
            sockEls.forEach(el => this.wireManager.removeAllForSocket(el));
            const idx = this.networkDevices.findIndex(e => e.win === win);
            if (idx >= 0) this.networkDevices.splice(idx, 1);
        };
    }

    private registerVmSockets(vm: Vm, ethPorts: number): () => void {
        for (let i = 0; i < ethPorts; i++) {
            const sockEl = vm.netPanel.getSocketEl(i);
            this.vmSocketMap.set(sockEl, { vm, ethIdx: i });
            this.wireManager.registerSocket(sockEl, 'vm', (cb) => { vm.onDrag = cb; },
                (otherEl) => {
                    const hp = this.hubSocketMap.get(otherEl);
                    if (hp) { vm.connectEth(i, hp.networkDevice, hp.idx); return; }
                    const peer = this.vmSocketMap.get(otherEl);
                    if (peer && !this.peerLinkMap.has(sockEl)) {
                        const peerDevice = createHub(2);
                        vm.connectEth(i, peerDevice, 0);
                        peer.vm.connectEth(peer.ethIdx, peerDevice, 1);
                        this.peerLinkMap.set(sockEl,  { networkDevice: peerDevice, peerSockEl: otherEl, peerVm: peer.vm });
                        this.peerLinkMap.set(otherEl, { networkDevice: peerDevice, peerSockEl: sockEl,  peerVm: vm });
                    }
                },
                (otherEl) => {
                    const link = this.peerLinkMap.get(sockEl);
                    if (link) {
                        link.peerVm.disconnectNetworkDevice(link.networkDevice);
                        vm.disconnectNetworkDevice(link.networkDevice);
                        this.peerLinkMap.delete(link.peerSockEl);
                        this.peerLinkMap.delete(sockEl);
                    } else {
                        const hp = this.hubSocketMap.get(otherEl);
                        if (hp) vm.disconnectNetworkDevice(hp.networkDevice);
                    }
                });
        }
        return () => {
            for (let i = 0; i < ethPorts; i++) {
                const sockEl = vm.netPanel.getSocketEl(i);
                const link = this.peerLinkMap.get(sockEl);
                if (link) {
                    link.peerVm.disconnectNetworkDevice(link.networkDevice);
                    this.peerLinkMap.delete(link.peerSockEl);
                    this.peerLinkMap.delete(sockEl);
                }
                this.wireManager.removeAllForSocket(sockEl);
                this.vmSocketMap.delete(sockEl);
            }
            this.vms = this.vms.filter(v => v !== vm);
        };
    }

    private addNetworkDevice(type: 'hub' | 'switch', ports: number): void {
        const device   = type === 'hub' ? createHub(ports) : createSwitch(ports);
        const title    = type === 'hub' ? 'Hub' : 'Switch';
        const cascadeIdx = this.windows.length;
        const win = new DeviceWindow(this.container, device, cascadeIdx, { title, ports });
        win.el.style.top = (VM_DEFAULT_TOP + VM_DEFAULT_HEIGHT + HUB_BELOW_PAD + cascadeIdx * 30) + 'px';
        this.networkDevices.push({ networkDevice: device, win });
        const cleanup = this.registerDeviceSockets(win, device, ports);
        this.registerWindow(win, cleanup);
    }

    addHub(ports = 5): void    { this.addNetworkDevice('hub',    ports); }
    addSwitch(ports = 5): void { this.addNetworkDevice('switch', ports); }

    addVm(ethPorts = 4, memSize?: number, title?: string): void {
        const vmHubPorts: ({ networkDevice: NetworkDevice; idx: number } | null)[] =
            Array.from({ length: ethPorts }, () => null);

        const baseParams = this.getBaseVmParams();
        const resolvedMem = memSize ?? baseParams.memSize;
        const vm = new Vm(this.container, {
            ...baseParams,
            url: '',
            memSize: resolvedMem,
            configJson: buildVmConfigJson({ eth_ports: ethPorts, mem_size: resolvedMem } as TopologyVm),
            initFiles: this.defaultInitFiles(),
        }, this.vmCount++, vmHubPorts, title ? { title } : undefined);
        this.vms.push(vm);

        const cleanup = this.registerVmSockets(vm, ethPorts);
        this.registerWindow(vm, () => { cleanup(); });
    }

    private defaultInitFiles(): Map<string, Uint8Array> {
        return new Map();
    }

    private createTopoNetworkDevice(
        factory: (ports: number) => NetworkDevice,
        td: TopologyHub,
        deviceMap: Map<string, NetworkDeviceEntry>
    ): void {
        const ports = td.ports ?? 5;
        const device = factory(ports);
        const cascadeIdx = this.windows.length;
        const win = new DeviceWindow(this.container, device, cascadeIdx, {
            title: td.title ?? td.id,
            ports,
            x: td.x,
            y: td.y,
        });
        this.networkDevices.push({ networkDevice: device, win });
        const cleanup = this.registerDeviceSockets(win, device, ports);
        this.registerWindow(win, cleanup);
        deviceMap.set(td.id, { networkDevice: device, win });
        this.topoEls.set(td.id, win.el);
    }

    private drawTopoWires(
        topo: Topology,
        vmMap: Map<string, Vm>,
        hubMap: Map<string, NetworkDeviceEntry>,
        peerHubPreMap: Map<string, { networkDevice: NetworkDevice; idx: number }>
    ): void {
        const updateFn = () => this.wireManager.updateAll();

        for (const wire of topo.wires) {
            if (!('vm' in wire)) continue;
            const vm = vmMap.get(wire.vm.id);
            const hubEntry = hubMap.get(wire.hub.id);
            if (!vm || !hubEntry) continue;
            const ifaceIdx = parseInt(wire.vm.iface.replace('eth', ''), 10);
            const vmSock   = vm.netPanel.getSocketEl(ifaceIdx);
            const hubSock  = hubEntry.win.netPanel.getSocketEl(wire.hub.port);
            this.wireManager.add(vmSock, hubSock);
            this.wireManager.markSocketUsed(vmSock);
            this.wireManager.markSocketUsed(hubSock);
            vm.onDrag           = updateFn;
            hubEntry.win.onDrag = updateFn;
        }

        for (const wire of topo.wires) {
            if (!('peers' in wire)) continue;
            const [s1, s2] = (wire as TopologyPeerWire).peers;
            const vm1 = vmMap.get(s1.id);
            const vm2 = vmMap.get(s2.id);
            if (!vm1 || !vm2) continue;
            const idx1    = parseInt(s1.iface.replace('eth', ''), 10);
            const idx2    = parseInt(s2.iface.replace('eth', ''), 10);
            const sockEl1 = vm1.netPanel.getSocketEl(idx1);
            const sockEl2 = vm2.netPanel.getSocketEl(idx2);
            this.wireManager.add(sockEl1, sockEl2);
            this.wireManager.markSocketUsed(sockEl1);
            this.wireManager.markSocketUsed(sockEl2);
            vm1.onDrag = updateFn;
            vm2.onDrag = updateFn;
            const ph = peerHubPreMap.get(`${s1.id}.${s1.iface}`)!;
            this.peerLinkMap.set(sockEl1, { networkDevice: ph.networkDevice, peerSockEl: sockEl2, peerVm: vm2 });
            this.peerLinkMap.set(sockEl2, { networkDevice: ph.networkDevice, peerSockEl: sockEl1, peerVm: vm1 });
        }
    }

    async applyTopology(topo: Topology): Promise<void> {
        (document.getElementById('btn_topology_title') as HTMLButtonElement).textContent = topo.title;

        // Create hubs and switches (both keyed into hubMap for wire lookup)
        const hubMap = new Map<string, NetworkDeviceEntry>();
        for (const th of topo.hubs)     this.createTopoNetworkDevice(createHub,    th, hubMap);
        for (const ts of topo.switches) this.createTopoNetworkDevice(createSwitch,  ts, hubMap);

        // Pre-create 2-port hubs for peer (VM-to-VM) wires so vmHubPorts can reference them
        const peerHubPreMap = new Map<string, { networkDevice: NetworkDevice; idx: number }>();
        for (const wire of topo.wires) {
            if (!('peers' in wire)) continue;
            const [s1, s2] = (wire as TopologyPeerWire).peers;
            const ph = createHub(2);
            peerHubPreMap.set(`${s1.id}.${s1.iface}`, { networkDevice: ph, idx: 0 });
            peerHubPreMap.set(`${s2.id}.${s2.iface}`, { networkDevice: ph, idx: 1 });
        }

        // Create VMs
        const vmMap = new Map<string, Vm>();
        for (const tv of topo.vms) {
            const ethPorts = tv.eth_ports ?? 1;

            // Build devicePorts array from hub/switch wires for this VM
            const vmHubPorts: ({ networkDevice: NetworkDevice; idx: number } | null)[] =
                new Array(ethPorts).fill(null);
            for (const wire of topo.wires) {
                if (!('vm' in wire)) continue;
                if (wire.vm.id !== tv.id) continue;
                const ifaceIdx = parseInt(wire.vm.iface.replace('eth', ''), 10);
                const hubEntry = hubMap.get(wire.hub.id);
                if (hubEntry && ifaceIdx >= 0 && ifaceIdx < ethPorts) {
                    vmHubPorts[ifaceIdx] = { networkDevice: hubEntry.networkDevice, idx: wire.hub.port };
                }
            }
            // Also populate from peer wires
            for (let i = 0; i < ethPorts; i++) {
                const ph = peerHubPreMap.get(`${tv.id}.eth${i}`);
                if (ph) vmHubPorts[i] = ph;
            }

            const params: VmParams = {
                url:        '',
                configJson: buildVmConfigJson(tv),
                memSize:    tv.mem_size  ?? 256,
                cmdline:    '',
                cols:       tv.cols      ?? 80,
                rows:       tv.rows      ?? 30,
                fontSize:   tv.font_size ?? 15,
                driveUrl:   '',
                initFiles:  buildInitFiles(tv),
            };

            const vm = new Vm(this.container, params, this.vmCount++, vmHubPorts, {
                title: tv.title ?? tv.id,
                x: tv.x,
                y: tv.y,
            });
            this.vms.push(vm);
            vmMap.set(tv.id, vm);
            this.vmRegistry.set(tv.id, vm);
            this.topoEls.set(tv.id, vm.el);
            const cleanup = this.registerVmSockets(vm, ethPorts);
            this.registerWindow(vm, () => {
                cleanup();
                this.vmRegistry.delete(tv.id);
            });
        }

        // Create doc windows
        const docMap = new Map<string, DocWindow>();
        for (const td of topo.docs) {
            const cascadeIdx = this.windows.length;
            const win = new DocWindow(this.container, td, cascadeIdx, {
                title:       td.title ?? td.id,
                x:           td.x,
                y:           td.y,
                width:       td.width,
                height:      td.height,
                onSendToVm:  (vmId, text) => { this.vmRegistry.get(vmId)?.sendText(text); },
                onGoto:      (topoId) => { window.location.search = topoId; },
            });
            this.registerWindow(win);
            win.onResize = (w, h) => { td.width = w; td.height = h; };
            docMap.set(td.id, win);
            this.topoEls.set(td.id, win.el);
        }

        // Bring default window to front
        if (topo.default_window) {
            const def = docMap.get(topo.default_window)
                ?? vmMap.get(topo.default_window)
                ?? hubMap.get(topo.default_window)?.win;
            if (def) this.bringToFront(def);
        }

        this.drawTopoWires(topo, vmMap, hubMap, peerHubPreMap);
    }

    snapshotPositions(): void {
        if (!this.currentTopo) return;
        const pan = this.panController.getPanOffset();
        const readXY = (el: HTMLElement) => ({
            x: (parseInt(el.style.left, 10) || 0) + pan.x,
            y: (parseInt(el.style.top,  10) || 0) + pan.y,
        });
        for (const tv of this.currentTopo.vms) {
            const el = this.topoEls.get(tv.id);
            if (el) { const p = readXY(el); tv.x = p.x; tv.y = p.y; }
            const size = this.vmRegistry.get(tv.id)?.currentSize;
            if (size) { tv.cols = size.cols; tv.rows = size.rows; }
        }
        for (const th of this.currentTopo.hubs) {
            const el = this.topoEls.get(th.id);
            if (el) { const p = readXY(el); th.x = p.x; th.y = p.y; }
        }
        for (const ts of this.currentTopo.switches) {
            const el = this.topoEls.get(ts.id);
            if (el) { const p = readXY(el); ts.x = p.x; ts.y = p.y; }
        }
        for (const td of this.currentTopo.docs) {
            const el = this.topoEls.get(td.id);
            if (el) {
                const p = readXY(el);
                td.x = p.x; td.y = p.y;
                if (el.offsetWidth)  td.width  = el.offsetWidth;
                if (el.offsetHeight) td.height = el.offsetHeight;
            }
        }
    }
}
