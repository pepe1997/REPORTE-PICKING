const SHEET_ID = "1JfxuqHDwuRkrXTZ_jPL1rFRZ9tAIA5tm-wpomLy10YE";
const HOJAS_PICKING = ["REPORTE PICKING", "Reporte Picking", "PICKING", "Picking"];
const HOJAS_USUARIOS = ["USUARIOS", "Usuarios"];
const USUARIOS = [
  { user: "admin", pass: "1234", nombre: "Administrador" },
  { user: "operador", pass: "1234", nombre: "Operador" }
];

let dataPicking = [];
let dataUsuarios = [];
let presentacionPendiente = true;
let rolActual = "";
let turnoOperadorSeleccionado = "";
let temporizadoresPresentacion = [];
let audioCelebracion = null;
let modeloPickingCache = null;
let directorioUsuariosCache = null;
let vistasPickingCache = new Map();
let totalesTurnoCache = { DIA: 0, TARDE: 0, NOCHE: 0 };

function limpiar(valor) {
  return String(valor ?? "").trim();
}

function normalizar(valor) {
  return limpiar(valor).toUpperCase();
}

function numero(valor) {
  const n = Number(String(valor ?? "0").trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function campo(row, nombres) {
  for (const nombre of nombres) {
    if (row?.[nombre] !== undefined && row[nombre] !== null && row[nombre] !== "") return row[nombre];
  }
  return "";
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function pct(valor, total) {
  return total > 0 ? (valor / total) * 100 : 0;
}

function html(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function horaFecha(valor) {
  if (!valor) return null;
  const texto = limpiar(valor);
  const match = texto.match(/(?:T|\s)(\d{1,2}):(\d{2})/);
  if (match) return Number(match[1]);
  const fecha = new Date(texto);
  return Number.isNaN(fecha.getTime()) ? null : fecha.getHours();
}

function turnoPorHora(hora) {
  if (hora === null || hora === undefined) return "SIN TURNO";
  if (hora >= 7 && hora < 16) return "DIA";
  if (hora >= 16 && hora < 21) return "TARDE";
  return "NOCHE";
}

function pickingValido(row) {
  const orden = normalizar(row.orden);
  const descripcion = normalizar(row.descripcion);
  if (normalizar(row.lpn).startsWith("ILE")) return false;
  if (orden.startsWith("TFC")) return false;
  if (orden.startsWith("TRF") && descripcion.startsWith("JABA")) return false;
  return row.bultos > 0;
}

function modeloPicking() {
  if (modeloPickingCache) return modeloPickingCache;
  modeloPickingCache = dataPicking.map((r, index) => {
    const fecha = campo(r, ["FECHA PICK", "FECHA_PICK", "Fecha Pick", "FECHA"]);
    const hora = horaFecha(fecha);
    return {
      index,
      orden: limpiar(campo(r, ["NRO ORDEN", "ORDEN"])),
      lpn: limpiar(campo(r, ["NRO LPN", "LPN"])),
      usuario: limpiar(campo(r, ["USUARIO PICKING", "USUARIO", "OPERADOR"])) || "SIN USUARIO",
      codigo: limpiar(campo(r, ["CODIGO", "CODIGO PRODUCTO", "PRODUCTO", "SKU"])),
      descripcion: limpiar(campo(r, ["DESCRIPCION", "Descripcion"])),
      bultos: numero(campo(r, ["BULTOS", "Bultos"])),
      hora,
      turno: turnoPorHora(hora)
    };
  }).filter(pickingValido);
  return modeloPickingCache;
}

async function cargarHoja(nombre) {
  const url = `https://opensheet.elk.sh/${SHEET_ID}/${encodeURIComponent(nombre)}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`No se pudo cargar ${nombre}: HTTP ${response.status}`);
  return response.json();
}

async function cargarPicking() {
  let ultimoError;
  for (const hoja of HOJAS_PICKING) {
    try {
      const data = await cargarHoja(hoja);
      if (Array.isArray(data)) return { data, hoja };
    } catch (error) {
      ultimoError = error;
    }
  }
  throw ultimoError || new Error("No se encontro la hoja PICKING");
}

async function cargarUsuarios() {
  let ultimoError;
  for (const hoja of HOJAS_USUARIOS) {
    try {
      const data = await cargarHoja(hoja);
      if (Array.isArray(data)) return { data, hoja };
    } catch (error) {
      ultimoError = error;
    }
  }
  console.warn("No se pudo cargar USUARIOS", ultimoError);
  return { data: [], hoja: "USUARIOS no disponible" };
}

function aliasUsuarios() {
  try {
    return JSON.parse(localStorage.getItem("ranking_picking_independiente_alias") || "{}");
  } catch {
    return {};
  }
}

function directorioUsuarios() {
  if (directorioUsuariosCache) return directorioUsuariosCache;
  const mapa = new Map();
  dataUsuarios.forEach(row => {
    const usuario = limpiar(campo(row, ["USUARIO", "Usuario", "usuario"]));
    const activo = normalizar(campo(row, ["ACTIVO", "Activo", "activo"])) || "SI";
    if (!usuario || activo === "NO") return;
    mapa.set(usuario, {
      usuario,
      nombre: limpiar(campo(row, ["NOMBRE", "Nombre", "nombre"])),
      activo
    });
  });
  directorioUsuariosCache = mapa;
  return directorioUsuariosCache;
}

function nombreUsuario(usuario, aliases = aliasUsuarios()) {
  const nombreSheet = directorioUsuarios().get(usuario)?.nombre;
  return limpiar(nombreSheet) || limpiar(aliases[usuario]) || usuario;
}

function guardarAlias(usuario, nombre) {
  const aliases = aliasUsuarios();
  const valor = limpiar(nombre);
  if (valor) aliases[usuario] = valor;
  else delete aliases[usuario];
  localStorage.setItem("ranking_picking_independiente_alias", JSON.stringify(aliases));
  renderRanking();
}

function rankingUsuarios(data) {
  const mapa = new Map();
  data.forEach(r => {
    if (!mapa.has(r.usuario)) mapa.set(r.usuario, { usuario: r.usuario, bultos: 0, registros: 0, horas: new Map() });
    const item = mapa.get(r.usuario);
    item.bultos += r.bultos;
    item.registros += 1;
    if (r.hora !== null) item.horas.set(r.hora, (item.horas.get(r.hora) || 0) + r.bultos);
  });

  return Array.from(mapa.values()).map(item => {
    const horas = Array.from(item.horas.entries()).sort((a, b) => b[1] - a[1]);
    return {
      ...item,
      horasActivas: item.horas.size,
      promedioHora: item.horas.size ? item.bultos / item.horas.size : 0,
      horaPico: horas.length ? `${String(horas[0][0]).padStart(2, "0")}:00` : "-",
      bultosPico: horas[0]?.[1] || 0
    };
  }).sort((a, b) => b.bultos - a.bultos || b.registros - a.registros);
}

function rankingProductos(data) {
  const mapa = new Map();
  data.forEach(r => {
    const clave = r.codigo || r.descripcion || "SIN PRODUCTO";
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        codigo: r.codigo || "-",
        descripcion: r.descripcion || "SIN DESCRIPCION",
        bultos: 0,
        registros: 0,
        lpns: new Set()
      });
    }
    const item = mapa.get(clave);
    item.bultos += r.bultos;
    item.registros += 1;
    if (r.lpn) item.lpns.add(r.lpn);
  });

  return Array.from(mapa.values()).map(item => ({
    ...item,
    lpns: item.lpns.size
  })).sort((a, b) => b.bultos - a.bultos || b.registros - a.registros);
}

function cargarOpcionesTurno(data) {
  const select = document.getElementById("filtroTurno");
  const actual = select.value;
  const opciones = Array.from(new Set(data.map(r => r.turno))).sort();
  select.innerHTML = `<option value="">Todos los turnos</option>${opciones.map(x => `<option value="${html(x)}">${html(x)}</option>`).join("")}`;
  select.value = opciones.includes(actual) ? actual : "";
}

function podium(data, total, aliases) {
  const orden = [data[1], data[0], data[2]];
  const clases = ["second", "first", "third"];
  return `<div class="podium">${orden.map((x, i) => x ? `
    <article class="podium-card ${clases[i]}">
      <span>${clases[i] === "first" ? 1 : clases[i] === "second" ? 2 : 3}</span>
      <div class="avatar">${html((nombreUsuario(x.usuario, aliases)[0] || "U").toUpperCase())}</div>
      <strong>${html(nombreUsuario(x.usuario, aliases))}</strong>
      <small>${html(x.usuario)}</small>
      <b>${fmt(x.bultos)}</b>
      <em>${fmt(x.promedioHora)} prom/h | ${pct(x.bultos, total).toFixed(1)}%</em>
    </article>` : `<article class="podium-card empty"><span>-</span><strong>Sin usuario</strong><b>0</b></article>`).join("")}</div>`;
}

function tarjetasPresentacion(data, total, aliases) {
  const orden = [data[1], data[0], data[2]];
  const clases = ["second", "first", "third"];
  const retrasos = { third: 0, second: 550, first: 1100 };
  return orden.map((x, index) => x ? `
    <article class="presentation-card ${clases[index]}" style="--delay:${retrasos[clases[index]]}ms">
      <span class="presentation-rank">${clases[index] === "first" ? 1 : clases[index] === "second" ? 2 : 3}</span>
      <div class="presentation-avatar">${html((nombreUsuario(x.usuario, aliases)[0] || "U").toUpperCase())}</div>
      <strong>${html(nombreUsuario(x.usuario, aliases))}</strong>
      <small>${html(x.usuario)}</small>
      <b>${fmt(x.bultos)}</b>
      <em>BULTOS PICKADOS</em>
      <div><span>${fmt(x.promedioHora)}</span><small>Promedio por hora</small></div>
      <i>${pct(x.bultos, total).toFixed(1)}% del total</i>
    </article>` : `<article class="presentation-card empty"><strong>Sin usuario</strong></article>`).join("");
}

function restoPresentacion(data, total, aliases) {
  const restantes = data.slice(3, 10);
  if (!restantes.length) return "";
  return `<section class="presentation-rest-card">
    <h2>Puestos 4 al 10</h2>
    <div class="presentation-rest-list">${restantes.map((x, index) => `
      <article>
        <span>${index + 4}</span>
        <div class="operator-mini-avatar">${html((nombreUsuario(x.usuario, aliases)[0] || "U").toUpperCase())}</div>
        <div class="presentation-rest-user"><strong>${html(nombreUsuario(x.usuario, aliases))}</strong><small>${html(x.usuario)}</small></div>
        <div class="presentation-rest-metrics">
          <div><b>${fmt(x.bultos)}</b><small>Bultos</small></div>
          <div><b>${fmt(x.promedioHora)}</b><small>Promedio / hora</small></div>
        </div>
      </article>`).join("")}</div>
  </section>`;
}

function prepararAudioCelebracion() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCelebracion) audioCelebracion = new AudioContext();
    if (audioCelebracion.state === "suspended") audioCelebracion.resume();
  } catch {}
}

function reproducirCelebracion() {
  if (!audioCelebracion) return;
  const inicio = audioCelebracion.currentTime;
  [523.25, 659.25, 783.99].forEach((frecuencia, index) => {
    const oscilador = audioCelebracion.createOscillator();
    const ganancia = audioCelebracion.createGain();
    const desde = inicio + index * 0.11;
    oscilador.type = "sine";
    oscilador.frequency.setValueAtTime(frecuencia, desde);
    ganancia.gain.setValueAtTime(0.0001, desde);
    ganancia.gain.exponentialRampToValueAtTime(0.09, desde + 0.025);
    ganancia.gain.exponentialRampToValueAtTime(0.0001, desde + 0.32);
    oscilador.connect(ganancia).connect(audioCelebracion.destination);
    oscilador.start(desde);
    oscilador.stop(desde + 0.34);
  });
}

function lanzarCelebracion() {
  const contenedor = document.getElementById("celebracionRanking");
  if (!contenedor || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  contenedor.innerHTML = "";
  const presentacion = document.getElementById("presentacionView");
  const colores = ["#fbbf24", "#60a5fa", "#f472b6", "#34d399", "#ffffff"];
  const destello = document.createElement("span");
  destello.className = "celebration-flash";
  contenedor.appendChild(destello);
  [[24, 29], [50, 18], [77, 30]].forEach(([x, y], grupo) => {
    const explosion = document.createElement("div");
    explosion.className = "firework-burst";
    explosion.style.setProperty("--x", `${x}%`);
    explosion.style.setProperty("--y", `${y}%`);
    explosion.style.setProperty("--delay", `${grupo * 120}ms`);
    for (let i = 0; i < 14; i += 1) {
      const chispa = document.createElement("i");
      chispa.style.setProperty("--angle", `${i * (360 / 14)}deg`);
      chispa.style.setProperty("--distance", `${-(75 + (i % 3) * 20)}px`);
      chispa.style.setProperty("--color", colores[(i + grupo) % colores.length]);
      explosion.appendChild(chispa);
    }
    contenedor.appendChild(explosion);
  });
  for (let i = 0; i < 28; i += 1) {
    const confeti = document.createElement("b");
    confeti.className = "celebration-confetti";
    confeti.style.setProperty("--left", `${3 + (i * 17) % 94}%`);
    confeti.style.setProperty("--delay", `${(i % 9) * 55}ms`);
    confeti.style.setProperty("--drift", `${-55 + (i * 31) % 110}px`);
    confeti.style.setProperty("--spin", `${360 + (i % 4) * 180}deg`);
    confeti.style.setProperty("--color", colores[i % colores.length]);
    contenedor.appendChild(confeti);
  }
  presentacion?.classList.add("celebrating");
  setTimeout(() => {
    contenedor.innerHTML = "";
    presentacion?.classList.add("celebration-complete");
    presentacion?.classList.remove("celebrating");
  }, 2100);
}

function reiniciarScrollPresentacion(vista) {
  if (!vista) return;
  vista.scrollTop = 0;
  vista.scrollLeft = 0;
  if (typeof vista.scrollTo === "function") vista.scrollTo({ top: 0, left: 0, behavior: "auto" });
  const listaRestante = vista.querySelector(".presentation-rest-list");
  if (listaRestante) listaRestante.scrollTop = 0;
}

function mostrarPresentacion(turnoForzado) {
  if (!dataPicking.length) return;
  temporizadoresPresentacion.forEach(clearTimeout);
  temporizadoresPresentacion = [];
  const turno = turnoForzado !== undefined
    ? limpiar(turnoForzado)
    : limpiar(document.getElementById("filtroTurno")?.value);
  const resumen = vistaPicking(turno);
  const total = resumen.total;
  const top = resumen.ranking.slice(0, 3);
  const aliases = aliasUsuarios();
  document.getElementById("presentacionPodio").innerHTML = tarjetasPresentacion(top, total, aliases);
  document.getElementById("presentacionResto").innerHTML = restoPresentacion(resumen.ranking, total, aliases);
  const vista = document.getElementById("presentacionView");
  vista.classList.remove("celebrating", "celebration-complete");
  const cuenta = document.getElementById("presentationCountdown");
  const numeroCuenta = document.getElementById("countdownNumber");
  vista.hidden = false;
  document.body.classList.add("presentation-open");
  reiniciarScrollPresentacion(vista);
  requestAnimationFrame(() => requestAnimationFrame(() => reiniciarScrollPresentacion(vista)));

  if (rolActual !== "operador") {
    vista.classList.remove("counting");
    cuenta.hidden = true;
    return;
  }

  vista.classList.add("counting");
  cuenta.hidden = false;
  numeroCuenta.classList.remove("is-word");
  numeroCuenta.textContent = "3";
  ["2", "1", "TOP"].forEach((valor, index) => {
    temporizadoresPresentacion.push(setTimeout(() => {
      numeroCuenta.classList.remove("count-pop");
      void numeroCuenta.offsetWidth;
      numeroCuenta.textContent = valor;
      numeroCuenta.classList.toggle("is-word", valor === "TOP");
      numeroCuenta.classList.add("count-pop");
    }, (index + 1) * 850));
  });
  temporizadoresPresentacion.push(setTimeout(() => {
    reiniciarScrollPresentacion(vista);
    cuenta.hidden = true;
    vista.classList.remove("counting");
    requestAnimationFrame(() => reiniciarScrollPresentacion(vista));
    lanzarCelebracion();
    reproducirCelebracion();
  }, 3500));
}

function cerrarPresentacion() {
  temporizadoresPresentacion.forEach(clearTimeout);
  temporizadoresPresentacion = [];
  const vista = document.getElementById("presentacionView");
  reiniciarScrollPresentacion(vista);
  vista.hidden = true;
  vista.classList.remove("counting");
  document.body.classList.remove("presentation-open");
}

function seleccionarTurnoOperador(boton) {
  turnoOperadorSeleccionado = limpiar(boton.dataset.turno);
  document.querySelectorAll("#turnosOperador button").forEach(x => x.classList.toggle("active", x === boton));
}

function generarRankingOperador() {
  prepararAudioCelebracion();
  mostrarPresentacion(turnoOperadorSeleccionado);
}

function tablaTop10(data, aliases) {
  return `<div class="top-list">${data.slice(0, 10).map((x, i) => `
    <article>
      <span>${i + 1}</span>
      <div><strong>${html(nombreUsuario(x.usuario, aliases))}</strong><small>${html(x.usuario)}</small></div>
      <b>${fmt(x.bultos)}</b>
      <em>${fmt(x.promedioHora)} prom/h</em>
    </article>`).join("") || `<div class="empty-state">Sin datos.</div>`}</div>`;
}

function tablaNombres(data, aliases) {
  const directorio = directorioUsuarios();
  return `<div class="scroll-table alias-table"><table><thead><tr><th>Usuario</th><th>Nombre Google Sheet</th><th>Activo</th></tr></thead><tbody>${data.map(x => {
    const ficha = directorio.get(x.usuario);
    return `<tr><td><strong>${html(x.usuario)}</strong></td><td>${html(ficha?.nombre || "Sin nombre")}</td><td>${html(ficha?.activo || "NO REGISTRADO")}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function tablaCompleta(data, total, aliases) {
  return `<div class="scroll-table ranking-table"><table><thead><tr><th>Rank</th><th>Usuario</th><th>Nombre</th><th>Bultos</th><th>Promedio/hora</th><th>Hora pico</th><th>Horas activas</th><th>%</th></tr></thead><tbody>${data.map((x, i) => `
    <tr><td><strong>${i + 1}</strong></td><td>${html(x.usuario)}</td><td><strong>${html(nombreUsuario(x.usuario, aliases))}</strong></td><td class="number"><strong>${fmt(x.bultos)}</strong></td><td class="number">${fmt(x.promedioHora)}</td><td>${x.horaPico} | ${fmt(x.bultosPico)}</td><td>${fmt(x.horasActivas)}</td><td>${pct(x.bultos, total).toFixed(1)}%</td></tr>`).join("")}</tbody></table></div>`;
}

function resumenHoras(data) {
  const mapa = new Map();
  data.forEach(r => {
    if (r.hora === null || r.hora === undefined) return;
    const hora = Number(r.hora);
    if (!mapa.has(hora)) mapa.set(hora, { hora, valor: 0, registros: 0 });
    const item = mapa.get(hora);
    item.valor += r.bultos;
    item.registros += 1;
  });
  return Array.from(mapa.values()).sort((a, b) => a.hora - b.hora);
}

function prepararVistasPicking() {
  const modelo = modeloPicking();
  const turnos = Array.from(new Set(modelo.map(r => r.turno))).sort();
  vistasPickingCache = new Map();
  totalesTurnoCache = { DIA: 0, TARDE: 0, NOCHE: 0 };

  modelo.forEach(r => {
    if (totalesTurnoCache[r.turno] !== undefined) totalesTurnoCache[r.turno] += r.bultos;
  });

  ["", ...turnos].forEach(turno => {
    const data = turno ? modelo.filter(r => r.turno === turno) : modelo;
    const total = data.reduce((a, b) => a + b.bultos, 0);
    const horas = resumenHoras(data);
    vistasPickingCache.set(turno, {
      turno,
      data,
      total,
      horas,
      promedioHora: horas.length ? total / horas.length : 0,
      ranking: rankingUsuarios(data),
      productos: rankingProductos(data),
      tendenciaHtml: tendenciaOperativa(horas)
    });
  });
}

function vistaPicking(turno = "") {
  return vistasPickingCache.get(limpiar(turno)) || {
    turno: limpiar(turno),
    data: [],
    total: 0,
    horas: [],
    promedioHora: 0,
    ranking: [],
    productos: [],
    tendenciaHtml: `<div class="empty-state">Sin datos horarios.</div>`
  };
}

function detalleUsuariosAdmin(data, total) {
  const aliases = aliasUsuarios();
  if (!data.length) return `<div class="empty-state">Sin usuarios para el turno seleccionado.</div>`;
  return `<div class="admin-detail-scroll"><table class="admin-detail-table"><thead><tr><th>#</th><th>Usuario</th><th>Nombre</th><th>Bultos</th><th>Promedio / hora</th><th>Horas activas</th><th>Participacion</th></tr></thead><tbody>${data.map((x, index) => `
    <tr><td><span class="admin-rank">${index + 1}</span></td><td><strong>${html(x.usuario)}</strong></td><td>${html(nombreUsuario(x.usuario, aliases))}</td><td class="admin-main-number">${fmt(x.bultos)}</td><td class="admin-average">${fmt(x.promedioHora)}</td><td>${fmt(x.horasActivas)}</td><td>${pct(x.bultos, total).toFixed(1)}%</td></tr>`).join("")}</tbody></table></div>`;
}

function detalleProductosAdmin(data, total) {
  if (!data.length) return `<div class="empty-state">Sin productos para el turno seleccionado.</div>`;
  return `<div class="admin-detail-scroll"><table class="admin-detail-table"><thead><tr><th>#</th><th>Codigo</th><th>Descripcion</th><th>Bultos</th><th>LPNs</th><th>Participacion</th></tr></thead><tbody>${data.map((x, index) => `
    <tr><td><span class="admin-rank product">${index + 1}</span></td><td><strong>${html(x.codigo)}</strong></td><td>${html(x.descripcion)}</td><td class="admin-main-number">${fmt(x.bultos)}</td><td>${fmt(x.lpns)}</td><td>${pct(x.bultos, total).toFixed(1)}%</td></tr>`).join("")}</tbody></table></div>`;
}

function tendenciaOperativa(data) {
  if (!data.length) return `<div class="empty-state">Sin datos horarios para el turno seleccionado.</div>`;
  const width = 1200;
  const height = 350;
  const left = 55;
  const right = 28;
  const top = 42;
  const bottom = 72;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(...data.map(x => x.valor), 1);
  const puntos = data.map((item, index) => ({
    ...item,
    x: data.length === 1 ? left + plotW / 2 : left + (plotW * index / (data.length - 1)),
    y: top + plotH - (item.valor / max) * plotH
  }));
  const path = puntos.map((p, index) => `${index ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const pico = [...puntos].sort((a, b) => b.valor - a.valor)[0];
  const lineas = [0, 1, 2, 3].map(i => {
    const y = top + plotH * i / 3;
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>`;
  }).join("");

  return `
    <div class="admin-trend-chart">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Tendencia de picking por hora">
        <g class="trend-grid">${lineas}</g>
        <path d="${path}"></path>
        ${puntos.map(p => {
          const valor = fmt(p.valor);
          const badgeWidth = Math.max(82, valor.length * 12 + 24);
          const badgeY = Math.max(5, p.y - 48);
          return `
            <g class="${p === pico ? "peak" : ""}">
              <rect class="value-badge" x="${p.x - badgeWidth / 2}" y="${badgeY}" width="${badgeWidth}" height="34" rx="9"></rect>
              <text class="value-label" x="${p.x}" y="${badgeY + 23}" text-anchor="middle">${valor}</text>
              <circle cx="${p.x}" cy="${p.y}" r="${p === pico ? 9 : 7}"></circle>
              <rect class="hour-badge" x="${p.x - 34}" y="${height - 52}" width="68" height="34" rx="8"></rect>
              <text class="hour" x="${p.x}" y="${height - 29}" text-anchor="middle">${String(p.hora).padStart(2, "0")}:00</text>
            </g>`;
        }).join("")}
      </svg>
      <div class="trend-peak"><strong>Hora pico ${String(pico.hora).padStart(2, "0")}:00</strong><span>${fmt(pico.valor)} bultos</span></div>
    </div>`;
}

function renderRanking() {
  const turno = limpiar(document.getElementById("filtroTurno").value);
  const resumen = vistaPicking(turno);
  const total = resumen.total;
  const dia = totalesTurnoCache.DIA;
  const tarde = totalesTurnoCache.TARDE;
  const noche = totalesTurnoCache.NOCHE;
  const horas = resumen.horas;
  const promedioHora = resumen.promedioHora;
  document.getElementById("totalPicking").textContent = fmt(total);
  document.getElementById("contenido").innerHTML = `
    <section class="admin-kpis">
      <article class="admin-kpi total"><span>Total ${html(turno || "general")}</span><strong>${fmt(total)}</strong><small>Bultos pickados</small></article>
      <article class="admin-kpi dia ${turno === "DIA" ? "selected" : ""}"><span>Turno dia</span><strong>${fmt(dia)}</strong><small>07:00 a 15:59</small></article>
      <article class="admin-kpi tarde ${turno === "TARDE" ? "selected" : ""}"><span>Turno tarde</span><strong>${fmt(tarde)}</strong><small>16:00 a 20:59</small></article>
      <article class="admin-kpi noche ${turno === "NOCHE" ? "selected" : ""}"><span>Turno noche</span><strong>${fmt(noche)}</strong><small>21:00 a 06:59</small></article>
      <article class="admin-kpi promedio"><span>Promedio por hora</span><strong>${fmt(promedioHora)}</strong><small>${fmt(horas.length)} horas activas</small></article>
    </section>
    <section class="card admin-trend-panel">
      <div class="section-head"><div><h2>Tendencia por hora${turno ? ` - ${html(turno)}` : ""}</h2></div><strong>${fmt(total)} bultos</strong></div>
      ${resumen.tendenciaHtml}
    </section>
    <section class="admin-detail-grid">
      <article class="card admin-detail-panel">
        <div class="section-head"><div><h2>Usuarios por turno${turno ? ` - ${html(turno)}` : ""}</h2></div><strong>${fmt(resumen.ranking.length)} usuarios</strong></div>
        ${detalleUsuariosAdmin(resumen.ranking, total)}
      </article>
      <article class="card admin-detail-panel">
        <div class="section-head"><div><h2>Productos mas pickados</h2></div><strong>${fmt(resumen.productos.length)} productos</strong></div>
        ${detalleProductosAdmin(resumen.productos, total)}
      </article>
    </section>`;
}

async function cargarDatos() {
  document.getElementById("estadoCarga").textContent = "Cargando Google Sheet...";
  const [resultado, usuarios] = await Promise.all([cargarPicking(), cargarUsuarios()]);
  dataPicking = resultado.data;
  dataUsuarios = usuarios.data;
  modeloPickingCache = null;
  directorioUsuariosCache = null;
  prepararVistasPicking();
  const modelo = modeloPicking();
  cargarOpcionesTurno(modelo);
  document.getElementById("estadoCarga").textContent = `${resultado.hoja}: ${fmt(modelo.length)} registros | Usuarios: ${fmt(dataUsuarios.length)}`;
  if (rolActual === "admin") renderRanking();
}

async function recargarDatos() {
  document.getElementById("contenido").innerHTML = `<div class="loading">Actualizando data...</div>`;
  try {
    await cargarDatos();
  } catch (error) {
    console.error(error);
    document.getElementById("estadoCarga").textContent = "Error de carga";
    document.getElementById("contenido").innerHTML = `<div class="error"><strong>No se pudo cargar REPORTE PICKING.</strong><p>${html(error.message || error)}</p><p>Verifica que el Sheet sea publico y que la pestana se llame REPORTE PICKING.</p></div>`;
  }
}

function login(event) {
  event.preventDefault();
  const user = limpiar(document.getElementById("usuario").value);
  const pass = limpiar(document.getElementById("password").value);
  const valido = USUARIOS.find(x => x.user === user && x.pass === pass);
  if (!valido) {
    document.getElementById("loginError").textContent = "Usuario o contrasena incorrecta.";
    return;
  }
  localStorage.setItem("ranking_picking_sesion", JSON.stringify({ user: valido.user, nombre: valido.nombre, rol: valido.user }));
  mostrarApp(valido);
}

function mostrarApp(usuario) {
  rolActual = usuario.rol || usuario.user;
  document.getElementById("loginView").hidden = true;
  document.getElementById("appView").hidden = false;
  document.getElementById("usuarioActivo").textContent = usuario.nombre || usuario.user;
  const esAdmin = rolActual === "admin";
  document.getElementById("adminView").hidden = !esAdmin;
  document.getElementById("operadorView").hidden = esAdmin;
  document.getElementById("btnActualizar").hidden = false;
  presentacionPendiente = false;
  recargarDatos();
}

function logout() {
  localStorage.removeItem("ranking_picking_sesion");
  cerrarPresentacion();
  document.getElementById("appView").hidden = true;
  document.getElementById("loginView").hidden = false;
  document.getElementById("password").value = "";
  rolActual = "";
}

function cargarSesion() {
  try {
    const sesion = JSON.parse(localStorage.getItem("ranking_picking_sesion") || "null");
    if (sesion?.user) return mostrarApp(sesion);
  } catch {}
  document.getElementById("loginView").hidden = false;
  document.getElementById("appView").hidden = true;
}

cargarSesion();
