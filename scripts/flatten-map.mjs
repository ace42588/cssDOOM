/**
 * Flatten monolithic map JSON into SGNL S3 CSVs under public/maps/flattened/<map>/.
 * S3 SoR has no child entities: each non-map row includes mapId (= map.name). Numeric ids
 * are unique only within that entity CSV for a given map.
 *
 * Usage: node scripts/flatten-map.mjs <map.json> [--out dir] [--no-meta]
 */

import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
    let input = null;
    let out = null;
    let noMeta = false;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') out = argv[++i];
        else if (a === '--no-meta') noMeta = true;
        else if (!a.startsWith('-')) input = a;
    }
    return { input, out, noMeta };
}

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function csvRow(cells) {
    return cells.map(csvCell).join(',');
}

function writeCsv(filePath, headers, rows) {
    const lines = [csvRow(headers), ...rows.map((r) => csvRow(r))];
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildVertexIndex(vertices) {
    const coordToId = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const { x, y } = vertices[i];
        const key = `${x},${y}`;
        if (!coordToId.has(key)) coordToId.set(key, i);
    }
    return coordToId;
}

function makeResolver(coordToId, sourceFile) {
    return function resolveVertex(x, y, context) {
        const key = `${x},${y}`;
        const id = coordToId.get(key);
        if (id === undefined) {
            throw new Error(
                `${sourceFile}: ${context}: no vertex for (${x}, ${y})`,
            );
        }
        return id;
    };
}

function main() {
    const { input, out: outOverride, noMeta } = parseArgs(process.argv);
    if (!input) {
        console.error('Usage: node scripts/flatten-map.mjs <map.json> [--out dir] [--no-meta]');
        process.exit(1);
    }

    const absInput = path.resolve(input);
    const raw = fs.readFileSync(absInput, 'utf8');
    const map = JSON.parse(raw);
    const name = map.name;
    if (!name || typeof name !== 'string') {
        throw new Error(`${absInput}: missing string "name"`);
    }

    const mapId = name;
    const outDir =
        outOverride ?? path.join(path.dirname(absInput), 'flattened', name.toLowerCase());
    fs.mkdirSync(outDir, { recursive: true });

    const vertices = map.vertices ?? [];
    const coordToId = buildVertexIndex(vertices);
    const resolve = makeResolver(coordToId, absInput);

    writeCsv(
        path.join(outDir, 'vertices.csv'),
        ['mapId', 'id', 'x', 'y'],
        vertices.map((v, id) => [mapId, id, v.x, v.y]),
    );

    const linedefs = map.linedefs ?? [];
    writeCsv(
        path.join(outDir, 'linedefs.csv'),
        [
            'mapId',
            'id',
            'startVertex',
            'endVertex',
            'flags',
            'specialType',
            'sectorTag',
            'frontSidedef',
            'backSidedef',
        ],
        linedefs.map((ld, id) => [
            mapId,
            id,
            ld.startVertex,
            ld.endVertex,
            ld.flags,
            ld.specialType,
            ld.sectorTag,
            ld.frontSidedef === '' ||
            ld.frontSidedef === null ||
            ld.frontSidedef === undefined ||
            ld.frontSidedef === -1
                ? ''
                : ld.frontSidedef,
            ld.backSidedef === '' ||
            ld.backSidedef === null ||
            ld.backSidedef === undefined ||
            ld.backSidedef === -1
                ? ''
                : ld.backSidedef,
        ]),
    );

    const sidedefs = map.sidedefs ?? [];
    writeCsv(
        path.join(outDir, 'sidedefs.csv'),
        [
            'mapId',
            'id',
            'xOffset',
            'yOffset',
            'upperTexture',
            'lowerTexture',
            'middleTexture',
            'sectorIndex',
        ],
        sidedefs.map((sd, id) => [
            mapId,
            id,
            sd.xOffset,
            sd.yOffset,
            sd.upperTexture,
            sd.lowerTexture,
            sd.middleTexture,
            sd.sectorIndex,
        ]),
    );

    const sectors = map.sectors ?? [];
    writeCsv(
        path.join(outDir, 'sectors.csv'),
        [
            'mapId',
            'id',
            'floorHeight',
            'ceilingHeight',
            'floorTexture',
            'ceilingTexture',
            'lightLevel',
            'specialType',
            'tag',
        ],
        sectors.map((s, id) => [
            mapId,
            id,
            s.floorHeight,
            s.ceilingHeight,
            s.floorTexture,
            s.ceilingTexture,
            s.lightLevel,
            s.specialType,
            s.tag,
        ]),
    );

    const things = map.things ?? [];
    writeCsv(
        path.join(outDir, 'things.csv'),
        ['mapId', 'id', 'x', 'y', 'angle', 'type', 'flags'],
        things.map((t, id) => [mapId, id, t.x, t.y, t.angle, t.type, t.flags]),
    );

    const walls = map.walls ?? [];
    writeCsv(
        path.join(outDir, 'walls.csv'),
        [
            'mapId',
            'id',
            'startVertex',
            'endVertex',
            'bottomHeight',
            'topHeight',
            'isSolid',
            'isDoor',
            'isScrolling',
            'linedefIndex',
            'wallId',
            'texture',
            'xOffset',
            'yOffset',
            'sectorIndex',
            'lightLevel',
            'specialType',
        ],
        walls.map((w, id) => {
            const sv = resolve(w.start.x, w.start.y, `walls[${id}].start`);
            const ev = resolve(w.end.x, w.end.y, `walls[${id}].end`);
            return [
                mapId,
                id,
                sv,
                ev,
                w.bottomHeight,
                w.topHeight,
                w.isSolid,
                w.isDoor,
                w.isScrolling,
                w.linedefIndex,
                w.wallId,
                w.texture,
                w.xOffset,
                w.yOffset,
                w.sectorIndex,
                w.lightLevel,
                w.specialType,
            ];
        }),
    );

    const sectorPolygons = map.sectorPolygons ?? [];
    const boundaryRows = [];
    let nextBoundaryId = 0;
    const polygonRows = sectorPolygons.map((poly, polyId) => {
        const boundaryIds = [];
        const loops = poly.boundaries ?? [];
        for (let li = 0; li < loops.length; li++) {
            const loop = loops[li];
            const vids = loop.map((p, pi) =>
                resolve(p.x, p.y, `sectorPolygons[${polyId}].boundaries[${li}][${pi}]`),
            );
            const bid = nextBoundaryId++;
            boundaryIds.push(bid);
            boundaryRows.push([mapId, bid, vids.join(';')]);
        }
        return [
            mapId,
            polyId,
            poly.sectorIndex,
            poly.floorHeight,
            poly.ceilingHeight,
            poly.lightLevel,
            poly.floorTexture,
            poly.ceilingTexture,
            poly.specialType,
            boundaryIds.join(';'),
            poly.hasHoles,
        ];
    });

    writeCsv(path.join(outDir, 'boundaries.csv'), ['mapId', 'id', 'vertexIds'], boundaryRows);
    writeCsv(
        path.join(outDir, 'sectorPolygons.csv'),
        [
            'mapId',
            'id',
            'sectorIndex',
            'floorHeight',
            'ceilingHeight',
            'lightLevel',
            'floorTexture',
            'ceilingTexture',
            'specialType',
            'boundaries',
            'hasHoles',
        ],
        polygonRows,
    );

    const doors = map.doors ?? [];
    writeCsv(
        path.join(outDir, 'doors.csv'),
        ['mapId', 'id', 'sectorIndex', 'closedHeight', 'openHeight', 'floorHeight', 'keyRequired'],
        doors.map((d, id) => [
            mapId,
            id,
            d.sectorIndex,
            d.closedHeight,
            d.openHeight,
            d.floorHeight,
            d.keyRequired ?? '',
        ]),
    );

    const lifts = map.lifts ?? [];
    const shaftRows = [];
    const collisionRows = [];
    let nextShaftId = 0;
    let nextCollisionId = 0;

    const liftRows = lifts.map((lift, liftId) => {
        (lift.shaftWalls ?? []).forEach((sw, swi) => {
            const sid = nextShaftId++;
            shaftRows.push([
                mapId,
                sid,
                liftId,
                resolve(sw.start.x, sw.start.y, `lifts[${liftId}].shaftWalls[${swi}].start`),
                resolve(sw.end.x, sw.end.y, `lifts[${liftId}].shaftWalls[${swi}].end`),
                sw.texture,
                sw.xOffset,
                sw.yOffset,
                sw.lightLevel,
                sw.isPlatformFace,
            ]);
        });
        let cei = 0;
        for (const ce of lift.collisionEdges ?? []) {
            const cid = nextCollisionId++;
            collisionRows.push([
                mapId,
                cid,
                liftId,
                resolve(ce.start.x, ce.start.y, `lifts[${liftId}].collisionEdges[${cei}].start`),
                resolve(ce.end.x, ce.end.y, `lifts[${liftId}].collisionEdges[${cei}].end`),
            ]);
            cei++;
        }
        return [
            mapId,
            liftId,
            lift.sectorIndex,
            lift.tag,
            lift.upperHeight,
            lift.lowerHeight,
            lift.oneWay === true ? true : '',
        ];
    });

    writeCsv(
        path.join(outDir, 'lifts.csv'),
        ['mapId', 'id', 'sectorIndex', 'tag', 'upperHeight', 'lowerHeight', 'oneWay'],
        liftRows,
    );
    writeCsv(
        path.join(outDir, 'shaftWalls.csv'),
        [
            'mapId',
            'id',
            'liftId',
            'startVertex',
            'endVertex',
            'texture',
            'xOffset',
            'yOffset',
            'lightLevel',
            'isPlatformFace',
        ],
        shaftRows,
    );
    writeCsv(
        path.join(outDir, 'collisionEdges.csv'),
        ['mapId', 'id', 'liftId', 'startVertex', 'endVertex'],
        collisionRows,
    );

    const triggers = map.triggers ?? [];
    writeCsv(
        path.join(outDir, 'triggers.csv'),
        ['mapId', 'id', 'startVertex', 'endVertex', 'sectorTag', 'specialType'],
        triggers.map((t, id) => [
            mapId,
            id,
            resolve(t.start.x, t.start.y, `triggers[${id}].start`),
            resolve(t.end.x, t.end.y, `triggers[${id}].end`),
            t.sectorTag,
            t.specialType,
        ]),
    );

    const sightLines = map.sightLines ?? [];
    writeCsv(
        path.join(outDir, 'sightLines.csv'),
        [
            'mapId',
            'id',
            'startVertex',
            'endVertex',
            'openBottom',
            'openTop',
            'frontSector',
            'backSector',
        ],
        sightLines.map((sl, id) => [
            mapId,
            id,
            resolve(sl.start.x, sl.start.y, `sightLines[${id}].start`),
            resolve(sl.end.x, sl.end.y, `sightLines[${id}].end`),
            sl.openBottom,
            sl.openTop,
            sl.frontSector,
            sl.backSector,
        ]),
    );

    const teleporters = map.teleporters ?? [];
    writeCsv(
        path.join(outDir, 'teleporters.csv'),
        [
            'mapId',
            'id',
            'startVertex',
            'endVertex',
            'destX',
            'destY',
            'destAngle',
            'oneShot',
        ],
        teleporters.map((tp, id) => [
            mapId,
            id,
            resolve(tp.start.x, tp.start.y, `teleporters[${id}].start`),
            resolve(tp.end.x, tp.end.y, `teleporters[${id}].end`),
            tp.destX,
            tp.destY,
            tp.destAngle,
            tp.oneShot === true ? true : '',
        ]),
    );

    const crushers = map.crushers ?? [];
    writeCsv(
        path.join(outDir, 'crushers.csv'),
        ['mapId', 'id', 'sectorIndex', 'topHeight', 'crushHeight', 'speed'],
        crushers.map((c, id) => [
            mapId,
            id,
            c.sectorIndex,
            c.topHeight,
            c.crushHeight,
            c.speed ?? '',
        ]),
    );

    if (!noMeta) {
        const ps = map.playerStart ?? {};
        const b = map.bounds ?? {};
        writeCsv(
            path.join(outDir, 'map.csv'),
            [
                'name',
                'playerX',
                'playerY',
                'playerAngle',
                'playerFloorHeight',
                'minX',
                'maxX',
                'minY',
                'maxY',
            ],
            [
                [
                    map.name,
                    ps.x,
                    ps.y,
                    ps.angle,
                    ps.floorHeight ?? 0,
                    b.minX,
                    b.maxX,
                    b.minY,
                    b.maxY,
                ],
            ],
        );
    }

    console.log(`Wrote CSVs to ${outDir}`);
}

try {
    main();
} catch (e) {
    console.error(e.message || e);
    process.exit(1);
}
