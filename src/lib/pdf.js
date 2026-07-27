// Genera el PDF del recibo replicando la plantilla de Curiosamente:
// cabecera con logo, Fecha de Emisión, Recibí de, La cantidad de, Concepto y Total.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const NARANJA = rgb(0.95, 0.55, 0.16); // naranja del lápiz del logo
const GRIS = rgb(0.35, 0.35, 0.35);
const NEGRO = rgb(0.1, 0.1, 0.1);
const VERDE = rgb(0.16, 0.53, 0.30); // sello de pagado

// Dibuja un lápiz naranja vectorial como sustituto del logo si no hay logo.png.
function dibujarLapiz(page, x, y, escala = 1) {
  const w = 46 * escala, h = 12 * escala;
  // cuerpo
  page.drawRectangle({ x, y, width: w, height: h, color: NARANJA });
  // punta (triángulo aproximado con svg path)
  page.drawSvgPath(`M 0 0 L ${14 * escala} ${h / 2} L 0 ${h} Z`, {
    x: x + w, y: y + h, color: rgb(0.85, 0.65, 0.45)
  });
  // mina
  page.drawSvgPath(`M 0 ${h / 2 - 2 * escala} L ${5 * escala} ${h / 2} L 0 ${h / 2 + 2 * escala} Z`, {
    x: x + w + 9 * escala, y: y + h, color: NEGRO
  });
  // goma
  page.drawRectangle({ x: x - 6 * escala, y, width: 6 * escala, height: h, color: rgb(0.93, 0.45, 0.45) });
}

/**
 * @param {object} datos
 *  - fechaEmision: string (ej. "08/07/2026")
 *  - recibiDe: string (nombre del alumno o pagador)
 *  - cantidadLetras: string (ej. "Doscientos diez")
 *  - concepto: string (ej. "Abril+mayo+junio")
 *  - totalCifra: string (ej. "210")
 *  - referencia: string interna opcional (no visible salvo pie discreto)
 *  - logoPngBase64: base64 del logo real (opcional)
 * @returns {Uint8Array} bytes del PDF
 */
export async function generarReciboPdf(datos) {
  const doc = await PDFDocument.create();
  // A5 apaisado: formato compacto de "recibí"
  const page = doc.addPage([595, 420]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();
  const margen = 48;

  // ---- Cabecera ----
  let cursorY = height - 70;
  if (datos.logoPngBase64) {
    const png = await doc.embedPng(Uint8Array.from(atob(datos.logoPngBase64), c => c.charCodeAt(0)));
    const maxW = 220, maxH = 60;
    const ratio = Math.min(maxW / png.width, maxH / png.height);
    page.drawImage(png, {
      x: margen, y: cursorY - 10,
      width: png.width * ratio, height: png.height * ratio
    });
  } else {
    page.drawText('Curiosamente', { x: margen, y: cursorY, size: 26, font: helvBold, color: NARANJA });
    dibujarLapiz(page, margen + 185, cursorY + 2, 1);
    page.drawText('tu centro de estudios', { x: margen + 2, y: cursorY - 16, size: 11, font: helv, color: GRIS });
  }

  page.drawText('RECIBO', { x: width - margen - 78, y: cursorY, size: 16, font: helvBold, color: NEGRO });

  // línea separadora
  cursorY -= 46;
  page.drawLine({
    start: { x: margen, y: cursorY }, end: { x: width - margen, y: cursorY },
    thickness: 1.2, color: NARANJA
  });

  // ---- Campos ----
  const campos = [
    ['Fecha de Emisión:', datos.fechaEmision],
    ['Recibí de:', datos.recibiDe],
    ['La cantidad de:', `${datos.cantidadLetras}€`],
    ['Concepto:', datos.concepto]
  ];

  cursorY -= 42;
  const xEtiqueta = margen;
  const xValor = margen + 130;
  for (const [etiqueta, valor] of campos) {
    page.drawText(etiqueta, { x: xEtiqueta, y: cursorY, size: 12, font: helvBold, color: NEGRO });
    page.drawText(String(valor || ''), { x: xValor, y: cursorY, size: 12, font: helv, color: NEGRO });
    // línea de puntos bajo el valor, estilo formulario de la plantilla
    page.drawLine({
      start: { x: xValor - 4, y: cursorY - 4 }, end: { x: width - margen, y: cursorY - 4 },
      thickness: 0.5, color: rgb(0.75, 0.75, 0.75), dashArray: [1.5, 2.5]
    });
    cursorY -= 38;
  }

  // ---- Total destacado ----
  cursorY -= 8;
  const cajaW = 200, cajaH = 40;
  const cajaX = width - margen - cajaW;
  page.drawRectangle({
    x: cajaX, y: cursorY - cajaH + 22, width: cajaW, height: cajaH,
    borderColor: NARANJA, borderWidth: 1.4
  });
  page.drawText('Total:', { x: cajaX + 14, y: cursorY, size: 14, font: helvBold, color: NEGRO });
  const totalTxt = `${datos.totalCifra}€`;
  const totalW = helvBold.widthOfTextAtSize(totalTxt, 16);
  page.drawText(totalTxt, { x: cajaX + cajaW - 14 - totalW, y: cursorY - 1, size: 16, font: helvBold, color: NARANJA });

  // ---- Sello PAGADO: convierte el recibo en justificante de pago ----
  if (datos.pagado) {
    const ang = 14;
    const rad = (ang * Math.PI) / 180;
    const tamTexto = 24;
    const anchoTexto = helvBold.widthOfTextAtSize('PAGADO', tamTexto);
    const padX = 16, padY = 10;
    const cajaAncho = anchoTexto + padX * 2;
    const cajaAlto = tamTexto + padY * 2 + (datos.fechaPago ? 12 : 0);
    const x0 = margen + 14, y0 = 50;
    // Posición dentro del sello, girada con el mismo ángulo que la caja.
    const enSello = (dx, dy) => ({
      x: x0 + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: y0 + dx * Math.sin(rad) + dy * Math.cos(rad)
    });

    page.drawRectangle({
      x: x0, y: y0, width: cajaAncho, height: cajaAlto,
      rotate: degrees(ang), borderColor: VERDE, borderWidth: 2.5, borderOpacity: 0.85
    });
    const pTexto = enSello(padX, cajaAlto - padY - tamTexto + 5);
    page.drawText('PAGADO', {
      x: pTexto.x, y: pTexto.y, size: tamTexto, font: helvBold,
      color: VERDE, rotate: degrees(ang), opacity: 0.85
    });
    if (datos.fechaPago) {
      const pFecha = enSello(padX, padY - 2);
      page.drawText(datos.fechaPago, {
        x: pFecha.x, y: pFecha.y, size: 9, font: helv,
        color: VERDE, rotate: degrees(ang), opacity: 0.85
      });
    }
  }

  // ---- Pie: referencia interna discreta ----
  if (datos.referencia) {
    page.drawText(`Ref. ${datos.referencia}`, {
      x: margen, y: 28, size: 7.5, font: helv, color: rgb(0.65, 0.65, 0.65)
    });
  }

  return doc.save();
}

// Nombre de archivo: Recibo_NombreAlumno_MesAño.pdf
// (con sufijo _PAGADO cuando es el justificante de pago)
export function nombreArchivoRecibo(nombreAlumno, concepto, pagado = false) {
  const limpio = (s) => String(s).trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9+]+/g, '_').replace(/^_+|_+$/g, '');
  return `Recibo_${limpio(nombreAlumno)}_${limpio(concepto)}${pagado ? '_PAGADO' : ''}.pdf`;
}
