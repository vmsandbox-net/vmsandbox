import { marked } from 'marked';
import { makeDraggable } from './drag';
import type { TopologyDoc } from './topology';

marked.use({
    renderer: {
        code({ text, lang }: { text: string; lang?: string }): string | false {
            if (lang?.startsWith('send-vm:')) {
                const vmId = lang.slice('send-vm:'.length);
                const escaped = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                return `<pre data-send-vm="${vmId}">${escaped}</pre>`;
            }
            if (lang?.startsWith('goto:')) {
                const topoId = lang.slice('goto:'.length);
                const label = text.trim()
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                return `<span data-goto="${topoId}">${label}</span>`;
            }
            return false;
        }
    }
});

export class DocWindow {
    readonly el: HTMLElement;
    onClose:        (() => void) | null = null;
    onFocusRequest: (() => void) | null = null;
    onDrag:         (() => void) | null = null;
    onResize:       ((width: number, height: number) => void) | null = null;

    private readonly sendToVm: ((vmId: string, text: string) => void) | undefined;
    private readonly goto:     ((topoId: string) => void) | undefined;

    constructor(
        container: HTMLElement,
        doc: TopologyDoc,
        cascadeIndex: number,
        opts?: {
            title?: string; x?: number; y?: number; width?: number; height?: number;
            onSendToVm?: (vmId: string, text: string) => void;
            onGoto?: (topoId: string) => void;
        }
    ) {
        this.sendToVm = opts?.onSendToVm;
        this.goto     = opts?.onGoto;
        this.el = this.buildDOM(opts?.title ?? doc.title ?? doc.id, doc.markdown, opts?.width, opts?.height);
        this.el.style.top  = (opts?.y ?? (80 + cascadeIndex * 30)) + 'px';
        this.el.style.left = (opts?.x ?? (200 + cascadeIndex * 30)) + 'px';
        container.appendChild(this.el);
    }

    private buildDOM(title: string, markdown: string, width?: number, height?: number): HTMLElement {
        const win = document.createElement('div');
        win.className = 'vm_window doc_window';
        if (width)  win.style.width = width + 'px';
        if (height) win.style.height = height + 'px';

        const titlebar = document.createElement('div');
        titlebar.className = 'vm_titlebar';

        const titleEl = document.createElement('span');
        titleEl.className = 'vm_title';
        titleEl.textContent = title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'vm_close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.close(); });

        titlebar.appendChild(titleEl);
        titlebar.appendChild(closeBtn);
        win.appendChild(titlebar);

        const content = document.createElement('div');
        content.className = 'doc_content';
        content.innerHTML = marked.parse(markdown) as string;

        for (const el of Array.from(content.querySelectorAll('[data-send-vm]'))) {
            const vmId = el.getAttribute('data-send-vm')!;
            const text = (el.textContent ?? '').trim();
            el.removeAttribute('data-send-vm');

            const wrapper = document.createElement('div');
            wrapper.className = 'send_block';
            el.parentNode!.insertBefore(wrapper, el);
            wrapper.appendChild(el);

            const actions = document.createElement('div');
            actions.className = 'send_actions';

            const btn = document.createElement('button');
            btn.className = 'send_btn';
            btn.textContent = `Send to ${vmId} VM`;
            btn.addEventListener('click', () => this.sendToVm?.(vmId, text));

            actions.appendChild(btn);
            wrapper.appendChild(actions);
        }

        for (const el of Array.from(content.querySelectorAll('[data-goto]'))) {
            const topoId = el.getAttribute('data-goto')!;
            const label = (el.textContent ?? '').trim();
            el.removeAttribute('data-goto');

            const btn = document.createElement('button');
            btn.className = 'goto_btn';
            btn.textContent = label;
            btn.addEventListener('click', () => this.goto?.(topoId));
            el.parentNode!.replaceChild(btn, el);
        }

        win.appendChild(content);

        const grip = document.createElement('div');
        grip.className = 'vm_resize_grip';
        win.appendChild(grip);
        this.addResizeGrip(grip, win);

        makeDraggable(win, titlebar, () => this.onDrag?.());
        win.addEventListener('pointerdown', () => this.onFocusRequest?.());

        return win;
    }

    private addResizeGrip(grip: HTMLElement, win: HTMLElement): void {
        grip.style.touchAction = 'none';
        grip.addEventListener('pointerdown', (ev: PointerEvent) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            const startX = ev.clientX;
            const startY = ev.clientY;
            const startW = win.offsetWidth;
            const startH = win.offsetHeight;
            grip.setPointerCapture(ev.pointerId);

            const onMove = (ev: PointerEvent) => {
                const w = Math.max(200, startW + (ev.clientX - startX));
                const h = Math.max(100, startH + (ev.clientY - startY));
                win.style.width  = w + 'px';
                win.style.height = h + 'px';
                this.onDrag?.();
            };
            const onUp = (ev: PointerEvent) => {
                grip.releasePointerCapture(ev.pointerId);
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup', onUp);
                this.onResize?.(win.offsetWidth, win.offsetHeight);
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
        });
    }

    setFocus(focused: boolean): void {
        this.el.classList.toggle('focused', focused);
    }

    close(): void {
        this.el.remove();
        this.onClose?.();
    }
}
