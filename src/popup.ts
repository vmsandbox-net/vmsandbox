export class Popup {
    private overlay: HTMLDivElement;
    readonly bodyEl: HTMLDivElement;
    readonly footerEl: HTMLDivElement;

    constructor(options: { title: string; width?: number; height?: number }) {
        this.overlay = document.createElement('div');
        this.overlay.className = 'popup_overlay';
        this.overlay.hidden = true;

        const dialog = document.createElement('div');
        dialog.className = 'popup_dialog';
        if (options.width)  dialog.style.width  = `${options.width}px`;
        if (options.height) dialog.style.height = `${options.height}px`;

        const header = document.createElement('div');
        header.className = 'popup_header';

        const titleEl = document.createElement('span');
        titleEl.className = 'popup_title';
        titleEl.textContent = options.title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'popup_close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', () => this.close());

        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'popup_body';

        this.footerEl = document.createElement('div');
        this.footerEl.className = 'popup_footer';

        dialog.appendChild(header);
        dialog.appendChild(this.bodyEl);
        dialog.appendChild(this.footerEl);
        this.overlay.appendChild(dialog);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        document.body.appendChild(this.overlay);
    }

    open(): void  { this.overlay.hidden = false; }
    close(): void { this.overlay.hidden = true; }
}
