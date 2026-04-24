import './style.css';
import { type VmParams } from './vm';
import { WireManager } from './wire_manager';
import { Workspace } from './workspace';
import { PanController } from './pan';
import { loadTopology, serializeTopology } from './topology';
import { assetUrl } from './config';
import { DocWindow } from './doc_window';
import { Popup } from './popup';
import { LabPicker } from './lab_picker';

const app = document.getElementById('app')!;
const wireManager = new WireManager(app);
const titlebarEl = document.getElementById('page_titlebar')!;
const panController = new PanController(app, titlebarEl, () => wireManager.updateAll());

function getParams(): VmParams {
    const params = new URLSearchParams(window.location.search);
    const fname = params.get('url') ?? 'vmsandbox-browser.cfg';
    const url = fname.includes(':')
        ? fname
        : (() => {
            const loc = window.location;
            const pathEnd = loc.pathname.lastIndexOf('/');
            return loc.origin + loc.pathname.slice(0, pathEnd + 1) + fname;
        })();
    return {
        url,
        memSize:  parseInt(params.get('mem')       ?? '', 10) || 256,
        cmdline:  params.get('cmdline')  ?? '',
        cols:     parseInt(params.get('cols')      ?? '', 10) || 80,
        rows:     parseInt(params.get('rows')      ?? '', 10) || 30,
        fontSize: parseInt(params.get('font_size') ?? '', 10) || 15,
        driveUrl: params.get('drive_url') ?? '',
    };
}

const workspace = new Workspace(app, wireManager, getParams, panController);

window.addEventListener('resize', () => {
    panController.updateFitState();
    wireManager.updateAll();
});

// --- Add Resources popup ---
const resourcesPopup = new Popup({ title: 'Add Resources', width: 700, height: 400 });

document.getElementById('btn_fab')!.addEventListener('click', () => resourcesPopup.open());

// Modal resource tabs
type ResourceType = 'vm' | 'switch' | 'hub';
let selectedResource: ResourceType = 'vm';

const modalTabDefs: { label: string; type: ResourceType }[] = [
    { label: 'Virtual Machine', type: 'vm' },
    { label: 'Network Switch',  type: 'switch' },
    { label: 'Network Hub',     type: 'hub' },
];

const modalContent = document.createElement('div');
modalContent.id = 'modal_content';
const modalTabsEl = document.createElement('div');
modalTabsEl.id = 'modal_tabs';
const modalPanel = document.createElement('div');
modalPanel.id = 'modal_panel';
modalContent.appendChild(modalTabsEl);
modalContent.appendChild(modalPanel);
resourcesPopup.bodyEl.appendChild(modalContent);

const modalAddBtn = document.createElement('button');
modalAddBtn.id = 'modal_add';
modalAddBtn.textContent = 'Add';
resourcesPopup.footerEl.appendChild(modalAddBtn);

function makeRadioField(name: string, label: string, options: number[], defaultVal: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'modal_field';
    const lbl = document.createElement('div');
    lbl.className = 'modal_field_label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    const group = document.createElement('div');
    group.className = 'modal_radio_group';
    options.forEach(val => {
        const radioLabel = document.createElement('label');
        radioLabel.className = 'modal_radio_label';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = String(val);
        if (val === defaultVal) radio.checked = true;
        radioLabel.appendChild(radio);
        radioLabel.append(` ${val}`);
        group.appendChild(radioLabel);
    });
    wrap.appendChild(group);
    return wrap;
}

function makeTextField(id: string, label: string, placeholder = ''): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'modal_field';
    const lbl = document.createElement('label');
    lbl.htmlFor = id;
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.placeholder = placeholder;
    input.className = 'modal_text_input';
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return wrap;
}

function renderModalPanel(type: ResourceType): void {
    modalPanel.innerHTML = '';
    if (type === 'vm') {
        modalPanel.appendChild(makeTextField('vm_name', 'Name', 'vmsandbox'));
        modalPanel.appendChild(makeRadioField('vm_ports', 'Network Ports', [0, 1, 2, 3, 4], 1));
        modalPanel.appendChild(makeRadioField('vm_mem', 'Memory (MB)', [48, 64, 128, 256, 512, 1024], 256));
    } else {
        modalPanel.appendChild(makeRadioField('sw_ports', 'Network Ports', [2, 3, 4, 5, 6, 7, 8], 5));
    }
}

modalTabDefs.forEach(({ label, type }) => {
    const tab = document.createElement('div');
    tab.className = 'modal_tab';
    tab.textContent = label;
    if (type === selectedResource) tab.classList.add('active');
    tab.addEventListener('click', () => {
        selectedResource = type;
        modalTabsEl.querySelectorAll('.modal_tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderModalPanel(type);
    });
    modalTabsEl.appendChild(tab);
});

renderModalPanel(selectedResource);

modalAddBtn.addEventListener('click', () => {
    if (selectedResource === 'vm') {
        const ports = parseInt((modalPanel.querySelector('input[name="vm_ports"]:checked') as HTMLInputElement).value, 10);
        const mem   = parseInt((modalPanel.querySelector('input[name="vm_mem"]:checked') as HTMLInputElement).value, 10);
        const name  = ((document.getElementById('vm_name') as HTMLInputElement).value.trim()) || 'vmsandbox';
        workspace.addVm(ports, mem, name);
    } else if (selectedResource === 'switch') {
        const ports = parseInt((modalPanel.querySelector('input[name="sw_ports"]:checked') as HTMLInputElement).value, 10);
        workspace.addSwitch(ports);
    } else {
        const ports = parseInt((modalPanel.querySelector('input[name="sw_ports"]:checked') as HTMLInputElement).value, 10);
        workspace.addHub(ports);
    }
    resourcesPopup.close();
});

// --- Simulation tuning panel ---

type SliderDef = {
    label: string;
    key: 'springK' | 'damping' | 'impulseScale' | 'simStop' | 'birthKick';
    min: number; max: number; step: number;
};

const sliderDefs: SliderDef[] = [
    { label: 'Stiffness',      key: 'springK',      min: 10,   max: 500,  step: 1    },
    { label: 'Damping',        key: 'damping',       min: 0.5,  max: 30,   step: 0.5  },
    { label: 'Impulse scale',  key: 'impulseScale',  min: 0,    max: 3,    step: 0.05 },
    { label: 'Settle thresh.', key: 'simStop',       min: 0.01, max: 2,    step: 0.01 },
    { label: 'Birth kick',     key: 'birthKick',     min: 0,    max: 150,  step: 1    },
];

if (import.meta.env.DEV) {
    const tunePanel = document.getElementById('sim_tune_panel')!;
    for (const def of sliderDefs) {
        const row = document.createElement('div');
        row.className = 'sim_tune_row';

        const label = document.createElement('span');
        label.className = 'sim_tune_label';
        label.textContent = def.label;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'sim_tune_slider';
        slider.min  = String(def.min);
        slider.max  = String(def.max);
        slider.step = String(def.step);
        slider.value = String(wireManager[def.key]);

        const val = document.createElement('span');
        val.className = 'sim_tune_value';
        val.textContent = String(wireManager[def.key]);

        slider.addEventListener('input', () => {
            const n = parseFloat(slider.value);
            wireManager[def.key] = n;
            val.textContent = String(n);
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(val);
        tunePanel.appendChild(row);
    }
}

// --- Lab picker ---
const labPicker = new LabPicker();
document.getElementById('btn_topology_title')!.addEventListener('click', () => labPicker.open());
if (new URLSearchParams(window.location.search).has('select') || !window.location.search) labPicker.open();

// --- About popup ---
const aboutPopup = new Popup({ title: 'About', width: 820, height: 680 });

const aboutItems: { id: string; label: string }[] = [
    { id: 'vmsandbox',   label: 'vmsandbox.net'   },
    { id: 'tinyemu',     label: 'TinyEMU'          },
    { id: 'ubuntu-font', label: 'Ubuntu Font'      },
    { id: 'xtermjs',     label: 'xterm.js'         },
    { id: 'opensbi',     label: 'OpenSBI'          },
    { id: 'linux',       label: 'Linux Kernel'     },
    { id: 'debian',      label: 'Debian GNU/Linux' },
    { id: 'ngirc',       label: 'ngIRCd'           },
    { id: 'irssi',       label: 'Irssi'            },
    { id: 'bird',        label: 'BIRD'             },
    { id: 'etcd',        label: 'etcd'             },
    { id: 'postgresql',  label: 'PostgreSQL'       },
];

const aboutContent = document.createElement('div');
aboutContent.id = 'about_content';

const aboutNav = document.createElement('div');
aboutNav.id = 'about_nav';

const aboutFrame = document.createElement('iframe');
aboutFrame.id = 'about_frame';
aboutFrame.src = assetUrl('about.html');

aboutContent.appendChild(aboutNav);
aboutContent.appendChild(aboutFrame);
aboutPopup.bodyEl.appendChild(aboutContent);

aboutItems.forEach(({ id, label }, i) => {
    const item = document.createElement('div');
    item.className = 'about_nav_item' + (i === 0 ? ' active' : '');
    item.textContent = label;
    item.addEventListener('click', () => {
        aboutNav.querySelectorAll('.about_nav_item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        aboutFrame.contentWindow?.postMessage({ anchor: id }, '*');
    });
    aboutNav.appendChild(item);
});

document.getElementById('btn_about')!.addEventListener('click', (e) => {
    e.preventDefault();
    aboutPopup.open();
});

// --- Topology loading ---

const DEFAULT_TOPOLOGY = 'default.yaml';
const params = new URLSearchParams(window.location.search);
const firstKey = [...params.keys()].find(k => k !== 'select');
const topoFile = firstKey ? firstKey + '.yaml' : DEFAULT_TOPOLOGY;
if (!firstKey) {
    const defaultKey = DEFAULT_TOPOLOGY.replace(/\.yaml$/, '');
    history.replaceState(null, '', `${window.location.pathname}?${defaultKey}&select`);
}
const topoUrl = assetUrl(`topologies/${topoFile}`);

function showError(title: string, message: string): void {
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedTitle   = escapeHtml(title);
    const escapedMessage = escapeHtml(message);
    const doc = { id: 'error', title: escapedTitle, markdown: `\`\`\`\n${escapedMessage}\n\`\`\``, x: 200, y: 200 };
    new DocWindow(app, doc, 0, { title: escapedTitle, x: 200, y: 200, width: 600 });
}

if (import.meta.env.DEV) {
    const btnSave = document.createElement('button');
    btnSave.id = 'btn_save_topology';
    btnSave.textContent = 'Save';
    btnSave.title = 'Save topology positions to disk';
    document.getElementById('page_titlebar')!.appendChild(btnSave);

    btnSave.addEventListener('click', async () => {
        if (!workspace.currentTopo) return;
        workspace.snapshotPositions();
        const yaml = serializeTopology(workspace.currentTopo);
        btnSave.disabled = true;
        btnSave.textContent = 'Saving…';
        try {
            const res = await fetch('/api/save-topology', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: topoFile, yaml }),
            });
            const data = await res.json();
            if (data.ok) {
                btnSave.textContent = 'Saved!';
                setTimeout(() => { btnSave.textContent = 'Save'; btnSave.disabled = false; }, 1500);
            } else {
                btnSave.textContent = 'Error';
                console.error('Save failed:', data.error);
                setTimeout(() => { btnSave.textContent = 'Save'; btnSave.disabled = false; }, 2000);
            }
        } catch (e) {
            btnSave.textContent = 'Error';
            console.error('Save failed:', e);
            setTimeout(() => { btnSave.textContent = 'Save'; btnSave.disabled = false; }, 2000);
        }
    });
}

loadTopology(topoUrl)
    .then(topo => { workspace.currentTopo = topo; return workspace.applyTopology(topo); })
    .catch((e) => {
        console.error('Failed to load topology:', e);
        showError('Topology Error', String(e?.message ?? e));
    });
