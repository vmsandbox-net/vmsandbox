import { Popup } from './popup';
import { assetUrl } from './config';

interface LabEntry {
    file: string;
    title: string;
    description?: string;
}

export class LabPicker {
    private popup: Popup;
    private listEl: HTMLDivElement;

    constructor() {
        this.popup = new Popup({ title: 'Select Lab', width: 660, height: 600 });
        this.listEl = document.createElement('div');
        this.listEl.className = 'lab_list';
        this.popup.bodyEl.appendChild(this.listEl);
        this.load();
    }

    private async load(): Promise<void> {
        try {
            const url = assetUrl('topologies/index.json');
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const labs: LabEntry[] = await resp.json();
            for (const lab of labs) {
                const row = document.createElement('div');
                row.className = 'lab_row';
                row.dataset.file = lab.file;

                const header = document.createElement('div');
                header.className = 'lab_row_header';

                const title = document.createElement('span');
                title.className = 'lab_row_title';
                title.textContent = lab.title;
                header.appendChild(title);

                if (lab.file === 'ping.yaml') {
                    const badge = document.createElement('span');
                    badge.className = 'lab_row_badge';
                    badge.textContent = 'Start here';
                    header.appendChild(badge);
                }

                row.appendChild(header);

                if (lab.description) {
                    const desc = document.createElement('div');
                    desc.className = 'lab_row_desc';
                    desc.textContent = lab.description;
                    row.appendChild(desc);
                }

                row.addEventListener('click', () => {
                    window.location.search = '?' + encodeURIComponent(lab.file.replace(/\.yaml$/, ''));
                });
                this.listEl.appendChild(row);
            }
        } catch (e) {
            const msg = document.createElement('div');
            msg.className = 'lab_list_error';
            msg.textContent = `Failed to load lab list: ${e}`;
            this.listEl.appendChild(msg);
        }
    }

    open(): void {
        this.popup.open();
    }
}
