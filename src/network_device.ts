export interface NetworkDevice {
    register(idx: number, send: (ethIdx: number, buf: Uint8Array) => void, ethIdx: number, onReceive?: () => void): void;
    setConnected(idx: number, val: boolean): void;
    isConnected(idx: number): boolean;
    forward(fromIdx: number, buf: Uint8Array): void;
    onConnectedChange: ((idx: number, connected: boolean) => void) | null;
    onTraffic: ((fromIdx: number, toIdx: number) => void) | null;
}

interface Port {
    send: ((ethIdx: number, buf: Uint8Array) => void) | null;
    ethIdx: number;
    connected: boolean;
    onReceive: (() => void) | null;
}

function makePorts(n: number): Port[] {
    return Array.from({ length: n }, () => ({ send: null, ethIdx: 0, connected: false, onReceive: null }));
}

function deliverTo(p: Port, fromIdx: number, toIdx: number, buf: Uint8Array, onTraffic: NetworkDevice['onTraffic']): void {
    if (!p.connected || !p.send) return;
    p.send(p.ethIdx, buf);
    p.onReceive?.();
    onTraffic?.(fromIdx, toIdx);
}

export function createHub(numPorts = 16): NetworkDevice {
    const ports = makePorts(numPorts);
    const hub: NetworkDevice = {
        onConnectedChange: null,
        onTraffic: null,
        register(idx, send, ethIdx = 0, onReceive?) {
            ports[idx].send      = send;
            ports[idx].ethIdx    = ethIdx;
            ports[idx].onReceive = onReceive ?? null;
        },
        setConnected(idx, val) {
            ports[idx].connected = Boolean(val);
            hub.onConnectedChange?.(idx, Boolean(val));
        },
        isConnected(idx) { return ports[idx].connected; },
        forward(fromIdx, buf) {
            for (let i = 0; i < ports.length; i++) {
                if (i !== fromIdx) deliverTo(ports[i], fromIdx, i, buf, hub.onTraffic);
            }
        },
    };
    return hub;
}

function macKey(buf: Uint8Array, off: number): string {
    return `${buf[off].toString(16).padStart(2,'0')}:${buf[off+1].toString(16).padStart(2,'0')}:` +
           `${buf[off+2].toString(16).padStart(2,'0')}:${buf[off+3].toString(16).padStart(2,'0')}:` +
           `${buf[off+4].toString(16).padStart(2,'0')}:${buf[off+5].toString(16).padStart(2,'0')}`;
}

export function createSwitch(numPorts = 16): NetworkDevice {
    const ports = makePorts(numPorts);
    const macTable = new Map<string, number>();
    const sw: NetworkDevice = {
        onConnectedChange: null,
        onTraffic: null,
        register(idx, send, ethIdx = 0, onReceive?) {
            ports[idx].send      = send;
            ports[idx].ethIdx    = ethIdx;
            ports[idx].onReceive = onReceive ?? null;
        },
        setConnected(idx, val) {
            ports[idx].connected = Boolean(val);
            sw.onConnectedChange?.(idx, Boolean(val));
        },
        isConnected(idx) { return ports[idx].connected; },
        forward(fromIdx, buf) {
            if (buf.length < 12) return;

            // Learn source MAC
            macTable.set(macKey(buf, 6), fromIdx);

            // Multicast/broadcast: low bit of first byte
            const isMulticast = (buf[0] & 1) !== 0;
            const dst = macKey(buf, 0);
            const knownPort = macTable.get(dst);

            if (isMulticast || knownPort === undefined) {
                for (let i = 0; i < ports.length; i++) {
                    if (i !== fromIdx) deliverTo(ports[i], fromIdx, i, buf, sw.onTraffic);
                }
            } else if (knownPort !== fromIdx) {
                deliverTo(ports[knownPort], fromIdx, knownPort, buf, sw.onTraffic);
            }
        },
    };
    return sw;
}
