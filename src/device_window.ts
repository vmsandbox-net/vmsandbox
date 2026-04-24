import { makeDraggable } from './drag';
import { buildNetPanel, type NetPanel } from './net_panel';
import type { NetworkDevice } from './network_device';

export class DeviceWindow {
    readonly el: HTMLElement;
    readonly networkDevice: NetworkDevice;
    onClose: (() => void) | null = null;
    onFocusRequest: (() => void) | null = null;
    onDrag: (() => void) | null = null;

    readonly netPanel: NetPanel;

    constructor(
        container: HTMLElement,
        networkDevice: NetworkDevice,
        cascadeIndex: number,
        opts?: { title?: string; ports?: number; x?: number; y?: number }
    ) {
        const ports = opts?.ports ?? 5;
        this.networkDevice = networkDevice;
        this.netPanel = buildNetPanel(ports, (i) => String(i));
        this.el = this.buildDOM(opts?.title ?? 'Hub');
        this.el.style.top  = (opts?.y ?? (80 + cascadeIndex * 30)) + 'px';
        this.el.style.left = (opts?.x ?? (200 + cascadeIndex * 30)) + 'px';
        container.appendChild(this.el);

        // Reflect initial connection state
        for (let i = 0; i < ports; i++) {
            this.netPanel.setConnected(i, networkDevice.isConnected(i));
        }

        // Track future connection changes
        networkDevice.onConnectedChange = (idx, connected) => {
            this.netPanel.setConnected(idx, connected);
        };

        // Blink orange LED on traffic
        networkDevice.onTraffic = (fromIdx, toIdx) => {
            this.netPanel.blinkOrange(fromIdx);
            this.netPanel.blinkOrange(toIdx);
        };
    }

    private buildDOM(title: string): HTMLElement {
        const win = document.createElement('div');
        win.className = 'vm_window hub_window';

        const titlebar = document.createElement('div');
        titlebar.className = 'vm_titlebar';

        const titleEl = document.createElement('span');
        titleEl.className = 'vm_title';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'vm_close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.close();
        });

        titlebar.appendChild(titleEl);
        titlebar.appendChild(closeBtn);
        win.appendChild(titlebar);
        win.appendChild(this.netPanel.el);

        makeDraggable(win, titlebar, () => this.onDrag?.());
        win.addEventListener('pointerdown', () => this.onFocusRequest?.());

        return win;
    }

    setFocus(focused: boolean): void {
        this.el.classList.toggle('focused', focused);
    }

    close(): void {
        this.networkDevice.onConnectedChange = null;
        this.networkDevice.onTraffic = null;
        this.el.remove();
        this.onClose?.();
    }
}
