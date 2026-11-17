/*
 Meridiano · Oficina 3D
 Una planta con nueve salas: siete áreas de trabajo (máximo tres agentes por sala) y dos espacios comunes.
 Todo lo que se ve sale de datos: el estado de cada agente, las pantallas de pared y los racks de conexiones.
 Requiere THREE r128 como global.
*/
(function () {
  "use strict";
  var T = window.THREE;

  var AREAS = {
    dir: { n: "Dirección", c: "#0f766e" },
    inv: { n: "Inversiones", c: "#2a78d6" },
    tes: { n: "Tesorería", c: "#c98500" },
    fis: { n: "Fiscal y Custodia", c: "#7c5cc4" },
    per: { n: "Personas", c: "#d95926" },
    cre: { n: "Crecimiento", c: "#199e70" },
    pla: { n: "Plataforma", c: "#5b6b7a" }
  };
  var ROOM_W = 9, ROOM_D = 7, WALL_H = 2.3, COLS = [-10.5, 0, 10.5], ROWS = [-9.75, 0, 9.75];
  var ROOMS = [
    { id: "inv", area: "inv", name: "Mesa de Inversiones", col: 0, row: 0, doors: [["pz", 0]] },
    { id: "dir", area: "dir", name: "Sala de Estrategia", col: 1, row: 0, doors: [["pz", 0]] },
    { id: "fis", area: "fis", name: "Fiscal y Custodia", col: 2, row: 0, doors: [["pz", 0]] },
    { id: "tes", area: "tes", name: "Tesorería", col: 0, row: 1, doors: [["pz", 0]] },
    { id: "dec", area: null, name: "Sala de Decisiones", col: 1, row: 1, doors: [["pz", 0], ["nz", 3.3]] },
    { id: "per", area: "per", name: "Personas y Aprendizaje", col: 2, row: 1, doors: [["pz", 0]] },
    { id: "cre", area: "cre", name: "Estudio de Crecimiento", col: 0, row: 2, doors: [["px", 0]] },
    { id: "rec", area: null, name: "Recepción", col: 1, row: 2, doors: [["pz", 0], ["nz", 3.3], ["px", 0], ["nx", 0]] },
    { id: "pla", area: "pla", name: "Plataforma y Datos", col: 2, row: 2, doors: [["nx", 0]] }
  ];
  ROOMS.forEach(function (r) { r.cx = COLS[r.col]; r.cz = ROWS[r.row]; });

  // Aspecto de cada persona. Los códigos sin entrada reciben uno derivado del código.
  var LOOKS = {
    A: { skin: "#e0ac8a", hair: "#3b2a20", style: "bun" },
    B: { skin: "#8d5a3b", hair: "#1d1512", style: "short", glasses: true },
    C: { skin: "#d9a37c", hair: "#6b4a2b", style: "short" },
    D: { skin: "#f0c9a8", hair: "#b5651d", style: "long" },
    E: { skin: "#e6b998", hair: "#9a9a9a", style: "short", glasses: true },
    F: { skin: "#f4d3b8", hair: "#e3cb7c", style: "long" },
    G: { skin: "#b97a56", hair: "#20160f", style: "cap" },
    H: { skin: "#ecc19c", hair: "#15110f", style: "long" },
    I: { skin: "#d59f7a", hair: "#4a2f24", style: "bun", glasses: true },
    J: { skin: "#e3b594", hair: "#2a2a2a", style: "short" },
    K: { skin: "#a86f4a", hair: "#1a1a1a", style: "afro" },
    L: { skin: "#efc8a5", hair: "#3a2a52", style: "long", phones: true }
  };
  var SKINS = ["#e0ac8a", "#8d5a3b", "#f0c9a8", "#b97a56", "#d59f7a"], HAIRS = ["#3b2a20", "#1d1512", "#b5651d", "#9a9a9a"], STYLES = ["short", "long", "bun", "afro"];
  function lookFor(code) {
    if (LOOKS[code]) return LOOKS[code];
    var n = code.charCodeAt(0);
    return { skin: SKINS[n % SKINS.length], hair: HAIRS[n % HAIRS.length], style: STYLES[n % STYLES.length] };
  }

  var STATE_COLOR = { run: "#3b82f6", wait: "#f0a020", appr: "#f0a020", done: "#2fbf71", err: "#e5484d", prog: "#8a9a98", off: "#56615f", idea: "#8a9a98" };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function col(hex) { return new T.Color(hex).convertSRGBToLinear(); }

  function create(stage, opts) {
    opts = opts || {};
    if (!T) return null;
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "Oficina virtual: nueve salas con los agentes agrupados por área");
    var overlay = document.createElement("div"); overlay.className = "of-tags";
    var bar = document.createElement("div"); bar.className = "of-bar";
    stage.appendChild(canvas); stage.appendChild(overlay); stage.appendChild(bar);

    var renderer;
    try { renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { stage.innerHTML = ""; return null; }
    renderer.outputEncoding = T.sRGBEncoding;
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var cs = getComputedStyle(document.documentElement);
    function css(n) { return cs.getPropertyValue(n).trim(); }
    var dark = col(css("--bg")).getHSL({ h: 0, s: 0, l: 0 }).l < 0.25;

    var C = {
      slab: col(dark ? "#1a2625" : "#cfd8d6"), floor: col(dark ? "#243230" : "#f4f7f6"), plinth: col(dark ? "#33443f" : "#b9c5c2"),
      wood: col(dark ? "#7a5a3c" : "#c9a373"), woodDark: col(dark ? "#4d3a28" : "#8f6f4a"), chair: col(dark ? "#10181a" : "#2c3a3d"),
      metal: col(dark ? "#2a3638" : "#59686b"), white: col(dark ? "#c9d4d2" : "#ffffff"), pants: col("#2b3440"), shoe: col("#16191d"),
      leaf: col("#2f9e62"), leaf2: col("#1f7a4a"), pot: col(dark ? "#8a5f45" : "#c98a63"), accent: col(css("--accent") || "#0d5f66"),
      glass: col(dark ? "#9fd0cc" : "#7fb5b0"), rack: col("#151c1f"), sofa: col(dark ? "#3a4a57" : "#6d8597"), rug: col(dark ? "#2e3d3b" : "#dfe7e5")
    };
    function std(c, extra) { var m = new T.MeshStandardMaterial({ color: c, roughness: 0.88, metalness: 0.02 }); if (extra) for (var k in extra) m[k] = extra[k]; return m; }
    var M = {
      slab: std(C.slab), plinth: std(C.plinth), wood: std(C.wood, { roughness: 0.7 }), woodDark: std(C.woodDark), chair: std(C.chair), metal: std(C.metal, { metalness: 0.4, roughness: 0.5 }),
      white: std(C.white), pants: std(C.pants), shoe: std(C.shoe), leaf: std(C.leaf), leaf2: std(C.leaf2), pot: std(C.pot), rack: std(C.rack, { roughness: 0.5 }),
      sofa: std(C.sofa), rug: std(C.rug), eye: std(col("#1b1b1b")), dark: std(col("#0e1415"), { roughness: 0.4 }),
      glass: new T.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: dark ? 0.1 : 0.16, depthWrite: false, roughness: 0.1 }),
      ghost: new T.MeshStandardMaterial({ color: C.plinth, transparent: true, opacity: 0.28, depthWrite: false })
    };
    var areaMat = {};
    function aMat(id) { if (!areaMat[id]) areaMat[id] = std(id && AREAS[id] ? col(AREAS[id].c) : C.accent); return areaMat[id]; }

    var scene = new T.Scene(), cam = new T.PerspectiveCamera(40, 1, 0.3, 220);
    scene.add(new T.HemisphereLight(0xffffff, dark ? 0x1b2a29 : 0xaebbb8, dark ? 0.62 : 0.62));
    var sun = new T.DirectionalLight(0xfff3e2, dark ? 0.6 : 0.62); sun.position.set(16, 30, 14); scene.add(sun); scene.add(sun.target);
    var wide = (stage.clientWidth || 800) >= 700;
    if (wide) {
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
      var sc = sun.shadow.camera; sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 90; sc.updateProjectionMatrix();
    }

    var picks = [];
    function mesh(geo, mat, x, y, z, parent, cast) { var m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast !== false; m.receiveShadow = true; (parent || scene).add(m); return m; }
    function box(w, h, d, mat, x, y, z, parent, cast) { return mesh(new T.BoxGeometry(w, h, d), mat, x, y, z, parent, cast); }
    function cyl(rt, rb, h, mat, x, y, z, parent, seg) { return mesh(new T.CylinderGeometry(rt, rb, h, seg || 18), mat, x, y, z, parent); }
    function sph(r, mat, x, y, z, parent) { return mesh(new T.SphereGeometry(r, 18, 14), mat, x, y, z, parent); }

    // ---------- edificio ----------
    box(35, 0.3, 31, M.slab, 0, -0.15, 0, null, false);
    var screens = {};

    function wall(g, horiz, fixed, mid, len, area) {
      var x = horiz ? mid : fixed, z = horiz ? fixed : mid, w = horiz ? len : 0.1, d = horiz ? 0.1 : len;
      box(w, 0.3, d, M.plinth, x, 0.15, z, g);
      var gl = box(horiz ? len : 0.04, WALL_H - 0.3, horiz ? 0.04 : len, M.glass, x, 0.3 + (WALL_H - 0.3) / 2, z, g, false); gl.receiveShadow = false;
      box(w, 0.07, d, aMat(area), x, WALL_H + 0.035, z, g, false);
    }
    function plant(g, x, z, s) {
      s = s || 1; cyl(0.2 * s, 0.15 * s, 0.34 * s, M.pot, x, 0.17 * s + 0.06, z, g);
      sph(0.3 * s, M.leaf, x, 0.72 * s, z, g); sph(0.22 * s, M.leaf2, x + 0.16 * s, 0.98 * s, z - 0.06 * s, g); sph(0.2 * s, M.leaf, x - 0.14 * s, 1.06 * s, z + 0.08 * s, g);
    }
    function shelf(g, x, z, rotY, area) {
      var s = new T.Group(); s.position.set(x, 0, z); s.rotation.y = rotY || 0; g.add(s);
      box(1.6, 1.5, 0.34, M.woodDark, 0, 0.81, 0, s);
      var cols = [aMat(area), M.white, M.metal, M.pot, M.leaf2];
      for (var r = 0; r < 3; r++) for (var i = 0; i < 6; i++) box(0.12 + (i % 3) * 0.03, 0.3, 0.2, cols[(i + r * 2) % cols.length], -0.6 + i * 0.22, 0.38 + r * 0.46, 0.09, s);
    }
    function sofa(g, x, z, rotY, mat) {
      var s = new T.Group(); s.position.set(x, 0, z); s.rotation.y = rotY || 0; g.add(s); mat = mat || M.sofa;
      box(2.1, 0.36, 0.85, mat, 0, 0.3, 0, s); box(2.1, 0.5, 0.2, mat, 0, 0.67, -0.33, s); box(0.2, 0.52, 0.85, mat, -1.05, 0.42, 0, s); box(0.2, 0.52, 0.85, mat, 1.05, 0.42, 0, s);
    }
    function chair(g, x, z, rotY, mat) {
      var s = new T.Group(); s.position.set(x, 0, z); s.rotation.y = rotY || 0; g.add(s); mat = mat || M.chair;
      cyl(0.27, 0.27, 0.04, M.metal, 0, 0.08, 0, s); cyl(0.04, 0.04, 0.36, M.metal, 0, 0.26, 0, s);
      box(0.5, 0.08, 0.5, mat, 0, 0.46, 0, s); box(0.5, 0.56, 0.07, mat, 0, 0.8, -0.25, s);
      return s;
    }
    function rug(g, x, z, w, d, mat) { box(w, 0.02, d, mat || M.rug, x, 0.07, z, g, false); }

    function decor(R, g) {
      var id = R.id;
      plant(g, -3.9, 2.9, 1.1);
      if (id === "inv") { rug(g, 0, 1.6, 6.4, 2.2); shelf(g, 4.1, 1.6, -Math.PI / 2, R.area); plant(g, 3.9, 2.9, 0.9); }
      if (id === "dir") {
        rug(g, 2.3, 1.7, 3, 2.4); chair(g, 1.6, 1.9, 2.2, M.sofa); chair(g, 3.1, 1.9, -2.2, M.sofa);
        cyl(0.45, 0.45, 0.05, M.wood, 2.35, 0.5, 1.2, g, 24); cyl(0.05, 0.05, 0.46, M.metal, 2.35, 0.26, 1.2, g); shelf(g, -4.1, 0.4, Math.PI / 2, R.area);
      }
      if (id === "fis") { // caja fuerte y archivo
        box(1.2, 1.3, 1.0, M.metal, 3.6, 0.71, 1.9, g); cyl(0.3, 0.3, 0.06, M.dark, 2.98, 0.75, 1.9, g, 24).rotation.z = Math.PI / 2; cyl(0.05, 0.05, 0.12, aMat(R.area), 2.92, 0.75, 1.9, g).rotation.z = Math.PI / 2;
        for (var i = 0; i < 3; i++) box(0.55, 1.2, 0.6, M.plinth, -3.9, 0.66, -0.6 + i * 0.66, g);
      }
      if (id === "tes") { // globo terráqueo y mostrador
        cyl(0.05, 0.22, 0.9, M.metal, 3.5, 0.51, 2.3, g); sph(0.42, aMat("inv"), 3.5, 1.3, 2.3, g); sph(0.425, M.leaf2, 3.56, 1.34, 2.28, g).scale.set(0.9, 0.7, 0.9);
        box(2.4, 0.8, 0.5, M.woodDark, 0.4, 0.46, 2.9, g);
      }
      if (id === "per") { rug(g, 1.6, 1.9, 4.6, 2.4, aMat(R.area)); sofa(g, 1.6, 2.6, Math.PI); cyl(0.5, 0.5, 0.05, M.wood, 1.6, 0.4, 1.4, g, 24); cyl(0.05, 0.05, 0.34, M.metal, 1.6, 0.21, 1.4, g); shelf(g, 4.1, -0.2, -Math.PI / 2, R.area); }
      if (id === "cre") { // pizarra con curva ascendente
        box(0.06, 1.3, 2.6, M.white, -4.3, 1.25, 0.6, g);
        for (var k = 0; k < 5; k++) box(0.03, 0.05, 0.5, aMat(R.area), -4.25, 0.85 + k * 0.17, 1.5 - k * 0.45, g, false).rotation.x = 0.36;
        sph(0.42, aMat("per"), 2.6, 0.36, 2.2, g).scale.set(1, 0.72, 1); sph(0.42, aMat("tes"), 3.5, 0.36, 1.5, g).scale.set(1, 0.72, 1); rug(g, 3, 1.9, 2.6, 2.2);
      }
      if (id === "dec") { // mesa de directorio
        rug(g, 0, 0.5, 6.6, 4.2); box(4.6, 0.07, 1.6, M.wood, 0, 0.75, 0.5, g); box(0.5, 0.7, 0.9, M.woodDark, -1.5, 0.37, 0.5, g); box(0.5, 0.7, 0.9, M.woodDark, 1.5, 0.37, 0.5, g);
        for (var c = 0; c < 3; c++) { chair(g, -1.5 + c * 1.5, -0.75, 0); chair(g, -1.5 + c * 1.5, 1.75, Math.PI); }
        chair(g, -2.9, 0.5, Math.PI / 2); chair(g, 2.9, 0.5, -Math.PI / 2); plant(g, 3.9, 2.9, 0.9);
      }
      if (id === "rec") { // mostrador de recepción y espera
        box(3.4, 1.05, 0.6, M.woodDark, 0, 0.58, -1.2, g); box(3.6, 0.06, 0.8, M.wood, 0, 1.13, -1.2, g); box(3.4, 0.08, 0.04, aMat(null), 0, 0.9, -0.88, g, false);
        sofa(g, -2.6, 1.6, Math.PI / 2); rug(g, -2.2, 1.6, 2.6, 3); cyl(0.4, 0.4, 0.05, M.wood, -1.3, 0.4, 1.6, g, 24); cyl(0.05, 0.05, 0.34, M.metal, -1.3, 0.21, 1.6, g); plant(g, 3.9, 2.9, 1.2); plant(g, 3.9, -2.7, 0.8);
      }
      if (id === "pla") { rug(g, -1.4, 1.6, 4, 2.2); box(1.6, 0.9, 0.5, M.metal, -2.2, 0.51, 2.9, g); }
    }

    ROOMS.forEach(function (R) {
      var g = new T.Group(); g.position.set(R.cx, 0, R.cz); scene.add(g); R.g = g;
      var ac = R.area ? col(AREAS[R.area].c) : C.accent;
      var f = box(ROOM_W, 0.06, ROOM_D, std(C.floor.clone().lerp(ac, dark ? 0.16 : 0.09)), 0, 0.03, 0, g, false); f.userData.room = R.id; picks.push(f);
      var sides = { pz: [true, ROOM_D / 2, ROOM_W], nz: [true, -ROOM_D / 2, ROOM_W], px: [false, ROOM_W / 2, ROOM_D], nx: [false, -ROOM_W / 2, ROOM_D] };
      Object.keys(sides).forEach(function (k) {
        var s = sides[k], L = s[2], a = -L / 2;
        var gaps = R.doors.filter(function (d) { return d[0] === k; }).map(function (d) { return [d[1] - 0.85, d[1] + 0.85]; }).sort(function (p, q) { return p[0] - q[0]; });
        gaps.concat([[L / 2, L / 2]]).forEach(function (gp) { var len = gp[0] - a; if (len > 0.05) wall(g, s[0], s[1], a + len / 2, len, R.area); a = gp[1]; });
      });
      // pantalla de pared
      var cv = document.createElement("canvas"); cv.width = 512; cv.height = 288;
      var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
      box(3.3, 1.86, 0.08, M.dark, 0, 1.3, -ROOM_D / 2 + 0.14, g);
      var sm = new T.Mesh(new T.PlaneGeometry(3.14, 1.7), new T.MeshBasicMaterial({ map: tex })); sm.position.set(0, 1.3, -ROOM_D / 2 + 0.185); g.add(sm);
      sm.userData = R.id === "dec" ? { act: "decisiones" } : { room: R.id }; picks.push(sm);
      screens[R.id] = { cv: cv, ctx: cv.getContext("2d"), tex: tex, color: R.area ? AREAS[R.area].c : (css("--accent") || "#0d5f66") };
      decor(R, g);
      // etiqueta
      var tag = document.createElement("button"); tag.type = "button"; tag.className = "of-room"; tag.textContent = R.name;
      tag.addEventListener("click", function () { stopTour(); goRoom(R.id); }); overlay.appendChild(tag);
      R.tag = tag; R.top = new T.Vector3(R.cx, WALL_H + 1.1, R.cz);
    });

    // ---------- personas y puestos ----------
    function hairOn(head, look, mat, capMat) {
      var style = look.style;
      if (style === "afro") { sph(0.2, mat, 0, 0.07, -0.03, head).scale.set(1.08, 0.95, 1.05); return; }
      var cap = mesh(new T.SphereGeometry(0.176, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), style === "cap" ? capMat : mat, 0, 0.005, 0, head); cap.rotation.x = -0.32;
      if (style === "long") box(0.31, 0.3, 0.1, mat, 0, -0.1, -0.12, head);
      if (style === "bun") sph(0.075, mat, 0, 0.17, -0.09, head);
      if (style === "cap") box(0.22, 0.02, 0.14, capMat, 0, 0.075, 0.18, head);
    }
    function makeChar(look, shirt) {
      var g = new T.Group(), skin = std(col(look.skin)), hairM = std(col(look.hair));
      box(0.15, 0.13, 0.46, M.pants, -0.11, 0.55, 0.2, g); box(0.15, 0.13, 0.46, M.pants, 0.11, 0.55, 0.2, g);
      box(0.12, 0.44, 0.13, M.pants, -0.11, 0.27, 0.4, g); box(0.12, 0.44, 0.13, M.pants, 0.11, 0.27, 0.4, g);
      box(0.13, 0.07, 0.24, M.shoe, -0.11, 0.04, 0.45, g); box(0.13, 0.07, 0.24, M.shoe, 0.11, 0.04, 0.45, g);
      var torso = new T.Group(); torso.position.set(0, 0.6, 0); g.add(torso);
      cyl(0.2, 0.17, 0.5, shirt, 0, 0.27, 0, torso); sph(0.2, shirt, 0, 0.5, 0, torso).scale.set(1.18, 0.45, 0.92); cyl(0.06, 0.07, 0.1, skin, 0, 0.6, 0, torso);
      var head = new T.Group(); head.position.set(0, 0.79, 0); torso.add(head);
      sph(0.165, skin, 0, 0, 0, head).scale.set(1, 1.06, 1);
      sph(0.019, M.eye, -0.06, 0.02, 0.152, head); sph(0.019, M.eye, 0.06, 0.02, 0.152, head);
      hairOn(head, look, hairM, shirt);
      if (look.glasses) [-0.06, 0.06].forEach(function (x) { mesh(new T.TorusGeometry(0.042, 0.008, 6, 18), M.dark, x, 0.02, 0.158, head, false); });
      if (look.phones) { var hb = mesh(new T.TorusGeometry(0.18, 0.016, 6, 20, Math.PI), M.dark, 0, 0.02, 0, head, false); cyl(0.05, 0.05, 0.05, M.dark, -0.18, 0, 0, head).rotation.z = Math.PI / 2; cyl(0.05, 0.05, 0.05, M.dark, 0.18, 0, 0, head).rotation.z = Math.PI / 2; hb.rotation.y = 0; }
      function arm(sx) { var p = new T.Group(); p.position.set(sx * 0.25, 0.47, 0); torso.add(p); cyl(0.055, 0.05, 0.46, shirt, 0, -0.23, 0, p); sph(0.06, skin, 0, -0.48, 0, p); return p; }
      return { g: g, torso: torso, head: head, aL: arm(-1), aR: arm(1) };
    }
    var iconTex = {};
    function iconFor(st) {
      if (iconTex[st]) return iconTex[st];
      var c = document.createElement("canvas"); c.width = c.height = 96; var x = c.getContext("2d");
      x.fillStyle = STATE_COLOR[st] || STATE_COLOR.prog; x.beginPath(); x.arc(48, 48, 42, 0, 6.3); x.fill();
      x.strokeStyle = x.fillStyle = "#fff"; x.lineWidth = 9; x.lineCap = "round"; x.lineJoin = "round";
      if (st === "run") { x.beginPath(); x.moveTo(38, 28); x.lineTo(68, 48); x.lineTo(38, 68); x.closePath(); x.fill(); }
      else if (st === "wait") { [28, 48, 68].forEach(function (px) { x.beginPath(); x.arc(px, 48, 6.5, 0, 6.3); x.fill(); }); }
      else if (st === "done") { x.beginPath(); x.moveTo(27, 50); x.lineTo(42, 64); x.lineTo(69, 33); x.stroke(); }
      else if (st === "off") { x.beginPath(); x.moveTo(38, 30); x.lineTo(38, 66); x.moveTo(58, 30); x.lineTo(58, 66); x.stroke(); }
      else if (st === "prog") { x.lineWidth = 7; x.beginPath(); x.arc(48, 48, 24, 0, 6.3); x.stroke(); x.beginPath(); x.moveTo(48, 34); x.lineTo(48, 48); x.lineTo(58, 54); x.stroke(); }
      else if (st === "idea") { x.beginPath(); x.moveTo(48, 28); x.lineTo(48, 68); x.moveTo(28, 48); x.lineTo(68, 48); x.stroke(); }
      else { x.font = "700 60px system-ui,sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(st === "appr" ? "?" : "!", 48, 51); }
      var t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding; iconTex[st] = t; return t;
    }

    var stations = [], byCode = {}, stationRoot = new T.Group(), signature = ""; scene.add(stationRoot);
    var ring = mesh(new T.TorusGeometry(0.82, 0.045, 8, 48), new T.MeshBasicMaterial({ color: C.accent }), 0, -5, 0, null, false); ring.rotation.x = Math.PI / 2;

    function buildStations(agents) {
      stations.forEach(function (s) { overlay.removeChild(s.tag); picks.splice(picks.indexOf(s.hit), 1); });
      while (stationRoot.children.length) stationRoot.remove(stationRoot.children[0]);
      stations = []; byCode = {};
      var perRoom = {};
      agents.forEach(function (a) {
        var R = ROOMS.filter(function (r) { return r.area === a.area; })[0] || ROOMS[1];
        (perRoom[R.id] = perRoom[R.id] || []).push(a);
      });
      ROOMS.forEach(function (R) {
        var list = (perRoom[R.id] || []).slice(0, 3), n = list.length; // máximo tres personas por sala
        var xs = n === 1 ? [R.id === "pla" ? -1.6 : 0] : n === 2 ? [-2.1, 2.1] : [-2.95, 0, 2.95];
        list.forEach(function (a, i) {
          var ghost = a.st === "idea", g = new T.Group(); g.position.set(R.cx + xs[i], 0, R.cz - 1.3); stationRoot.add(g);
          var shirt = aMat(a.area);
          var ch = chair(g, 0, 0, 0, ghost ? M.ghost : M.chair);
          box(1.7, 0.05, 0.8, ghost ? M.ghost : M.wood, 0, 0.745, 0.78, g); box(0.05, 0.72, 0.74, ghost ? M.ghost : M.woodDark, -0.8, 0.36, 0.78, g); box(0.05, 0.72, 0.74, ghost ? M.ghost : M.woodDark, 0.8, 0.36, 0.78, g);
          box(1.56, 0.4, 0.03, ghost ? M.ghost : M.woodDark, 0, 0.5, 1.15, g);
          var s = { a: a, g: g, room: R, ghost: ghost, phase: i * 1.7 + R.col, pos: new T.Vector3(R.cx + xs[i], 0, R.cz - 1.3) };
          if (!ghost) {
            cyl(0.03, 0.03, 0.22, M.metal, 0, 0.88, 1.0, g); box(0.26, 0.02, 0.18, M.metal, 0, 0.78, 1.0, g); box(0.72, 0.44, 0.04, M.dark, 0, 1.12, 1.02, g);
            s.display = new T.Mesh(new T.PlaneGeometry(0.66, 0.38), new T.MeshBasicMaterial({ color: 0xffffff })); s.display.position.set(0, 1.12, 0.998); s.display.rotation.y = Math.PI; g.add(s.display);
            s.strip = box(0.5, 0.06, 0.02, new T.MeshBasicMaterial({ color: 0xffffff }), 0, 1.12, 1.046, g, false);
            box(0.42, 0.02, 0.14, M.dark, 0, 0.78, 0.52, g, false); cyl(0.04, 0.04, 0.09, shirt, 0.56, 0.815, 0.62, g);
            s.led = box(1.5, 0.035, 0.02, new T.MeshBasicMaterial({ color: 0xffffff }), 0, 0.7, 1.17, g, false);
            s.ch = makeChar(lookFor(a.c), shirt); g.add(s.ch.g);
          } else { ch.position.z = -0.35; }
          s.icon = new T.Sprite(new T.SpriteMaterial({ map: iconFor(a.st), depthTest: false })); s.icon.scale.set(0.34, 0.34, 1); s.icon.position.set(0, ghost ? 1.25 : 1.98, 0); s.icon.renderOrder = 5; g.add(s.icon);
          s.hit = new T.Mesh(new T.CylinderGeometry(0.95, 0.95, 2.1, 10), new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })); s.hit.position.set(0, 1.05, 0.4); s.hit.userData.code = a.c; g.add(s.hit); picks.push(s.hit);
          s.top = new T.Vector3(s.pos.x, ghost ? 1.75 : 2.38, s.pos.z);
          var tag = document.createElement("button"); tag.type = "button"; tag.className = "of-tag"; tag.innerHTML = "<i></i><b></b><span></span><u></u>";
          tag.addEventListener("click", function () { stopTour(); if (opts.onSelect) opts.onSelect(a.c); }); overlay.appendChild(tag); s.tag = tag;
          stations.push(s); byCode[a.c] = s;
        });
      });
    }

    function paint() {
      stations.forEach(function (s) {
        var a = s.a, st = a.st, c = col(STATE_COLOR[st] || STATE_COLOR.prog);
        if (s.display) { s.display.material.color.copy(st === "off" ? col("#161d1e") : c); s.strip.material.color.copy(c); s.led.material.color.copy(c); }
        s.icon.material.map = iconFor(st);
        s.tag.firstChild.style.background = STATE_COLOR[st] || STATE_COLOR.prog;
        s.tag.children[1].textContent = s.ghost ? "Vacante" : String(a.p).split(" ")[0];
        s.tag.children[2].textContent = " · " + a.title;
        s.tag.children[3].textContent = a.inbox ? String(a.inbox) : "";
        s.tag.title = a.p + ", " + a.title + ": " + a.label;
        s.tag.setAttribute("aria-pressed", a.c === selected);
      });
      var sel = byCode[selected]; if (sel) ring.position.set(sel.pos.x, 0.09, sel.pos.z + 0.05); else ring.position.y = -5;
    }

    function drawScreen(S, info) {
      var x = S.ctx, W = 512, H = 288; info = info || { t: "", big: "", lines: [] };
      x.fillStyle = "#0b1615"; x.fillRect(0, 0, W, H); x.fillStyle = S.color; x.fillRect(0, 0, W, 10);
      x.textBaseline = "alphabetic"; x.textAlign = "left";
      x.fillStyle = "#8fb3ae"; x.font = "600 23px 'IBM Plex Sans',system-ui,sans-serif"; x.fillText(String(info.t).toUpperCase(), 28, 54);
      if (info.bars) {
        info.bars.slice(0, 4).forEach(function (b, i) {
          var y = 92 + i * 48; x.fillStyle = "#dbe7e5"; x.font = "500 21px 'IBM Plex Sans',system-ui,sans-serif"; x.fillText(b[0], 28, y, 250);
          x.fillStyle = "#1d2e2c"; x.fillRect(28, y + 9, 380, 12); x.fillStyle = S.color; x.fillRect(28, y + 9, Math.max(4, 380 * b[1]), 12);
          x.fillStyle = "#fff"; x.font = "500 22px 'IBM Plex Mono',ui-monospace,monospace"; x.textAlign = "right"; x.fillText(Math.round(b[1] * 100) + "%", 484, y + 22); x.textAlign = "left";
        });
      } else {
        var big = String(info.big || ""); x.fillStyle = "#fff"; x.font = "500 " + (big.length > 13 ? 50 : big.length > 9 ? 62 : 76) + "px 'IBM Plex Mono',ui-monospace,monospace"; x.fillText(big, 28, 142, 456);
        x.fillStyle = "#b9cbc8"; x.font = "400 23px 'IBM Plex Sans',system-ui,sans-serif";
        (info.lines || []).slice(0, 3).forEach(function (l, i) { x.fillText(String(l), 28, 190 + i * 34, 456); });
      }
      S.tex.needsUpdate = true;
    }

    var rackGroup = new T.Group(), rackLeds = []; ROOMS[8].g.add(rackGroup);
    function buildRacks(racks) {
      while (rackGroup.children.length) rackGroup.remove(rackGroup.children[0]); rackLeds = [];
      racks.slice(0, 7).forEach(function (r, i) {
        var z = -2.75 + i * 0.86; box(0.8, 1.95, 0.66, M.rack, 3.85, 1.035, z, rackGroup);
        var leds = [];
        for (var k = 0; k < 4; k++) leds.push(box(0.02, 0.05, 0.46, new T.MeshBasicMaterial({ color: 0xffffff }), 3.44, 0.5 + k * 0.4, z, rackGroup, false));
        rackLeds.push(leds);
      });
    }

    // ---------- tareas entre agentes: arcos con paquetes que viajan de un puesto a otro ----------
    var flowRoot = new T.Group(), flows = [], flowSig = ""; scene.add(flowRoot);
    var FLOW_COLOR = { open: "#f0a020", in_progress: "#3b82f6", blocked: "#e5484d" };
    function anchor(code) {
      if (code === "sistema") { var P = ROOMS.filter(function (r) { return r.id === "pla"; })[0]; return new T.Vector3(P.cx + 3.4, 1.9, P.cz); }
      if (code === "user") { var R = ROOMS.filter(function (r) { return r.id === "dec"; })[0]; return new T.Vector3(R.cx, 1.0, R.cz + 0.5); }
      var s = byCode[code]; return s ? new T.Vector3(s.pos.x, 1.55, s.pos.z + 0.2) : null;
    }
    function buildFlows(tasks) {
      flowRoot.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      while (flowRoot.children.length) flowRoot.remove(flowRoot.children[0]);
      flows = [];
      tasks.forEach(function (t, i) {
        var a = anchor(t.from), b = anchor(t.to); if (!a || !b) return;
        var mid = a.clone().add(b).multiplyScalar(0.5); mid.y = 2.4 + a.distanceTo(b) * 0.2;
        var curve = new T.QuadraticBezierCurve3(a, mid, b), c = col(FLOW_COLOR[t.st] || FLOW_COLOR.open);
        var tube = new T.Mesh(new T.TubeGeometry(curve, 48, 0.055, 8, false), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: t.st === "blocked" ? 0.9 : 0.78, depthWrite: false }));
        tube.renderOrder = 3; flowRoot.add(tube);
        var dots = [0, 1].map(function () { var d = new T.Mesh(new T.SphereGeometry(0.16, 14, 10), new T.MeshBasicMaterial({ color: c })); d.renderOrder = 4; flowRoot.add(d); return d; });
        var end = new T.Mesh(new T.TorusGeometry(0.26, 0.03, 6, 24), new T.MeshBasicMaterial({ color: c })); end.rotation.x = Math.PI / 2; end.position.set(b.x, 0.1, b.z - 0.2); flowRoot.add(end);
        flows.push({ curve: curve, dots: dots, st: t.st, off: i * 0.37 });
      });
    }

    var data = null, selected = null;
    function update(d) {
      data = d;
      var sig = d.agents.map(function (a) { return a.c + ":" + a.area + ":" + (a.st === "idea" ? 1 : 0); }).join("|");
      var rebuilt = false;
      if (sig !== signature) { signature = sig; buildStations(d.agents); rebuilt = true; }
      else d.agents.forEach(function (a) { if (byCode[a.c]) byCode[a.c].a = a; });
      paint();
      var tasks = d.tasks || [], fsig = tasks.map(function (t) { return t.id + t.st; }).join("|");
      if (rebuilt || fsig !== flowSig) { flowSig = fsig; buildFlows(tasks); }
      ROOMS.forEach(function (R) { drawScreen(screens[R.id], d.screens && d.screens[R.id]); });
      var racks = d.racks || []; if (rackLeds.length !== Math.min(7, racks.length)) buildRacks(racks);
      var Q = { good: "#2fbf71", warn: "#f0a020", crit: "#e5484d" };
      rackLeds.forEach(function (leds, i) { var c = col(Q[racks[i].q] || "#8a9a98"); leds.forEach(function (l) { l.material.color.copy(c); }); });
    }

    // ---------- cámara y navegación ----------
    var W = 1, H = 1, aspect = 1;
    var cur = { yaw: 0.38, phi: 0.82, dist: 40, t: new T.Vector3(0, 0.5, 0.8) }, goal = { yaw: 0.38, phi: 0.82, dist: 40, t: new T.Vector3(0, 0.5, 0.8) };
    function near(target) { var d = (target - goal.yaw) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return goal.yaw + d; }
    function overview() { goal.t.set(0, 0.5, 0.8); goal.dist = aspect < 1 ? 66 : aspect < 1.5 ? 50 : 40; goal.phi = 0.82; goal.yaw = near(0.38); }
    function goRoom(id) { var R = ROOMS.filter(function (r) { return r.id === id; })[0]; if (!R) return; goal.t.set(R.cx, 0.9, R.cz); goal.dist = aspect < 1 ? 19 : 13.5; goal.phi = 0.95; goal.yaw = near(0.3); mark(id); }
    function goAgent(code) { var s = byCode[code]; if (!s) return; goal.t.set(s.pos.x, 1.0, s.pos.z + 0.35); goal.dist = aspect < 1 ? 8.5 : 6; goal.phi = 1.12; goal.yaw = near(0.5); mark(s.room.id); }
    function select(code, fly) { selected = code; paint(); if (fly) goAgent(code); }

    // barra de salas
    var chips = {};
    function chip(label, fn, id) { var b = document.createElement("button"); b.type = "button"; b.className = "of-chip"; b.textContent = label; b.addEventListener("click", function () { stopTour(); fn(); }); bar.appendChild(b); if (id) chips[id] = b; return b; }
    chip("Vista general", function () { overview(); mark("all"); }, "all");
    ROOMS.forEach(function (R) { chip(R.name, function () { goRoom(R.id); }, R.id); });
    var tourBtn = document.createElement("button"); tourBtn.type = "button"; tourBtn.className = "of-chip of-tour"; tourBtn.textContent = "Recorrido guiado"; stage.appendChild(tourBtn);
    function mark(id) { Object.keys(chips).forEach(function (k) { chips[k].setAttribute("aria-pressed", k === id); }); }
    var tour = null, tourIdx = 0;
    function stopTour() { if (tour) { clearInterval(tour); tour = null; tourBtn.setAttribute("aria-pressed", false); } }
    tourBtn.addEventListener("click", function () {
      if (tour) { stopTour(); return; }
      if (still) return; tourIdx = 0; goRoom(ROOMS[0].id); tourBtn.setAttribute("aria-pressed", true);
      tour = setInterval(function () { tourIdx = (tourIdx + 1) % ROOMS.length; goRoom(ROOMS[tourIdx].id); }, 6500);
    });

    function resize() {
      W = stage.clientWidth || 800; H = stage.clientHeight || 520; aspect = W / H;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false); cam.aspect = aspect; cam.updateProjectionMatrix();
    }
    function panBy(dx, dy) {
      var k = goal.dist * 0.0016, cy = Math.cos(goal.yaw), sy = Math.sin(goal.yaw);
      goal.t.x -= (cy * dx + sy * dy) * k; goal.t.z -= (-sy * dx + cy * dy) * k; bound();
    }
    function bound() { goal.t.x = clamp(goal.t.x, -17, 17); goal.t.z = clamp(goal.t.z, -15, 15); goal.dist = clamp(goal.dist, 3.2, 80); goal.phi = clamp(goal.phi, 0.12, 1.5); }

    var ptr = {}, moved = 0, panning = false, ray = new T.Raycaster(), m2 = new T.Vector2();
    function hitAt(e) { var r = canvas.getBoundingClientRect(); m2.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(m2, cam); return ray.intersectObjects(picks)[0]; }
    function onDown(e) { try { canvas.setPointerCapture(e.pointerId); } catch (_) { } ptr[e.pointerId] = { x: e.clientX, y: e.clientY }; if (Object.keys(ptr).length === 1) { moved = 0; panning = e.button === 2 || e.button === 1 || e.shiftKey; } stopTour(); stage.focus({ preventScroll: true }); }
    function onMove(e) {
      var p = ptr[e.pointerId]; if (!p) return; var ids = Object.keys(ptr), dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (ids.length === 1) { moved += Math.abs(dx) + Math.abs(dy); if (panning) panBy(dx, dy); else { goal.yaw -= dx * 0.006; goal.phi -= dy * 0.005; bound(); } }
      else if (ids.length === 2) {
        var o = ptr[ids[0] === String(e.pointerId) ? ids[1] : ids[0]], before = Math.hypot(p.x - o.x, p.y - o.y), after = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        if (before > 0 && after > 0) goal.dist *= before / after; panBy(dx / 2, dy / 2); moved += 10;
      }
      p.x = e.clientX; p.y = e.clientY;
    }
    function onUp(e) {
      var single = Object.keys(ptr).length === 1; delete ptr[e.pointerId];
      if (!single || moved > 6 || e.type === "pointercancel") return;
      var h = hitAt(e); if (!h) return; var u = h.object.userData;
      if (u.code) { if (opts.onSelect) opts.onSelect(u.code); } else if (u.act) { if (opts.onAct) opts.onAct(u.act); } else if (u.room) goRoom(u.room);
    }
    function onWheel(e) { e.preventDefault(); stopTour(); goal.dist *= Math.exp(clamp(e.deltaY, -120, 120) * 0.0014); bound(); }
    function onDbl(e) { var h = hitAt(e); if (h && !h.object.userData.code) { goal.t.set(h.point.x, 0.9, h.point.z); goal.dist = Math.max(7, goal.dist * 0.55); bound(); } }
    var keys = {};
    function onKey(e) { var k = e.key.length === 1 ? e.key.toLowerCase() : e.key; if (/^(w|a|s|d|q|e|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|\+|-|=)$/.test(k)) { keys[k] = e.type === "keydown"; e.preventDefault(); stopTour(); } }
    function onBlur() { keys = {}; }
    canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp); canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("dblclick", onDbl); canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    stage.addEventListener("keydown", onKey); stage.addEventListener("keyup", onKey); stage.addEventListener("blur", onBlur);
    window.addEventListener("resize", resize);

    var v = new T.Vector3(), last = 0, raf = 0, alive = true;
    function place(el, p, show) {
      v.copy(p).project(cam);
      if (!show || v.z > 1 || v.x < -1.15 || v.x > 1.15 || v.y < -1.15 || v.y > 1.15) { el.style.display = "none"; return; }
      el.style.display = ""; el.style.transform = "translate(-50%,-50%) translate(" + ((v.x + 1) / 2 * W).toFixed(1) + "px," + ((1 - v.y) / 2 * H).toFixed(1) + "px)"; el.style.zIndex = Math.round((1 - v.z) * 10000);
    }
    function frame(ts) {
      if (!alive) return; raf = requestAnimationFrame(frame);
      var t = ts / 1000, dt = Math.min(0.05, t - last || 0.016); last = t;
      // teclado
      var mv = goal.dist * 0.9 * dt, cy = Math.cos(goal.yaw), sy = Math.sin(goal.yaw), fx = 0, fz = 0;
      if (keys.w || keys.ArrowUp) fz -= 1; if (keys.s || keys.ArrowDown) fz += 1; if (keys.a || keys.ArrowLeft) fx -= 1; if (keys.d || keys.ArrowRight) fx += 1;
      if (fx || fz) { goal.t.x += (cy * fx + sy * fz) * mv; goal.t.z += (-sy * fx + cy * fz) * mv; }
      if (keys.q) goal.yaw += 1.4 * dt; if (keys.e) goal.yaw -= 1.4 * dt; if (keys["+"] || keys["="]) goal.dist *= 1 - 1.2 * dt; if (keys["-"]) goal.dist *= 1 + 1.2 * dt;
      if (tour) goal.yaw += 0.05 * dt;
      bound();
      var k = still ? 1 : 1 - Math.exp(-dt * 6.5);
      cur.yaw += (goal.yaw - cur.yaw) * k; cur.phi += (goal.phi - cur.phi) * k; cur.dist += (goal.dist - cur.dist) * k; cur.t.lerp(goal.t, k);
      var sp = Math.sin(cur.phi);
      cam.position.set(cur.t.x + cur.dist * sp * Math.sin(cur.yaw), cur.t.y + cur.dist * Math.cos(cur.phi), cur.t.z + cur.dist * sp * Math.cos(cur.yaw)); cam.lookAt(cur.t);

      // animación según el estado real de cada agente
      stations.forEach(function (s) {
        var st = s.a.st, ph = s.phase, bob = 0, ic = 1;
        if (s.ch && !still) {
          var c = s.ch, aL = -1.0, aR = -1.0, zL = 0, zR = 0, lean = 0, hx = 0, hy = 0;
          if (st === "run") { aL += Math.sin(t * 15 + ph) * 0.07; aR += Math.sin(t * 15 + ph + 2) * 0.07; hx = 0.1 + Math.sin(t * 2 + ph) * 0.03; bob = Math.sin(t * 6 + ph) * 0.02; }
          else if (st === "wait") { aL = aR = -0.75; hy = Math.sin(t * 0.8 + ph) * 0.6; }
          else if (st === "appr") { aR = -2.85 + Math.sin(t * 5 + ph) * 0.14; zR = 0.18; aL = -0.8; hx = -0.12; bob = Math.abs(Math.sin(t * 3 + ph)) * 0.04; }
          else if (st === "err") { aL = aR = -2.35; zL = -0.55; zR = 0.55; hx = 0.3; lean = 0.1; ic = Math.sin(t * 9) > 0 ? 1.25 : 0.7; }
          else if (st === "done") { aL = aR = -0.45; lean = -0.14; hx = -0.05 + Math.sin(t * 1.2 + ph) * 0.05; }
          else if (st === "off") { aL = aR = -0.3; hx = 0.5; lean = 0.08; }
          else { aL = aR = -0.85; hy = Math.sin(t * 0.5 + ph) * 0.18; lean = Math.sin(t * 1.1 + ph) * 0.015; }
          c.aL.rotation.x += (aL - c.aL.rotation.x) * 0.2; c.aR.rotation.x += (aR - c.aR.rotation.x) * 0.2; c.aL.rotation.z += (zL - c.aL.rotation.z) * 0.2; c.aR.rotation.z += (zR - c.aR.rotation.z) * 0.2;
          c.torso.rotation.x += (lean - c.torso.rotation.x) * 0.1; c.head.rotation.x += (hx - c.head.rotation.x) * 0.15; c.head.rotation.y += (hy - c.head.rotation.y) * 0.15;
        } else if (s.ch) { s.ch.aL.rotation.x = s.ch.aR.rotation.x = st === "appr" ? -0.9 : -1.0; if (st === "appr") s.ch.aR.rotation.x = -2.85; }
        s.icon.position.y = (s.ghost ? 1.25 : 1.98) + (still ? 0 : bob + Math.sin(t * 2 + ph) * 0.015); s.icon.scale.set(0.34 * ic, 0.34 * ic, 1);
        place(s.tag, s.top, true); s.tag.classList.toggle("compact", cur.dist > 27 && s.a.c !== selected);
      });
      flows.forEach(function (f) {
        f.dots.forEach(function (d, k) {
          if (f.st === "blocked") { d.position.copy(f.curve.getPoint(0.5)); d.visible = k === 0; d.scale.setScalar(still ? 1 : 1 + Math.abs(Math.sin(t * 4)) * 0.6); return; }
          var u = still ? 0.35 + k * 0.3 : ((t * (f.st === "in_progress" ? 0.32 : 0.16) + f.off + k * 0.5) % 1);
          d.position.copy(f.curve.getPoint(u));
        });
      });
      ROOMS.forEach(function (R) { place(R.tag, R.top, cur.dist > 17); });
      renderer.render(scene, cam);
    }

    resize(); overview(); cur.yaw = goal.yaw; cur.phi = goal.phi; cur.dist = goal.dist * 1.25; cur.t.copy(goal.t); mark("all");
    raf = requestAnimationFrame(frame);

    function dispose() {
      alive = false; cancelAnimationFrame(raf); stopTour(); window.removeEventListener("resize", resize);
      scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      try { renderer.dispose(); } catch (e) { }
      stage.innerHTML = "";
    }
    return { update: update, select: select, goRoom: goRoom, overview: overview, dispose: dispose, resize: resize };
  }

  window.Oficina = { create: create, AREAS: AREAS, ROOMS: ROOMS.map(function (r) { return { id: r.id, area: r.area, name: r.name }; }) };
})();
