const express = require("express");
const Database = require("better-sqlite3");

const app = express();

const MBTILES = __dirname + "/ulan-ude.mbtiles";

const db = new Database(MBTILES, {
    readonly: true
});

app.get("/tiles/:z/:x/:y.pbf", (req, res) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);

    if (
        !Number.isInteger(z) ||
        !Number.isInteger(x) ||
        !Number.isInteger(y)
    ) {
        return res.status(400).send("Invalid tile coordinates");
    }

    // XYZ → TMS
    const tmsY = (1 << z) - 1 - y;

    const row = db.prepare(`
        SELECT tile_data
        FROM tiles
        WHERE zoom_level = ?
          AND tile_column = ?
          AND tile_row = ?
    `).get(z, x, tmsY);

    if (!row) {
        return res.status(404).end();
    }

    res.setHeader("Content-Type", "application/x-protobuf");

    // Most vector MBTiles use gzip-compressed PBF.
    res.setHeader("Content-Encoding", "gzip");

    res.send(row.tile_data);
});

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.listen(8080, "127.0.0.1", () => {
    console.log("MBTiles server listening on http://127.0.0.1:8080");
});
