export function makeDraggable(win: HTMLElement, titlebar: HTMLElement, onDrag?: () => void): void {
    titlebar.style.touchAction = 'none';
    titlebar.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        if ((ev.target as HTMLElement).closest('button')) return;
        const rect    = win.getBoundingClientRect();
        const offsetX = ev.clientX - rect.left;
        const offsetY = ev.clientY - rect.top;
        titlebar.setPointerCapture(ev.pointerId);

        function handleMove(ev: PointerEvent): void {
            win.style.left = (ev.clientX - offsetX) + 'px';
            win.style.top  = (ev.clientY - offsetY) + 'px';
            onDrag?.();
        }
        function onUp(ev: PointerEvent): void {
            titlebar.releasePointerCapture(ev.pointerId);
            titlebar.removeEventListener('pointermove', handleMove);
            titlebar.removeEventListener('pointerup',   onUp);
        }
        titlebar.addEventListener('pointermove', handleMove);
        titlebar.addEventListener('pointerup',   onUp);
        ev.preventDefault();
    });
}
