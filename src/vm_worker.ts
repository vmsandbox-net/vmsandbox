// Per-VM Web Worker: runs the TinyEMU WASM module off the main thread.
// Communicates with the main thread via postMessage.

// The Emscripten glue code references `window` directly (e.g. new window.XMLHttpRequest()).
// Workers don't have `window`, but `self` is the equivalent global scope.
(self as any).window = self;

// importScripts is not available in module workers; fetch + indirect eval is equivalent:
// it loads the script text and executes it in the worker's global scope so that
// assignments like `self.createTinyEMU = ...` inside the script take effect.
async function loadScript(url: string): Promise<void> {
    const text = await (await fetch(url)).text();
    // eslint-disable-next-line no-eval
    (0, eval)(text);
}

function post(msg: any, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
        (self as any).postMessage(msg, transfer);
    } else {
        (self as any).postMessage(msg);
    }
}

interface TermSize { cols: number; rows: number }

let wasmModule: any = null;
let consoleQueueCharN:     ((idx: number, code: number) => void) | null = null;
let vmConsoleResizeNotify: ((idx: number) => void) | null = null;
let netSetCarrierFn:       ((ethIdx: number, v: number) => void) | null = null;
let netWritePacketFn:      ((ethIdx: number, ptr: number, len: number) => void) | null = null;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Called from the WASM side (via EM_ASM) once the VM is fully initialised.
// Drives the run loop via an async/await cycle so the worker event loop
// remains live for incoming messages (net_recv, terminal_input, etc.).
async function runVMLoop(): Promise<void> {
    const vmRunStep: () => number = wasmModule.cwrap('vm_run_step', 'number', []);
    for (;;) {
        const delay = vmRunStep();
        if (delay > 0) {
            await sleep(delay);
        }
    }
}
// vm_on_ready is called by name from WASM (EM_ASM); keep the snake_case identifier.
(self as any).vm_on_ready = () => { post({ type: 'vm_ready' }); void runVMLoop(); };

const termSizes: TermSize[] = [];

addEventListener('message', (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
        case 'start':
            handleStart(msg);
            break;
        case 'terminal_input':
            handleTerminalInput(msg.consoleIdx, msg.data);
            break;
        case 'console_resize':
            handleConsoleResize(msg.consoleIdx, msg.cols, msg.rows);
            break;
        case 'net_recv':
            handleNetRecv(msg.ethIdx, msg.packet);
            break;
        case 'connect_eth':
            handleConnectEth(msg.ethIdx);
            break;
        case 'disconnect_eth':
            handleDisconnectEth(msg.ethIdx);
            break;
    }
});

async function handleStart(msg: any): Promise<void> {
    const { wasmJsUrl, wasmBinaryUrl, params, preconnectedEths } = msg;
    const consoleCount: number = params.consoleCount ?? 8;
    for (let i = 0; i < consoleCount; i++) {
        termSizes.push({ cols: params.cols, rows: params.rows });
    }

    await initBlkCompression(params);

    await loadScript(wasmJsUrl);
    const m: any = {};
    // Override Emscripten's WASM path resolution: it computes the path relative to
    // self.location (the worker URL), but the .wasm file lives at /assets/ on the server.
    // locateFile lets us supply the correct absolute URL directly.
    m.locateFile = (path: string) => path.endsWith('.wasm') ? wasmBinaryUrl : path;
    m.preRun = () => onModuleReady(m, params, preconnectedEths as number[]);
    (self as any).createTinyEMU(m);
}

async function initBlkCompression(params: any): Promise<void> {
    // Initialize zstandard-wasm — needed for kernel/firmware (.bin.zst) and disk blocks
    const { default: zstd } = await import('zstandard-wasm');
    await zstd.loadWASM();
    (self as any)._zstd = zstd;

    // Parse the VM config to find the blk.txt URL
    let blkUrl: string | null = null;
    try {
        const cfg = JSON.parse(params.configJson ?? '{}');
        blkUrl = cfg?.drive0?.file ?? null;
    } catch {
        return;
    }

    if (!blkUrl) return;

    // Fetch and parse blk.txt to read disk block compression settings
    const resp = await fetch(blkUrl);
    if (!resp.ok) throw new Error(`Failed to fetch blk.txt: HTTP ${resp.status}`);
    const cfg = JSON.parse(await resp.text());
    if (cfg.compressed === true) {
        (self as any)._blkCompressed = true;
    }
}

function handleTerminalInput(consoleIdx: number, data: string): void {
    if (!consoleQueueCharN) return;
    // Encode as UTF-8 bytes so multi-byte characters (e.g. accented letters, CJK)
    // are sent to the VM as the correct byte sequence rather than raw code units.
    const bytes = new TextEncoder().encode(data);
    for (const byte of bytes) {
        consoleQueueCharN(consoleIdx, byte);
    }
}

function handleConsoleResize(consoleIdx: number, cols: number, rows: number): void {
    termSizes[consoleIdx] = { cols, rows };
    vmConsoleResizeNotify?.(consoleIdx);
}

function handleNetRecv(ethIdx: number, packet: ArrayBuffer): void {
    if (!wasmModule || !netWritePacketFn) return;
    const buf = new Uint8Array(packet);
    const ptr = wasmModule._malloc(buf.length);
    if (!ptr) return;
    wasmModule.HEAPU8.set(buf, ptr);
    netWritePacketFn(ethIdx, ptr, buf.length);
    wasmModule._free(ptr);
}

function handleConnectEth(ethIdx: number): void {
    setTimeout(() => netSetCarrierFn?.(ethIdx, 1), 200);
}

function handleDisconnectEth(ethIdx: number): void {
    netSetCarrierFn?.(ethIdx, 0);
}

function onModuleReady(m: any, params: any, preconnectedEths: number[]): void {
    wasmModule = m;
    const consoleCount: number = params.consoleCount ?? 8;
    const hubPortCount: number = params.hubPortCount ?? 0;

    // Terminal callbacks — output goes to main thread via postMessage
    wasmModule.terms = Array.from({ length: consoleCount }, (_: unknown, idx: number) => ({
        write: (str: string) => post({ type: 'terminal_output', consoleIdx: idx, data: str }),
        getSize: () => {
            const s = termSizes[idx] ?? { cols: 80, rows: 24 };
            return [s.cols, s.rows];
        },
    }));

    wasmModule.graphic_display = null;
    wasmModule.update_downloading = (flag: number) => post({ type: 'update_downloading', flag });

    // Wrap WASM functions
    consoleQueueCharN     = m.cwrap('console_queue_char_n',     null, ['number', 'number']);
    vmConsoleResizeNotify = m.cwrap('vm_console_resize_notify', null, ['number']);
    netSetCarrierFn       = m.cwrap('net_set_carrier',          null, ['number', 'number']);
    netWritePacketFn      = m.cwrap('net_write_packet',         null, ['number', 'number', 'number']);
    const vmVirtio9pClearFiles = m.cwrap('vm_virtio9p_clear_files', null, []);
    const vmVirtio9pAddFile    = m.cwrap('vm_virtio9p_add_file',    null, ['string', 'array', 'number']);

    // Network states — outgoing packets are forwarded to main thread
    wasmModule.net_states = new Array(hubPortCount).fill(null);
    const preconnectedSet = new Set<number>(preconnectedEths);
    for (let i = 0; i < hubPortCount; i++) {
        const ethIdx = i;
        wasmModule.net_states[ethIdx] = {
            recv_packet(buf: Uint8Array): void {
                const copy = buf.slice();
                post({ type: 'net_send', ethIdx, packet: copy.buffer }, [copy.buffer]);
            },
        };
        if (preconnectedSet.has(ethIdx)) {
            setTimeout(() => netSetCarrierFn!(ethIdx, 1), 200);
        }
    }

    // Load init files into virtio9p
    if (params.initFiles && params.initFiles.size > 0) {
        vmVirtio9pClearFiles();
        for (const [name, data] of params.initFiles as Map<string, Uint8Array>) {
            vmVirtio9pAddFile(name, data, data.length);
        }
    }

    // Set config JSON
    if (params.configJson) {
        const setJson = m.cwrap('vm_set_config_json', null, ['string']);
        setJson(params.configJson);
    }

    m.ccall(
        'vm_start', null,
        ['string', 'number', 'string', 'string', 'number', 'number', 'number', 'number'],
        [params.url, params.memSize, params.cmdline, '', 0, 0, 1, consoleCount]
    );
}
