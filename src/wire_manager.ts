// Simulation constants
const SIM_N         = 4;    // interior simulation points
const SPRING_K      = 39;   // stiffness (s⁻²)
const DAMPING       = 4;    // velocity damping (s⁻¹)
const IMPULSE_SCALE = 0.4;  // fraction of endpoint delta transferred as velocity impulse
const SIM_STOP      = 0.75; // px/s — stop simulating when all |v| fall below this
const BIRTH_KICK    = 17;   // px/s downward velocity given to all masses on wire creation

const SVG_NS = 'http://www.w3.org/2000/svg';

type SocketType = 'vm' | 'hub';

interface SocketMeta {
    type: SocketType;
    used: boolean;
    onDragSetter: (cb: () => void) => void;
    onConnect: ((otherEl: HTMLElement) => void) | null;
    onDisconnect: ((otherEl: HTMLElement) => void) | null;
}

interface DragState {
    sourceEl: HTMLElement;
    sourceMeta: SocketMeta;
}

interface SimPoint { x: number; y: number; vx: number; vy: number; }

interface WireEntry {
    path: SVGPathElement;
    fromEl: HTMLElement;
    toEl: HTMLElement;
    pts: SimPoint[];           // SIM_N interior masses
    active: boolean;           // true while any mass velocity > SIM_STOP
    lx1: number; ly1: number;  // last-known endpoint positions (for delta computation)
    lx2: number; ly2: number;
}

interface DeleteButtonEntry {
    g: SVGGElement;
    socketEl: HTMLElement;
}

export class WireManager {
    // Tunable simulation parameters (can be changed at runtime)
    springK      = SPRING_K;
    damping      = DAMPING;
    impulseScale = IMPULSE_SCALE;
    simStop      = SIM_STOP;
    birthKick    = BIRTH_KICK;

    private readonly svg: SVGSVGElement;
    private readonly wires = new Map<number, WireEntry>();
    private nextId = 0;

    private readonly sockets = new Map<HTMLElement, SocketMeta>();
    private readonly ghostPath: SVGPathElement;
    private dragState: DragState | null = null;
    private hotSocketEl: HTMLElement | null = null;
    private selectedWireId: number | null = null;
    private deleteButtons: DeleteButtonEntry[] = [];

    private animFrameId: number | null = null;
    private lastTime: number | null = null;

    private readonly boundOnMove           = (ev: PointerEvent) => this.onDragMove(ev);
    private readonly boundOnUp             = (ev: PointerEvent) => this.onDragUp(ev);
    private readonly boundAnimate          = () => this.animate();
    private readonly boundClearSelection   = () => this.clearSelection();

    constructor(container: HTMLElement) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:visible';
        container.prepend(svg);
        this.svg = svg;

        const ghost = document.createElementNS(SVG_NS, 'path');
        ghost.setAttribute('fill', 'none');
        ghost.setAttribute('stroke', '#c8b560');
        ghost.setAttribute('stroke-width', '2');
        ghost.setAttribute('stroke-dasharray', '6 4');
        ghost.setAttribute('stroke-linecap', 'round');
        ghost.setAttribute('opacity', '0.6');
        ghost.style.display = 'none';
        svg.appendChild(ghost);
        this.ghostPath = ghost;
        document.addEventListener('pointerdown', this.boundClearSelection);
    }

    // --- Socket registration ---

    registerSocket(
        el: HTMLElement,
        type: SocketType,
        onDragSetter: (cb: () => void) => void,
        onConnect?: (otherEl: HTMLElement) => void,
        onDisconnect?: (otherEl: HTMLElement) => void,
    ): void {
        this.sockets.set(el, {
            type, used: false, onDragSetter,
            onConnect: onConnect ?? null,
            onDisconnect: onDisconnect ?? null,
        });
        el.style.cursor = 'crosshair';
        el.style.touchAction = 'none';
        el.addEventListener('pointerdown', (ev: PointerEvent) => this.onSocketPointerDown(ev, el));
    }

    isSocketFree(el: HTMLElement): boolean {
        const meta = this.sockets.get(el);
        return meta !== undefined && !meta.used;
    }

    markSocketUsed(el: HTMLElement): void {
        const meta = this.sockets.get(el);
        if (meta) { meta.used = true; el.style.cursor = 'default'; el.classList.add('wire_connected'); }
    }

    // --- Static wires ---

    add(fromEl: HTMLElement, toEl: HTMLElement): number {
        const id = this.nextId++;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#c8b560');
        path.setAttribute('stroke-width', '3');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('opacity', '0.75');
        this.svg.appendChild(path);

        // Compute initial endpoint positions
        const r1 = fromEl.getBoundingClientRect();
        const r2 = toEl.getBoundingClientRect();
        // Anchor at the connector body tip (offset to align with cable-exit oval)
        const x1 = r1.left + r1.width / 2 + 6,  y1 = r1.bottom - 1;
        const x2 = r2.left + r2.width / 2 + 6,  y2 = r2.bottom - 1;
        const droop = Math.min(Math.max(Math.abs(x2 - x1) * 0.4, 30), 200);

        // Initialise masses at rest positions with a downward birth kick
        const pts: SimPoint[] = [];
        for (let i = 1; i <= SIM_N; i++) {
            const t = i / (SIM_N + 1);
            pts.push({
                x:  x1 + (x2 - x1) * t,
                y:  y1 + (y2 - y1) * t + droop * Math.sin(t * Math.PI),
                vx: 0,
                vy: this.birthKick,
            });
        }

        const entry: WireEntry = {
            path, fromEl, toEl, pts, active: true,
            lx1: x1, ly1: y1, lx2: x2, ly2: y2,
        };
        this.wires.set(id, entry);
        this.renderPath(entry);
        this.ensureAnimating();
        return id;
    }

    removeAllForSocket(el: HTMLElement): void {
        const ids: number[] = [];
        for (const [id, entry] of this.wires) {
            if (entry.fromEl === el || entry.toEl === el) ids.push(id);
        }
        for (const id of ids) this.remove(id);
    }

    remove(id: number): void {
        if (this.selectedWireId === id) this.clearSelection();
        const entry = this.wires.get(id);
        if (!entry) return;

        // Fire disconnect callbacks before marking sockets free
        const fromMeta = this.sockets.get(entry.fromEl);
        const toMeta   = this.sockets.get(entry.toEl);
        fromMeta?.onDisconnect?.(entry.toEl);
        toMeta?.onDisconnect?.(entry.fromEl);

        entry.path.remove();
        this.wires.delete(id);
        for (const el of [entry.fromEl, entry.toEl]) {
            const meta = this.sockets.get(el);
            if (meta) { meta.used = false; el.style.cursor = 'crosshair'; el.classList.remove('wire_connected'); }
        }
    }

    clearSelection(): void {
        if (this.selectedWireId === null) return;
        const entry = this.wires.get(this.selectedWireId);
        if (entry) {
            entry.path.setAttribute('stroke', '#c8b560');
            entry.path.setAttribute('opacity', '0.75');
            (entry.path as SVGPathElement).style.filter = '';
            entry.fromEl.classList.remove('wire_selected');
            entry.toEl.classList.remove('wire_selected');
        }
        for (const { g } of this.deleteButtons) g.remove();
        this.deleteButtons = [];
        this.selectedWireId = null;
    }

    private selectWire(id: number): void {
        if (this.selectedWireId === id) return;
        this.clearSelection();
        const entry = this.wires.get(id);
        if (!entry) return;
        this.selectedWireId = id;
        entry.path.setAttribute('stroke', '#ff4444');
        entry.path.setAttribute('opacity', '1');
        (entry.path as SVGPathElement).style.filter = 'drop-shadow(0 0 4px #ff3333) drop-shadow(0 0 8px #cc0000)';
        entry.fromEl.classList.add('wire_selected');
        entry.toEl.classList.add('wire_selected');

        this.deleteButtons = [entry.fromEl, entry.toEl].map(socketEl =>
            ({ g: this.createDeleteButton(socketEl, id), socketEl })
        );
        this.updateDeleteButtons();
    }

    private createDeleteButton(_socketEl: HTMLElement, wireId: number): SVGGElement {
        const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
        g.setAttribute('pointer-events', 'all');
        g.setAttribute('class', 'wire_delete_btn');

        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', '0');
        circle.setAttribute('cy', '0');
        circle.setAttribute('r', '20');
        g.appendChild(circle);

        const d = 9;
        for (const [x1, y1, x2, y2] of [[-d, -d, d, d], [d, -d, -d, d]] as const) {
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('x1', String(x1));
            line.setAttribute('y1', String(y1));
            line.setAttribute('x2', String(x2));
            line.setAttribute('y2', String(y2));
            line.setAttribute('stroke', 'white');
            line.setAttribute('stroke-width', '2.5');
            line.setAttribute('stroke-linecap', 'round');
            g.appendChild(line);
        }

        g.addEventListener('pointerdown', (ev: PointerEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.remove(wireId);
        });

        // Insert before the ghost path so delete buttons render behind all wire paths
        this.svg.insertBefore(g, this.ghostPath);
        return g;
    }

    private updateDeleteButtons(): void {
        for (const { g, socketEl } of this.deleteButtons) {
            const r = socketEl.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.bottom + 29;  // radius=20 + 5px gap below connector bottom
            g.setAttribute('transform', `translate(${cx},${cy})`);
        }
    }

    private getWireIdForSocket(el: HTMLElement): number | null {
        for (const [id, entry] of this.wires) {
            if (entry.fromEl === el || entry.toEl === el) return id;
        }
        return null;
    }

    updateAll(): void {
        // Reactivate all wires so the rAF loop picks up endpoint movement from drag
        for (const entry of this.wires.values()) entry.active = true;
        this.ensureAnimating();
    }

    // --- Simulation ---

    private simStep(entry: WireEntry, dt: number): void {
        const r1 = entry.fromEl.getBoundingClientRect();
        const r2 = entry.toEl.getBoundingClientRect();
        // Anchor at the connector body tip (offset to align with cable-exit oval)
        const x1 = r1.left + r1.width / 2 + 6,  y1 = r1.bottom - 1;
        const x2 = r2.left + r2.width / 2 + 6,  y2 = r2.bottom - 1;

        // Endpoint deltas since last frame
        const dx1 = x1 - entry.lx1,  dy1 = y1 - entry.ly1;
        const dx2 = x2 - entry.lx2,  dy2 = y2 - entry.ly2;
        entry.lx1 = x1; entry.ly1 = y1;
        entry.lx2 = x2; entry.ly2 = y2;

        const droop = Math.min(Math.max(Math.abs(x2 - x1) * 0.4, 30), 200);
        let anyActive = false;

        for (let i = 0; i < SIM_N; i++) {
            const p = entry.pts[i];
            const t = (i + 1) / (SIM_N + 1);

            // Transfer endpoint velocity to mass, weighted by proximity
            const w1 = (SIM_N - i)     / (SIM_N + 1);
            const w2 = (i + 1)         / (SIM_N + 1);
            p.vx += this.impulseScale * (dx1 * w1 + dx2 * w2);
            p.vy += this.impulseScale * (dy1 * w1 + dy2 * w2);

            // Rest position on the droop curve
            const rx = x1 + (x2 - x1) * t;
            const ry = y1 + (y2 - y1) * t + droop * Math.sin(t * Math.PI);

            // Spring-damper acceleration
            const ax = this.springK * (rx - p.x) - this.damping * p.vx;
            const ay = this.springK * (ry - p.y) - this.damping * p.vy;

            // Euler integration
            p.vx += ax * dt;
            p.vy += ay * dt;
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;

            if (Math.hypot(p.vx, p.vy) > this.simStop) anyActive = true;
        }

        entry.active = anyActive;
    }

    private renderPath(entry: WireEntry): void {
        // 7-point array: endpoint1, 5 masses, endpoint2
        const P: { x: number; y: number }[] = [
            { x: entry.lx1, y: entry.ly1 },
            ...entry.pts,
            { x: entry.lx2, y: entry.ly2 },
        ];
        const n = P.length;
        const px = (i: number) => P[Math.max(0, Math.min(n - 1, i))].x;
        const py = (i: number) => P[Math.max(0, Math.min(n - 1, i))].y;

        // Catmull-Rom → cubic Bezier (phantom points at both ends)
        let d = `M ${P[0].x},${P[0].y}`;
        for (let i = 0; i < n - 1; i++) {
            const cp1x = P[i].x   + (px(i + 1) - px(i - 1)) / 6;
            const cp1y = P[i].y   + (py(i + 1) - py(i - 1)) / 6;
            const cp2x = P[i + 1].x - (px(i + 2) - px(i    )) / 6;
            const cp2y = P[i + 1].y - (py(i + 2) - py(i    )) / 6;
            d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${P[i + 1].x},${P[i + 1].y}`;
        }
        entry.path.setAttribute('d', d);
    }

    private ensureAnimating(): void {
        if (this.animFrameId === null) {
            this.lastTime = null; // reset so first frame doesn't get a huge dt
            this.animFrameId = requestAnimationFrame(this.boundAnimate);
        }
    }

    private animate(): void {
        this.animFrameId = null;
        const now = performance.now();
        const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, 0.05);
        this.lastTime = now;

        let anyActive = false;
        for (const entry of this.wires.values()) {
            if (!entry.active) continue;
            this.simStep(entry, dt);
            this.renderPath(entry);
            if (entry.active) anyActive = true;
        }
        this.updateDeleteButtons();
        if (anyActive) {
            this.animFrameId = requestAnimationFrame(this.boundAnimate);
        }
        // Loop exits here when all wires have settled — zero overhead until next trigger
    }

    // --- Drag interaction ---

    private onSocketPointerDown(ev: PointerEvent, sourceEl: HTMLElement): void {
        if (ev.button !== 0) return;
        const meta = this.sockets.get(sourceEl);
        if (!meta) return;

        if (meta.used) {
            ev.preventDefault();
            ev.stopPropagation();
            const wireId = this.getWireIdForSocket(sourceEl);
            if (wireId !== null) this.selectWire(wireId);
            return;
        }

        this.clearSelection();
        ev.preventDefault();
        ev.stopPropagation();
        sourceEl.setPointerCapture(ev.pointerId);

        this.dragState = { sourceEl, sourceMeta: meta };
        sourceEl.classList.add('wire_drag_source');

        const compatTypes: SocketType[] = meta.type === 'vm' ? ['hub', 'vm'] : ['vm'];
        for (const [el, m] of this.sockets) {
            if (el !== sourceEl && compatTypes.includes(m.type) && !m.used) {
                el.classList.add('wire_drag_target');
            }
        }

        this.ghostPath.style.display = '';
        this.updateGhost(ev.clientX, ev.clientY);

        sourceEl.addEventListener('pointermove', this.boundOnMove);
        sourceEl.addEventListener('pointerup',   this.boundOnUp);
    }

    private onDragMove(ev: PointerEvent): void {
        this.updateGhost(ev.clientX, ev.clientY);

        const { sourceEl, sourceMeta } = this.dragState!;
        const compatTypes: SocketType[] = sourceMeta.type === 'vm' ? ['hub', 'vm'] : ['vm'];
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const overEl = hit?.closest('.vm_net_iface') as HTMLElement | null;
        const overMeta = overEl ? this.sockets.get(overEl) : undefined;
        const newHot = (overEl && overEl !== sourceEl && overMeta && !overMeta.used && compatTypes.includes(overMeta.type))
            ? overEl : null;

        if (newHot !== this.hotSocketEl) {
            this.hotSocketEl?.classList.remove('wire_drag_target_hot');
            this.hotSocketEl = newHot;
            this.hotSocketEl?.classList.add('wire_drag_target_hot');
        }
    }

    private updateGhost(cx: number, cy: number): void {
        if (!this.dragState) return;
        const r = this.dragState.sourceEl.getBoundingClientRect();
        const x1 = r.left + r.width / 2 + 6;
        const y1 = r.bottom - 1;
        const droop = Math.min(Math.max(Math.abs(cx - x1) * 0.4, 30), 200);
        this.ghostPath.setAttribute('d',
            `M ${x1},${y1} C ${x1},${y1 + droop} ${cx},${cy + droop} ${cx},${cy}`
        );
    }

    private onDragUp(ev: PointerEvent): void {
        if (!this.dragState) return;
        const { sourceEl, sourceMeta } = this.dragState;

        sourceEl.releasePointerCapture(ev.pointerId);
        sourceEl.removeEventListener('pointermove', this.boundOnMove);
        sourceEl.removeEventListener('pointerup',   this.boundOnUp);

        this.ghostPath.style.display = 'none';
        this.clearHighlights();

        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetEl = hit?.closest('.vm_net_iface') as HTMLElement | null;
        const targetMeta = targetEl ? this.sockets.get(targetEl) : undefined;

        const compatTypes: SocketType[] = sourceMeta.type === 'vm' ? ['hub', 'vm'] : ['vm'];
        if (targetEl && targetEl !== sourceEl && targetMeta && !targetMeta.used && compatTypes.includes(targetMeta.type)) {
            this.add(sourceEl, targetEl);
            this.markSocketUsed(sourceEl);
            this.markSocketUsed(targetEl);
            const updateFn = () => this.updateAll();
            sourceMeta.onDragSetter(updateFn);
            targetMeta.onDragSetter(updateFn);
            sourceMeta.onConnect?.(targetEl);
            targetMeta.onConnect?.(sourceEl);
        }

        this.dragState = null;
    }

    private clearHighlights(): void {
        for (const el of this.sockets.keys()) {
            el.classList.remove('wire_drag_source', 'wire_drag_target', 'wire_drag_target_hot');
        }
        this.hotSocketEl = null;
    }
}
