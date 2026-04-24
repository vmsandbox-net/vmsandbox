export interface NetPanel {
    el: HTMLElement;
    setConnected(idx: number, connected: boolean): void;
    blinkOrange(idx: number): void;
    getSocketEl(idx: number): HTMLElement;
}

const NS = 'http://www.w3.org/2000/svg';

function s(tag: string): SVGElement {
    return document.createElementNS(NS, tag) as SVGElement;
}

function attrs(el: SVGElement, a: Record<string, string | number>): void {
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
}

function linearGrad(
    id: string, c1: string, c2: string,
    x1: number, y1: number, x2: number, y2: number,
): SVGElement {
    const g = s('linearGradient');
    attrs(g, { id, x1, y1, x2, y2, gradientUnits: 'userSpaceOnUse' });
    const s1 = s('stop'); attrs(s1, { offset: '0%',   'stop-color': c1 });
    const s2 = s('stop'); attrs(s2, { offset: '100%', 'stop-color': c2 });
    g.appendChild(s1); g.appendChild(s2);
    return g;
}

// SVG dimensions (H extended by 10 to give label room at the top)
const W = 48, H = 57;
// Socket body area
const BW = 48, BH = 57;
// Opening inside socket body (OY shifted down 10px to make room for label)
const OX = 6, OY = 15, OW = 36, OH = 27;
// Latch shoulders at top of opening
const SH = 6, SW = 10;  // shoulder height, shoulder width (SW also = LED width)

function buildSocket(idx: number, label: string): {
    wrapper: HTMLElement;
    setGreen: (on: boolean) => void;
    blinkOrange: () => void;
} {
    const p = `_ns${idx}`;   // unique gradient/filter id prefix

    const svg = s('svg');
    attrs(svg, { viewBox: `0 0 ${W} ${H}`, width: W, height: H, overflow: 'visible' });

    const defs = s('defs');

    // Body gradient: top=lighter, bottom=darker (vertical)
    defs.appendChild(linearGrad(`${p}bg`, '#585858', '#282828', 0, 0, 0, H));
    // Inner rim highlight: top edge of body slightly lighter
    defs.appendChild(linearGrad(`${p}rim`, '#6a6a6a', '#383838', 0, 0, 0, 4));
    // Socket interior gradient (slightly recessed look)
    defs.appendChild(linearGrad(`${p}int`, '#181818', '#080808', 0, OY, 0, OY + OH));
    // Gold pin gradient — objectBoundingBox so every pin gets identical colouring
    const pinGrad = s('linearGradient');
    attrs(pinGrad, { id: `${p}pin`, x1: '0', y1: '0', x2: '1', y2: '0',
        gradientUnits: 'objectBoundingBox' });
    const pg1 = s('stop'); attrs(pg1, { offset: '0%',   'stop-color': '#f0d070' });
    const pg2 = s('stop'); attrs(pg2, { offset: '55%',  'stop-color': '#c8960c' });
    const pg3 = s('stop'); attrs(pg3, { offset: '100%', 'stop-color': '#8b6010' });
    pinGrad.appendChild(pg1); pinGrad.appendChild(pg2); pinGrad.appendChild(pg3);
    defs.appendChild(pinGrad);
    // Yellow LED on  (y range matches the opening row: OY .. OY+SH)
    defs.appendChild(linearGrad(`${p}yon`, '#fff0a0', '#c88000', 0, OY, 0, OY + SH));
    // Yellow LED off
    defs.appendChild(linearGrad(`${p}yof`, '#3a2200', '#1e1000', 0, OY, 0, OY + SH));
    // Yellow LED bright flash (traffic activity)
    defs.appendChild(linearGrad(`${p}ybr`, '#ffffff', '#ffaa00', 0, OY, 0, OY + SH));
    // Green LED on
    defs.appendChild(linearGrad(`${p}gon`, '#aaffaa', '#009900', 0, OY, 0, OY + SH));
    // Green LED off
    defs.appendChild(linearGrad(`${p}gof`, '#002800', '#001200', 0, OY, 0, OY + SH));

    // Connector body gradient (light ivory-cream at top, warm tan at bottom)
    // Extends to y=H+1 (connector body tip, 1px below SVG viewBox)
    defs.appendChild(linearGrad(`${p}cbody`, '#ecdcb0', '#a88848', 0, OY + SH, 0, H + 1));
    // Connector pin tray (dark recess behind the 8 contacts)
    defs.appendChild(linearGrad(`${p}ctray`, '#281c08', '#100a04', 0, OY + OH - 9, 0, OY + OH));
    // Latch clip — pure white at top face, medium gray at base for strong contrast
    defs.appendChild(linearGrad(`${p}clatch`, '#ffffff', '#9090a0', 0, 5, 0, 11));
    // Cable boot at bottom of connector (slightly darker cream)
    defs.appendChild(linearGrad(`${p}cboot`, '#c8b07a', '#907840', 0, 28, 0, 34));

    // Graduated side-shadow gradients for 3-D connector depth
    const shadLG = s('linearGradient');
    attrs(shadLG, { id: `${p}cshl`, x1: OX, y1: 0, x2: OX + 8, y2: 0,
        gradientUnits: 'userSpaceOnUse' });
    const sl1 = s('stop'); attrs(sl1, { offset: '0%',   'stop-color': '#000', 'stop-opacity': '0.3' });
    const sl2 = s('stop'); attrs(sl2, { offset: '100%', 'stop-color': '#000', 'stop-opacity': '0' });
    shadLG.appendChild(sl1); shadLG.appendChild(sl2);
    defs.appendChild(shadLG);

    const shadRG = s('linearGradient');
    attrs(shadRG, { id: `${p}cshr`, x1: OX + OW - 8, y1: 0, x2: OX + OW, y2: 0,
        gradientUnits: 'userSpaceOnUse' });
    const sr1 = s('stop'); attrs(sr1, { offset: '0%',   'stop-color': '#000', 'stop-opacity': '0' });
    const sr2 = s('stop'); attrs(sr2, { offset: '100%', 'stop-color': '#000', 'stop-opacity': '0.3' });
    shadRG.appendChild(sr1); shadRG.appendChild(sr2);
    defs.appendChild(shadRG);

    // Drop-shadow filter for glowing LEDs
    const fY = s('filter'); fY.setAttribute('id', `${p}fy`);
    fY.setAttribute('x', '-50%'); fY.setAttribute('y', '-50%');
    fY.setAttribute('width', '200%'); fY.setAttribute('height', '200%');
    const feY = s('feDropShadow');
    attrs(feY, { dx: 0, dy: 0, stdDeviation: 1.8, 'flood-color': '#d4a000', 'flood-opacity': 0.9 });
    fY.appendChild(feY); defs.appendChild(fY);

    const fG = s('filter'); fG.setAttribute('id', `${p}fg`);
    fG.setAttribute('x', '-50%'); fG.setAttribute('y', '-50%');
    fG.setAttribute('width', '200%'); fG.setAttribute('height', '200%');
    const feG = s('feDropShadow');
    attrs(feG, { dx: 0, dy: 0, stdDeviation: 1.8, 'flood-color': '#00dd00', 'flood-opacity': 0.9 });
    fG.appendChild(feG); defs.appendChild(fG);

    svg.appendChild(defs);

    // ── Socket body ──────────────────────────────────────────────────────────

    const BP = 4;  // padding at top and bottom of the background rect
    const body = s('rect');
    attrs(body, { x: 0.5, y: BP + 0.5, width: BW - 1, height: BH - 2 * BP - 1, rx: 3,
        fill: `url(#${p}bg)`, stroke: '#444', 'stroke-width': 1 });
    svg.appendChild(body);

    // Inner bevel highlight (top-left rim)
    const rimH = s('line');
    attrs(rimH, { x1: 3, y1: BP + 1.5, x2: BW - 3, y2: BP + 1.5,
        stroke: '#999', 'stroke-width': 0.6, opacity: 0.4 });
    svg.appendChild(rimH);
    const rimV = s('line');
    attrs(rimV, { x1: 1.5, y1: BP + 3, x2: 1.5, y2: BH - BP - 3,
        stroke: '#999', 'stroke-width': 0.6, opacity: 0.3 });
    svg.appendChild(rimV);

    // ── Indicator LEDs ───────────────────────────────────────────────────────

    // LEDs are on the same row as the latch gap, one each side.
    // With SW=10: left LED x=OX..OX+SW=6..16, gap x=16..32, right LED x=32..42.

    // Orange (traffic activity indicator) — left of gap, off by default
    const yLed = s('rect');
    attrs(yLed, { x: OX, y: OY, width: SW, height: SH, rx: 1,
        fill: `url(#${p}yof)`, stroke: '#444', 'stroke-width': 0.5 });
    svg.appendChild(yLed);

    // Orange LED surface shine (hidden when off)
    const yShine = s('rect');
    attrs(yShine, { x: OX + 0.5, y: OY + 0.5, width: 4, height: 2, rx: 0.5,
        fill: 'rgba(255,255,200,0.35)', display: 'none' });
    svg.appendChild(yShine);

    // Green (activity — toggled by setConnected) — right of gap
    const gLed = s('rect');
    attrs(gLed, { x: OX + OW - SW, y: OY, width: SW, height: SH, rx: 1,
        fill: `url(#${p}gof)`, stroke: '#444', 'stroke-width': 0.5 });
    svg.appendChild(gLed);

    // Green LED surface shine (shown when on)
    const gShine = s('rect');
    attrs(gShine, { x: OX + OW - SW + 0.5, y: OY + 0.5, width: 4, height: 2, rx: 0.5,
        fill: 'rgba(200,255,200,0.35)', display: 'none' });
    svg.appendChild(gShine);

    // ── Socket opening — stepped latch profile ───────────────────────────────
    //
    //   ┌──[SW]──┬──────────────────┬──[SW]──┐  ← OY
    //   │        │   inner top      │        │
    //   │ shoulder└──────────────────┘shoulder│  ← OY+SH
    //   │                                    │
    //   │           full-width body           │
    //   └────────────────────────────────────┘  ← OY+OH
    //
    // The shoulders are the plastic body that retains the cable latch.

    const innerL  = OX + SW + 2;           // 2 px gap between LED and opening
    const innerR  = OX + OW - SW - 2;
    const shouldY = OY + SH;               // 18

    const openPath = [
        `M ${innerL},${OY}`,               // top-left of inner opening
        `L ${innerR},${OY}`,               // top-right of inner opening
        `L ${innerR},${shouldY}`,           // right shoulder bottom-inner
        `L ${OX + OW},${shouldY}`,         // right shoulder bottom-outer
        `L ${OX + OW},${OY + OH}`,         // bottom-right
        `L ${OX},${OY + OH}`,              // bottom-left
        `L ${OX},${shouldY}`,              // left shoulder bottom-outer
        `L ${innerL},${shouldY}`,          // left shoulder bottom-inner
        'Z',
    ].join(' ');

    const opening = s('path');
    attrs(opening, { d: openPath,
        fill: `url(#${p}int)`, stroke: '#0a0a0a', 'stroke-width': 1.2 });
    svg.appendChild(opening);

    // Shoulder ledge highlight (subtle lighter edge on the shelf surface)
    const shelfL = s('rect');
    attrs(shelfL, { x: OX, y: shouldY - 0.5, width: innerL - OX, height: 1,
        fill: '#606060', opacity: 0.6 });
    svg.appendChild(shelfL);
    const shelfR = s('rect');
    attrs(shelfR, { x: innerR, y: shouldY - 0.5, width: OX + OW - innerR, height: 1,
        fill: '#606060', opacity: 0.6 });
    svg.appendChild(shelfR);

    // Inner top shadow (depth effect, only over the inner top portion)
    const topShadow = s('rect');
    attrs(topShadow, { x: innerL, y: OY, width: innerR - innerL, height: 4,
        fill: 'black', opacity: 0.45 });
    svg.appendChild(topShadow);

    // ── 8 gold pins ──────────────────────────────────────────────────────────

    const PW = 1.4, PH = 7, GAP = 1.8;
    const totalPW = 8 * PW + 7 * GAP;          // ≈ 26.9 px
    const px0 = OX + (OW - totalPW) / 2;        // left edge of first pin
    const py0 = OY + OH - PH - 0.5;             // pin top y

    for (let i = 0; i < 8; i++) {
        const px = px0 + i * (PW + GAP);

        const pin = s('rect');
        attrs(pin, { x: px.toFixed(2), y: py0, width: PW, height: PH,
            fill: `url(#${p}pin)` });
        svg.appendChild(pin);

        // Thin highlight on left side of each pin
        const hl = s('rect');
        attrs(hl, { x: px.toFixed(2), y: py0, width: PW * 0.35, height: PH,
            fill: 'rgba(255,230,130,0.28)' });
        svg.appendChild(hl);
    }

    // ── Plugged-in connector (shown via .wire_connected → .net_plug) ────────
    //
    //   Geometry (all SVG px, 1× scale):
    //   y=5   [orange LED 6..16][ latch trapezoid 16..32 ][ green LED 32..42 ]
    //   y=11  ┌─────────────────────────────────────────┐  shoulder / body top
    //         │  connector body (tan gradient, 36×21)   │
    //   y=23  │  ┌───────────────────────────────────┐  │  pin tray top
    //         │  │  | | | | | | | |  (8 gold pins)  │  │
    //   y=32  └──┴───────────────────────────────────┴──┘  opening bottom

    const plugGroup = s('g');
    plugGroup.setAttribute('class', 'net_plug');

    // Nested SVG showing the RJ-45 connector body from "Ethernet cable.svg".
    // ViewBox crops to just the connector (x=288..630, y=1158..1545),
    // excluding the cable body below, the cable-exit oval, and the latch clip.
    // Rendered at x=OX, y=shouldY, sized to fill the opening and extend below.
    const connSvg = s('svg');
    attrs(connSvg, {
        viewBox: '288 1158 342 387',
        x: OX, y: shouldY,
        width: OW,
        height: H + 1 - shouldY,   // extends to y=H+1 (1px below viewBox)
        preserveAspectRatio: 'none',
        overflow: 'visible',
    });
    connSvg.style.cssText =
        'fill-rule:evenodd;clip-rule:evenodd;' +
        'stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:1.5;';

    // Paths from the SVG file — body, ribs, top face, contacts.
    // Ellipses (cable oval), cable body, and latch clip omitted.
    (connSvg as SVGElement).innerHTML = `
<path d="M308.955,1385.135L304.263,1221.812L288.385,1186.378L290.962,1348.009L308.955,1385.135Z" style="fill:rgb(90,63,14);"/>
<path d="M304.263,1222.932L439.874,1451.402C439.874,1451.402 466.033,1421.056 505.248,1420.16C534.468,1419.493 540.768,1423.219 563.793,1434.948C599.309,1453.041 607.018,1503.487 608.947,1518.418C610.295,1528.857 629.902,1310.291 629.902,1310.291C629.902,1310.291 626.822,1271.092 619.822,1249.532C612.822,1227.972 604.142,1221.812 604.142,1221.812L304.263,1222.932Z" style="fill:rgb(226,208,155);"/>
<path d="M309.125,1386.625L304.263,1222.932L439.045,1450C439.045,1450 415.337,1476.547 422.021,1506.795C424.211,1516.707 437.927,1540.477 437.927,1540.477C398.756,1494.789 338.302,1457.935 309.125,1386.625Z" style="fill:rgb(136,117,75);"/>
<path d="M520.625,1319.988L602.483,1325.866C602.483,1325.866 625.027,1335.149 625.457,1343.607C625.887,1352.065 626.711,1330.669 626.711,1330.669C626.711,1330.669 615.959,1318.125 606.067,1318.841C596.176,1319.558 518.905,1314.111 518.905,1314.111C518.905,1314.111 515.034,1317.981 520.625,1319.988Z" style="fill:rgb(113,94,50);"/>
<path d="M524.783,1342.305C525.069,1338.052 524.926,1336.596 535.104,1336.607C545.283,1336.618 594.742,1339.772 594.742,1339.772C594.742,1339.772 621.192,1344.288 623.342,1353.033C625.493,1361.778 622.243,1373.258 622.243,1373.258C622.243,1373.258 623.271,1359.986 610.081,1353.534C596.892,1347.083 534.818,1344.933 530.087,1344.646C525.356,1344.359 524.496,1346.559 524.783,1342.305Z" style="fill:rgb(113,94,50);"/>
<path d="M534.818,1361.419L590.047,1364.752C598.894,1365.072 625.522,1372.472 621.168,1390.665C617.23,1407.118 619.113,1415.179 618.396,1410.448C617.68,1405.717 616.318,1385.324 602.985,1378.156C589.653,1370.988 540.982,1370.881 537.255,1369.161C533.527,1367.44 528.94,1364.286 534.818,1361.419Z" style="fill:rgb(113,94,50);"/>
<path d="M537.255,1388.658C537.255,1388.658 535.391,1383.497 541.699,1383.64C548.007,1383.783 580.549,1386.22 590.155,1390.951C599.76,1395.682 606.498,1397.976 610.798,1405.717C615.099,1413.459 617.429,1443.17 617.429,1443.17L613.092,1480.157C613.092,1480.157 610.854,1423.453 601.193,1413.982C578.513,1391.747 550.065,1398.252 543.849,1395.109C536.803,1391.545 537.255,1388.658 537.255,1388.658Z" style="fill:rgb(113,94,50);"/>
<g transform="matrix(1,0,0,1,0.344063,1.605625)">
<path d="M405.264,1505.834L399.621,1500.446L398.322,1422.624C397.056,1415.414 416.06,1395.583 440.142,1392.145C457.249,1389.702 476.544,1386.158 478.149,1387.764C479.755,1389.369 481.121,1389.161 480.324,1392.805C479.485,1396.642 461.554,1397.153 454.501,1398.338C454.501,1398.338 439.061,1400.77 432.788,1402.875C426.935,1404.839 405.952,1412.953 405.382,1428.95C404.868,1443.403 405.264,1505.834 405.264,1505.834Z" style="fill:rgb(113,94,50);"/>
</g>
<path d="M381.692,1484.995L381.234,1394.411C381.234,1394.411 381.807,1368.033 404.401,1366.427C426.994,1364.821 468.511,1362.413 468.511,1362.413C468.511,1362.413 474.354,1368.755 470.346,1370.326C466.318,1371.905 406.708,1373.89 406.236,1375.621C400.485,1376.285 388.557,1388.612 389.147,1398.54C389.762,1408.892 389.226,1491.953 389.226,1491.953L381.692,1484.995Z" style="fill:rgb(113,94,50);"/>
<path d="M456.125,1344.063L386.509,1348.421C386.509,1348.421 379.743,1349.797 372.288,1360.807C369.601,1364.776 369.797,1473.207 369.797,1473.207L362.709,1466.045L361.737,1360.463C361.737,1360.463 368.962,1343.031 382.61,1341.884C396.258,1340.737 455.895,1338.673 455.895,1338.673C455.895,1338.673 462.088,1340.852 456.125,1344.063Z" style="fill:rgb(113,94,50);"/>
<path d="M445.422,1321.644C420.401,1321.958 397.146,1323.004 377.605,1323.905C377.677,1324.484 364.798,1329.938 363.517,1336.324C360.318,1352.273 356.92,1341.947 356.92,1341.947C356.92,1341.947 355.223,1318.22 386.509,1316.997C417.599,1315.781 446.032,1315.047 446.032,1315.047C446.032,1315.047 448.67,1315.402 448.67,1318.488C448.67,1321.699 445.422,1321.644 445.422,1321.644Z" style="fill:rgb(113,94,50);"/>
<path d="M342.616,1442.854L346.784,1300.001C346.784,1300.001 353.942,1287.773 486.632,1289.512C551.458,1290.362 587.965,1290.001 608.315,1295.076C626.831,1299.693 632.513,1299.793 628.844,1325.966C625.053,1353.022 617.429,1448.203 617.429,1448.203L613.092,1457.173L626.472,1320.278C626.472,1320.278 626.082,1299.136 481.9,1300.351C434.563,1300.751 364.023,1297.015 353.728,1312.707C350.365,1317.832 349.185,1450.921 349.185,1450.921L342.616,1442.854Z" style="fill:rgb(113,94,50);"/>
<g transform="matrix(1.580586,0,0,1.483801,-331.523298,-746.674238)">
<ellipse cx="536.484" cy="1510.939" rx="61.152" ry="51.856" style="fill:rgb(131,113,72);"/>
</g>
<g transform="matrix(1.076923,0,0,1.036717,-60.979981,-69.029099)">
<ellipse cx="536.484" cy="1510.939" rx="61.152" ry="51.856" style="fill:rgb(88,76,46);"/>
</g>
<g transform="matrix(1,0,0,0.949129,0,62.211993)">
<path d="M288.385,1182.886L304.263,1222.932L605.791,1221.812L589.02,1180.669L288.385,1182.886Z" style="fill:rgb(136,99,25);"/>
</g>
<path d="M342.616,1184.827L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.56px;"/>
<g transform="matrix(1,0,0,1,37.334393,0)">
<path d="M342.395,1184.827L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.56px;"/>
</g>
<g transform="matrix(0.994842,-0.002915,-0.035685,0.925636,157.100076,90.94395)">
<path d="M341.104,1180.669L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.78px;"/>
</g>
<g transform="matrix(0.994774,-0.019418,-0.019418,0.927854,100.257959,93.953737)">
<path d="M341.104,1180.669L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.77px;"/>
</g>
<g transform="matrix(0.994774,-0.019418,-0.019418,0.927854,174.926746,93.953737)">
<path d="M341.104,1180.669L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.77px;"/>
</g>
<g transform="matrix(0.994774,-0.019418,-0.019418,0.927854,212.261139,93.953737)">
<path d="M341.104,1180.669L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.77px;"/>
</g>
<g transform="matrix(0.994797,-0.017326,-0.021487,0.927581,252.072152,93.562421)">
<path d="M341.104,1180.669L352.479,1222.932" style="fill:none;stroke:rgb(92,64,17);stroke-width:3.78px;"/>
</g>
<g transform="matrix(1.132647,0,0,1.132647,-653.113315,-182.585168)">
<path d="M929.978,1190.294L929.978,1158.794L949.665,1207.357L951.739,1265.106L940.915,1213.044L929.978,1190.294Z" style="fill:rgb(50,55,64);fill-opacity:0.6;"/>
<path d="M929.978,1158.794L948.79,1207.357L1041.54,1207.357L1017.915,1158.794L929.978,1158.794Z" style="fill:rgb(122,128,142);fill-opacity:0.6;"/>
<path d="M951.853,1264.669L1041.54,1265.106L1041.54,1207.357L949.665,1207.357L951.853,1264.669Z" style="fill:rgb(122,128,142);fill-opacity:0.6;"/>
</g>`;

    plugGroup.appendChild(connSvg);
    svg.appendChild(plugGroup);

    // ── Label (inside the socket body, below the opening) ───────────────────

    const txt = s('text');
    attrs(txt, { x: W / 2, y: 13,
        'font-family': '"Courier New", Courier, monospace',
        'font-size': 9,
        fill: '#bbb',
        'text-anchor': 'middle',
        'letter-spacing': 0.8 });
    txt.textContent = label;
    svg.appendChild(txt);

    // ── Wrapper div (keeps vm_net_iface class for wire-drag hit detection) ───

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:inline-block;line-height:0;';
    wrapper.appendChild(svg);

    // ── LED state helpers ────────────────────────────────────────────────────

    const setGreen = (on: boolean) => {
        if (on) {
            gLed.setAttribute('fill', `url(#${p}gon)`);
            gLed.setAttribute('filter', `url(#${p}fg)`);
            gShine.removeAttribute('display');
        } else {
            gLed.setAttribute('fill', `url(#${p}gof)`);
            gLed.removeAttribute('filter');
            gShine.setAttribute('display', 'none');
        }
    };

    let blinkTimer: ReturnType<typeof setTimeout> | null = null;
    const blinkOrange = () => {
        yLed.setAttribute('fill', `url(#${p}ybr)`);
        yLed.setAttribute('filter', `url(#${p}fy)`);
        yShine.removeAttribute('display');
        if (blinkTimer !== null) clearTimeout(blinkTimer);
        blinkTimer = setTimeout(() => {
            yLed.setAttribute('fill', `url(#${p}yof)`);
            yLed.removeAttribute('filter');
            yShine.setAttribute('display', 'none');
            blinkTimer = null;
        }, 80);
    };

    return { wrapper, setGreen, blinkOrange };
}

export function buildNetPanel(count: number, labelFn: (i: number) => string): NetPanel {
    const el = document.createElement('div');
    el.className = 'vm_net_panel';

    const wrappers: HTMLElement[] = [];
    const greenSetters: Array<(on: boolean) => void> = [];
    const orangeBlinkers: Array<() => void> = [];

    for (let i = 0; i < count; i++) {
        const { wrapper, setGreen, blinkOrange } = buildSocket(i, labelFn(i));
        wrapper.className = 'vm_net_iface';
        el.appendChild(wrapper);
        wrappers.push(wrapper);
        greenSetters.push(setGreen);
        orangeBlinkers.push(blinkOrange);
    }

    return {
        el,
        getSocketEl: (idx) => wrappers[idx],
        setConnected(idx, connected) {
            greenSetters[idx]?.(connected);
        },
        blinkOrange(idx) {
            orangeBlinkers[idx]?.();
        },
    };
}
