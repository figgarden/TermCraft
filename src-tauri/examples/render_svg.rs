// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Rasterize SVG artwork for scripts/build-icons.js.
//! Usage: cargo run --example render_svg -- jobs.json
//! jobs.json: [{ "svg": "<svg…>", "out": "file.png", "width": 1024, "height": 1024 }, …]

use resvg::{tiny_skia, usvg};

fn main() {
    let path = std::env::args().nth(1).expect("usage: render_svg jobs.json");
    let jobs: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    for job in jobs {
        let svg = job["svg"].as_str().unwrap();
        let (w, h) = (job["width"].as_u64().unwrap() as u32, job["height"].as_u64().unwrap() as u32);
        let tree = usvg::Tree::from_str(svg, &opt).unwrap();
        let size = tree.size();
        let mut pixmap = tiny_skia::Pixmap::new(w, h).unwrap();
        let t = tiny_skia::Transform::from_scale(w as f32 / size.width(), h as f32 / size.height());
        resvg::render(&tree, t, &mut pixmap.as_mut());
        pixmap.save_png(job["out"].as_str().unwrap()).unwrap();
    }
}
