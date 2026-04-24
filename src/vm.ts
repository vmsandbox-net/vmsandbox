import { makeDraggable } from './drag';
import { assetUrl } from './config';
import vmWorkerUrl from './vm_worker.ts?worker&url';
import { buildNetPanel, type NetPanel } from './net_panel';
import type { NetworkDevice } from './network_device';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './fonts/ubuntu.css';

export interface VmParams {
    url: string;
    configJson?: string;  // if set, written to Emscripten FS and used instead of url
    memSize: number;
    cmdline: string;
    cols: number;
    rows: number;
    fontSize: number;
    driveUrl: string;
    initFiles?: Map<string, Uint8Array>;
}

let vmIdCounter = 0;

export class Vm {
    readonly el: HTMLElement;
    onClose: (() => void) | null = null;
    onFocusRequest: (() => void) | null = null;
    onDrag: (() => void) | null = null;

    private termContainerEls: HTMLElement[] = [];
    private tabBarEl!: HTMLElement;
    private tabEls: (HTMLElement | null)[] = [];
    private tabAddBtn!: HTMLButtonElement;
    private netProgressEl!: HTMLElement;

    private devicePorts!: ({ networkDevice: NetworkDevice; idx: number } | null)[];
    private vmTitle!: string;
    private consoleCount = 1;
    private activeConsole = 0;
    private openTabs = new Set<number>();
    netPanel!: NetPanel;
    private terms: Terminal[] = [];
    private termOpened: boolean[] = [];
    private worker: Worker | null = null;

    private cellWidth  = 0;
    private cellHeight = 0;

    private downloadingTimerPending = false;
    private downloadingTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        container: HTMLElement,
        params: VmParams,
        cascadeIndex: number,
        devicePorts: ({ networkDevice: NetworkDevice; idx: number } | null)[],
        opts?: { title?: string; x?: number; y?: number }
    ) {
        ++vmIdCounter;
        this.devicePorts = devicePorts;
        this.vmTitle  = opts?.title ?? 'vmsandbox';
        this.consoleCount = 4;
        this.el = this.buildDOM();
        this.el.style.top  = (opts?.y ?? (60 + cascadeIndex * 30)) + 'px';
        this.el.style.left = (opts?.x ?? (40 + cascadeIndex * 30)) + 'px';
        container.appendChild(this.el);
        this.start(params);
    }

    private buildDOM(): HTMLElement {
        // Window
        const win = document.createElement('div');
        win.className = 'vm_window';

        // Titlebar
        const titlebar = document.createElement('div');
        titlebar.className = 'vm_titlebar';
        const title = document.createElement('span');
        title.className = 'vm_title';
        title.textContent = this.vmTitle;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'vm_close';
        closeBtn.textContent = '×';
        closeBtn.title = 'Close VM';
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.close();
        });
        const netProgress = document.createElement('div');
        netProgress.className = 'net_progress';
        this.netProgressEl = netProgress;
        titlebar.appendChild(title);
        titlebar.appendChild(netProgress);
        titlebar.appendChild(closeBtn);
        win.appendChild(titlebar);

        // Tab bar (only when multiple consoles available)
        const tabBar = document.createElement('div');
        tabBar.className = 'vm_tabbar';
        tabBar.hidden = this.consoleCount <= 1;
        this.tabBarEl = tabBar;

        this.tabEls = new Array(this.consoleCount).fill(null);
        const firstTab = this.makeTabEl(0);
        firstTab.classList.add('active');
        tabBar.appendChild(firstTab);
        this.tabEls[0] = firstTab;
        this.openTabs.add(0);

        const addBtn = document.createElement('button');
        addBtn.className = 'vm_tab_add';
        addBtn.textContent = '+';
        addBtn.title = 'Add console';
        addBtn.hidden = this.consoleCount <= 1;
        addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.addTab(); });
        this.tabAddBtn = addBtn;
        tabBar.appendChild(addBtn);
        win.appendChild(tabBar);

        // Body wrap
        const wrap = document.createElement('div');
        wrap.className = 'vm_wrap';

        // Term wrap
        const termWrap = document.createElement('div');
        termWrap.className = 'term_wrap';

        // Create a container div for each console
        for (let i = 0; i < this.consoleCount; i++) {
            const termContainer = document.createElement('div');
            termContainer.className = 'term_container';
            termContainer.style.display = i === 0 ? '' : 'none';
            termWrap.appendChild(termContainer);
            this.termContainerEls.push(termContainer);
        }

        // Network interfaces panel
        this.netPanel = buildNetPanel(this.devicePorts.length, (i) => 'eth' + i);
        termWrap.appendChild(this.netPanel.el);

        wrap.appendChild(termWrap);

        win.appendChild(wrap);

        // Drag
        makeDraggable(win, titlebar, () => this.onDrag?.());

        // Focus on click
        win.addEventListener('pointerdown', () => {
            this.onFocusRequest?.();
        });

        // Resize grip
        const grip = document.createElement('div');
        grip.className = 'vm_resize_grip';
        win.appendChild(grip);
        this.addResizeGrip(grip);

        // Reflow wires whenever the window changes size (e.g. font load, resize grip)
        new ResizeObserver(() => this.onDrag?.()).observe(win);

        return win;
    }

    private makeTabEl(idx: number): HTMLElement {
        const tab = document.createElement('div');
        tab.className = 'vm_tab';
        tab.textContent = 'hvc' + idx;
        tab.addEventListener('click', (ev) => { ev.stopPropagation(); this.switchTab(idx); });
        return tab;
    }

    private switchTab(idx: number): void {
        if (idx === this.activeConsole) return;
        this.tabEls[this.activeConsole]?.classList.remove('active');
        this.termContainerEls[this.activeConsole].style.display = 'none';

        this.activeConsole = idx;
        this.tabEls[idx]?.classList.add('active');
        this.termContainerEls[idx].style.display = '';

        // Lazily open the xterm on first activation
        if (!this.termOpened[idx] && this.terms[idx]) {
            this.terms[idx].open(this.termContainerEls[idx]);
            this.termOpened[idx] = true;
            // Sync size in case it differs from the default; the onResize handler notifies the worker.
            const t0 = this.terms[0];
            if (t0 && (this.terms[idx].cols !== t0.cols || this.terms[idx].rows !== t0.rows)) {
                this.terms[idx].resize(t0.cols, t0.rows);
            }
        }
        this.terms[idx]?.focus();
    }

    private addTab(): void {
        // Find the first console slot that has no open tab
        let idx = -1;
        for (let i = 0; i < this.consoleCount; i++) {
            if (!this.openTabs.has(i)) { idx = i; break; }
        }
        if (idx === -1) return;

        this.openTabs.add(idx);
        const tab = this.makeTabEl(idx);
        this.tabEls[idx] = tab;

        // Insert in sorted order: before the first open tab with a higher index
        let insertBefore: HTMLElement = this.tabAddBtn;
        for (let i = idx + 1; i < this.consoleCount; i++) {
            if (this.tabEls[i]) { insertBefore = this.tabEls[i]!; break; }
        }
        this.tabBarEl.insertBefore(tab, insertBefore);

        if (this.openTabs.size >= this.consoleCount) {
            this.tabAddBtn.hidden = true;
        }

        this.activateConsole(idx);
        this.switchTab(idx);
    }

    private addResizeGrip(grip: HTMLElement): void {
        grip.style.touchAction = 'none';
        grip.addEventListener('pointerdown', (ev: PointerEvent) => {
            if (ev.button !== 0) return;
            const startX  = ev.clientX;
            const startY  = ev.clientY;
            const startW  = this.el.offsetWidth;
            const startH  = this.el.offsetHeight;
            const activeContainerEl = this.termContainerEls[this.activeConsole];
            const chromeH = startH - activeContainerEl.offsetHeight;
            grip.setPointerCapture(ev.pointerId);

            const onMove = (ev: PointerEvent) => {
                if (this.terms.length === 0 || this.cellWidth === 0) return;
                const activeTerm = this.terms[this.activeConsole];
                const newCols = Math.max(10, Math.floor((startW + (ev.clientX - startX)) / this.cellWidth));
                const newRows = Math.max(3,  Math.floor((startH + (ev.clientY - startY) - chromeH) / this.cellHeight));
                if (newCols !== activeTerm.cols || newRows !== activeTerm.rows) {
                    for (const t of this.terms) {
                        t.resize(newCols, newRows);
                    }
                    this.el.style.width = (newCols * this.cellWidth) + 'px';
                }
            };
            const onUp = () => {
                grip.releasePointerCapture(ev.pointerId);
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup',   onUp);
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup',   onUp);
            ev.preventDefault();
        });
    }

    get currentSize(): { cols: number; rows: number } | null {
        const t = this.terms[0];
        return t ? { cols: t.cols, rows: t.rows } : null;
    }

    setFocus(focused: boolean): void {
        if (focused) {
            this.el.classList.add('focused');
        } else {
            this.el.classList.remove('focused');
        }
        const activeTerm = this.terms[this.activeConsole];
        if (activeTerm) {
            if (focused) activeTerm.focus();
            else activeTerm.blur();
        }
    }

    connectEth(ethIdx: number, networkDevice: NetworkDevice, portIdx: number): void {
        if (!this.worker) return;
        const hp = { networkDevice, idx: portIdx };
        this.registerDevicePort(ethIdx, hp);
        this.devicePorts[ethIdx] = hp;
        this.worker.postMessage({ type: 'connect_eth', ethIdx });
    }

    disconnectNetworkDevice(device: NetworkDevice): void {
        for (let i = 0; i < this.devicePorts.length; i++) {
            const hp = this.devicePorts[i];
            if (!hp || hp.networkDevice !== device) continue;
            device.setConnected(hp.idx, false);
            this.netPanel.setConnected(i, false);
            this.devicePorts[i] = null;
            this.worker?.postMessage({ type: 'disconnect_eth', ethIdx: i });
        }
    }

    sendText(text: string): void {
        if (!this.worker) return;
        this.worker.postMessage({ type: 'terminal_input', consoleIdx: this.activeConsole, data: text + '\r' });
    }

    close(): void {
        // Disconnect from all network devices so no more packets are forwarded
        for (const hp of this.devicePorts) {
            if (hp) hp.networkDevice.setConnected(hp.idx, false);
        }

        // Clear any pending timers
        if (this.downloadingTimer !== null) {
            clearTimeout(this.downloadingTimer);
            this.downloadingTimer = null;
        }

        // Terminate the worker
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }

        // Dispose all terminals
        for (const t of this.terms) {
            t.blur();
            t.dispose();
        }
        this.terms = [];

        this.el.remove();
        this.onClose?.();
    }

    // Network progress indicator

    private updateDownloading(flag: number): void {
        if (flag) {
            if (this.downloadingTimerPending) {
                clearTimeout(this.downloadingTimer!);
                this.downloadingTimer = null;
                this.downloadingTimerPending = false;
            } else {
                this.netProgressEl.classList.add('active');
            }
        } else {
            if (this.downloadingTimerPending) clearTimeout(this.downloadingTimer!);
            this.downloadingTimerPending = true;
            this.downloadingTimer = setTimeout(() => {
                this.netProgressEl.classList.remove('active');
                this.downloadingTimerPending = false;
                this.downloadingTimer = null;
            }, 500);
        }
    }

    // Worker message handler

    private onWorkerMessage(e: MessageEvent): void {
        const msg = e.data;
        switch (msg.type) {
            case 'terminal_output':
                // Each char in msg.data represents a raw byte (0–255) as emitted by the WASM VM.
                // Converting to Uint8Array preserves the byte values so xterm receives correct UTF-8.
                this.terms[msg.consoleIdx]?.write(
                    Uint8Array.from(msg.data as string, (c: string) => c.charCodeAt(0))
                );
                break;
            case 'net_send': {
                const buf = new Uint8Array(msg.packet as ArrayBuffer);
                const ethIdx: number = msg.ethIdx;
                this.netPanel.blinkOrange(ethIdx);
                const hp = this.devicePorts[ethIdx];
                if (hp && hp.networkDevice.isConnected(hp.idx)) {
                    hp.networkDevice.forward(hp.idx, buf);
                }
                break;
            }
            case 'update_downloading':
                this.updateDownloading(msg.flag);
                break;
            case 'vm_ready':
                // hvc0 has no --wait-cr; nothing needed
                break;
        }
    }

    private activateConsole(idx: number): void {
        this.worker?.postMessage({ type: 'terminal_input', consoleIdx: idx, data: '\n' });
    }

    private closeTab(idx: number): void {
        if (!this.openTabs.has(idx)) return;

        // If closing the active tab, switch to nearest open tab first
        if (this.activeConsole === idx) {
            let nextIdx = -1;
            // Prefer left neighbor
            for (let i = idx - 1; i >= 0; i--) {
                if (this.openTabs.has(i)) { nextIdx = i; break; }
            }
            // Fall back to right neighbor
            if (nextIdx === -1) {
                for (let i = idx + 1; i < this.consoleCount; i++) {
                    if (this.openTabs.has(i)) { nextIdx = i; break; }
                }
            }
            if (nextIdx !== -1) this.switchTab(nextIdx);
        }

        this.openTabs.delete(idx);
        this.terms[idx]?.reset();
        this.tabEls[idx]?.remove();
        this.tabEls[idx] = null;
        this.termContainerEls[idx].style.display = 'none';
        this.tabAddBtn.hidden = false;
    }

    // Shared device-port wiring used by both start() and connectEth()

    private registerDevicePort(ethIdx: number, hp: { networkDevice: NetworkDevice; idx: number }): void {
        const blinkFn = () => this.netPanel.blinkOrange(ethIdx);
        const worker = this.worker!;
        hp.networkDevice.register(hp.idx, (vmEthIdx: number, buf: Uint8Array) => {
            const copy = buf.slice();
            worker.postMessage(
                { type: 'net_recv', ethIdx: vmEthIdx, packet: copy.buffer },
                [copy.buffer]
            );
        }, ethIdx, blinkFn);
        hp.networkDevice.setConnected(hp.idx, true);
        this.netPanel.setConnected(ethIdx, true);
    }

    // VM startup

    private start(params: VmParams): void {
        // Create all terminals upfront (only first one will be opened immediately)
        for (let i = 0; i < this.consoleCount; i++) {
            const xterm = new Terminal({
                cols: params.cols,
                rows: params.rows,
                scrollback: 10000,
                fontSize: params.fontSize,
                fontFamily: '"Ubuntu Mono", monospace',
                theme: { foreground: '#c8c8c8' },
            });
            const idx = i;
            xterm.parser.registerOscHandler(30, (data: string) => {
                const name = sanitizeTabName(data);
                if (this.tabEls[idx]) this.tabEls[idx]!.textContent = name || ('hvc' + idx);
                return true;
            });
            xterm.parser.registerOscHandler(31, () => {
                if (idx !== 0) {
                    // hvc1-3: close the tab; agetty continues waiting silently on that console
                    this.closeTab(idx);
                }
                // hvc0: agetty respawns and auto-logins without --wait-cr; nothing needed
                return true;
            });
            this.terms.push(xterm);
            this.termOpened.push(false);
        }

        Promise.all([
            document.fonts.load(`${params.fontSize}px "Ubuntu Mono"`),
            document.fonts.load(`bold ${params.fontSize}px "Ubuntu Mono"`),
        ]).then(async () => {
            // Open the first terminal and measure cell dimensions
            this.terms[0].open(this.termContainerEls[0]);
            this.termOpened[0] = true;
            this.cellWidth  = this.termContainerEls[0].offsetWidth  / this.terms[0].cols;
            this.cellHeight = this.termContainerEls[0].offsetHeight / this.terms[0].rows;
            this.el.style.width = this.termContainerEls[0].offsetWidth + 'px';

            // Wire up resize and input events for all consoles
            for (let i = 0; i < this.consoleCount; i++) {
                const idx = i;
                this.terms[i].onResize(() => {
                    this.worker?.postMessage({
                        type: 'console_resize',
                        consoleIdx: idx,
                        cols: this.terms[idx].cols,
                        rows: this.terms[idx].rows,
                    });
                });
                this.terms[i].onData((data) => {
                    this.worker?.postMessage({ type: 'terminal_input', consoleIdx: idx, data });
                });
            }

            this.terms[0].write('Loading...\r\n');

            // Determine which eth ports are pre-wired
            const preconnectedEths: number[] = [];
            for (let i = 0; i < this.devicePorts.length; i++) {
                if (this.devicePorts[i]) preconnectedEths.push(i);
            }

            // Create the worker. When assets are served from a cross-origin CDN,
            // new Worker(crossOriginUrl) throws a SecurityError, so we fetch the
            // script and construct the worker from a blob: URL instead (always
            // same-origin). In dev the URL is same-origin so we skip the round-trip.
            // vmWorkerUrl comes from the ?worker&url import so Vite bundles the
            // worker correctly (correct hash, .js extension) in all cases.
            const resolvedWorkerUrl = new URL(vmWorkerUrl, window.location.href);
            if (resolvedWorkerUrl.origin !== window.location.origin) {
                const resp = await fetch(vmWorkerUrl);
                const blob = await resp.blob();
                const blobUrl = URL.createObjectURL(blob);
                this.worker = new Worker(blobUrl, { type: 'module' });
                URL.revokeObjectURL(blobUrl);
            } else {
                this.worker = new Worker(vmWorkerUrl, { type: 'module' });
            }
            this.worker.onmessage = (e) => this.onWorkerMessage(e);
            this.worker.onerror = (e) => console.error('VM worker error:', e);

            // Register pre-wired network device ports
            for (let i = 0; i < this.devicePorts.length; i++) {
                const hp = this.devicePorts[i];
                if (hp) this.registerDevicePort(i, hp);
            }

            // Start the worker VM
            this.worker.postMessage({
                type: 'start',
                wasmJsUrl:     assetUrl('assets/riscvemu64-wasm.js'),
                wasmBinaryUrl: assetUrl('assets/riscvemu64-wasm.wasm'),
                params: {
                    ...params,
                    consoleCount: this.consoleCount,
                    hubPortCount: this.devicePorts.length,
                },
                preconnectedEths,
            });
        }).catch((err) => console.error('VM start failed:', err));
    }
}

// Utilities

function sanitizeTabName(raw: string): string {
    return raw.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 40);
}
