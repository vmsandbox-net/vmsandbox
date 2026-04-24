import './style.css';
import { buildNetPanel } from './net_panel';

const panel = buildNetPanel(4, (i) => 'eth' + i);
document.getElementById('root')!.appendChild(panel.el);

// Sockets 0 and 1: connected (green LED on, plug overlay shown)
panel.setConnected(0, true);
panel.getSocketEl(0).classList.add('wire_connected');

panel.setConnected(1, true);
panel.getSocketEl(1).classList.add('wire_connected');

// Sockets 2 and 3: disconnected (default state)
