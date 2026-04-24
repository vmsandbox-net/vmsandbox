const PAN_THRESHOLD = 5;

export class PanController {
    private viewPanX = 0;
    private viewPanY = 0;
    private windows: HTMLElement[] = [];
    private panEnabled = false;
    private activePointerId: number | null = null;
    private panning = false;
    private pointerDownX = 0;
    private pointerDownY = 0;

    private readonly container: HTMLElement;
    private readonly titlebarEl: HTMLElement;
    private readonly onPanUpdate: () => void;

    private readonly boundOnPointerDown = (ev: PointerEvent) => this.onPointerDown(ev);
    private readonly boundOnPointerMove = (ev: PointerEvent) => this.onPointerMove(ev);
    private readonly boundOnPointerUp   = (ev: PointerEvent) => this.onPointerUp(ev);

    constructor(container: HTMLElement, titlebarEl: HTMLElement, onPanUpdate: () => void) {
        this.container   = container;
        this.titlebarEl  = titlebarEl;
        this.onPanUpdate = onPanUpdate;
        // Listen on document because #app has zero layout height (all children are position:fixed)
        // so background clicks target body, never bubbling through #app.
        document.addEventListener('pointerdown', this.boundOnPointerDown);
    }

    registerWindow(el: HTMLElement): void   { this.windows.push(el); }
    unregisterWindow(el: HTMLElement): void { this.windows = this.windows.filter(w => w !== el); }
    getPanOffset(): { x: number; y: number } { return { x: this.viewPanX, y: this.viewPanY }; }

    updateFitState(): void {
        const { maxPanX, maxPanY } = this.computeMaxPan();
        const nowEnabled = maxPanX > 0 || maxPanY > 0;
        if (this.panEnabled && !nowEnabled) this.resetPanToZero();
        this.panEnabled = nowEnabled;
        this.container.style.cursor = nowEnabled ? 'grab' : '';
    }

    private resetPanToZero(): void {
        for (const el of this.windows) {
            el.style.left = ((parseFloat(el.style.left) || 0) + this.viewPanX) + 'px';
            el.style.top  = ((parseFloat(el.style.top) || 0) + this.viewPanY) + 'px';
        }
        this.viewPanX = 0;
        this.viewPanY = 0;
        this.onPanUpdate();
    }

    private computeMaxPan(): { maxPanX: number; maxPanY: number } {
        let maxRight = 0, maxBottom = 0;
        for (const el of this.windows) {
            const lx = (parseFloat(el.style.left) || 0) + this.viewPanX;
            const ly = (parseFloat(el.style.top) || 0) + this.viewPanY;
            maxRight  = Math.max(maxRight,  lx + el.offsetWidth);
            maxBottom = Math.max(maxBottom, ly + el.offsetHeight);
        }
        const availH = window.innerHeight - this.titlebarEl.offsetHeight - 25;
        return {
            maxPanX: Math.max(0, maxRight  + 50 - window.innerWidth),
            maxPanY: Math.max(0, maxBottom + 50 - availH),
        };
    }

    private applyDelta(dx: number, dy: number): void {
        const { maxPanX, maxPanY } = this.computeMaxPan();
        const newPanX = Math.min(maxPanX, Math.max(0, this.viewPanX - dx));
        const newPanY = Math.min(maxPanY, Math.max(0, this.viewPanY - dy));
        const winDx = this.viewPanX - newPanX;
        const winDy = this.viewPanY - newPanY;
        if (winDx === 0 && winDy === 0) return;
        for (const el of this.windows) {
            el.style.left = ((parseFloat(el.style.left) || 0) + winDx) + 'px';
            el.style.top  = ((parseFloat(el.style.top) || 0) + winDy) + 'px';
        }
        this.viewPanX = newPanX;
        this.viewPanY = newPanY;
        this.onPanUpdate();
    }

    private onPointerDown(ev: PointerEvent): void {
        if (!this.panEnabled) return;
        if (this.activePointerId !== null) return;
        if (ev.button !== 0) return;
        const target = ev.target as Element;
        // Only pan on the bare background (body/html) or inside #app but outside any window.
        // Clicks on titlebar, footer, FAB, popups, or sim-tune panel must not start a pan.
        const inApp        = target.closest('#app') !== null;
        const isBackground = target === document.body || target === document.documentElement;
        if (!inApp && !isBackground) return;
        if (target.closest('.vm_window')) return;
        this.pointerDownX = ev.clientX;
        this.pointerDownY = ev.clientY;
        this.panning = false;
        this.activePointerId = ev.pointerId;
        document.addEventListener('pointermove',   this.boundOnPointerMove);
        document.addEventListener('pointerup',     this.boundOnPointerUp);
        document.addEventListener('pointercancel', this.boundOnPointerUp);
        ev.preventDefault();
    }

    private onPointerMove(ev: PointerEvent): void {
        if (ev.pointerId !== this.activePointerId) return;
        if (!this.panning) {
            if (Math.hypot(ev.clientX - this.pointerDownX, ev.clientY - this.pointerDownY) < PAN_THRESHOLD) return;
            this.panning = true;
            this.container.style.cursor = 'grabbing';
            document.documentElement.setPointerCapture(ev.pointerId);
        }
        const dx = ev.clientX - this.pointerDownX;
        const dy = ev.clientY - this.pointerDownY;
        this.pointerDownX = ev.clientX;
        this.pointerDownY = ev.clientY;
        this.applyDelta(dx, dy);
    }

    private onPointerUp(ev: PointerEvent): void {
        if (ev.pointerId !== this.activePointerId) return;
        this.panning = false;
        this.activePointerId = null;
        this.container.style.cursor = this.panEnabled ? 'grab' : '';
        document.removeEventListener('pointermove',   this.boundOnPointerMove);
        document.removeEventListener('pointerup',     this.boundOnPointerUp);
        document.removeEventListener('pointercancel', this.boundOnPointerUp);
        if (document.documentElement.hasPointerCapture(ev.pointerId))
            document.documentElement.releasePointerCapture(ev.pointerId);
    }
}
